import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";
import { systemCommandRunner } from "../src/runtime/commands.js";
import { MainOrchestrator } from "../src/runtime/main.js";
import type { WorkerLaunchInput } from "../src/runtime/worker-runtime.js";
import { initializeWorkspace } from "../src/runtime/workspace.js";
import { type MainToolAPI, registerMainTools } from "../src/tools/main.js";
import { GitClient } from "../src/vcs/git.js";

const initCommands = { async run(file: string, args: readonly string[]) {
  if (file === "pi") return { stdout: args[0] === "--version" ? "1.0.0" : "--tui-mode", stderr: "" };
  if (file === "tmux") return { stdout: "tmux 3.6", stderr: "" };
  throw new Error(`Unexpected init command: ${file}`);
} };

async function repository(root: string) {
  const path = join(root, "repo");
  await mkdir(path);
  const git = async (...args: string[]) => (await systemCommandRunner.run("git", args, { cwd: path })).stdout.trim();
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.test");
  await writeFile(join(path, "file.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "base");
  return { path, git };
}

test("first init creates complete config and short templates; repeated init never repairs or validates dependencies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-minimal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Use the real Git command only for optional local excludes.
  await initializeWorkspace(root, { async run(file, args, options) {
    return file === "git" ? systemCommandRunner.run(file, args, options) : initCommands.run(file, args);
  } });
  assert.equal(await readFile(join(root, ".merro", "config.json"), "utf8"), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  for (const file of ["WORKSPACE.md", "IMPLEMENTER.md", "REVIEWER.md"]) assert.ok((await readFile(join(root, ".merro", file), "utf8")).startsWith("# "));
  await rm(join(root, ".wt"), { recursive: true });
  await rm(join(root, ".merro", "IMPLEMENTER.md"));
  await writeFile(join(root, ".merro", "config.json"), "invalid but preserved");
  await initializeWorkspace(root, { async run() { throw new Error("Repeated init must not run dependencies"); } });
  assert.equal(await readFile(join(root, ".merro", "config.json"), "utf8"), "invalid but preserved");
  await assert.rejects(readFile(join(root, ".merro", "IMPLEMENTER.md")), { code: "ENOENT" });
  await assert.rejects(systemCommandRunner.run("test", ["-d", join(root, ".wt")]));
});

test("remote registration clones into configured workspace paths without GitHub or destination adoption", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-register-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await repository(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await initializeWorkspace(workspace, { async run(file, args, options) {
    return file === "git" ? systemCommandRunner.run(file, args, options) : initCommands.run(file, args);
  } });
  const config = validateConfig({ projectsDir: "owned/projects", worktreesDir: "owned/work" });
  const messages: string[] = [];
  const main = new MainOrchestrator({ workspacePath: workspace, config, notify: (message) => { messages.push(message); }, progress: (message) => { messages.push(message); },
    github: new Proxy({}, { get() { return () => { throw new Error("Registration must not call GitHub"); }; } }) as NonNullable<ConstructorParameters<typeof MainOrchestrator>[0]["github"]> });
  const tools = new Map<string, Parameters<MainToolAPI["registerTool"]>[0]>();
  registerMainTools({ registerTool(tool) { tools.set(tool.name, tool); } }, main);
  const register = (path: string, slug: string) => tools.get("merro_add_project")!.execute("register", { path, slug });
  const remote = `file://${source.path}`;
  const registered = await register(remote, "app");
  assert.equal((registered.details as { path: string }).path, join(workspace, "owned/projects/app"));
  assert.equal(registered.content[0]!.text, "Registered app.");
  assert.deepEqual(messages, ["Cloning -> ./owned/projects/app"]);
  assert.equal(await readFile(join(workspace, "owned/projects/app/file.txt"), "utf8"), "base\n");
  await register(remote, "app");
  assert.equal(messages.length, 1);
  const local = await register("../repo", "local-app");
  assert.equal((local.details as { path: string }).path, source.path);
  const occupied = join(workspace, "owned/projects/occupied");
  await mkdir(occupied);
  await writeFile(join(occupied, "sentinel"), "preserved");
  await assert.rejects(register(remote, "occupied"), /destination already exists/);
  assert.equal(await readFile(join(occupied, "sentinel"), "utf8"), "preserved");
  assert.deepEqual((await main.listProjects()).map((project) => project.slug), ["app", "local-app"]);
  await symlink(source.path, join(workspace, "linked"));
  const linked = new MainOrchestrator({ workspacePath: workspace, config: validateConfig({ projectsDir: "linked" }) });
  await assert.rejects(linked.addProject(remote, "escape"), /must not be a symlink/);
});

for (const scenario of ["remote-free", "with-remote", "base-moved", "approval-base-moved", "approval-dirty-target", "requirements-restart", "dirty-target", "merge-declined", "branch-switch-during-final-fetch", "branch-switch-during-ref-update", "head-lock-during-final-fetch", "tracked-edit-after-ref-update", "staged-edit-before-sync", "read-tree-fails"] as const) {
test(`tool flow approves, implements, reviews and delivers locally without gh: ${scenario}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-local-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await repository(root);
  const initialBase = await source.git("rev-parse", "HEAD");
  if (scenario === "with-remote") await source.git("remote", "add", "origin", "https://github.invalid/example/app.git");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await initializeWorkspace(workspace, { async run(file, args, options) {
    return file === "git" ? systemCommandRunner.run(file, args, options) : initCommands.run(file, args);
  } });
  const launches: WorkerLaunchInput[] = [];
  let implementationAttempts = 0;
  let switchedDuringFinalFetch = false;
  let switchRejectedDuringRefUpdate = false;
  let headLockCreated = false;
  let editedAfterRefUpdate = false;
  let stagedEditBeforeSync = false;
  const deliveryGit = new GitClient({ async run(file, args, commandOptions) {
    if (scenario === "read-tree-fails" && file === "git" && commandOptions?.cwd === source.path && args[0] === "read-tree") {
      throw new Error("Injected checkout synchronization failure");
    }
    if (scenario === "staged-edit-before-sync" && !stagedEditBeforeSync
      && file === "git" && commandOptions?.cwd === source.path && args[0] === "read-tree") {
      await writeFile(join(source.path, "file.txt"), "concurrent staged edit\n");
      await systemCommandRunner.run("git", ["add", "file.txt"], { cwd: source.path });
      stagedEditBeforeSync = true;
    }
    if (scenario === "branch-switch-during-ref-update" && file === "git" && commandOptions?.cwd === source.path && args.includes("update-ref")) {
      try {
        await systemCommandRunner.run("git", ["switch", "-c", "other"], { cwd: source.path });
      } catch {
        switchRejectedDuringRefUpdate = true;
      }
    }
    const output = await systemCommandRunner.run(file, args, commandOptions);
    if (file === "git" && commandOptions?.cwd === source.path && args[0] === "fetch"
      && args[args.indexOf("--") + 1] === launches[0]?.clonePath) {
      if (scenario === "branch-switch-during-final-fetch" && !switchedDuringFinalFetch) {
        await systemCommandRunner.run("git", ["switch", "-c", "other"], { cwd: source.path });
        switchedDuringFinalFetch = true;
      }
      if (scenario === "head-lock-during-final-fetch" && !headLockCreated) {
        await writeFile(join(source.path, ".git", "HEAD.lock"), "external Git lock\n");
        headLockCreated = true;
      }
    }
    if (scenario === "tracked-edit-after-ref-update" && !editedAfterRefUpdate
      && file === "git" && commandOptions?.cwd === source.path && args.includes("update-ref")) {
      await writeFile(join(source.path, "file.txt"), "concurrent edit\n");
      editedAfterRefUpdate = true;
    }
    return output;
  } });
  const options = {
    ...(["branch-switch-during-final-fetch", "branch-switch-during-ref-update", "head-lock-during-final-fetch", "tracked-edit-after-ref-update", "staged-edit-before-sync", "read-tree-fails"].includes(scenario) ? { git: deliveryGit } : {}),
    workspacePath: workspace, config: scenario === "with-remote" ? validateConfig({ worktreesDir: "scratch/changes", git: { defaultDelivery: "local" }, tmux: { session: "work" } }) : { ...DEFAULT_CONFIG },
    github: new Proxy({}, { get(_target, name) { return () => { throw new Error(`GitHub must not be called: ${String(name)}`); }; } }) as NonNullable<ConstructorParameters<typeof MainOrchestrator>[0]["github"]>,
    workers: {
      async prepareClone() {}, async listOwnedWorkers() { return []; },
      async inspect() { return { alive: false, identityMatches: false, reason: "finished" }; },
      async cleanup() {},
      async launch(input: WorkerLaunchInput, plan: Parameters<NonNullable<ConstructorParameters<typeof MainOrchestrator>[0]["workers"]>["launch"]>[1]) {
        assert.ok(plan);
        assert.equal(plan.tmuxSession, `${scenario === "with-remote" ? "work" : "merro"}-app`);
        launches.push(input);
        if (input.role === "implement") {
          if (input.baseUpdate) await systemCommandRunner.run("git", ["merge", "--no-ff", "--no-commit", input.baseUpdate.baseCommit], { cwd: input.clonePath });
          implementationAttempts++;
          const content = scenario === "requirements-restart" && implementationAttempts > 1 ? "updated\n" : "implemented\n";
          await writeFile(join(input.clonePath, "file.txt"), content);
          await systemCommandRunner.run("git", ["add", "."], { cwd: input.clonePath });
          await systemCommandRunner.run("git", ["commit", "-m", "fix: requested change"], { cwd: input.clonePath });
        }
        const commit = (await systemCommandRunner.run("git", ["rev-parse", "HEAD"], { cwd: input.clonePath })).stdout.trim();
        const result = { task_id: input.taskId, status: input.role === "implement" ? "success" : "pass", summary: "Verified requested change",
          ...(input.role === "implement" ? { commit } : { reviewed_commit: commit, findings: [] }),
          verification: [{ kind: "command", command: "test -f file.txt", project: "app", cwd: ".", exit_code: 0 }] };
        await mkdir(dirname(plan.resultPath), { recursive: true });
        await writeFile(plan.resultPath, JSON.stringify(result));
        return plan;
      },
    },
  };
  let main = new MainOrchestrator(options);
  const tools = new Map<string, Parameters<MainToolAPI["registerTool"]>[0]>();
  registerMainTools({ registerTool(tool) { tools.set(tool.name, tool); } }, main);
  const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.execute(name, args);
  await call("merro_add_project", { path: "../repo", slug: "app" });
  if (scenario !== "with-remote") {
    await assert.rejects(call("merro_propose_objective", { goal: "Unapproved PR", delivery_mode: "pr", change_sets: [{ name: "pr-request", project_slug: "app" }] }), /no supported remote/);
  }
  const plan = await call("merro_propose_objective", { goal: "Make the requested change", change_sets: [{ name: "requested-change", project_slug: "app" }] });
  assert.match(plan.content[0]!.text, /local/i);
  assert.match(plan.content[0]!.text, /0 pull requests/);
  await main.runPass();
  assert.equal(launches.length, 0);
  await call("merro_start_objective");
  main = new MainOrchestrator(options); // Approved delivery survives Main restart.
  if (scenario === "base-moved") {
    await writeFile(join(source.path, "external.txt"), "external change\n");
    await source.git("add", ".");
    await source.git("commit", "-m", "chore: advance local base");
  }
  if (scenario === "dirty-target") await writeFile(join(source.path, "unrelated.txt"), "do not overwrite\n");
  for (let pass = 0; pass < 3; pass++) await main.runPass();
  if (scenario === "dirty-target") {
    assert.equal((await main.statusSnapshot()).changeSets[0]!.state, "Blocked");
    assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "base\n");
    assert.equal(await readFile(join(source.path, "unrelated.txt"), "utf8"), "do not overwrite\n");
    await rm(join(source.path, "unrelated.txt"));
    await main.retryChangeSet("requested-change");
  }
  if (scenario === "base-moved") {
    for (let pass = 0; pass < 3; pass++) await main.runPass();
    assert.equal(await readFile(join(source.path, "external.txt"), "utf8"), "external change\n");
    assert.ok(launches[2]!.baseUpdate);
  }
  assert.deepEqual(launches.map((input) => input.role), scenario === "base-moved" ? ["implement", "review", "implement", "review"] : ["implement", "review"]);
  assert.equal(launches[0]!.clonePath, join(workspace, options.config.worktreesDir, "app", "requested-change"));
  const pendingMerge = await main.statusSnapshot();
  assert.equal(pendingMerge.changeSets[0]!.state, "AwaitingLocalMerge");
  assert.deepEqual(pendingMerge.decisions.map((decision) => decision.kind), ["local_merge"]);
  assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "base\n");
  const publicStatus = await main.publicSnapshot();
  assert.equal(publicStatus.changes[0]!.status, "Needs you");
  assert.equal(publicStatus.changes[0]!.reason, "ready to merge");
  assert.equal(publicStatus.decisions[0]!.summary, "Approve local merge?");
  const formattedStatus = await call("merro_status");
  assert.match(formattedStatus.content[0]?.text ?? "", /Approve local merge: \/merro approve/);
  assert.match(formattedStatus.content[0]?.text ?? "", /Leave unchanged/);
  assert.doesNotMatch(formattedStatus.content[0]?.text ?? "", /Leave open/);
  if (scenario === "merge-declined") {
    await call("merro_resolve_decision", { change: "requested-change", approved: false });
    assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "base\n");
    const declined = await main.publicSnapshot();
    assert.equal(declined.changes[0]!.blocked?.message, "Local merge was declined; no changes were applied.");
    assert.match(declined.changes[0]!.blocked?.next ?? "", /merro retry requested-change/);
    assert.equal((await main.statusSnapshot()).decisions.length, 0);
    return;
  }
  if (scenario === "requirements-restart") {
    await main.restartChange("requested-change", "Add the required follow-up change.");
    for (let pass = 0; pass < 3; pass++) await main.runPass();
    const restarted = await main.statusSnapshot();
    assert.equal(restarted.changeSets[0]!.state, "AwaitingLocalMerge");
    assert.deepEqual(restarted.decisions.map((decision) => decision.kind), ["local_merge"]);
    assert.deepEqual(launches.map((input) => input.role), ["implement", "review", "implement", "review"]);
    assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "base\n");
  }
  if (scenario === "approval-base-moved") {
    await writeFile(join(source.path, "external.txt"), "external change\n");
    await source.git("add", ".");
    await source.git("commit", "-m", "chore: advance local base during approval");
    const staleApproval = await call("merro_resolve_decision", { change: "requested-change", approved: true });
    assert.match(staleApproval.content[0]?.text ?? "", /fresh implementation, verification, review, and approval/);
    for (let pass = 0; pass < 3; pass++) await main.runPass();
    const refreshed = await main.statusSnapshot();
    assert.equal(refreshed.changeSets[0]!.state, "AwaitingLocalMerge");
    assert.deepEqual(refreshed.decisions.map((decision) => decision.kind), ["local_merge"]);
    assert.deepEqual(launches.map((input) => input.role), ["implement", "review", "implement", "review"]);
    assert.ok(launches[2]!.baseUpdate);
    assert.equal(await readFile(join(source.path, "external.txt"), "utf8"), "external change\n");
    assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "base\n");
  }
  if (scenario === "approval-dirty-target") await writeFile(join(source.path, "unrelated.txt"), "preserve this edit\n");
  const approval = await call("merro_resolve_decision", { change: "requested-change", approved: true });
  if (scenario === "approval-dirty-target") {
    const message = approval.content[0]?.text ?? "";
    assert.match(message, /Local merge failed: Local delivery needs clean working copies/);
    assert.match(message, /Check the canonical checkout, then \/merro retry requested-change\./);
    assert.doesNotMatch(message, /Local base changed/);
    assert.equal(await source.git("rev-parse", "refs/heads/main"), initialBase);
    assert.equal(await source.git("rev-parse", "HEAD"), initialBase);
    assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "base\n");
    assert.equal(await readFile(join(source.path, "unrelated.txt"), "utf8"), "preserve this edit\n");
    const blocked = await main.statusSnapshot();
    assert.equal(blocked.changeSets[0]!.state, "Blocked");
    assert.equal(blocked.objectives[0]!.state, "Active");
    assert.equal(blocked.decisions.length, 0);
    return;
  }
  if (scenario === "branch-switch-during-final-fetch") {
    assert.equal(switchedDuringFinalFetch, true);
    assert.doesNotMatch(approval.content[0]?.text ?? "", /Applied locally/);
    assert.equal(await source.git("branch", "--show-current"), "other");
    assert.equal(await source.git("rev-parse", "refs/heads/main"), initialBase);
    assert.equal(await source.git("rev-parse", "refs/heads/other"), initialBase);
    assert.equal(await source.git("rev-parse", "HEAD"), initialBase);
    assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "base\n");
    assert.equal((await main.statusSnapshot()).changeSets[0]!.state, "Blocked");
    assert.equal((await main.statusSnapshot()).decisions.length, 0);
    return;
  }
  if (scenario === "head-lock-during-final-fetch") {
    assert.equal(headLockCreated, true);
    await rm(join(source.path, ".git", "HEAD.lock"), { force: true });
    assert.doesNotMatch(approval.content[0]?.text ?? "", /Applied locally/);
    assert.equal(await source.git("rev-parse", "refs/heads/main"), initialBase);
    assert.equal(await source.git("rev-parse", "HEAD"), initialBase);
    assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "base\n");
    assert.equal((await main.statusSnapshot()).changeSets[0]!.state, "Blocked");
    assert.equal((await main.statusSnapshot()).decisions.length, 0);
    return;
  }
  if (scenario === "tracked-edit-after-ref-update" || scenario === "staged-edit-before-sync" || scenario === "read-tree-fails") {
    if (scenario === "tracked-edit-after-ref-update") {
      assert.equal(editedAfterRefUpdate, true);
      assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "concurrent edit\n");
    } else if (scenario === "staged-edit-before-sync") {
      assert.equal(stagedEditBeforeSync, true);
      assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "concurrent staged edit\n");
      assert.equal(await source.git("status", "--porcelain"), "M  file.txt");
    } else {
      assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "base\n");
    }
    assert.doesNotMatch(approval.content[0]?.text ?? "", /Applied locally/);
    assert.equal(await source.git("branch", "--show-current"), "main");
    assert.equal(await source.git("rev-parse", "refs/heads/main"), await source.git("rev-parse", "HEAD"));
    assert.equal((await main.statusSnapshot()).changeSets[0]!.state, "Blocked");
    assert.equal((await main.statusSnapshot()).objectives[0]!.state, "Active");
    assert.equal((await main.statusSnapshot()).decisions.length, 0);
    return;
  }
  if (scenario === "branch-switch-during-ref-update") assert.equal(switchRejectedDuringRefUpdate, true);
  assert.match(approval.content[0]?.text ?? "", /Applied locally: requested-change · main/);
  assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), scenario === "requirements-restart" ? "updated\n" : "implemented\n");
  assert.equal(await source.git("branch", "--show-current"), "main");
  assert.equal(await source.git("status", "--porcelain"), "");
  const snapshot = await main.statusSnapshot();
  assert.equal(snapshot.changeSets[0]!.state, "Done");
  assert.equal(snapshot.objectives[0]!.state, "Done");
  assert.equal(snapshot.decisions.length, 0);
});
}

for (const [kind, remote] of [
  ["local path", (path: string) => path],
  ["file URL", (path: string) => `file://${path}`],
  ["unsupported host", () => "https://gitlab.com/example/app.git"],
] as const) {
test(`checkout-detected delivery uses local mode for ${kind} remotes`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-local-remote-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await repository(root);
  await source.git("remote", "add", "origin", remote(source.path));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await initializeWorkspace(workspace, { async run(file, args, options) {
    return file === "git" ? systemCommandRunner.run(file, args, options) : initCommands.run(file, args);
  } });
  const githubCalls: string[] = [];
  const github = new Proxy({}, { get(_target, name) {
    return async () => {
      githubCalls.push(String(name));
      throw new Error(`GitHub must not be called for ${kind}: ${String(name)}`);
    };
  } }) as NonNullable<ConstructorParameters<typeof MainOrchestrator>[0]["github"]>;
  const main = new MainOrchestrator({ workspacePath: workspace, config: { ...DEFAULT_CONFIG }, github });
  const tools = new Map<string, Parameters<MainToolAPI["registerTool"]>[0]>();
  registerMainTools({ registerTool(tool) { tools.set(tool.name, tool); } }, main);
  await tools.get("merro_add_project")!.execute("register", { path: "../repo", slug: "app" });
  const proposal = await tools.get("merro_propose_objective")!.execute("plan", {
    goal: "Update the local project", change_sets: [{ name: "local-change", project_slug: "app" }],
  });
  assert.equal((proposal.details as { plans: Array<{ delivery: string }> }).plans[0]!.delivery, "local");
  assert.deepEqual(githubCalls, []);
});
}

test("checkout-detected delivery selects PRs for Projects with supported GitHub remotes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-auto-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await repository(root);
  await source.git("remote", "add", "origin", "git@github.com:example/app.git");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await initializeWorkspace(workspace, { async run(file, args, options) {
    return file === "git" ? systemCommandRunner.run(file, args, options) : initCommands.run(file, args);
  } });
  const repositoryLookups: string[] = [];
  const github = new Proxy({}, { get(_target, name) {
    if (name === "repository") return async (reference: string) => {
      repositoryLookups.push(reference);
      return { defaultBranch: "main" };
    };
    throw new Error(`Unexpected GitHub call: ${String(name)}`);
  } }) as NonNullable<ConstructorParameters<typeof MainOrchestrator>[0]["github"]>;
  const main = new MainOrchestrator({ workspacePath: workspace, config: { ...DEFAULT_CONFIG }, github });
  const tools = new Map<string, Parameters<MainToolAPI["registerTool"]>[0]>();
  registerMainTools({ registerTool(tool) { tools.set(tool.name, tool); } }, main);
  await tools.get("merro_add_project")!.execute("register", { path: "../repo", slug: "app" });
  const proposal = await tools.get("merro_propose_objective")!.execute("plan", {
    goal: "Update the remote-backed project", change_sets: [{ name: "remote-change", project_slug: "app" }],
  });
  assert.equal((proposal.details as { plans: Array<{ delivery: string }> }).plans[0]!.delivery, "pr");
  assert.deepEqual(repositoryLookups, ["git@github.com:example/app.git"]);
});

test("supported GitHub remote failures do not fall back to local delivery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-github-outage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await repository(root);
  await source.git("remote", "add", "origin", "https://github.com/example/app.git");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await initializeWorkspace(workspace, { async run(file, args, options) {
    return file === "git" ? systemCommandRunner.run(file, args, options) : initCommands.run(file, args);
  } });
  let lookups = 0;
  const github = new Proxy({}, { get() {
    return async () => {
      lookups++;
      throw new Error("error connecting to api.github.com");
    };
  } }) as NonNullable<ConstructorParameters<typeof MainOrchestrator>[0]["github"]>;
  const main = new MainOrchestrator({ workspacePath: workspace, config: { ...DEFAULT_CONFIG }, github });
  const tools = new Map<string, Parameters<MainToolAPI["registerTool"]>[0]>();
  registerMainTools({ registerTool(tool) { tools.set(tool.name, tool); } }, main);
  await tools.get("merro_add_project")!.execute("register", { path: "../repo", slug: "app" });
  await assert.rejects(tools.get("merro_propose_objective")!.execute("plan", {
    goal: "Update the remote project", change_sets: [{ name: "remote-change", project_slug: "app" }],
  }), /error connecting to api\.github\.com/);
  assert.equal(lookups, 1);
});
