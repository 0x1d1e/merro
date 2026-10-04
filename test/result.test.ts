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

test("implement result accepts bounded explicit cross-Project dependency suggestions", () => {
  const result = parseImplementResult({
    task_id: "t1",
    status: "success",
    summary: "implemented",
    commit: "abc",
    verification: [{ kind: "command", project: "p", cwd: ".", command: "npm test", exit_code: 0 }],
    dependency_suggestions: [{ project_slug: "other", issue_number: 42, gate: "reviewed", reason: "The API must expose this capability first." }],
  });
  assert.equal(result.status, "success");
  if (result.status === "success") assert.deepEqual(result.dependency_suggestions, [
    { project_slug: "other", issue_number: 42, gate: "reviewed", reason: "The API must expose this capability first." },
  ]);
});

test("failed implementation retains discoveries that prevent completion", () => {
  const suggestions = [{ project_slug: "api", issue_number: 1, gate: "done", reason: "Missing prerequisite" }];
  const result = parseImplementResult({ task_id: "t1", status: "failed", summary: "Cannot verify", reason: "Missing API", commit: "abc", verification: [], dependency_suggestions: suggestions });
  assert.deepEqual(result.dependency_suggestions, suggestions);
  assert.throws(() => parseImplementResult({ ...result, dependency_suggestions: [{ ...suggestions[0], gate: "unknown" }] }), /gate/);
});

test("implement result rejects invalid dependency suggestions", () => {
  const base = {
    task_id: "t1", status: "success", summary: "implemented", commit: "abc",
    verification: [{ kind: "command", project: "p", cwd: ".", command: "npm test", exit_code: 0 }],
  };
  for (const dependency_suggestions of [
    Array.from({ length: 11 }, (_, issue_number) => ({ project_slug: "other", issue_number: issue_number + 1, gate: "done", reason: "needed" })),
    [{ project_slug: "bad slug", issue_number: 1, gate: "done", reason: "needed" }],
    [{ project_slug: "other", issue_number: 0, gate: "done", reason: "needed" }],
    [{ project_slug: "other", issue_number: 1, gate: "unknown", reason: "needed" }],
    [{ project_slug: "other", issue_number: 1, gate: "done", reason: "bad\nline" }],
  ]) {
    assert.throws(() => parseImplementResult({ ...base, dependency_suggestions }));
  }
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

test("failed implement result requires commit and validates it", () => {
  assert.throws(() => parseImplementResult({
    task_id: "t1",
    status: "failed",
    summary: "could not finish",
    reason: "verification failed",
    verification: [],
  }), /commit/);

  const result = parseImplementResult({
    task_id: "t1",
    status: "failed",
    summary: "could not finish",
    commit: "abc",
    reason: "verification failed",
    verification: [],
  });

  assert.throws(
    () => assertResultMatchesTask({ expectedTaskId: "t1", expectedCommit: "def", result }),
    /commit mismatch/,
  );
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
