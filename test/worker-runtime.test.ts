import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Project } from "../src/domain/model.js";
import { WorkerRuntime } from "../src/runtime/worker-runtime.js";
import type { CommandRunner } from "../src/runtime/commands.js";

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const execFileAsync = promisify(execFile);

test("Docker worker uses the built Merro image, owns its tmux session, and isolates a read-only review", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-worker-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = join(root, "source-project");
  const clonePath = join(root, "worker-clone");
  const piConfigPath = join(root, "pi-config");
  const dependencyPath = join(root, "runtime", ".merro", "tasks", "task-1", "dependencies", "1");
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
        if (args[0] === "new-session") {
          sessionExists = true;
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "show-option") {
          return { stdout: args.at(-1) === "@merro_project" ? "example\n" : `${createHash("sha256").update(projectPath).digest("hex")}\n`, stderr: "" };
        }
        if (args[0] === "new-window") {
          const launchCommand = String(args.at(-1));
          const tokens = [...launchCommand.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? "");
          const cidIndex = tokens.indexOf("--cidfile");
          const envIndex = tokens.indexOf("--env-file");
          assert.ok(cidIndex >= 0 && envIndex >= 0);
          await writeFile(String(tokens[cidIndex + 1]), `${containerId}\n`);
          environmentFile = String(tokens[envIndex + 1]);
          assert.match(await readFile(environmentFile, "utf8"), /GH_TOKEN=ghp_test-token/);
          containerArgs = tokens;
          return { stdout: "%1\n", stderr: "" };
        }
        if (args[0] === "display-message") return { stdout: "123 123 1700000000\n", stderr: "" };
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
    workspacePath: join(root, "runtime"),
    config: { ...DEFAULT_CONFIG, sandbox: "none", pi_config: "copy" },
    commands,
    piConfigPath,
  });
  const record = await runtime.launch({
    taskId: "task-1",
    workItemId: "work-1",
    role: "review",
    project,
    clonePath,
    taskFile: "Review exactly this commit.",
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
  const stagedConfig = join(root, "runtime", ".merro", "tasks", "task-1", "pi-config");
  assert.equal(await readFile(join(stagedConfig, "settings.json"), "utf8"), '{"theme":"host-theme"}\n');
  assert.equal(await readFile(join(stagedConfig, "auth.json"), "utf8"), '{"apiKey":"test-secret"}\n');
  assert.deepEqual((await readdir(stagedConfig)).sort(), ["auth.json", "settings.json"]);
  assert.equal(await exists(environmentFile), false);
  const volumeArgs = containerArgs.flatMap((arg, index) => arg === "--volume" ? [containerArgs[index + 1] ?? ""] : []);
  assert.ok(volumeArgs.includes(`${clonePath}:/work:ro`));
  assert.ok(volumeArgs.includes(`${dependencyPath}:/merro-dependencies/1:ro`));
  assert.ok(volumeArgs.some((value) => value.includes("/merro-task")));
  assert.ok(!volumeArgs.some((value) => value.startsWith(`${projectPath}:`)));
  assert.ok(containerArgs.includes("--read-only"));
  assert.ok(containerArgs.includes("--cap-drop"));
  assert.ok(calls.some((call) => call.file === "tmux" && call.args[0] === "set-option" && call.args.includes("@merro_owner")));
  assert.ok(calls.some((call) => call.file === "docker" && call.args[0] === "build"));
  assert.equal(await exists(join(root, "runtime", ".merro", "container-ids", "task-1.cid")), true);

  await runtime.cleanup(record);
  assert.equal(await exists(join(root, "runtime", ".merro", "container-ids", "task-1.cid")), false);
  assert.equal(await exists(record.resultPath), false);
});

test("sandbox none launches Pi with host paths and no Docker dependency", async (t) => {
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
  const owner = createHash("sha256").update(projectPath).digest("hex");
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let sessionExists = false;
  let workerScript = "";
  const commands: CommandRunner = {
    async run(file, args) {
      calls.push({ file, args: [...args] });
      if (file === "tmux") {
        if (args[0] === "has-session") {
          if (!sessionExists) throw new Error("no such session");
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "new-session") {
          sessionExists = true;
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "show-option") {
          return { stdout: args.at(-1) === "@merro_project" ? "sandbox-none\n" : `${owner}\n`, stderr: "" };
        }
        if (args[0] === "new-window") {
          const command = String(args.at(-1));
          workerScript = command.slice(1, -1);
          return { stdout: "%7\n", stderr: "" };
        }
        if (args[0] === "display-message") return { stdout: "123 456 1700000000\n", stderr: "" };
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    },
  };
  const runtime = new WorkerRuntime({
    workspacePath,
    config: { ...DEFAULT_CONFIG, sandbox: "none", worker_github: "off", pi_config: "clean" },
    commands,
    piConfigPath,
  });
  const record = await runtime.launch({
    taskId: "host-task",
    workItemId: "work-1",
    role: "implement",
    project,
    clonePath,
    taskFile: "Implement this issue.",
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
  assert.ok(workerScript);
  const taskRoot = join(workspacePath, ".merro", "tasks", "host-task");
  const stagedConfig = join(taskRoot, "pi-config");
  assert.deepEqual(await readdir(stagedConfig), ["auth.json"]);
  assert.equal(await readFile(join(stagedConfig, "auth.json"), "utf8"), '{"apiKey":"test-secret"}\n');
  assert.equal(await exists(join(stagedConfig, "settings.json")), false);
  assert.equal(await exists(join(stagedConfig, "sessions")), false);
  const script = await readFile(workerScript, "utf8");
  assert.ok(script.includes(`export HOME='${join(taskRoot, "home")}'`));
  assert.ok(script.includes(`export PI_CODING_AGENT_DIR='${join(taskRoot, "pi-config")}'`));
  assert.ok(script.includes(`'${join(taskRoot, "merro-runtime", "tools", "worker-result.js")}'`));
  assert.ok(script.includes(`@${join(clonePath, ".merro-task.md")}`));
  assert.ok(!script.includes("/merro-task/"));
  assert.ok(!script.includes("/work/"));

  const binPath = join(root, "bin");
  const fakePi = join(binPath, "pi");
  const capturePath = join(root, "pi-invocation.txt");
  await mkdir(binPath);
  await writeFile(fakePi, "#!/bin/sh\nprintf '%s\\n' \"$HOME\" \"$PI_CODING_AGENT_DIR\" \"$MERRO_RESULT_PATH\" \"$@\" > \"$MERRO_TEST_CAPTURE\"\n", { mode: 0o700 });
  await execFileAsync("bash", [workerScript], {
    env: {
      ...process.env,
      PATH: `${binPath}:${process.env.PATH ?? ""}`,
      MERRO_TEST_CAPTURE: capturePath,
    },
  });
  const invocation = (await readFile(capturePath, "utf8")).trimEnd().split("\n");
  assert.deepEqual(invocation.slice(0, 3), [join(taskRoot, "home"), join(taskRoot, "pi-config"), join(taskRoot, ".merro-result.json")]);
  assert.deepEqual(invocation.slice(3), [
    "--no-session", "--print", "--extension",
    join(taskRoot, "merro-runtime", "tools", "worker-result.js"),
    "--", `@${join(clonePath, ".merro-task.md")}`,
  ]);
  assert.ok(!calls.some((call) => call.file === "docker"));
});
