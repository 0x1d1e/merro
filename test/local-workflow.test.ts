import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";
import { initializeWorkspace } from "../src/runtime/workspace.js";
import { systemCommandRunner } from "../src/runtime/commands.js";
import { MainOrchestrator } from "../src/runtime/main.js";
import { registerMainTools, type MainToolAPI } from "../src/tools/main.js";
import type { WorkerLaunchInput } from "../src/runtime/worker-runtime.js";

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
  const main = new MainOrchestrator({ workspacePath: workspace, config, notify: (message) => { messages.push(message); },
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

for (const scenario of ["remote-free", "with-remote", "base-moved", "dirty-target"] as const) {
test(`tool flow approves, implements, reviews and delivers locally without gh: ${scenario}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-local-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await repository(root);
  if (scenario === "with-remote") await source.git("remote", "add", "origin", "https://github.invalid/example/app.git");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await initializeWorkspace(workspace, { async run(file, args, options) {
    return file === "git" ? systemCommandRunner.run(file, args, options) : initCommands.run(file, args);
  } });
  const launches: WorkerLaunchInput[] = [];
  const options = {
    workspacePath: workspace, config: scenario === "with-remote" ? validateConfig({ worktreesDir: "scratch/changes", tmux: { session: "work" } }) : { ...DEFAULT_CONFIG },
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
          await writeFile(join(input.clonePath, "file.txt"), "implemented\n");
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
  await assert.rejects(call("merro_propose_objective", { goal: "Unapproved PR", delivery_mode: "pr", change_sets: [{ name: "pr-request", project_slug: "app" }] }), scenario === "with-remote" ? /GitHub must not be called/ : /no remote/);
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
  assert.equal(await readFile(join(source.path, "file.txt"), "utf8"), "implemented\n");
  assert.equal(await source.git("branch", "--show-current"), "main");
  assert.equal(await source.git("status", "--porcelain"), "");
  const snapshot = await main.statusSnapshot();
  assert.equal(snapshot.changeSets[0]!.state, "Done");
  assert.equal(snapshot.objectives[0]!.state, "Done");
  assert.equal(snapshot.decisions.length, 0);
});
}
