import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitClient } from "../src/vcs/git.js";
import { systemCommandRunner } from "../src/runtime/commands.js";

async function tempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "merro-git-"));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await systemCommandRunner.run("git", args, { cwd })).stdout.trim();
}

async function createProject(root: string): Promise<{ path: string; bare: string }> {
  const path = join(root, "project");
  const bare = join(root, "remote.git");
  await systemCommandRunner.run("git", ["init", "--bare", "--initial-branch=main", bare]);
  await systemCommandRunner.run("git", ["init", "--initial-branch=main", path]);
  await git(path, "config", "user.name", "Merro Test");
  await git(path, "config", "user.email", "merro@example.test");
  await writeFile(join(path, "README.md"), "initial\n");
  await git(path, "add", "README.md");
  await git(path, "commit", "-m", "initial");
  await git(path, "remote", "add", "origin", bare);
  await git(path, "push", "--set-upstream", "origin", "main");
  return { path, bare };
}

test("Git client creates per-WorkItem clone, validates one commit, and pushes without force", async (t) => {
  const root = await tempDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await createProject(root);
  const workRoot = join(root, "work");
  const clonePath = join(workRoot, "project", "p-issue-1-g1");
  const input = {
    slug: "p",
    path: project.path,
    baseRemote: "origin",
    pushRemote: "origin",
    defaultBranch: "main",
  };
  const gitClient = new GitClient();

  const clone = await gitClient.createWorkItemClone(input, clonePath, "merro/issue-1-example");
  assert.equal(await git(clonePath, "config", "user.name"), "Merro Test");
  await writeFile(join(clonePath, "change.txt"), "change\n");
  await git(clonePath, "add", "change.txt");
  await git(clonePath, "commit", "-m", "change");
  const commit = await gitClient.currentCommit(clonePath);
  assert.equal(await gitClient.validateTaskCommit(clonePath, clone.baseCommit, commit), commit);

  await gitClient.pushBranch(input, clonePath, clone.branchName);
  assert.equal(await gitClient.remoteBranchCommit(input, clone.branchName), commit);

  const externalClone = join(root, "external");
  await systemCommandRunner.run("git", ["clone", "--", project.bare, externalClone]);
  await git(externalClone, "config", "user.name", "Other");
  await git(externalClone, "config", "user.email", "other@example.test");
  await git(externalClone, "switch", "--create", clone.branchName, "origin/main");
  await writeFile(join(externalClone, "external.txt"), "external\n");
  await git(externalClone, "add", "external.txt");
  await git(externalClone, "commit", "-m", "external update");
  await git(externalClone, "push", "--force", "origin", `HEAD:refs/heads/${clone.branchName}`);
  const externalCommit = await gitClient.remoteBranchCommit(input, clone.branchName);
  assert.ok(externalCommit);
  await assert.rejects(gitClient.pushBranch(input, clonePath, clone.branchName));
  assert.equal(await gitClient.remoteBranchCommit(input, clone.branchName), externalCommit);
  await gitClient.syncBranchHead(input, clonePath, clone.branchName, externalCommit);
  assert.equal(await gitClient.currentCommit(clonePath), externalCommit);

  await git(clonePath, "switch", "main");
  await git(clonePath, "branch", "-D", clone.branchName);
  await gitClient.ensureWorkItemClone(input, clonePath, clone.branchName, externalCommit);
  assert.equal(await git(clonePath, "branch", "--show-current"), clone.branchName);
  assert.equal(await gitClient.currentCommit(clonePath), externalCommit);

  await gitClient.deleteClone(workRoot, clonePath);
  await gitClient.ensureWorkItemClone(input, clonePath, clone.branchName, externalCommit);
  assert.equal(await gitClient.currentCommit(clonePath), externalCommit);

  await gitClient.deleteClone(workRoot, clonePath);
  await assert.rejects(gitClient.deleteClone(workRoot, project.path), /outside work root/);
});

