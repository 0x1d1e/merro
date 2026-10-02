import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lifecycle from "../src/tools/worker-lifecycle.js";
import { publishWorkerState, type WorkerState } from "../src/protocol/worker-state.js";

test("worker lifecycle derives busy, progress, idle and finished from Pi events without regression", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "merro-events-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const previous = { runtime: process.env.MERRO_RUNTIME, result: process.env.MERRO_RESULT_PATH };
  process.env.MERRO_RUNTIME = "worker";
  process.env.MERRO_RESULT_PATH = join(cwd, ".merro-result.json");
  t.after(() => {
    if (previous.runtime === undefined) delete process.env.MERRO_RUNTIME; else process.env.MERRO_RUNTIME = previous.runtime;
    if (previous.result === undefined) delete process.env.MERRO_RESULT_PATH; else process.env.MERRO_RESULT_PATH = previous.result;
  });
  const events = new Map<string, Parameters<Parameters<typeof lifecycle>[0]["on"]>[1]>();
  lifecycle({ on(name, handler) { events.set(name, handler); } });
  let idle = false;
  let shutdowns = 0;
  const warnings: string[] = [];
  const ctx = { isIdle: () => idle, shutdown: () => { shutdowns++; }, ui: { notify: (message: string) => { warnings.push(message); } } };
  const path = join(cwd, "worker-state.json");
  const state = async () => JSON.parse(await readFile(path, "utf8")) as WorkerState;
  // The initial CLI @file task is interactive. Only subsequent input is blocked.
  assert.equal(await events.get("input")!({ source: "interactive" }, ctx), undefined);
  assert.deepEqual(await events.get("input")!({ source: "interactive" }, ctx), { action: "handled" });
  assert.match(warnings[0]!, /Stop the attempt in Main/);
  assert.throws(() => events.get("user_bash")!({}, ctx), /intervention is disabled/);
  await events.get("agent_start")!({}, ctx);
  assert.equal((await state()).state, "busy");
  await events.get("turn_end")!({ toolResults: [{ toolName: "edit" }, { toolName: "bash" }] }, ctx);
  assert.equal((await state()).lastActivity, "Using edit, bash");
  await events.get("agent_settled")!({}, ctx);
  assert.equal((await state()).state, "busy");
  idle = true;
  await events.get("agent_settled")!({}, ctx);
  assert.equal((await state()).state, "idle");
  // submit_result publishes finished before Pi settles.
  await publishWorkerState(path, "finished", "Implementation submitted");
  await events.get("agent_settled")!({}, ctx);
  assert.equal(shutdowns, 1);
  await events.get("turn_end")!({}, ctx);
  assert.equal((await state()).state, "finished");
  assert.equal((await state()).lastActivity, "Implementation submitted");
});
