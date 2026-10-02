import { chmod, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BaseUpdate, Project } from "../domain/model.js";
import { assertProjectSlug } from "../domain/project.js";
import { CommandError, systemCommandRunner, type CommandRunner } from "../runtime/commands.js";

export interface ChangeSetClone {
  path: string;
  branchName: string;
  baseCommit: string;
}

export class GitClient {
  readonly #commands: CommandRunner;

  constructor(commands: CommandRunner = systemCommandRunner) {
    this.#commands = commands;
  }

  async discoverProject(path: string, slug: string): Promise<Project> {
    assertProjectSlug(slug);
    const root = (await this.#run("git", ["rev-parse", "--show-toplevel"], { cwd: path })).stdout.trim();
    const remotes = (await this.#run("git", ["remote"], { cwd: root })).stdout.trim().split(/\r?\n/).filter(Boolean);
    if (remotes.length === 0) throw new Error(`Project ${path} has no Git remotes`);
    const baseName = remotes.includes("upstream") ? "upstream" : remotes.includes("origin") ? "origin" : remotes[0];
    const pushName = remotes.includes("origin") ? "origin" : baseName;
    if (!baseName || !pushName) throw new Error(`Project ${path} has no usable Git remote`);
    const baseRemote = (await this.#run("git", ["remote", "get-url", baseName], { cwd: root })).stdout.trim();
    const pushRemote = (await this.#run("git", ["remote", "get-url", pushName], { cwd: root })).stdout.trim();
    if (!baseRemote || !pushRemote) throw new Error(`Project ${path} has an empty Git remote URL`);
    let defaultBranch = "";
    try {
      defaultBranch = (await this.#run("git", ["symbolic-ref", "--short", `refs/remotes/${baseName}/HEAD`], { cwd: root })).stdout.trim().replace(`${baseName}/`, "");
    } catch {
      defaultBranch = (await this.#run("git", ["branch", "--show-current"], { cwd: root })).stdout.trim();
    }
    if (!defaultBranch) throw new Error(`cannot determine default branch for Project ${path}`);
    return { slug, path: root, baseRemote, pushRemote, defaultBranch };
  }

  async resolveProjectRemotes(project: Project): Promise<Project> {
    return {
      ...project,
      baseRemote: await this.#resolveRemote(project.path, project.baseRemote),
      pushRemote: await this.#resolveRemote(project.path, project.pushRemote),
    };
  }

  async createChangeSetClone(project: Project, path: string, branchName: string): Promise<ChangeSetClone> {
    const resolvedProject = await this.resolveProjectRemotes(project);
    await this.#run("git", ["check-ref-format", "--branch", branchName]);
    const userName = await this.#gitConfig(project.path, "user.name");
    const userEmail = await this.#gitConfig(project.path, "user.email");
    if (!userName || !userEmail) {
      throw new Error(`Git identity is missing in Project ${project.slug}; configure user.name and user.email`);
    }

    await mkdir(dirname(path), { recursive: true });
    await this.#run("git", [
      "clone", "--local", "--no-checkout", "--", project.path, path,
    ]);
    await this.#run("git", ["config", "--local", "user.name", userName], { cwd: path });
    await this.#run("git", ["config", "--local", "user.email", userEmail], { cwd: path });
    await this.#run("git", ["remote", "set-url", "origin", resolvedProject.baseRemote], { cwd: path });
    await this.#run("git", ["remote", "add", "push", resolvedProject.pushRemote], { cwd: path });
    await this.#run("git", ["fetch", "--no-tags", "origin", `+refs/heads/${project.defaultBranch}:refs/remotes/origin/${project.defaultBranch}`], { cwd: path });
    await this.#run("git", ["switch", "--create", branchName, `origin/${project.defaultBranch}`], { cwd: path });
    const baseCommit = (await this.#run("git", ["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
    return { path, branchName, baseCommit };
  }

  async discardAttempt(path: string, expectedCommit: string): Promise<void> {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expectedCommit)) throw new Error("Attempt base commit is invalid.");
    await this.#run("git", ["reset", "--hard", expectedCommit], { cwd: path });
    await this.#run("git", ["clean", "-fd", "-e", ".pi/"], { cwd: path });
  }

  async fullDiff(path: string, baseCommit: string): Promise<string> {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(baseCommit)) throw new Error("Review base commit is invalid.");
    return (await this.#run("git", ["diff", "--no-ext-diff", "--no-color", `${baseCommit}...HEAD`, "--"], { cwd: path })).stdout;
  }

  async currentCommit(path: string): Promise<string> {
    return (await this.#run("git", ["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
  }

  async createReadOnlyCheckout(project: Project, path: string, commit: string): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error(`invalid dependency commit SHA: ${commit}`);
    try {
      await lstat(path);
      throw new Error(`dependency checkout path already exists: ${path}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("dependency checkout path already exists:")) throw error;
      if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const remote = await this.#resolveRemote(project.path, project.baseRemote);
    await mkdir(dirname(path), { recursive: true });
    try {
      await this.#run("git", ["clone", "--no-checkout", "--no-hardlinks", "--", remote, path]);
      const resolved = (await this.#run("git", ["rev-parse", "--verify", `${commit}^{commit}`], { cwd: path })).stdout.trim();
      if (resolved !== commit) throw new Error(`dependency commit ${commit} resolved to ${resolved}`);
      await this.#run("git", ["checkout", "--detach", "--force", commit], { cwd: path });
      if (await this.currentCommit(path) !== commit) throw new Error(`dependency checkout did not reach exact commit ${commit}`);
      await this.#makeReadOnly(path);
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }

  async #makeReadOnly(path: string): Promise<void> {
    const details = await lstat(path);
    if (details.isSymbolicLink()) return;
    if (details.isDirectory()) {
      for (const entry of await readdir(path)) await this.#makeReadOnly(join(path, entry));
    }
    await chmod(path, details.mode & ~0o222);
  }

  async validateTaskCommit(path: string, expectedHead: string, reportedCommit: string, baseUpdate?: BaseUpdate | null): Promise<string> {
    if (!/^[0-9a-f]{40,64}$/i.test(reportedCommit)) {
      throw new Error(`Task reported an invalid commit SHA: ${reportedCommit}`);
    }
    const reported = (await this.#run("git", ["rev-parse", "--verify", `${reportedCommit}^{commit}`], { cwd: path })).stdout.trim();
    const head = await this.currentCommit(path);
    if (head !== reported) throw new Error(`Task commit ${reported} does not match clone HEAD ${head}`);

    const parents = (await this.#run("git", ["show", "-s", "--format=%P", reported], { cwd: path })).stdout.trim().split(/\s+/).filter(Boolean);
    const approvedMerge = baseUpdate && parents.length === 2 && parents[1] === baseUpdate.baseCommit;
    if (parents[0] !== expectedHead || (parents.length !== 1 && !approvedMerge)) {
      throw new Error(`Task commit must be one commit directly on ${expectedHead}, with only the approved base as an optional second parent`);
    }
    if (baseUpdate) {
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(baseUpdate.baseCommit)) throw new Error("invalid approved base commit SHA");
      try {
        await this.#run("git", ["merge-base", "--is-ancestor", baseUpdate.baseCommit, reported], { cwd: path });
      } catch (error) {
        if (!(error instanceof CommandError) || error.exitCode !== 1) throw error;
        throw new Error(`Task commit does not contain approved base ${baseUpdate.baseCommit}`, { cause: error });
      }
    }

    const status = (await this.#run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: path })).stdout;
    if (status.length > 0) throw new Error("Task clone has uncommitted or untracked changes");
    return reported;
  }

  async fetchBaseCommit(path: string, baseRefName: string, baseCommit: string): Promise<void> {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(baseCommit)) throw new Error("invalid approved base commit SHA");
    await this.#run("git", ["check-ref-format", "--branch", baseRefName], { cwd: path });
    await this.#run("git", ["fetch", "--no-tags", "origin", baseRefName], { cwd: path });
    const resolved = (await this.#run("git", ["rev-parse", "--verify", `${baseCommit}^{commit}`], { cwd: path })).stdout.trim();
    if (resolved !== baseCommit) throw new Error(`approved base ${baseCommit} resolved to ${resolved}`);
  }

  async pushBranch(project: Project, clonePath: string, branchName: string): Promise<void> {
    const current = (await this.#run("git", ["branch", "--show-current"], { cwd: clonePath })).stdout.trim();
    if (current !== branchName) throw new Error(`Refusing to push unexpected branch ${current}; expected ${branchName}`);
    const pushRemote = await this.#resolveRemote(project.path, project.pushRemote);
    await this.#run("git", ["push", pushRemote, `HEAD:refs/heads/${branchName}`], { cwd: clonePath });
  }

  async syncBranchHead(project: Project, clonePath: string, branchName: string, expectedCommit: string): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/i.test(expectedCommit)) throw new Error(`invalid GitHub pull request head SHA: ${expectedCommit}`);
    const current = (await this.#run("git", ["branch", "--show-current"], { cwd: clonePath })).stdout.trim();
    if (current !== branchName) throw new Error(`Refusing to sync unexpected branch ${current}; expected ${branchName}`);
    const status = await this.#run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: clonePath });
    if (status.stdout.length > 0) throw new Error(`cannot sync ${branchName}: clone has uncommitted or untracked changes`);
    const pushRemote = await this.#resolveRemote(project.path, project.pushRemote);
    await this.#run("git", ["fetch", "--no-tags", pushRemote, `refs/heads/${branchName}`], { cwd: clonePath });
    const fetched = (await this.#run("git", ["rev-parse", "FETCH_HEAD"], { cwd: clonePath })).stdout.trim();
    if (fetched !== expectedCommit) throw new Error(`GitHub pull request head ${expectedCommit} does not match fetched branch ${fetched}`);
    await this.#run("git", ["reset", "--hard", fetched], { cwd: clonePath });
  }

  async ensureChangeSetClone(project: Project, path: string, branchName: string, expectedCommit: string): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/i.test(expectedCommit)) throw new Error(`invalid authoritative branch SHA: ${expectedCommit}`);
    await this.#run("git", ["check-ref-format", "--branch", branchName]);
    try {
      const details = await lstat(path);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`ChangeSet clone is not a directory: ${path}`);
    } catch (error) {
      if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.#rebuildChangeSetClone(project, path, branchName, expectedCommit);
      return;
    }

    const status = await this.#run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: path });
    if (status.stdout.length > 0) throw new Error(`cannot reconcile ${branchName}: clone has uncommitted or untracked changes`);
    const branches = await this.#run("git", ["branch", "--list", "--format=%(refname:short)", branchName], { cwd: path });
    const hasBranch = branches.stdout.trim().split(/\r?\n/).includes(branchName);
    const remote = await this.#resolveRemote(project.path, project.pushRemote);
    if (!hasBranch) {
      await this.#run("git", ["fetch", "--no-tags", remote, `refs/heads/${branchName}`], { cwd: path });
      const fetched = (await this.#run("git", ["rev-parse", "FETCH_HEAD"], { cwd: path })).stdout.trim();
      if (fetched !== expectedCommit) throw new Error(`authoritative branch ${branchName} is ${fetched}, expected ${expectedCommit}`);
      await this.#run("git", ["switch", "--create", branchName, "FETCH_HEAD"], { cwd: path });
      return;
    }

    const current = (await this.#run("git", ["branch", "--show-current"], { cwd: path })).stdout.trim();
    if (current !== branchName) await this.#run("git", ["switch", branchName], { cwd: path });
    if (await this.currentCommit(path) !== expectedCommit) await this.syncBranchHead(project, path, branchName, expectedCommit);
  }

  async #rebuildChangeSetClone(project: Project, path: string, branchName: string, expectedCommit: string): Promise<void> {
    const temporaryPath = join(dirname(path), `.merro-rebuild-${randomUUID()}`);
    await mkdir(dirname(path), { recursive: true });
    try {
      await this.createChangeSetClone(project, temporaryPath, branchName);
      await this.syncBranchHead(project, temporaryPath, branchName, expectedCommit);
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true });
      throw error;
    }
  }

  async effectiveDiffFingerprint(
    project: Project,
    path: string,
    baseRefName: string,
    baseCommit: string,
    headCommit: string,
  ): Promise<string> {
    if (!/^[0-9a-f]{40,64}$/i.test(baseCommit) || !/^[0-9a-f]{40,64}$/i.test(headCommit)) {
      throw new Error("effective diff requires valid base and head commit SHAs");
    }
    await this.#run("git", ["check-ref-format", "--branch", baseRefName]);
    const remote = await this.#resolveRemote(project.path, project.baseRemote);
    await this.#run("git", ["fetch", "--no-tags", remote, `refs/heads/${baseRefName}`], { cwd: path });
    const fetchedBase = (await this.#run("git", ["rev-parse", "FETCH_HEAD"], { cwd: path })).stdout.trim();
    if (fetchedBase !== baseCommit) {
      throw new Error(`pull request base changed while comparing diff: expected ${baseCommit}, fetched ${fetchedBase}`);
    }
    const mergeBase = (await this.#run("git", ["merge-base", baseCommit, headCommit], { cwd: path })).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(mergeBase)) throw new Error("Git returned an invalid merge base");
    const diff = await this.#run("git", [
      "diff", "--no-ext-diff", "--no-color", "--binary", "--full-index", mergeBase, headCommit,
    ], { cwd: path });
    return createHash("sha256").update(diff.stdout).digest("hex");
  }

  async remoteBranchCommit(project: Project, branchName: string): Promise<string | null> {
    await this.#run("git", ["check-ref-format", "--branch", branchName]);
    const remote = await this.#resolveRemote(project.path, project.pushRemote);
    const output = await this.#run("git", ["ls-remote", "--heads", remote, `refs/heads/${branchName}`]);
    const line = output.stdout.trim();
    return line ? line.split(/\s+/)[0] ?? null : null;
  }

  async deleteClone(workRoot: string, path: string): Promise<void> {
    const root = resolve(workRoot);
    const target = resolve(path);
    const fromRoot = relative(root, target);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`refusing to delete clone outside work root: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }

  async #resolveRemote(path: string, remote: string): Promise<string> {
    if (/^(https?|ssh|git|file):\/\//i.test(remote) || /^git@[^:]+:.+/.test(remote) || remote.startsWith("/") || remote.startsWith("./") || remote.startsWith("../")) {
      return remote;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith("-")) {
      throw new Error(`invalid Git remote ${remote}`);
    }
    try {
      const value = (await this.#run("git", ["remote", "get-url", remote], { cwd: path })).stdout.trim();
      if (!value) throw new Error(`Git remote ${remote} in ${path} has no URL`);
      return value;
    } catch (error) {
      if (error instanceof CommandError && error.exitCode === 2) {
        throw new Error(`unknown Git remote or invalid URL ${remote} in ${path}`);
      }
      throw error;
    }
  }

  async #gitConfig(path: string, key: string): Promise<string | null> {
    try {
      const value = (await this.#run("git", ["config", "--get", key], { cwd: path })).stdout.trim();
      return value || null;
    } catch (error) {
      if (error instanceof CommandError && error.exitCode === 1) return null;
      throw error;
    }
  }

  async #run(file: string, args: readonly string[], options: { cwd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
    return this.#commands.run(file, args, options);
  }
}
