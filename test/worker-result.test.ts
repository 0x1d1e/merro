import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerWorkerResultTool, type WorkerResultToolAPI } from "../src/tools/worker-result.js";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "merro-worker-result-"));
}

test("worker result tool rejects mismatched Task identity and writes valid results atomically", async (t) => {
  const previousTaskId = process.env.MERRO_TASK_ID;
  process.env.MERRO_TASK_ID = "expected-task";
  t.after(() => {
    if (previousTaskId === undefined) delete process.env.MERRO_TASK_ID;
    else process.env.MERRO_TASK_ID = previousTaskId;
  });
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resultPath = join(directory, ".merro-result.json");
  let tool: Parameters<WorkerResultToolAPI["registerTool"]>[0] | undefined;
  const api = {
    registerTool(definition: Parameters<WorkerResultToolAPI["registerTool"]>[0]) {
      tool = definition;
    },
  };
  registerWorkerResultTool(api, { role: "implement", resultPath });
  assert.ok(tool);

  const result = {
    task_id: "expected-task",
    status: "success",
    summary: "done",
    commit: "abc",
    verification: [{ kind: "command", project: "p", cwd: ".", command: "npm test", exit_code: 0 }],
  };
  await assert.rejects(tool.execute("stale", { ...result, task_id: "stale-task" }), /task_id mismatch/);
  await assert.rejects(readFile(resultPath, "utf8"), { code: "ENOENT" });

  const submitted = await tool.execute("call", result);
  assert.equal(submitted.terminate, true);
  assert.equal(JSON.parse(await readFile(resultPath, "utf8")).task_id, "expected-task");
  await assert.rejects(tool.execute("call-again", result));
});

test("worker result tool refuses malformed role results without creating a result file", async (t) => {
  process.env.MERRO_TASK_ID = "task";
  t.after(() => { delete process.env.MERRO_TASK_ID; });
  const directory = await temporaryDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resultPath = join(directory, ".merro-result.json");
  let tool: Parameters<WorkerResultToolAPI["registerTool"]>[0] | undefined;
  registerWorkerResultTool({
    registerTool(definition) { tool = definition; },
  }, { role: "review", resultPath });
  assert.ok(tool);
  await assert.rejects(tool.execute("call", {
    task_id: "task",
    status: "pass",
    summary: "looks good",
    reviewed_commit: "abc",
    findings: [{ severity: "blocking", summary: "issue" }],
    verification: [],
  }));
  await assert.rejects(readFile(resultPath, "utf8"), { code: "ENOENT" });
});
