import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { systemCommandRunner } from "../src/runtime/commands.js";
import merroWorker, { registerWorkerResultTool, type WorkerResultToolAPI } from "../src/tools/worker-result.js";
import { GitClient } from "../src/vcs/git.js";

async function fixture(t: test.TestContext, role: "implement" | "review") {
  const previous = process.env.MERRO_TASK_ID;
  process.env.MERRO_TASK_ID = "expected-task";
  t.after(() => { if (previous === undefined) delete process.env.MERRO_TASK_ID; else process.env.MERRO_TASK_ID = previous; });
  const directory = await mkdtemp(join(tmpdir(), "merro-worker-result-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await systemCommandRunner.run("git", args, { cwd: directory })).stdout.trim();
  await git("init");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.test");
  await git("commit", "--allow-empty", "-m", "base");
  const base = await git("rev-parse", "HEAD");
  await mkdir(join(directory, ".git", "info"), { recursive: true });
  await writeFile(join(directory, ".git", "info", "exclude"), "/.merro-task.md\n");
  await writeFile(join(directory, ".merro-task.md"), "controlled input");
  await writeFile(join(directory, "implementation.txt"), "done\n");
  await git("add", "implementation.txt");
  await git("commit", "-m", "implementation");
  const head = await git("rev-parse", "HEAD");
  const resultPath = join(directory, "..", `${head}-${role}.json`);
  t.after(() => rm(resultPath, { force: true }));
  let tool!: Parameters<WorkerResultToolAPI["registerTool"]>[0];
  registerWorkerResultTool({ registerTool(definition) { tool = definition; } }, { role, resultPath, checkoutPath: directory });
  const result = { task_id: "expected-task", status: role === "implement" ? "success" : "pass", summary: "done",
    ...(role === "implement" ? { commit: head } : { reviewed_commit: head, findings: [] }),
    verification: [{ kind: "manual", project: "p", summary: "checked" }] };
  return { tool, result, resultPath, directory, base, head };
}

for (const role of ["implement", "review"] as const) {
  test(`${role} rejects bad commits without finalization, then accepts corrected HEAD`, async (t) => {
    const f = await fixture(t, role);
    const key = role === "implement" ? "commit" : "reviewed_commit";
    for (const commit of ["abc", "-HEAD", "f".repeat(40), f.base]) {
      await assert.rejects(f.tool.execute("bad", { ...f.result, [key]: commit }), /git rev-parse HEAD/);
      await assert.rejects(readFile(f.resultPath), { code: "ENOENT" });
    }
    assert.ok(!("task_id" in f.tool.parameters.properties));
    const submitted = await f.tool.execute("corrected", f.result);
    assert.equal(submitted.terminate, true);
    assert.equal(JSON.parse(await readFile(f.resultPath, "utf8"))[key], f.head);
    assert.equal(await new GitClient().validateTaskCommit(f.directory, f.base, f.head), f.head);
    await assert.rejects(f.tool.execute("duplicate", f.result));
  });
}

test("failed implementer can report an unusable checkout without exact-HEAD validation", async (t) => {
  const f = await fixture(t, "implement");
  assert.equal((await f.tool.execute("failed", { ...f.result, status: "failed", commit: "unavailable", reason: "clone lost" })).terminate, true);
});

test("malformed review schema never writes a result", async (t) => {
  const f = await fixture(t, "review");
  await assert.rejects(f.tool.execute("bad", { ...f.result, findings: [{ severity: "blocking", summary: "issue" }] }));
  await assert.rejects(readFile(f.resultPath), { code: "ENOENT" });
});

test("worker extension rejects unvalidated environment result paths", () => {
  const keys = ["MERRO_RUNTIME", "MERRO_TASK_ROLE", "MERRO_RESULT_PATH", "MERRO_TASK_SCRATCH"];
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.MERRO_RUNTIME = "worker";
    process.env.MERRO_TASK_ROLE = "implement";
    process.env.MERRO_TASK_SCRATCH = "/scratch";
    for (const path of ["relative.json", "/main/.merro/state.db", "/scratch/pi-config/result.json"]) {
      process.env.MERRO_RESULT_PATH = path;
      assert.throws(() => merroWorker({ registerTool() { assert.fail("must not register"); } }), /Task scratch/);
    }
    process.env.MERRO_TASK_SCRATCH = join(process.cwd(), "nested");
    process.env.MERRO_RESULT_PATH = join(process.cwd(), "nested", ".merro-result.json");
    assert.throws(() => merroWorker({ registerTool() { assert.fail("must not register"); } }), /outside the checkout/);
    delete process.env.MERRO_TASK_SCRATCH;
    process.env.MERRO_RESULT_PATH = "/scratch/.merro-result.json";
    assert.throws(() => merroWorker({ registerTool() { assert.fail("must not register"); } }), /Task scratch/);
  } finally {
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  }
});
