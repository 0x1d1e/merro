import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";

test("config applies documented defaults", () => {
  assert.deepEqual(validateConfig({}), DEFAULT_CONFIG);
});

test("config rejects invalid concurrency", () => {
  assert.throws(() => validateConfig({ max_concurrent_tasks: 0 }), /max_concurrent_tasks/);
});
