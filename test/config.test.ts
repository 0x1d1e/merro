import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";

test("config applies documented defaults", () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    version: 1,
    projectsDir: "projects",
    worktreesDir: ".wt",
    workers: {
      implementer: { runtime: "pi", model: null, thinking: null },
      reviewer: { runtime: "pi", model: null, thinking: null },
    },
    issues: { create: "approval" },
    merge: { auto: false, method: "squash", deleteBranch: true },
    git: { defaultDelivery: "auto" },
    tmux: { session: "merro" },
    maxConcurrentTasks: 3,
    maxReviewRounds: 3,
    sandbox: "none",
    network: "on",
    workerGithub: false,
    notifyCommand: null,
  });
  assert.deepEqual(validateConfig({}), DEFAULT_CONFIG);
});

test("minimal runtime settings accept paths and per-role overrides without prompt policy", () => {
  assert.deepEqual(validateConfig({ git: { defaultDelivery: "auto" } }).git, { defaultDelivery: "auto" });
  const config = validateConfig({ projectsDir: "repos", worktreesDir: "scratch/changes", workers: { implementer: { model: "openai/model", thinking: "max" }, reviewer: { thinking: "high" } }, git: { defaultDelivery: "pr" }, tmux: { session: "lead" } });
  assert.equal(config.projectsDir, "repos");
  assert.equal(config.worktreesDir, "scratch/changes");
  assert.deepEqual(config.workers.implementer, { runtime: "pi", model: "openai/model", thinking: "max" });
  assert.deepEqual(config.workers.reviewer, { runtime: "pi", model: null, thinking: "high" });
  assert.deepEqual(config.git, { defaultDelivery: "pr" });
  assert.deepEqual(config.tmux, { session: "lead" });
  for (const input of [
    { projectsDir: "../repos" }, { worktreesDir: "/tmp/work" }, { projectsDir: ".merro/repos" },
    { projectsDir: ".wt/repos" }, { worktreesDir: "projects/work" },
    { implementerPrompt: "instructions" }, { workers: { implementer: { prompt: "instructions" } } },
    { git: { defaultDelivery: "automatic" } }, { tmux: { session: "unsafe.name" } },
  ]) assert.throws(() => validateConfig(input));
});

test("config rejects invalid concurrency", () => {
  assert.throws(() => validateConfig({ maxConcurrentTasks: 0 }), /maxConcurrentTasks/);
});

test("config migrates legacy per-role settings to canonical output", () => {
  assert.deepEqual(validateConfig({
    worker_models: { implement: "anthropic/claude-sonnet-4" },
    worker_thinking: { review: "high" },
  }), {
    ...DEFAULT_CONFIG,
    workers: {
      implementer: { runtime: "pi", model: "anthropic/claude-sonnet-4", thinking: null },
      reviewer: { runtime: "pi", model: null, thinking: "high" },
    },
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
    assert.throws(() => validateConfig({ [role]: {}, workers: {} }), /Cannot combine workers/);
  }
});

test("canonical role settings are independent and null inherits agent defaults", () => {
  assert.deepEqual(validateConfig({ workers: {
    implementer: { runtime: "pi", model: " provider/implement ", thinking: "off" },
    reviewer: { runtime: "claude", model: "claude-sonnet-5", thinking: "high" },
  } }), {
    ...DEFAULT_CONFIG,
    workers: {
      implementer: { runtime: "pi", model: "provider/implement", thinking: "off" },
      reviewer: { runtime: "claude", model: "claude-sonnet-5", thinking: "high" },
    },
  });
  assert.deepEqual(validateConfig({ workers: { implementer: { model: null }, reviewer: { thinking: null } } }), DEFAULT_CONFIG);
  assert.deepEqual(validateConfig({ worker_models: { review: "provider/review" } }), {
    ...DEFAULT_CONFIG,
    workers: { ...DEFAULT_CONFIG.workers, reviewer: { runtime: "pi", model: "provider/review", thinking: null } },
  });
  for (const input of [
    { workers: null }, { workers: { reviewer: [] } }, { workers: { implementer: { model: " " } } },
    { workers: { reviewer: { model: "provider/model\n" } } }, { workers: { reviewer: { thinking: "extreme" } } },
    { workers: { implementer: { model: 3 } } }, { workers: { implementer: { thinking: false } } },
    { workers: { implementer: { runtime: "codex" } } }, { workers: { planner: {} } },
    { workers: { reviewer: { runtime: "claude", thinking: "off" } } },
    { workers: { reviewer: { runtime: "claude", thinking: "minimal" } } },
  ]) assert.throws(() => validateConfig(input));
});

test("legacy worker and reviewer keys migrate to workers", () => {
  assert.deepEqual(validateConfig({ worker: { model: "m", thinking: "off" }, reviewer: { thinking: "max" } }).workers, {
    implementer: { runtime: "pi", model: "m", thinking: "off" },
    reviewer: { runtime: "pi", model: null, thinking: "max" },
  });
});

test("reviewer does not inherit the implementer runtime or model", () => {
  const { workers } = validateConfig({ workers: { implementer: { runtime: "claude", model: "claude-opus-5", thinking: "max" } } });
  assert.deepEqual(workers.reviewer, { runtime: "pi", model: null, thinking: null });
});

test("issue and merge policies validate", () => {
  const config = validateConfig({ issues: { create: "auto" }, merge: { auto: true, method: "rebase", deleteBranch: false } });
  assert.deepEqual(config.issues, { create: "auto" });
  assert.deepEqual(config.merge, { auto: true, method: "rebase", deleteBranch: false });
  for (const input of [
    { issues: { create: "yes" } }, { issues: { other: 1 } }, { merge: { auto: "true" } },
    { merge: { method: "fast-forward" } }, { merge: { deleteBranch: 1 } }, { merge: { extra: true } },
  ]) assert.throws(() => validateConfig(input));
});
