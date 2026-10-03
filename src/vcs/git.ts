import { createHash, randomUUID } from "node:crypto";
import { chmod, type FileHandle, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { BaseUpdate, Project } from "../domain/model.js";
import { assertProjectSlug } from "../domain/project.js";
import { CommandError, type CommandRunner, systemCommandRunner } from "../runtime/commands.js";

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
    if (remotes.length === 0) {
      const defaultBranch = (await this.#run("git", ["branch", "--show-current"], { cwd: root })).stdout.trim();
      if (!defaultBranch) throw new Error(`Project ${slug} needs a checked-out branch`);
      await this.currentCommit(root); // An initial commit is required for isolated work.
      return { slug, path: root, baseRemote: "", pushRemote: "", defaultBranch };
    }
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

  async cloneProject(remote: string, path: string): Promise<void> {
    try { await lstat(path); throw new Error(`Project destination already exists: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(dirname(path), { recursive: true });
    // Clone privately first. Failed registration never removes or adopts a pre-existing destination.
    const temporary = `${path}.clone-${randomUUID()}`;
    try {
      await this.#run("git", ["clone", "--", remote, temporary]);
      await mkdir(path); // Exclusive reservation; never overwrite an existing checkout.
      await rename(temporary, path);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async createChangeSetClone(project: Project, path: string, branchName: string, delivery: "local" | "pr" = "pr"): Promise<ChangeSetClone> {
    try { await lstat(path); throw new Error(`ChangeSet destination already exists: ${path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const resolvedProject = delivery === "local" ? { ...project, baseRemote: project.path, pushRemote: project.path }
      : await this.resolveProjectRemotes(project);
    if (!resolvedProject.baseRemote) throw new Error("PR delivery requires a remote; use local delivery for this Project");
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

  async inspectLocalDelivery(
    project: Project,
    path: string,
    targetBranch: string,
    reviewedCommit: string,
    expectedBaseCommit: string,
  ): Promise<{ baseCommit: string; diffHash: string } | { baseUpdate: BaseUpdate }> {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(reviewedCommit)) throw new Error("Invalid reviewed commit");
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(expectedBaseCommit)) throw new Error("Invalid reviewed base commit");
    await this.#run("git", ["check-ref-format", "--branch", targetBranch]);
    if (await this.currentCommit(path) !== reviewedCommit) throw new Error("Working copy no longer matches the reviewed commit");
    for (const checkout of [path, project.path]) {
      if ((await this.#run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: checkout })).stdout) {
        throw new Error("Local delivery needs clean working copies; commit or stash unrelated changes first");
      }
    }
    const branch = (await this.#run("git", ["branch", "--show-current"], { cwd: project.path })).stdout.trim();
    if (branch !== targetBranch) throw new Error(`Local delivery needs ${targetBranch} checked out in Project ${project.slug}`);
    const target = await this.currentCommit(project.path);
    if (target !== expectedBaseCommit) return { baseUpdate: { baseRefName: targetBranch, baseCommit: target } };
    await this.#run("git", ["fetch", "--no-tags", "--", project.path, `refs/heads/${targetBranch}`], { cwd: path });
    try { await this.#run("git", ["merge-base", "--is-ancestor", target, reviewedCommit], { cwd: path }); }
    catch (error) {
      if (!(error instanceof CommandError) || error.exitCode !== 1) throw error;
      return { baseUpdate: { baseRefName: targetBranch, baseCommit: target } };
    }
    const diffHash = await this.effectiveDiffFingerprint(project, path, targetBranch, target, reviewedCommit, project.path);
    return { baseCommit: target, diffHash };
  }

  async deliverLocal(
    project: Project,
    path: string,
    targetBranch: string,
    reviewedCommit: string,
    expectedBaseCommit?: string,
    expectedDiffHash?: string,
  ): Promise<{ commit: string } | { baseUpdate: BaseUpdate }> {
    const expectedBase = expectedBaseCommit ?? await this.currentCommit(project.path);
    const inspected = await this.inspectLocalDelivery(project, path, targetBranch, reviewedCommit, expectedBase);
    if ("baseUpdate" in inspected) return inspected;
    if (expectedDiffHash && inspected.diffHash !== expectedDiffHash) throw new Error("Local reviewed diff changed before merge approval");
    await this.#run("git", ["fetch", "--no-tags", "--", path, reviewedCommit], { cwd: project.path });

    const releaseCheckout = await this.#lockLocalCheckout(project.path);
    try {
      // Repeat all approval checks after fetching, while Git branch changes are excluded.
      const finalInspection = await this.inspectLocalDelivery(project, path, targetBranch, reviewedCommit, expectedBase);
      if ("baseUpdate" in finalInspection) return finalInspection;
      if (expectedDiffHash && finalInspection.diffHash !== expectedDiffHash) {
        throw new Error("Local reviewed diff changed before merge approval");
      }

      const targetRef = `refs/heads/${targetBranch}`;
      const checkedOutBranch = (await this.#run("git", ["branch", "--show-current"], { cwd: project.path })).stdout.trim();
      if (checkedOutBranch !== targetBranch) throw new Error(`Local delivery needs ${targetBranch} checked out in Project ${project.slug}`);
      const targetBase = (await this.#run("git", ["rev-parse", "--verify", `${targetRef}^{commit}`], { cwd: project.path })).stdout.trim();
      if (targetBase !== expectedBase) return { baseUpdate: { baseRefName: targetBranch, baseCommit: targetBase } };
      if (await this.currentCommit(project.path) !== expectedBase) throw new Error("Local target changed during delivery; reconcile before retrying");
      if ((await this.#run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: project.path })).stdout) {
        throw new Error("Local delivery needs clean working copies; commit or stash unrelated changes first");
      }

      // Compare-and-swap the approved ref while protecting the canonical checkout.
      try {
        await this.#updateRefWithCheckoutLocked(project.path, targetRef, reviewedCommit, expectedBase);
      } catch (error) {
        const currentBase = (await this.#run("git", ["rev-parse", "--verify", `${targetRef}^{commit}`], { cwd: project.path })).stdout.trim();
        if (currentBase !== expectedBase) return { baseUpdate: { baseRefName: targetBranch, baseCommit: currentBase } };
        throw error;
      }
      await this.#syncCheckedOutLocalTarget(project.path, targetBranch, expectedBase, reviewedCommit);
      await this.#verifySynchronizedLocalTarget(project.path, targetBranch, reviewedCommit);
      const deliveredRef = (await this.#run("git", ["rev-parse", "--verify", `${targetRef}^{commit}`], { cwd: project.path })).stdout.trim();
      if (deliveredRef !== reviewedCommit) throw new Error("Approved local target ref changed during delivery; reconcile before retrying");
      return { commit: reviewedCommit };
    } finally {
      await releaseCheckout();
    }
  }

  async #updateRefWithCheckoutLocked(path: string, targetRef: string, reviewedCommit: string, expectedBase: string): Promise<void> {
    const commonDir = (await this.#run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: path })).stdout.trim();
    const detachedGitDir = join(commonDir, `.merro-ref-update-${randomUUID()}`);
    await mkdir(detachedGitDir);
    try {
      // A detached per-command HEAD lets update-ref change the checked-out branch
      // without trying to acquire the canonical checkout's already-held HEAD.lock.
      await writeFile(join(detachedGitDir, "HEAD"), `${expectedBase}\n`, { flag: "wx", mode: 0o600 });
      await writeFile(join(detachedGitDir, "commondir"), `${commonDir}\n`, { flag: "wx", mode: 0o600 });
      await this.#run("git", ["--git-dir", detachedGitDir, "update-ref", "--no-deref", targetRef, reviewedCommit, expectedBase], { cwd: path });
    } finally {
      await rm(detachedGitDir, { recursive: true, force: true });
    }
  }

  async #lockLocalCheckout(path: string): Promise<() => Promise<void>> {
    const headPath = (await this.#run("git", ["rev-parse", "--path-format=absolute", "--git-path", "HEAD"], { cwd: path })).stdout.trim();
    const lockPath = `${headPath}.lock`;
    let lock: FileHandle;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Local delivery cannot protect the canonical checkout because Git HEAD is locked; retry after Git finishes");
      }
      throw error;
    }
    return async () => {
      try {
        // Unlink while still holding the inode so a new Git lock is never removed accidentally.
        await rm(lockPath, { force: true });
      } finally {
        await lock.close();
      }
    };
  }

  async #syncCheckedOutLocalTarget(path: string, targetBranch: string, baseCommit: string, reviewedCommit: string): Promise<void> {
    const branch = (await this.#run("git", ["branch", "--show-current"], { cwd: path })).stdout.trim();
    if (branch !== targetBranch || await this.currentCommit(path) !== reviewedCommit) {
      throw new Error("Canonical checkout changed before local delivery synchronization");
    }
    const baseTree = (await this.#run("git", ["rev-parse", "--verify", `${baseCommit}^{tree}`], { cwd: path })).stdout.trim();
    const indexTree = (await this.#run("git", ["write-tree"], { cwd: path })).stdout.trim();
    const untracked = (await this.#run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: path })).stdout;
    let worktreeChanged = false;
    try {
      await this.#run("git", ["diff", "--quiet", "--"], { cwd: path });
    } catch (error) {
      if (!(error instanceof CommandError) || error.exitCode !== 1) throw error;
      worktreeChanged = true;
    }
    if (indexTree !== baseTree || worktreeChanged || untracked) {
      throw new Error("Canonical checkout changed during local delivery; refusing to overwrite edits");
    }
    // Merge from the reviewed base so concurrent index or worktree edits are preserved and rejected, not reset.
    await this.#run("git", ["read-tree", "-m", "-u", baseCommit, reviewedCommit], { cwd: path });
  }

  async #verifySynchronizedLocalTarget(path: string, targetBranch: string, reviewedCommit: string): Promise<void> {
    const branch = (await this.#run("git", ["branch", "--show-current"], { cwd: path })).stdout.trim();
    if (branch !== targetBranch) throw new Error(`Local delivery needs ${targetBranch} checked out in the canonical Project checkout`);
    if (await this.currentCommit(path) !== reviewedCommit) throw new Error("Canonical checkout HEAD does not match the reviewed commit after synchronization");
    const reviewedTree = (await this.#run("git", ["rev-parse", "--verify", `${reviewedCommit}^{tree}`], { cwd: path })).stdout.trim();
    const indexTree = (await this.#run("git", ["write-tree"], { cwd: path })).stdout.trim();
    if (indexTree !== reviewedTree) throw new Error("Canonical checkout index does not match the reviewed commit after synchronization");
    if ((await this.#run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: path })).stdout) {
      throw new Error("Canonical checkout is not clean after local delivery synchronization");
    }
    try {
      await this.#run("git", ["diff", "--quiet", "HEAD", "--"], { cwd: path });
    } catch (error) {
      if (!(error instanceof CommandError) || error.exitCode !== 1) throw error;
      throw new Error("Canonical checkout files do not match the reviewed commit after synchronization");
    }
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

    const remote = project.baseRemote ? await this.#resolveRemote(project.path, project.baseRemote) : project.path;
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

  async pushBranch(project: Project, clonePath: string, branchName: string, reviewedCommit?: string): Promise<void> {
    await this.#run("git", ["check-ref-format", "--branch", branchName]);
    const current = (await this.#run("git", ["branch", "--show-current"], { cwd: clonePath })).stdout.trim();
    if (current !== branchName) throw new Error(`Refusing to push unexpected branch ${current}; expected ${branchName}`);
    const status = await this.#run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: clonePath });
    if (status.stdout.length) throw new Error("Cannot publish: clone has uncommitted or untracked changes. Restore the reviewed checkout before retrying.");
    const head = await this.currentCommit(clonePath);
    if (reviewedCommit && head !== reviewedCommit) throw new Error("Cannot publish: clone HEAD no longer matches the reviewed commit. Request a fresh review.");
    const pushRemote = await this.#resolveRemote(project.path, project.pushRemote);
    let remoteHead: string | null = null;
    try {
      await this.#run("git", ["fetch", "--no-tags", pushRemote, `refs/heads/${branchName}`], { cwd: clonePath });
      remoteHead = (await this.#run("git", ["rev-parse", "FETCH_HEAD"], { cwd: clonePath })).stdout.trim();
    } catch (error) {
      // Do not mistake authentication/connectivity failures for an absent branch.
      let absent = false;
      try {
        await this.#run("git", ["ls-remote", "--exit-code", "--heads", pushRemote, `refs/heads/${branchName}`], { cwd: clonePath });
      } catch (probeError) {
        if (!(probeError instanceof CommandError) || probeError.exitCode !== 2) throw probeError;
        absent = true;
      }
      if (!absent) throw error;
    }
    if (remoteHead && remoteHead !== head) {
      try {
        await this.#run("git", ["merge-base", "--is-ancestor", remoteHead, head], { cwd: clonePath });
      } catch (error) {
        if (!(error instanceof CommandError) || error.exitCode !== 1) throw error;
        let behind = false;
        try {
          await this.#run("git", ["merge-base", "--is-ancestor", head, remoteHead], { cwd: clonePath });
          behind = true;
        } catch (ancestorError) {
          if (!(ancestorError instanceof CommandError) || ancestorError.exitCode !== 1) throw ancestorError;
        }
        throw new Error(`Remote branch ${branchName} ${behind ? "is ahead of the reviewed local branch" : "has diverged"}. Reconcile the branch and request a fresh review through Main before retrying; do not force-push.`);
      }
    }
    // An ordinary push also rejects a concurrent remote rewrite. Publish the exact reviewed SHA.
    await this.#run("git", ["push", pushRemote, `${head}:refs/heads/${branchName}`], { cwd: clonePath });
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
    baseRemote?: string,
  ): Promise<string> {
    if (!/^[0-9a-f]{40,64}$/i.test(baseCommit) || !/^[0-9a-f]{40,64}$/i.test(headCommit)) {
      throw new Error("effective diff requires valid base and head commit SHAs");
    }
    await this.#run("git", ["check-ref-format", "--branch", baseRefName]);
    const remote = baseRemote ?? (project.baseRemote ? await this.#resolveRemote(project.path, project.baseRemote) : project.path);
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
