import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Project } from "../src/domain/model.js";
import { CommandError, type CommandRunner } from "../src/runtime/commands.js";
import { WorkerRuntime } from "../src/runtime/worker-runtime.js";

const project: Project = { slug: "example", path: "/source", baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" };
const workspacePath = await mkdtemp(join(tmpdir(), "merro-inventory-"));
test.after(() => rm(workspacePath, { recursive: true, force: true }));
const owner = "workspace:65af8542-9b1e-4dfa-89a6-c90d2e38bf08";
await writeFile(join(workspacePath, "workspace-owner"), `${owner}\n`);
const container = (digit: string): string => digit.repeat(64);
const dockerMissing = (): CommandError => new CommandError("docker", [], Object.assign(new Error("not installed"), { code: "ENOENT" }), "");

test("owned worker inventory includes live panes, labeled containers, and legacy workspace mounts only", async () => {
  const calls: string[] = [];
  const runtime = new WorkerRuntime({ workspacePath, config: DEFAULT_CONFIG, commands: {
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
            { Source: legacy ? join(workspacePath, "tasks", "d-task") : "/foreign/tasks/d-task", Destination: "/merro-task" },
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
  const runtime = new WorkerRuntime({ workspacePath, config: DEFAULT_CONFIG, commands: {
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

test("planned readable tmux window proves Task identity through its ownership marker", async () => {
  const runtime = new WorkerRuntime({ workspacePath, config: { ...DEFAULT_CONFIG, sandbox: "none" }, commands: {
    async run(file, args) {
      if (file !== "tmux") throw new Error(`unexpected command: ${file}`);
      if (args[0] === "display-message") return { stdout: "%4 123 0 node", stderr: "" };
      if (args[0] === "show-option") return { stdout: args.at(-1) === "@merro_task_id" ? "task-uuid" : "", stderr: "" };
      throw new Error(`unexpected tmux command: ${args.join(" ")}`);
    },
  } });
  const record = runtime.plan({ taskId: "task-uuid", workItemId: "example:issue-188:g1", role: "implement",
    project, clonePath: "/clone", taskFile: "Test", expectedCommit: "a".repeat(40), projectSettings: null });

  assert.equal(record.tmuxWindow, "impl-188");
  assert.deepEqual(await runtime.inspect(record, "task-uuid"), { alive: true, identityMatches: true, reason: null });
});

for (const dead of [false, true]) {
  test(`host process inspection preserves uncertainty and recognizes dead panes (${dead})`, async () => {
    const runtime = new WorkerRuntime({ workspacePath, config: { ...DEFAULT_CONFIG, sandbox: "none" }, commands: {
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
    const runtime = new WorkerRuntime({ workspacePath, config: DEFAULT_CONFIG, commands });
    await assert.rejects(runtime.listOwnedWorkers(project), new RegExp(failure));
  });
}

for (const sandbox of ["none", "docker"] as const) {
  test(`${sandbox} worker inventory handles missing Docker without hiding required scans`, async () => {
    const runtime = new WorkerRuntime({ workspacePath, config: { ...DEFAULT_CONFIG, sandbox }, commands: {
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
    const runtime = new WorkerRuntime({ workspacePath, config: DEFAULT_CONFIG, commands: {
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

for (const hasCidArtifact of [false, true]) {
  test(`legacy path-hash container stays owned after Project moves, cid artifact present: ${hasCidArtifact}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "merro-legacy-owner-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const oldOwner = createHash("sha256").update(project.path).digest("hex");
    const commands: CommandRunner = { async run(file, args) {
      if (file === "tmux") throw new Error("no such session");
      if (args[0] === "ps") return { stdout: container("a"), stderr: "" };
      if (args[0] === "inspect") return { stdout: JSON.stringify([{ Id: container("a"), State: { Running: true },
        Config: { Labels: { "merro.task_id": "legacy", "merro.project": project.slug, "merro.owner": oldOwner } },
        Mounts: [{ Source: join(root, "tasks", "legacy"), Destination: "/merro-task" }],
      }]), stderr: "" };
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    } };
    const runtime = new WorkerRuntime({ workspacePath: root, config: DEFAULT_CONFIG, commands });
    if (hasCidArtifact) {
      await mkdir(join(root, "container-ids"));
      await writeFile(join(root, "container-ids", "legacy.cid"), container("a"));
    }
    assert.equal((await runtime.listOwnedWorkers(project)).length, 1);
    const restarted = new WorkerRuntime({ workspacePath: root, config: DEFAULT_CONFIG, commands });
    const workers = await restarted.listOwnedWorkers({ ...project, path: "/moved-source" });
    assert.equal(workers.length, 1);
    assert.equal(workers[0]?.taskId, "legacy");
    assert.equal(workers[0]?.containerId, container("a"));
    assert.deepEqual(await restarted.listOwnedWorkers({ ...project, slug: "different" }), []);
  });
}

test("path-hash labels without exact workspace Task mounts are not ownership proof", async () => {
  const oldOwner = createHash("sha256").update(project.path).digest("hex");
  const runtime = new WorkerRuntime({ workspacePath, config: DEFAULT_CONFIG, commands: { async run(file, args) {
    if (file === "tmux") throw new Error("no such session");
    if (args[0] === "ps") return { stdout: ["a", "b", "c", "d"].map(container).join("\n"), stderr: "" };
    const id = args[1]!;
    return { stdout: JSON.stringify([{ Id: id, State: { Running: true },
      Config: { Labels: { "merro.task_id": "legacy", "merro.project": project.slug,
        "merro.owner": id === container("d") ? "workspace:607bb118-019e-4151-8e64-0776b47b8016" : oldOwner } },
      Mounts: [{ Source: id === container("a") ? "/foreign/tasks/legacy" : id === container("b")
        ? join(workspacePath, "tasks", "different-task") : join(workspacePath, "tasks", "legacy"),
        Destination: id === container("c") ? "/wrong-mount" : "/merro-task" }],
    }]), stderr: "" };
  } } });
  assert.deepEqual(await runtime.listOwnedWorkers(project), []);
});

test("workspace identity is atomic, persistent, independent of Project paths, and moves with the workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-workspace-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let storedOwner = "";
  const commands: CommandRunner = { async run(file, args) {
    if (file === "docker") return { stdout: "", stderr: "" };
    if (!storedOwner && args[0] === "has-session") throw new Error("no such session");
    if (args[0] === "has-session") return { stdout: "", stderr: "" };
    if (args[0] === "show-option") return { stdout: args.at(-1) === "@merro_project" ? project.slug : storedOwner, stderr: "" };
    if (args[0] === "list-panes") return { stdout: "", stderr: "" };
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  } };
  const path = join(root, "runtime");
  await Promise.all(Array.from({ length: 8 }, () =>
    new WorkerRuntime({ workspacePath: path, config: DEFAULT_CONFIG, commands }).listOwnedWorkers(project)));
  storedOwner = (await readFile(join(path, "workspace-owner"), "utf8")).trim();
  assert.match(storedOwner, /^workspace:[0-9a-f-]{36}$/);
  assert.equal((await stat(join(path, "workspace-owner"))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(path), ["workspace-owner"]);
  const moved = join(root, "moved-runtime");
  await rename(path, moved);
  const restarted = new WorkerRuntime({ workspacePath: moved, config: DEFAULT_CONFIG, commands });
  await restarted.listOwnedWorkers({ ...project, path: "/moved-source" });
  assert.equal((await readFile(join(moved, "workspace-owner"), "utf8")).trim(), storedOwner);
  const other = new WorkerRuntime({ workspacePath: join(root, "other-runtime"), config: DEFAULT_CONFIG, commands });
  await assert.rejects(other.listOwnedWorkers(project), /unowned tmux session/);
  assert.notEqual((await readFile(join(root, "other-runtime", "workspace-owner"), "utf8")).trim(), storedOwner);
});

test("invalid workspace identity fails closed without replacing ownership or inspecting workers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-invalid-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "workspace-owner"), "corrupted\n");
  const runtime = new WorkerRuntime({ workspacePath: root, config: DEFAULT_CONFIG, commands: {
    async run() { assert.fail("must not inspect workers with invalid workspace identity"); },
  } });
  await assert.rejects(runtime.listOwnedWorkers(project), /invalid Merro workspace owner/);
  assert.equal(await readFile(join(root, "workspace-owner"), "utf8"), "corrupted\n");
});

for (const identity of ["matching", "wrong-container", "wrong-task"]) {
  test(`stored container identity recovers legacy workers after workspace relocation: ${identity}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "merro-recorded-owner-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const oldOwner = createHash("sha256").update(project.path).digest("hex");
    const runtime = new WorkerRuntime({ workspacePath: root, config: DEFAULT_CONFIG, commands: { async run(file, args) {
      if (file === "tmux") throw new Error("no such session");
      if (args[0] === "ps") return { stdout: container("a"), stderr: "" };
      return { stdout: JSON.stringify([{ Id: container("a"), State: { Running: true },
        Config: { Labels: { "merro.task_id": "legacy", "merro.project": project.slug, "merro.owner": oldOwner } },
        Mounts: [{ Source: "/old-workspace/tasks/legacy", Destination: "/merro-task" }],
      }]), stderr: "" };
    } } });
    const record = { ...runtime.plan({ taskId: identity === "wrong-task" ? "different" : "legacy", workItemId: "work",
      role: "implement", project, clonePath: "/clone", taskFile: "Test", expectedCommit: "a".repeat(40), projectSettings: null }),
      containerId: container(identity === "wrong-container" ? "b" : "a") };
    const workers = await runtime.listOwnedWorkers({ ...project, path: "/moved-source" }, null, [record]);
    assert.equal(workers.length, identity === "matching" ? 1 : 0);
  });
}

for (const identity of ["matching", "wrong-pane", "wrong-pid", "wrong-start", "no-start", "dead", "no-record", "gone-window", "docker-matching", "docker-no-id", "docker-wrong-id"]) {
  test(`legacy tmux namespace migration requires stored live process identity: ${identity}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "merro-tmux-owner-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let sessionOwner = createHash("sha256").update(project.path).digest("hex");
    let migrations = 0;
    const runtime = new WorkerRuntime({ workspacePath: root, config: { ...DEFAULT_CONFIG, sandbox: "none" }, commands: {
      async run(file, args) {
        if (file === "docker") {
          if (args[0] === "inspect") return { stdout: JSON.stringify([{ Id: container(identity === "docker-wrong-id" ? "b" : "a"),
            State: { Running: true }, Config: { Labels: { "merro.task_id": "legacy" } } }]), stderr: "" };
          return { stdout: args[0] === "exec" ? "pi --print" : "", stderr: "" };
        }
        if (file === "ps") return { stdout: identity === "wrong-start" ? "Thu Jan 1 00:00:01 2026" : "Thu Jan 1 00:00:00 2026", stderr: "" };
        if (args[0] === "has-session") return { stdout: "", stderr: "" };
        if (args[0] === "show-option") {
          const values: Record<string, string> = { "@merro_owner": sessionOwner, "@merro_project": project.slug,
            "@merro_task_id": "legacy", "@merro_work_item_id": "work", "@merro_clone_path": "/clone", "@merro_runtime_kind": "host" };
          return { stdout: values[args.at(-1)!] ?? "", stderr: "" };
        }
        if (args[0] === "display-message") {
          if (args.includes("merro-example:impl-gone")) throw new Error("no such window");
          return { stdout: args.at(-1) === "#{pane_id}" ? (identity === "wrong-pane" ? "%2" : "%1")
            : args.at(-1) === "#{window_name}" ? "impl-legacy"
            : `%1 ${identity === "wrong-pid" ? "999" : "123"} ${identity === "dead" ? "1" : "0"} node`, stderr: "" };
        }
        if (args[0] === "set-option") {
          sessionOwner = args[args.indexOf("@merro_owner") + 1]!;
          assert.equal(args[args.indexOf("MERRO_OWNER") + 1], sessionOwner);
          migrations++;
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "list-panes") return { stdout: "%1 0", stderr: "" };
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    } });
    const record = { ...runtime.plan({ taskId: "legacy", workItemId: "work", role: "implement", project,
      clonePath: "/clone", taskFile: "Test", expectedCommit: "a".repeat(40), projectSettings: null }),
      runtimeKind: identity.startsWith("docker-") ? "docker" as const : "host" as const,
      containerId: identity === "docker-matching" || identity === "docker-wrong-id" ? container("a") : null,
      paneId: "%1", processPid: 123, processStartedAt: identity === "no-start" ? null : "2026-01-01T00:00:00.000Z" };
    const records = identity === "no-record" ? [] : identity === "gone-window"
      ? [{ ...record, tmuxWindow: "impl-gone" }, record] : [record];
    const operation = runtime.listOwnedWorkers({ ...project, path: "/moved-source" }, null, records);
    const valid = identity === "matching" || identity === "gone-window" || identity === "docker-matching";
    if (!valid) await assert.rejects(operation, /unowned tmux session/);
    else {
      assert.equal((await operation)[0]?.taskId, "legacy");
      assert.equal(sessionOwner, (await readFile(join(root, "workspace-owner"), "utf8")).trim());
      assert.equal((await runtime.listOwnedWorkers({ ...project, path: "/moved-source" }))[0]?.taskId, "legacy");
    }
    assert.equal(migrations, valid ? 1 : 0);
  });
}
