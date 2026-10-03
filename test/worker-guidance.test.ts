import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workerGuidance from "../src/tools/worker-guidance.js";

test("Worker guidance extension adds staged scoped guidance to Pi's system prompt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "merro-worker-guidance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "worker-guidance.md");
  const guidance = "Workspace, reviewer-role, and Project-specific requirements.";
  await writeFile(path, guidance);

  const previousRuntime = process.env.MERRO_RUNTIME;
  const previousPath = process.env.MERRO_WORKER_GUIDANCE_PATH;
  process.env.MERRO_RUNTIME = "worker";
  process.env.MERRO_WORKER_GUIDANCE_PATH = path;
  try {
    let handler: ((event: { systemPromptOptions: { sections: Record<string, string> } }) => void) | undefined;
    await workerGuidance({
      on(event, callback) {
        assert.equal(event, "before_agent_start");
        handler = callback;
      },
    });
    assert.ok(handler);
    const event = { systemPromptOptions: { sections: {} } };
    handler(event);
    assert.deepEqual(event.systemPromptOptions.sections, { merro_worker_guidance: guidance });
  } finally {
    if (previousRuntime === undefined) delete process.env.MERRO_RUNTIME;
    else process.env.MERRO_RUNTIME = previousRuntime;
    if (previousPath === undefined) delete process.env.MERRO_WORKER_GUIDANCE_PATH;
    else process.env.MERRO_WORKER_GUIDANCE_PATH = previousPath;
  }
});
