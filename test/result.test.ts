import test from "node:test";
import assert from "node:assert/strict";
import { assertResultMatchesTask, parseImplementResult, parseReviewResult } from "../src/protocol/result.js";

test("implement result requires commit and structured verification", () => {
  const result = parseImplementResult({
    task_id: "t1",
    status: "success",
    summary: "implemented",
    commit: "abc",
    verification: [{ kind: "command", project: "p", cwd: ".", command: "npm test", exit_code: 0 }],
  });
  assert.equal(result.status, "success");
  assert.doesNotThrow(() => assertResultMatchesTask({ expectedTaskId: "t1", expectedCommit: "abc", result }));
});

test("successful implement result rejects failing command verification", () => {
  assert.throws(() => parseImplementResult({
    task_id: "t1",
    status: "success",
    summary: "implemented",
    commit: "abc",
    verification: [{ kind: "command", project: "p", cwd: ".", command: "npm test", exit_code: 1 }],
  }), /failing verification/);
});

test("review pass cannot contain blocking findings", () => {
  assert.throws(() => parseReviewResult({
    task_id: "t2",
    status: "pass",
    summary: "looks good",
    reviewed_commit: "abc",
    findings: [{ severity: "blocking", summary: "bug" }],
    verification: [],
  }), /blocking finding/);
});

test("review pass rejects failing command verification", () => {
  assert.throws(() => parseReviewResult({
    task_id: "t2",
    status: "pass",
    summary: "looks good",
    reviewed_commit: "abc",
    findings: [],
    verification: [{ kind: "command", project: "p", cwd: ".", command: "npm test", exit_code: 2 }],
  }), /failing verification/);
});

test("review reject requires a blocking finding", () => {
  assert.throws(() => parseReviewResult({
    task_id: "t2",
    status: "reject",
    summary: "needs changes",
    reviewed_commit: "abc",
    findings: [{ severity: "note", summary: "minor" }],
    verification: [],
  }), /requires at least one blocking/);
});

test("failed review requires reviewed_commit and validates it", () => {
  assert.throws(() => parseReviewResult({
    task_id: "t2",
    status: "failed",
    summary: "could not verify",
    reason: "tooling failed",
    findings: [],
    verification: [],
  }), /reviewed_commit/);

  const result = parseReviewResult({
    task_id: "t2",
    status: "failed",
    summary: "could not verify",
    reason: "tooling failed",
    reviewed_commit: "abc",
    findings: [],
    verification: [],
  });
  assert.throws(() => assertResultMatchesTask({ expectedTaskId: "t2", expectedCommit: "def", result }), /reviewed_commit mismatch/);
});

test("task and commit mismatches are rejected", () => {
  const result = parseReviewResult({
    task_id: "t2",
    status: "pass",
    summary: "ok",
    reviewed_commit: "abc",
    findings: [],
    verification: [],
  });
  assert.throws(() => assertResultMatchesTask({ expectedTaskId: "other", result }), /task_id mismatch/);
  assert.throws(() => assertResultMatchesTask({ expectedTaskId: "t2", expectedCommit: "def", result }), /reviewed_commit mismatch/);
});
