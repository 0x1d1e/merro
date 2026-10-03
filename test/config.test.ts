import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";

test("config applies documented defaults", () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    version: 1,
    projectsDir: "projects",
    worktreesDir: ".wt",
    worker: { model: null, thinking: null },
    reviewer: { model: null, thinking: null },
    git: { defaultDelivery: "local" },
    tmux: { session: "merro" },
    max_concurrent_tasks: 3,
    max_review_rounds: 3,
    sandbox: "none",
    network: "on",
    worker_github: "off",
    notify_command: null,
  });
  assert.deepEqual(validateConfig({}), DEFAULT_CONFIG);
});

test("minimal runtime settings accept paths and per-role overrides without prompt policy", () => {
  const config = validateConfig({ projectsDir: "repos", worktreesDir: "scratch/changes", worker: { model: "openai/model", thinking: "max" }, reviewer: { thinking: "high" }, git: { defaultDelivery: "pr" }, tmux: { session: "lead" } });
  assert.equal(config.projectsDir, "repos");
  assert.equal(config.worktreesDir, "scratch/changes");
  assert.deepEqual(config.worker, { model: "openai/model", thinking: "max" });
  assert.deepEqual(config.reviewer, { model: null, thinking: "high" });
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

test("config migrates legacy per-role settings to canonical output", () => {
  assert.deepEqual(validateConfig({
    worker_models: { implement: "anthropic/claude-sonnet-4" },
    worker_thinking: { review: "high" },
  }), {
    ...DEFAULT_CONFIG,
    worker: { model: "anthropic/claude-sonnet-4", thinking: null },
    reviewer: { model: null, thinking: "high" },
  });
  for (const input of [
    { worker_models: { implement: "   " } },
    { worker_models: { planning: "anthropic/claude-sonnet-4" } },
    { worker_thinking: { review: "extreme" } },
    { worker_models: null }, { worker_thinking: [] },
  ]) assert.throws(() => validateConfig(input));
});

test("config rejects mixing canonical and legacy forms even across roles and fields", () => {
  for (const role of ["worker", "reviewer"]) {
    for (const legacy of ["worker_models", "worker_thinking"]) {
      assert.throws(() => validateConfig({ [role]: {}, [legacy]: {} }), /Cannot combine.*migrate/);
    }
  }
});

test("canonical role settings are independent and null inherits Pi defaults", () => {
  assert.deepEqual(validateConfig({ worker: { model: " provider/implement ", thinking: "off" }, reviewer: { model: "provider/review", thinking: "max" } }), {
    ...DEFAULT_CONFIG,
    worker: { model: "provider/implement", thinking: "off" },
    reviewer: { model: "provider/review", thinking: "max" },
  });
  assert.deepEqual(validateConfig({ worker: { model: null }, reviewer: { thinking: null } }), DEFAULT_CONFIG);
  assert.deepEqual(validateConfig({ worker_models: { review: "provider/review" } }), {
    ...DEFAULT_CONFIG, reviewer: { model: "provider/review", thinking: null },
  });
  assert.deepEqual(validateConfig({ worker_thinking: { implement: "off" } }), {
    ...DEFAULT_CONFIG, worker: { model: null, thinking: "off" },
  });
  for (const input of [
    { worker: null }, { reviewer: [] }, { worker: { model: " " } },
    { reviewer: { model: "provider/model\n" } }, { reviewer: { thinking: "extreme" } },
    { worker: { model: 3 } }, { worker: { thinking: false } },
  ]) assert.throws(() => validateConfig(input));
});
