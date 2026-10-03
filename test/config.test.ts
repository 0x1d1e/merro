import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";

test("config applies documented defaults", () => {
  assert.deepEqual(validateConfig({}), DEFAULT_CONFIG);
});

test("minimal runtime settings accept paths and per-role overrides without prompt policy", () => {
  const config = validateConfig({ projectsDir: "repos", worktreesDir: "scratch/changes", worker: { model: "openai/model", thinking: "max" }, reviewer: { thinking: "high" }, git: { defaultDelivery: "pr" }, tmux: { session: "lead" } });
  assert.equal(config.projectsDir, "repos");
  assert.equal(config.worktreesDir, "scratch/changes");
  assert.deepEqual(config.worker_models, { implement: "openai/model", review: null });
  assert.deepEqual(config.worker_thinking, { implement: "max", review: "high" });
  assert.deepEqual(config.git, { defaultDelivery: "pr" });
  assert.deepEqual(config.tmux, { session: "lead" });
  for (const input of [
    { projectsDir: "../repos" }, { worktreesDir: "/tmp/work" }, { projectsDir: ".merro/repos" },
    { projectsDir: ".wt/repos" }, { worktreesDir: "projects/work" },
    { implementerPrompt: "instructions" }, { worker: { prompt: "instructions" } },
    { git: { defaultDelivery: "automatic" } }, { tmux: { session: "unsafe.name" } },
  ]) assert.throws(() => validateConfig(input));
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
