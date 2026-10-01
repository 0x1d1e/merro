import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Project } from "../src/domain/model.js";
import { CommandError, type CommandRunner } from "../src/runtime/commands.js";
import { WorkerRuntime } from "../src/runtime/worker-runtime.js";

const project: Project = { slug: "example", path: "/source", baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" };
const owner = createHash("sha256").update(project.path).digest("hex");
const container = (digit: string): string => digit.repeat(64);
const dockerMissing = (): CommandError => new CommandError("docker", [], Object.assign(new Error("not installed"), { code: "ENOENT" }), "");

test("owned worker inventory includes live panes, labeled containers, and legacy workspace mounts only", async () => {
  const calls: string[] = [];
  const runtime = new WorkerRuntime({ workspacePath: "/runtime", config: DEFAULT_CONFIG, commands: {
    async run(file, args) {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "tmux") {
        if (args[0] === "has-session") return { stdout: "", stderr: "" };
        if (args[0] === "list-panes") return { stdout: "%1 0\n%2 1\n%3 0\n", stderr: "" };
        if (args[0] === "display-message") return { stdout: "impl-pane-task\n", stderr: "" };
        if (args[0] === "show-option") {
          const key = args.at(-1)!;
          const values: Record<string, string> = {
            "@merro_owner": owner, "@merro_project": project.slug,
            "@merro_task_id": "pane-task", "@merro_work_item_id": "work-1",
            "@merro_clone_path": "/clone with\na newline", "@merro_runtime_kind": "host",
          };
          return { stdout: `${args.includes("%3") ? "" : values[key] ?? ""}\n`, stderr: "" };
        }
      }
      if (file === "docker") {
        if (args[0] === "ps") return { stdout: ["a", "b", "c", "d", "e", "f"].map(container).join("\n"), stderr: "" };
        if (args[0] === "inspect") {
          const id = args[1]!;
          const labels: Record<string, string> = { "merro.task_id": `${id[0]}-task` };
          if (id === container("a")) Object.assign(labels, { "merro.owner": owner, "merro.project": project.slug, "merro.work_item_id": "work-2", "merro.clone_path": "/container-clone" });
          if (id === container("b")) Object.assign(labels, { "merro.owner": "foreign", "merro.project": project.slug });
          if (id === container("c")) Object.assign(labels, { "merro.owner": owner, "merro.project": "different" });
          const legacy = id === container("d");
          return { stdout: JSON.stringify([{ Id: id, State: { Running: id !== container("f") }, Config: { Labels: labels }, Mounts: [
            { Source: legacy ? "/runtime/tasks/d-task" : "/foreign/tasks/d-task", Destination: "/merro-task" },
            { Source: "/legacy-clone", Destination: "/work" },
          ] }]), stderr: "" };
        }
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    },
  } });
  const workers = await runtime.listOwnedWorkers(project);
  assert.deepEqual(workers.map((worker) => worker.taskId), ["pane-task", null, "a-task", "d-task"]);
  assert.equal(workers[0]?.clonePath, "/clone with\na newline");
  assert.equal(workers[2]?.workItemId, "work-2");
  assert.equal(workers[3]?.clonePath, "/legacy-clone");
  assert.ok(calls.every((call) => !/kill|stop|set-option|new-window|new-session/.test(call)));
});

test("unowned tmux sessions are not adopted or inspected", async () => {
  const calls: string[] = [];
  const runtime = new WorkerRuntime({ workspacePath: "/runtime", config: DEFAULT_CONFIG, commands: {
    async run(file, args) {
      calls.push(`${file} ${args[0]}`);
      return { stdout: "", stderr: "" };
    },
  } });
  await assert.rejects(runtime.listOwnedWorkers(project), /refusing to adopt unowned/);
  assert.deepEqual(calls, ["tmux has-session", "tmux show-option", "tmux show-option"]);
});

test("refusing an unowned session never stops its existing workers during launch rollback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-unowned-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const runtime = new WorkerRuntime({ workspacePath: join(root, "runtime"), piConfigPath: join(root, "missing"),
    config: { ...DEFAULT_CONFIG, sandbox: "none", worker_github: "off", pi_config: "clean" }, commands: {
      async run(file, args) { calls.push(`${file} ${args[0]}`); return { stdout: "", stderr: "" }; },
    } });
  await assert.rejects(runtime.launch({ taskId: "unowned", workItemId: "work", role: "implement", project,
    clonePath: root, taskFile: "Test", expectedCommit: "a".repeat(40), projectSettings: null }), /unowned tmux session/);
  assert.ok(calls.every((call) => /^tmux (?:has-session|show-option)$/.test(call)));
});

