import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Project } from "../src/domain/model.js";
import { CommandError, systemCommandRunner, type CommandRunner } from "../src/runtime/commands.js";
import { taskWindowName, WorkerRuntime } from "../src/runtime/worker-runtime.js";

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const execFileAsync = promisify(execFile);

test("Task tmux names use readable ChangeSet references", () => {
  assert.equal(taskWindowName("implement", "plugin-lifecycle-safety"), "impl-plugin-lifecycle-safety");
  assert.equal(taskWindowName("review", "refresh-cli"), "rev-refresh-cli");
  assert.equal(taskWindowName("implement", "legacy-work"), "impl-legacy-work");
});

test("real tmux does not confuse semantic sessions with prefix neighbours", async (t) => {
  try { await execFileAsync("tmux", ["-V"]); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("tmux is not installed"); return; }
    throw error;
  }
  const root = await mkdtemp(join(tmpdir(), "merro-exact-tmux-"));
  const socket = join(root, "tmux.sock");
  const commands: CommandRunner = { async run(file, args, options) {
    if (file === "docker") return { stdout: "", stderr: "" };
    assert.equal(file, "tmux");
    const target = args[args.indexOf("-t") + 1];
    if (args.includes("-t")) assert.ok(target?.startsWith("=") || /^[%$@]\d+$/.test(target ?? ""), `non-exact target ${target}`);
    return systemCommandRunner.run(file, ["-S", socket, "-f", "/dev/null", ...args], options);
  } };
  const tmux = (...args: string[]) => systemCommandRunner.run("tmux", ["-S", socket, "-f", "/dev/null", ...args]);
  t.after(async () => { await tmux("kill-server").catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await tmux("new-session", "-d", "-s", "merro-kinetix-plugins", "-n", "impl-contract-extra", "sleep 60");
  const runtime = new WorkerRuntime({ workspacePath: root, config: { ...DEFAULT_CONFIG, sandbox: "none" }, commands });
  const project: Project = { slug: "kinetix", path: root, baseRemote: "", pushRemote: "", defaultBranch: "main" };
  assert.deepEqual(await runtime.listOwnedWorkers(project), []);
  const owner = (await readFile(join(root, "workspace-owner"), "utf8")).trim();
  await tmux("new-session", "-d", "-s", "merro-kinetix", "-n", "impl-contract", "sleep 60");
  for (const slug of ["kinetix", "kinetix-plugins"]) {
    await tmux("set-option", "-t", `=merro-${slug}:`, "@merro_owner", owner);
    await tmux("set-option", "-t", `=merro-${slug}:`, "@merro_project", slug);
    const workers = await runtime.listOwnedWorkers({ ...project, slug });
    assert.equal(workers.length, 1);
    assert.equal(workers[0]?.tmuxSession, `merro-${slug}`);
  }
  assert.notEqual((await runtime.listOwnedWorkers(project))[0]?.paneId,
    (await runtime.listOwnedWorkers({ ...project, slug: "kinetix-plugins" }))[0]?.paneId);
});

test("Docker worker uses the built Merro image, owns its tmux session, and isolates a read-only review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-worker-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = join(root, "source-project");
  const clonePath = join(root, 'worker: clone,"quoted",it\'s');
  const workspacePath = join(root, 'runtime: workspace,"quoted"');
  const piConfigPath = join(root, "pi-config");
  const dependencyPath = join(workspacePath, "tasks", "review-safety", "dependencies", "dependency: checkout");
  await Promise.all([mkdir(projectPath), mkdir(clonePath), mkdir(piConfigPath), mkdir(dependencyPath, { recursive: true })]);
  await writeFile(join(piConfigPath, "settings.json"), '{"theme":"host-theme"}\n');
  await writeFile(join(piConfigPath, "auth.json"), '{"apiKey":"test-secret"}\n');
  await mkdir(join(piConfigPath, "sessions"));
  await writeFile(join(piConfigPath, "sessions", "private.jsonl"), "host session\n");

  const project: Project = {
    slug: "example",
    path: projectPath,
    baseRemote: "https://github.com/example/project.git",
    pushRemote: "https://github.com/example/project.git",
    defaultBranch: "main",
  };
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let sessionExists = false;
  let containerId = "a".repeat(64);
  let environmentFile = "";
  let workerEnvironment = "";
  let containerArgs: readonly string[] = [];
  const commands: CommandRunner = {
    async run(file, args) {
      calls.push({ file, args: [...args] });
      if (file === "gh") return { stdout: "ghp_test-token\n", stderr: "" };
      if (file === "pi") return { stdout: "0.99.1\n", stderr: "" };
      if (file === "tmux") {
        if (args[0] === "has-session") {
          if (!sessionExists) throw new Error("no such session");
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "show-option") {
          return { stdout: args.at(-1) === "@merro_project" ? "example\n" : await readFile(join(workspacePath, "workspace-owner"), "utf8"), stderr: "" };
        }
        if (args[0] === "new-window" || args[0] === "new-session") {
          sessionExists = true;
          const launchCommand = String(args[args.indexOf("-c") + 2]);
          const output = await execFileAsync("sh", ["-c", `set -- ${launchCommand}; printf '%s\\0' "$@"`]);
          const tokens = output.stdout.split("\0").slice(0, -1);
          const cidIndex = tokens.indexOf("--cidfile");
          const envIndex = tokens.indexOf("--env-file");
          assert.ok(cidIndex >= 0 && envIndex >= 0);
          await writeFile(String(tokens[cidIndex + 1]), `${containerId}\n`);
          environmentFile = String(tokens[envIndex + 1]);
          workerEnvironment = await readFile(environmentFile, "utf8");
          assert.match(workerEnvironment, /GH_TOKEN=ghp_test-token/);
          assert.match(workerEnvironment, /^MERRO_RUNTIME=worker$/m);
          containerArgs = tokens;
          return { stdout: "%1\n", stderr: "" };
        }
        if (args[0] === "display-message") return { stdout: "@1\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }
      if (file === "docker") {
        if (args[0] === "image" && args[1] === "inspect") throw new Error("image not present");
        if (args[0] === "build") {
          const fileIndex = args.indexOf("--file");
          assert.ok(fileIndex >= 0);
          assert.equal(await exists(String(args[fileIndex + 1])), true);
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "inspect") {
          return {
            stdout: JSON.stringify([{
              Id: containerId,
              State: { Running: true, StartedAt: "2026-01-01T00:00:00Z" },
              Config: { Labels: { "merro.task_id": "task-1" } },
            }]),
            stderr: "",
          };
        }
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    },
  };

  const runtime = new WorkerRuntime({
    workspacePath,
    config: {
      ...DEFAULT_CONFIG,
      sandbox: "none",
      worker_github: "on",
      workers: { ...DEFAULT_CONFIG.workers, reviewer: { runtime: "pi", model: "openai/gpt-4o", thinking: "high" } },
    },
    commands,
    piConfigPath,
  });
  const record = await runtime.launch({
    taskId: "task-1",
    changeSetId: "merro-acceptance:issue-1:g1",
    changeSlug: "safety", taskName: "review-safety",
    role: "review",
    project,
    clonePath,
    taskFile: "Review exactly this commit.",
    systemPrompt: "Merro's scoped reviewer guidance. Keep APIs stable.",
    expectedCommit: "b".repeat(40),
    dependencies: [{ projectSlug: "dependency", checkoutPath: dependencyPath, mountPath: "/merro-dependencies/1" }],
    projectSettings: {
      guidance: "",
      image: null,
      setupCommand: null,
      sandbox: "docker",
      network: "on",
      workerGithub: true,
    },
  });

  assert.equal(record.containerId, containerId);
  assert.equal(record.processPid, 1);
  const stagedConfig = join(workspacePath, "tasks", "review-safety", "pi-config");
  assert.equal(await readFile(join(stagedConfig, "settings.json"), "utf8"), '{"theme":"host-theme"}\n');
  assert.equal(await readFile(join(stagedConfig, "auth.json"), "utf8"), '{"apiKey":"test-secret"}\n');
  assert.deepEqual((await readdir(stagedConfig)).sort(), ["auth.json", "settings.json"]);
  assert.equal(await exists(environmentFile), false);
  const extensionRoot = join(workspacePath, "tasks", "review-safety", "merro-runtime");
  assert.equal(await exists(join(extensionRoot, "tools", "worker-result.js")), true);
  assert.equal(await exists(join(extensionRoot, "tools", "worker-guidance.js")), true);
  assert.equal(await exists(join(extensionRoot, "protocol", "result.js")), true);
  assert.equal(await readFile(join(workspacePath, "tasks", "review-safety", "worker-guidance.md"), "utf8"), "Merro's scoped reviewer guidance. Keep APIs stable.");
  assert.match(workerEnvironment, /^MERRO_WORKER_GUIDANCE_PATH=\/merro-task\/worker-guidance\.md$/m);
  assert.ok(containerArgs.includes("/merro-task/merro-runtime/tools/worker-guidance.js"));
  const taskInput = await readFile(join(clonePath, ".merro-task.md"), "utf8");
  assert.equal(taskInput, "Review exactly this commit.");
  assert.ok(!taskInput.includes("Keep APIs stable"));
  assert.equal(await exists(join(extensionRoot, "node_modules", "typebox")), false);
  const mountArgs = containerArgs.flatMap((arg, index) => arg === "--mount" ? [containerArgs[index + 1] ?? ""] : []);
  assert.ok(!containerArgs.includes("--volume"));
  assert.deepEqual(mountArgs, [
    `type=bind,"src=${clonePath.replaceAll('"', '""')}",dst=/work,readonly`,
    `type=bind,"src=${workspacePath.replaceAll('"', '""')}/tasks/review-safety",dst=/merro-task`,
    `type=bind,"src=${dependencyPath.replaceAll('"', '""')}",dst=/merro-dependencies/1,readonly`,
  ]);
  assert.ok(!mountArgs.some((value) => value.includes(projectPath)));
  assert.ok(containerArgs.includes("--read-only"));
  assert.ok(containerArgs.includes("--cap-drop"));
  assert.equal(containerArgs[containerArgs.indexOf("--model") + 1], "openai/gpt-4o");
  assert.equal(containerArgs[containerArgs.indexOf("--thinking") + 1], "high");
  const start = calls.find((call) => call.file === "tmux" && call.args[0] === "new-session");
  assert.ok(start);
  assert.equal(start.args[start.args.indexOf("-n") + 1], "rev-safety");
  assert.ok(containerArgs.includes("merro-worker:pi-0.99.1"));
  const imageBuild = calls.find((call) => call.file === "docker" && call.args[0] === "build");
  assert.ok(imageBuild);
  assert.ok(imageBuild.args.includes("merro-worker:pi-0.99.1"));
  assert.ok(imageBuild.args.includes("PI_VERSION=0.99.1"));
  assert.ok(start.args.includes("@merro_owner"));
  assert.ok(start.args.includes("@merro_task_id"));
  const remainOnExit = start.args.lastIndexOf("remain-on-exit");
  assert.ok(remainOnExit >= 0);
  assert.equal(start.args[remainOnExit + 1], "off");
  const owner = (await readFile(join(workspacePath, "workspace-owner"), "utf8")).trim();
  assert.ok(containerArgs.includes(`merro.owner=${owner}`));
  assert.equal(start.args[start.args.indexOf("MERRO_OWNER") + 1], owner);
  assert.equal(start.args[start.args.indexOf("@merro_owner") + 1], owner);
  assert.ok(containerArgs.includes("merro.work_item_id=merro-acceptance:issue-1:g1"));
  assert.ok(start.args.includes("merro-acceptance:issue-1:g1"));
  assert.ok(calls.some((call) => call.file === "docker" && call.args[0] === "build"));
  assert.equal(await exists(join(workspacePath, "container-ids", "review-safety.cid")), true);

  await runtime.cleanup(record);
  assert.equal(await exists(join(workspacePath, "container-ids", "review-safety.cid")), false);
  assert.equal(await exists(record.resultPath), false);

  const movedPath = join(root, "moved-project");
  await rename(projectPath, movedPath);
  containerId = "b".repeat(64);
  const restarted = new WorkerRuntime({ workspacePath, config: { ...DEFAULT_CONFIG, sandbox: "docker", worker_github: "on" }, commands, piConfigPath });
  const legacyClonePath = join(root, "merro-acceptance:issue-1:g1");
  await mkdir(legacyClonePath);
  const successor = await restarted.launch({ taskId: "task-2", changeSetId: "merro-acceptance:issue-1:g1", changeSlug: "safety", taskName: "implement-safety", role: "implement",
    project: { ...project, path: movedPath }, clonePath: legacyClonePath, taskFile: "Implement after Project adoption.",
    expectedCommit: "b".repeat(40), projectSettings: null });
  assert.equal(successor.containerId, containerId);
  assert.equal(successor.clonePath, legacyClonePath);
  assert.ok(containerArgs.includes(`type=bind,src=${legacyClonePath},dst=/work`));
  assert.ok(containerArgs.includes(`merro.owner=${owner}`));
  assert.equal(calls.filter(call => call.file === "tmux" && call.args[0] === "new-session").length, 1);
  assert.equal(calls.filter(call => call.file === "tmux" && call.args[0] === "new-window").length, 1);
  await restarted.cleanup(successor);
});

test("generic Docker image tracks the host Pi version instead of reusing the stale default tag", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-worker-image-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project: Project = {
    slug: "versioned",
    path: root,
    baseRemote: "origin",
    pushRemote: "origin",
    defaultBranch: "main",
  };
  const inspected: string[] = [];
  const builds: string[][] = [];
  const runs: string[][] = [];
  const commands: CommandRunner = {
    async run(file, args) {
      if (file === "pi") return { stdout: "1.0.0\n", stderr: "" };
      if (file === "docker" && args[0] === "image" && args[1] === "inspect") {
        const image = String(args.at(-1));
        inspected.push(image);
        if (image === "merro-worker:0.1.0") return { stdout: "stale image", stderr: "" };
        throw new Error("image not present");
      }
      if (file === "docker" && args[0] === "build") {
        builds.push([...args]);
        return { stdout: "", stderr: "" };
      }
      if (file === "docker" && args[0] === "run") {
        runs.push([...args]);
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    },
  };
  const runtime = new WorkerRuntime({ workspacePath: join(root, "runtime"), config: DEFAULT_CONFIG, commands });
  await runtime.prepareClone(project, join(root, "clone"), {
    guidance: "", image: null, setupCommand: "npm install", sandbox: "docker", network: "on", workerGithub: false,
  });

  assert.deepEqual(inspected, ["merro-worker:pi-1.0.0"]);
  assert.equal(builds.length, 1);
  assert.ok(builds[0]!.includes("merro-worker:pi-1.0.0"));
  assert.ok(builds[0]!.includes("PI_VERSION=1.0.0"));
  assert.ok(runs[0]!.includes("merro-worker:pi-1.0.0"));
});

test("cleanup preserves mismatched results and active input, removes auth and launch material, and is idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new WorkerRuntime({ workspacePath: root, config: DEFAULT_CONFIG });
  const record = runtime.plan({
    taskId: "old-task", changeSetId: "work", changeSlug: "safety", taskName: "implement-safety", role: "implement",
    project: { slug: "project", path: root, baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" },
    clonePath: join(root, "clone"), taskFile: "old input", expectedCommit: "a".repeat(40), projectSettings: null,
  });
  const scratch = join(root, "tasks", "implement-safety");
  await mkdir(record.clonePath);
  await mkdir(join(scratch, "pi-config"), { recursive: true });
  await mkdir(join(scratch, "merro-runtime"));
  await mkdir(join(root, "launch-secrets"));
  await mkdir(join(root, "container-ids"));
  await writeFile(record.taskFilePath, "active successor input");
  const wrongResult = '{"task_id":"another-task"}';
  await writeFile(record.resultPath, wrongResult);
  await writeFile(join(scratch, "pi-config", "auth.json"), "private auth");
  await writeFile(join(scratch, "merro-runtime", "worker-result.js"), "staged extension");
  await chmod(join(scratch, "pi-config"), 0o500);
  await writeFile(join(root, "launch-secrets", "implement-safety.env"), "GH_TOKEN=secret");
  await writeFile(join(root, "launch-secrets", "implement-safety.sh"), "export GITHUB_TOKEN=secret");
  await writeFile(join(root, "container-ids", "implement-safety.cid"), "container");
  const options = { preserveResult: true, preserveTaskInput: true };
  await runtime.cleanup(record, options);
  await runtime.cleanup(record, options);
  assert.deepEqual(await readdir(scratch), [".merro-result.json"]);
  assert.equal(await readFile(record.resultPath, "utf8"), wrongResult);
  assert.equal(await readFile(record.taskFilePath, "utf8"), "active successor input");
  assert.deepEqual(await readdir(join(root, "launch-secrets")), []);
  assert.deepEqual(await readdir(join(root, "container-ids")), []);
  await runtime.cleanup(record, { preserveResult: true });
  assert.equal(await exists(record.taskFilePath), false);
  await runtime.cleanup(record);
  await runtime.cleanup(record);
  assert.equal(await exists(scratch), false);
});

for (const sandbox of ["docker", "none"] as const) {
  test(`failed ${sandbox} worker startup removes token-bearing launch material`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `merro-worker-secret-${sandbox}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspacePath = join(root, "runtime");
    const projectPath = join(root, "source-project");
    const clonePath = join(root, "worker-clone");
    await Promise.all([mkdir(projectPath), mkdir(clonePath)]);
    const project: Project = {
      slug: `secret-${sandbox}`,
      path: projectPath,
      baseRemote: "https://github.com/example/project.git",
      pushRemote: "https://github.com/example/project.git",
      defaultBranch: "main",
    };
    const commands: CommandRunner = {
      async run(file, args) {
        if (file === "gh") return { stdout: "ghp_launch-secret\n", stderr: "" };
        if (file === "pi") return { stdout: "0.99.1\n", stderr: "" };
        if (file === "docker" && args[0] === "image") throw new Error("image not present");
        if (file === "docker" && args[0] === "build") return { stdout: "", stderr: "" };
        if (file === "tmux") {
          if (args[0] === "has-session") throw new Error("no such session");
          if (args[0] === "new-window" || args[0] === "new-session") throw new Error("tmux startup failed");
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    };
    const runtime = new WorkerRuntime({
      workspacePath,
      config: { ...DEFAULT_CONFIG, sandbox, worker_github: "on" },
      commands,
      piConfigPath: join(root, "missing-pi-config"),
    });

    await assert.rejects(runtime.launch({
      taskId: `failed-${sandbox}`,
      changeSetId: "work-1",
      changeSlug: "safety", taskName: "implement-safety",
      role: "implement",
      project,
      clonePath,
      taskFile: "Implement this issue.",
      expectedCommit: "b".repeat(40),
      projectSettings: {
        guidance: "",
        image: null,
        setupCommand: null,
        sandbox,
        network: "on",
        workerGithub: true,
      },
    }), /tmux startup failed/);

    assert.deepEqual(await readdir(join(workspacePath, "launch-secrets")), []);
  });
}

test("partial host launch rolls back the owned tmux window before removing Task files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-partial-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let windowExists = false;
  let stopped = false;
  const runtime = new WorkerRuntime({ workspacePath: join(root, "runtime"), config: { ...DEFAULT_CONFIG, sandbox: "none", worker_github: "off" }, piConfigPath: join(root, "missing"), commands: {
    async run(file, args) {
      assert.equal(file, "tmux");
      if (args[0] === "has-session") throw new Error("missing session");
      if (args[0] === "new-window" || args[0] === "new-session") { windowExists = true; return { stdout: "%5", stderr: "" }; }
      if (args[0] === "display-message") throw new Error(windowExists ? "process identity lookup failed" : "missing window");
      if (args[0] === "kill-window") { assert.equal(args.at(-1), "%5"); stopped = true; windowExists = false; }
      return { stdout: "", stderr: "" };
    },
  } });
  const input = { taskId: "partial", changeSetId: "work", changeSlug: "safety", taskName: "implement-safety", role: "implement" as const, project: { slug: "partial", path: root, baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" }, clonePath: root, taskFile: "implement", expectedCommit: "a".repeat(40), projectSettings: null };
  await assert.rejects(runtime.launch(input), /process identity lookup failed/);
  assert.equal(stopped, true);
  assert.equal(await exists(runtime.plan(input).resultPath), false);
  assert.equal(await exists(join(root, ".merro-task.md")), false);
});

for (const scenario of ["exited pane", "unrecorded container", "missing cidfile"] as const) {
  test(`Docker launch rollback handles ${scenario} without obscuring the launch error`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "merro-docker-rollback-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspacePath = join(root, "runtime");
    const taskId = "failed-docker";
    const cidPath = join(workspacePath, "container-ids", "implement-safety.cid");
    const original = new Error("Docker launch failed before recording worker identity");
    let containerAlive = scenario === "unrecorded container";
    let stops = 0;
    const runtime = new WorkerRuntime({ workspacePath,
      config: { ...DEFAULT_CONFIG, sandbox: "docker", worker_github: "on" }, piConfigPath: join(root, "missing"), commands: {
        async run(file, args) {
          if (file === "gh") return { stdout: "launch-secret\n", stderr: "" };
          if (file === "pi") return { stdout: "1.0.0\n", stderr: "" };
          if (file === "tmux") {
            if (args[0] === "has-session") throw new Error("missing session");
            if (args[0] === "new-session") {
              if (scenario === "missing cidfile") return { stdout: "%5", stderr: "" };
              if (containerAlive) await writeFile(cidPath, "a".repeat(64));
              throw original;
            }
            if (args[0] === "display-message" && args.at(-1) === "#{window_id}") return { stdout: "@5", stderr: "" };
            if (args[0] === "kill-window" || args[0] === "display-message") {
              const detail = "could not find pane";
              throw new CommandError(file, args, Object.assign(new Error(detail), { code: 1 }), detail);
            }
          }
          if (file === "docker") {
            if (args[0] === "image") return { stdout: "[]", stderr: "" };
            if (args[0] === "inspect") {
              if (!containerAlive) throw new CommandError(file, args, new Error("No such container"), "No such container");
              assert.equal(args[1], "merro-implement-safety");
              return { stdout: JSON.stringify([{ Id: "a".repeat(64), State: { Running: true }, Config: { Labels: { "merro.task_id": taskId } } }]), stderr: "" };
            }
            if (args[0] === "exec") return { stdout: "pi --print", stderr: "" };
            if (args[0] === "stop") { stops++; containerAlive = false; return { stdout: "", stderr: "" }; }
          }
          throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
        },
      },
    });
    const input = { taskId, changeSetId: "merro-acceptance:issue-1:g1", changeSlug: "safety", taskName: "implement-safety", role: "implement" as const,
      project: { slug: "rollback", path: root, baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" },
      clonePath: root, taskFile: "implement", expectedCommit: "a".repeat(40), projectSettings: null };
    await assert.rejects(runtime.launch(input), (error: unknown) => {
      if (scenario === "missing cidfile") assert.match(String(error), /Docker did not start a container \(missing cidfile/);
      else assert.equal(error, original);
      assert.ok(!(error instanceof AggregateError));
      return true;
    });
    assert.equal(containerAlive, false);
    assert.equal(stops, scenario === "unrecorded container" ? 1 : 0);
    assert.equal(await exists(cidPath), false);
    assert.equal(await exists(join(workspacePath, "tasks", "implement-safety")), false);
    assert.equal(await exists(join(root, ".merro-task.md")), false);
    assert.deepEqual(await readdir(join(workspacePath, "launch-secrets")), []);
  });
}

test("Docker launch rollback reports real tmux cleanup failures alongside the original error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-docker-rollback-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = new Error("original launch error");
  const killError = new Error("tmux permission denied");
  const lookupError = new Error("tmux connection lost");
  const runtime = new WorkerRuntime({ workspacePath: join(root, "runtime"),
    config: { ...DEFAULT_CONFIG, sandbox: "docker", worker_github: "off" }, piConfigPath: join(root, "missing"), commands: {
      async run(file, args) {
        if (file === "docker" && args[0] === "image") return { stdout: "[]", stderr: "" };
        if (file === "pi") return { stdout: "1.0.0\n", stderr: "" };
        if (file === "tmux") {
          if (args[0] === "has-session") throw new Error("missing session");
          if (args[0] === "new-session") throw original;
          if (args[0] === "kill-window") throw killError;
          if (args[0] === "display-message") throw lookupError;
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    },
  });
  await assert.rejects(runtime.launch({ taskId: "failed", changeSetId: "work", changeSlug: "safety", taskName: "implement-safety", role: "implement",
    project: { slug: "rollback", path: root, baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" },
    clonePath: root, taskFile: "implement", expectedCommit: "a".repeat(40), projectSettings: null }), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], original);
    const rollback = error.errors[1] as AggregateError;
    assert.deepEqual(rollback.errors, [killError, lookupError]);
    return true;
  });
  assert.deepEqual(await readdir(join(root, "runtime", "launch-secrets")), []);
  // Keep Task artifacts when process cleanup cannot be confirmed.
  assert.equal(await exists(join(root, "runtime", "tasks", "implement-safety")), true);
});

test("host network isolation is rejected before any setup command runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "setup-ran");
  const runtime = new WorkerRuntime({ workspacePath: root, config: { ...DEFAULT_CONFIG, sandbox: "none", network: "off" } });
  const project: Project = { slug: "setup", path: root, baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" };
  await assert.rejects(runtime.prepareClone(project, root, {
    guidance: "", image: null, setupCommand: `touch '${marker}'`, sandbox: "none", network: "off", workerGithub: false,
  }), /requires Docker/);
  assert.equal(await exists(marker), false);
});

test("Docker setup uses structured writable bind mounts and the worker UID and GID", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-setup-user-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clonePath = join(root, "clone: setup space");
  let setupArgs: readonly string[] = [];
  const runtime = new WorkerRuntime({ workspacePath: root, config: DEFAULT_CONFIG, commands: {
    async run(file, args) {
      assert.equal(file, "docker");
      if (args[0] === "run") setupArgs = args;
      return { stdout: "", stderr: "" };
    },
  } });
  await runtime.prepareClone({ slug: "setup", path: root, baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" }, clonePath, {
    guidance: "", image: "test-image", setupCommand: "npm install", sandbox: "docker", network: "on", workerGithub: false,
  });
  const userIndex = setupArgs.indexOf("--user");
  assert.ok(userIndex >= 0);
  assert.equal(setupArgs[userIndex + 1], `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
  assert.ok(!setupArgs.includes("--volume"));
  assert.equal(setupArgs[setupArgs.indexOf("--mount") + 1], `type=bind,src=${clonePath},dst=/work`);
});

test("sandbox none launches Pi with host paths and staged system-prompt context, without Docker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-worker-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = join(root, "source-project");
  const clonePath = join(root, "worker-clone");
  const piConfigPath = join(root, "pi-config");
  const workspacePath = join(root, "runtime");
  await Promise.all([mkdir(projectPath), mkdir(clonePath), mkdir(piConfigPath)]);
  await writeFile(join(piConfigPath, "settings.json"), '{"theme":"host-theme"}\n');
  await writeFile(join(piConfigPath, "auth.json"), '{"apiKey":"test-secret"}\n');
  await mkdir(join(piConfigPath, "sessions"));
  await writeFile(join(piConfigPath, "sessions", "private.jsonl"), "host session\n");

  const project: Project = {
    slug: "sandbox-none",
    path: projectPath,
    baseRemote: "https://github.com/example/project.git",
    pushRemote: "https://github.com/example/project.git",
    defaultBranch: "main",
  };
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let sessionExists = false;
  let workerScript = "";
  let processStart = "Thu Jan 1 00:00:00 2026";
  const commands: CommandRunner = {
    async run(file, args) {
      calls.push({ file, args: [...args] });
      if (file === "tmux") {
        if (args[0] === "has-session") {
          if (!sessionExists) throw new Error("no such session");
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "show-option") {
          return { stdout: args.at(-1) === "@merro_task_id" ? "host-task" : args.at(-1) === "@merro_project" ? "sandbox-none\n" : await readFile(join(workspacePath, "workspace-owner"), "utf8"), stderr: "" };
        }
        if (args[0] === "new-window" || args[0] === "new-session") {
          sessionExists = true;
          const command = String(args[args.indexOf("-c") + 2]);
          workerScript = command.slice(6, -1);
          return { stdout: "%7\n", stderr: "" };
        }
        if (args[0] === "display-message") return { stdout: args.at(-1) === "#{window_id}" ? "@7" : args.at(-1) === "#{pane_pid}" ? "123\n" : "%7\t123\t0\tnode\tmerro-sandbox-none\timpl-safety\t@7\t1\t\t\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }
      if (file === "ps") return { stdout: args.at(-1) === "tpgid=" ? "123" : args[0] === "-eo" ? "123 123 node /usr/bin/node /opt/pi-coding-agent/dist/cli.js" : `${processStart}\n`, stderr: "" };
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    },
  };
  const runtime = new WorkerRuntime({
    workspacePath,
    config: { ...DEFAULT_CONFIG, sandbox: "none", worker_github: "off" },
    commands,
    piConfigPath,
  });
  const record = await runtime.launch({
    taskId: "host-task",
    changeSetId: "work-1",
    changeSlug: "safety", taskName: "implement-safety",
    role: "implement",
    project,
    clonePath,
    taskFile: "Implement this issue.",
    systemPrompt: "Scoped host worker context.",
    expectedCommit: "c".repeat(40),
    projectSettings: {
      guidance: "",
      image: null,
      setupCommand: null,
      sandbox: "none",
      network: "on",
      workerGithub: false,
    },
  });

  assert.equal(record.runtimeKind, "host");
  assert.equal(record.processStartedAt, "2026-01-01T00:00:00.000Z");
  assert.equal((await runtime.inspect(record, "host-task")).identityMatches, true);
  processStart = "Thu Jan 1 00:00:01 2026";
  assert.equal((await runtime.inspect(record, "host-task")).identityMatches, false);
  await assert.rejects(runtime.stop(record, "host-task"), /identity does not match/);
  assert.ok(workerScript);
  const taskRoot = join(workspacePath, "tasks", "implement-safety");
  assert.equal(await exists(join(taskRoot, "pi-config")), false);
  assert.equal(await readFile(join(taskRoot, "worker-guidance.md"), "utf8"), "Scoped host worker context.");
  const script = await readFile(workerScript, "utf8");
  assert.ok(script.includes("export MERRO_RUNTIME='worker'"));
  assert.ok(script.includes(`export HOME='${process.env.HOME}'`));
  assert.ok(!script.includes(`export PI_CODING_AGENT_DIR='${join(taskRoot, "pi-config")}'`));
  assert.ok(script.includes(`'${join(taskRoot, "merro-runtime", "tools", "worker-result.js")}'`));
  assert.ok(script.includes(`'${join(taskRoot, "merro-runtime", "tools", "worker-guidance.js")}'`));
  assert.ok(script.includes(`export MERRO_WORKER_GUIDANCE_PATH='${join(taskRoot, "worker-guidance.md")}'`));
  assert.ok(script.includes(`@${join(clonePath, ".merro-task.md")}`));
  assert.ok(!script.includes("/merro-task/"));
  assert.ok(!script.includes("/work/"));
  const hostStart = calls.find((call) => call.file === "tmux" && (call.args[0] === "new-session" || call.args[0] === "new-window"));
  assert.ok(hostStart);
  const remainOnExit = hostStart.args.lastIndexOf("remain-on-exit");
  assert.ok(remainOnExit >= 0);
  assert.equal(hostStart.args[remainOnExit + 1], "on");

  const binPath = join(root, "bin");
  const fakePi = join(binPath, "pi");
  const capturePath = join(root, "pi-invocation.txt");
  await mkdir(binPath);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: These are literal shell parameter expansions.
  await writeFile(fakePi, "#!/bin/sh\n[ -z \"${GH_TOKEN+x}\" ] && [ -z \"${GITHUB_TOKEN+x}\" ] || exit 91\nprintf '%s\\n' \"$HOME\" \"$PI_CODING_AGENT_DIR\" \"$MERRO_RESULT_PATH\" \"$@\" > \"$MERRO_TEST_CAPTURE\"\n", { mode: 0o700 });
  await writeFile(workerScript, script.replace(/^export PATH=.*$/m, `export PATH='${binPath}:${process.env.PATH ?? ""}'`));
  await execFileAsync("bash", [workerScript], {
    env: {
      ...process.env,
      PATH: `${binPath}:${process.env.PATH ?? ""}`,
      MERRO_TEST_CAPTURE: capturePath,
      GH_TOKEN: "inherited-gh-token",
      GITHUB_TOKEN: "inherited-github-token",
    },
  });
  const invocation = (await readFile(capturePath, "utf8")).trimEnd().split("\n");
  assert.deepEqual(invocation.slice(0, 3), [process.env.HOME, process.env.PI_CODING_AGENT_DIR ?? "", join(taskRoot, ".merro-result.json")]);
  assert.deepEqual(invocation.slice(3), [
    "--no-session", "--tui-mode", "regular", "--approve", "--extension",
    join(taskRoot, "merro-runtime", "tools", "worker-result.js"),
    "--extension", join(taskRoot, "merro-runtime", "tools", "worker-lifecycle.js"),
    "--extension", join(taskRoot, "merro-runtime", "tools", "worker-guidance.js"),
    "--", `@${join(clonePath, ".merro-task.md")}`,
  ]);
  assert.equal(await exists(workerScript), false);
  assert.ok(!calls.some((call) => call.file === "docker"));
});


test("dead host pane preserves exit diagnostics and cleanup removes the retained worker window", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-dead-pane-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspacePath = join(root, "runtime");
  const clonePath = join(root, "clone");
  await mkdir(clonePath);
  let killed = false;
  const runtime = new WorkerRuntime({
    workspacePath,
    config: { ...DEFAULT_CONFIG, sandbox: "none" },
    commands: {
      async run(file, args) {
        assert.equal(file, "tmux");
        if (args[0] === "display-message") {
          if (args.at(-1) === "#{pane_id}\t#{window_id}\t#{pane_dead}") {
            return { stdout: "%7\t@7\t1\n", stderr: "" };
          }
          return { stdout: "%7\t321\t1\tpi\tmerro-example\timpl-safety\t@7\t1\t0\t15\n", stderr: "" };
        }
        if (args[0] === "show-option") return { stdout: "host-task\n", stderr: "" };
        if (args[0] === "capture-pane") return { stdout: "reviewer was still working\nlast visible line\n", stderr: "" };
        if (args[0] === "kill-window") {
          assert.equal(args.at(-1), "@7");
          killed = true;
          return { stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    },
  });
  const record = {
    ...runtime.plan({
      taskId: "host-task",
      changeSetId: "work-1",
      changeSlug: "safety",
      taskName: "implement-safety",
      role: "implement",
      project: { slug: "example", path: root, baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" },
      clonePath,
      taskFile: "Implement this issue.",
      expectedCommit: "c".repeat(40),
      projectSettings: null,
    }),
    paneId: "%7",
    windowId: "@7",
    processPid: 321,
    processStartedAt: "2026-01-01T00:00:00.000Z",
  };
  await mkdir(join(workspacePath, "tasks", "implement-safety"), { recursive: true });

  const presence = await runtime.inspect(record, "host-task");
  assert.equal(presence.alive, false);
  assert.equal(presence.identityMatches, true);
  assert.equal(presence.exitStatus, 0);
  assert.equal(presence.exitSignal, 15);
  assert.match(presence.reason ?? "", /signal 15/);
  const diagnosticPath = presence.diagnosticPath;
  assert.ok(diagnosticPath);
  const diagnostics = await readFile(diagnosticPath, "utf8");
  assert.match(diagnostics, /status=0/);
  assert.match(diagnostics, /signal=15/);
  assert.match(diagnostics, /reviewer was still working/);

  await runtime.cleanup(record);
  assert.equal(killed, true);
  assert.equal(await exists(join(workspacePath, "tasks", "implement-safety")), false);
  assert.equal(await exists(diagnosticPath), true);
});