test("effective diff fingerprint survives commit rewrites but detects changed content", async (t) => {
  const root = await tempDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRepo = await createProject(root);
  const project = {
    slug: "p",
    path: projectRepo.path,
    baseRemote: "origin",
    pushRemote: "origin",
    defaultBranch: "main",
  };
  const gitClient = new GitClient();
  const clone = await gitClient.createWorkItemClone(project, join(root, "work"), "merro/issue-1-example");
  await writeFile(join(clone.path, "change.txt"), "same patch\n");
  await git(clone.path, "add", "change.txt");
  await git(clone.path, "commit", "-m", "first implementation");
  const firstHead = await gitClient.currentCommit(clone.path);
  const firstFingerprint = await gitClient.effectiveDiffFingerprint(
    project, clone.path, "main", clone.baseCommit, firstHead,
  );

  await git(clone.path, "commit", "--amend", "-m", "rewritten implementation");
  const rewrittenHead = await gitClient.currentCommit(clone.path);
  assert.notEqual(rewrittenHead, firstHead);
  const rewrittenFingerprint = await gitClient.effectiveDiffFingerprint(
    project, clone.path, "main", clone.baseCommit, rewrittenHead,
  );
  assert.equal(rewrittenFingerprint, firstFingerprint);

  await writeFile(join(clone.path, "change.txt"), "different patch\n");
  await git(clone.path, "add", "change.txt");
  await git(clone.path, "commit", "--amend", "--no-edit");
  const changedFingerprint = await gitClient.effectiveDiffFingerprint(
    project, clone.path, "main", clone.baseCommit, await gitClient.currentCommit(clone.path),
  );
  assert.notEqual(changedFingerprint, firstFingerprint);
});

test("Git client creates an exact detached checkout for dependency review", async (t) => {
  const root = await tempDirectory();
  t.after(async () => {
    await systemCommandRunner.run("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  });
  const project = await createProject(root);
  const projectRecord = {
    slug: "p",
    path: project.path,
    baseRemote: "origin",
    pushRemote: "origin",
    defaultBranch: "main",
  };
  await writeFile(join(project.path, "merged.txt"), "merged change\n");
  await git(project.path, "add", "merged.txt");
  await git(project.path, "commit", "-m", "squash merged dependency");
  await git(project.path, "push", "origin", "main");
  const mergedCommit = await git(project.path, "rev-parse", "HEAD");
  const checkoutPath = join(root, "runtime", "task-1", "dependencies", "1");

  await new GitClient().createReadOnlyCheckout(projectRecord, checkoutPath, mergedCommit);

  assert.equal(await git(checkoutPath, "rev-parse", "HEAD"), mergedCommit);
  assert.equal(await git(checkoutPath, "branch", "--show-current"), "");
  assert.equal(await git(checkoutPath, "show", "HEAD:merged.txt"), "merged change");
  await assert.rejects(new GitClient().createReadOnlyCheckout(projectRecord, join(root, "bad-checkout"), "f".repeat(40)));
});

test("Git client rejects Task commits that contain more than one commit", async (t) => {
  const root = await tempDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = await createProject(root);
  const clonePath = join(root, "work", "p-issue-1-g1");
  const gitClient = new GitClient();
  const clone = await gitClient.createWorkItemClone({
    slug: "p",
    path: project.path,
    baseRemote: "origin",
    pushRemote: "origin",
    defaultBranch: "main",
  }, clonePath, "merro/issue-1-example");

  for (const name of ["one", "two"]) {
    await writeFile(join(clonePath, `${name}.txt`), `${name}\n`);
    await git(clonePath, "add", `${name}.txt`);
    await git(clonePath, "commit", "-m", name);
  }

  await assert.rejects(
    gitClient.validateTaskCommit(clonePath, clone.baseCommit, await gitClient.currentCommit(clonePath)),
    /one commit directly/,
  );
});