for (const dead of [false, true]) {
  test(`host process inspection preserves uncertainty and recognizes dead panes (${dead})`, async () => {
    const runtime = new WorkerRuntime({ workspacePath: "/runtime", config: { ...DEFAULT_CONFIG, sandbox: "none" }, commands: {
      async run(file) {
        if (file === "tmux") return { stdout: `%1 123 ${dead ? "1" : "0"} node`, stderr: "" };
        throw new Error("ps unavailable");
      },
    } });
    const record = { ...runtime.plan({ taskId: "host", workItemId: "work", role: "implement", project,
      clonePath: "/clone", taskFile: "Test", expectedCommit: "a".repeat(40), projectSettings: null }),
      paneId: "%1", processPid: 123, processStartedAt: "2026-01-01T00:00:00.000Z" };
    if (dead) assert.equal((await runtime.inspect(record, "host")).alive, false);
    else await assert.rejects(runtime.inspect(record, "host"), /ps unavailable/);
  });
}

for (const failure of ["permission denied", "cannot read pane inventory"]) {
  test(`worker inventory does not hide ${failure}`, async () => {
    const commands: CommandRunner = { async run(_file, args) {
      if (failure === "permission denied" || args[0] === "list-panes") throw new Error(failure);
      return { stdout: args.at(-1) === "@merro_project" ? project.slug : owner, stderr: "" };
    } };
    const runtime = new WorkerRuntime({ workspacePath: "/runtime", config: DEFAULT_CONFIG, commands });
    await assert.rejects(runtime.listOwnedWorkers(project), new RegExp(failure));
  });
}

for (const sandbox of ["none", "docker"] as const) {
  test(`${sandbox} worker inventory handles missing Docker without hiding required scans`, async () => {
    const runtime = new WorkerRuntime({ workspacePath: "/runtime", config: { ...DEFAULT_CONFIG, sandbox }, commands: {
      async run(file) {
        if (file === "tmux") throw new Error("no such session");
        throw dockerMissing();
      },
    } });
    if (sandbox === "none") assert.deepEqual(await runtime.listOwnedWorkers(project), []);
    else await assert.rejects(runtime.listOwnedWorkers(project), /not installed/);
  });
}

test("prior Docker artifacts require a scan even after switching to host workers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-owned-workers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "container-ids"));
  await writeFile(join(root, "container-ids", "lost-task.cid"), container("a"));
  const runtime = new WorkerRuntime({ workspacePath: root, config: { ...DEFAULT_CONFIG, sandbox: "none" }, commands: {
    async run(file) { if (file === "tmux") throw new Error("no such session"); throw dockerMissing(); },
  } });
  await assert.rejects(runtime.listOwnedWorkers(project), /not installed/);
});

for (const stillAlive of [false, true]) {
  test(`container exiting during inventory is distinguished from a failed live inspection (${stillAlive})`, async () => {
    let enumerated = false;
    const runtime = new WorkerRuntime({ workspacePath: "/runtime", config: DEFAULT_CONFIG, commands: {
      async run(file, args) {
        if (file === "tmux") throw new Error("no such session");
        if (args[0] === "inspect") throw new Error("inspect failed");
        const present = !enumerated || stillAlive;
        enumerated = true;
        return { stdout: present ? container("a") : "", stderr: "" };
      },
    } });
    if (stillAlive) await assert.rejects(runtime.listOwnedWorkers(project), /inspect failed/);
    else assert.deepEqual(await runtime.listOwnedWorkers(project), []);
  });
}
