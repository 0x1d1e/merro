import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";

test("config applies documented defaults", () => {
  assert.deepEqual(validateConfig({}), DEFAULT_CONFIG);
});

test("config rejects invalid concurrency", () => {
  assert.throws(() => validateConfig({ max_concurrent_tasks: 0 }), /max_concurrent_tasks/);
});

test("config validates per-role Worker model and thinking settings", () => {
  assert.deepEqual(validateConfig({
    worker_models: { implement: "anthropic/claude-sonnet-4" },
    worker_thinking: { review: "high" },
  }), {
    ...DEFAULT_CONFIG,
    worker_models: { implement: "anthropic/claude-sonnet-4", review: null },
    worker_thinking: { implement: null, review: "high" },
  });
  for (const input of [
    { worker_models: { implement: "   " } },
    { worker_models: { planning: "anthropic/claude-sonnet-4" } },
    { worker_thinking: { review: "extreme" } },
  ]) assert.throws(() => validateConfig(input));
});
