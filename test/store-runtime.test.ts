import test from "node:test";
import assert from "node:assert/strict";
import { MerroStore } from "../src/store/store.js";

function makeStore(): MerroStore {
  const store = new MerroStore(":memory:");
  store.createProject({ slug: "p", path: "/tmp/p", baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" });
  return store;
}

function item(id: string) {
  return {
    id,
    projectSlug: "p",
    slug: id,
    issues: [],
    generation: 1,
    state: "Ready" as const,
    priority: "normal" as const,
    readySince: "2026-01-01T00:00:00Z",
    blockedReason: null,
    blockedResumeState: null,
  };
}

test("objectives preserve linked Projects and per-Objective review limits", () => {
  const store = makeStore();
  try {
    store.createProject({ slug: "q", path: "/tmp/q", baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" });
    store.createObjective({
      id: "o1",
      goal: "ship",
      priority: "high",
      state: "Active",
      projectSlugs: ["q", "p", "p"],
      maxReviewRounds: "unlimited",
      issueScopes: [{ projectSlug: "p", query: { labels: ["feature"], milestone: "v1" } }, { projectSlug: "q", numbers: [7] }],
    });
    assert.deepEqual(store.getObjective("o1")?.projectSlugs, ["p", "q"]);
    assert.equal(store.listObjectives()[0]?.maxReviewRounds, "unlimited");
    assert.deepEqual(store.getObjective("o1")?.issueScopes, [
      { projectSlug: "p", query: { labels: ["feature"], milestone: "v1" } }, { projectSlug: "q", numbers: [7] },
    ]);
    assert.throws(() => store.restoreObjectiveIssueScopes("o1", [{ projectSlug: "p", query: {} }]), /already has approved/);
    store.saveObjectiveSettings("o1", { maxReviewRounds: 2 });
    assert.equal(store.getObjective("o1")?.maxReviewRounds, 2);
  } finally {
    store.close();
  }
});

test("cleanup completion retires finalized runtime records without changing Task history", () => {
  const store = makeStore();
  try {
    store.createChangeSet(item("a"));
    store.createChangeSet(item("b"));
    const runtime = {
      runtimeKind: "host" as const, tmuxSession: "merro-p", tmuxWindow: "impl-a", paneId: "%1",
      containerId: null, processPid: 1, processStartedAt: "2026-01-01T00:00:00Z",
      clonePath: "/tmp/a", taskFilePath: "/tmp/a/.merro-task.md", resultPath: "/tmp/task/result.json",
      expectedCommit: "abc", startedAt: "2026-01-01T00:00:00Z",
    };
    for (let index = 0; index < 100; index++) {
      const id = `cleaned-${index}`;
      store.createTask({ id, changeSetId: "a", role: "implement", attempt: index + 1, runtime: { ...runtime, taskId: id } });
      store.finalizeTask({ id, outcome: "failed", summary: "Finished", resultJson: "{}" });
      store.markTaskCleanupCompleted(id);
    }
    store.createTask({ id: "pending", changeSetId: "a", role: "implement", attempt: 101, runtime: { ...runtime, taskId: "pending" } });
    store.createTask({ id: "no-runtime", changeSetId: "b", role: "implement", attempt: 1 });
    store.finalizeTask({ id: "no-runtime", outcome: "failed", summary: "No runtime", resultJson: "{}" });
    assert.equal(store.listTasksPendingCleanup().length, 0);
    assert.deepEqual(store.listActiveTaskInputPaths(), [runtime.taskFilePath]);
    assert.throws(() => store.markTaskCleanupCompleted("pending"), /requires a finalized Task with runtime/);
    assert.throws(() => store.markTaskCleanupCompleted("no-runtime"), /requires a finalized Task with runtime/);
    assert.throws(() => store.markTaskCleanupCompleted("unknown"), /requires a finalized Task with runtime/);
    assert.equal(store.getTaskRuntime("pending")?.cleanupCompletedAt, null);
    store.finalizeTask({ id: "pending", outcome: "failed", summary: "Retry cleanup", resultJson: "{}" });
    const history = store.getTask("pending");
    assert.deepEqual(store.listTasksPendingCleanup().map((task) => task.id), ["pending"]);
    assert.deepEqual(store.listActiveTaskInputPaths(), []);
    store.markTaskCleanupCompleted("pending");
    const completedAt = store.getTaskRuntime("pending")?.cleanupCompletedAt;
    assert.equal(typeof completedAt, "string");
    store.markTaskCleanupCompleted("pending");
    store.saveTaskRuntime({ ...runtime, taskId: "pending", cleanupCompletedAt: null });
    assert.equal(store.getTaskRuntime("pending")?.cleanupCompletedAt, completedAt);
    assert.deepEqual(store.listTasksPendingCleanup(), []);
    assert.deepEqual(store.getTask("pending"), history);
    assert.throws(() => store.finalizeTask({ id: "pending", outcome: "failed", summary: "Changed", resultJson: "{}" }), /already finalized/);
  } finally { store.close(); }
});

test("automatic relation rebuild preserves manual evidence and effective Requires precedence", () => {
  const store = makeStore();
  try {
    store.createChangeSet(item("a"));
    store.createChangeSet(item("b"));
    const manual = { kind: "Requires" as const, from: "a", to: "b", confidence: "explicit" as const, rationale: "Approved", evidence: "User" };
    const inferred = { ...manual, confidence: "high" as const, rationale: "Inferred", evidence: "Requires #7" };
    store.replaceRelations([manual]);
    store.rebuildAutomaticRelations(["a", "b"], [inferred, { ...inferred, kind: "Conflicts" }]);
    assert.deepEqual(store.listRelations(), [manual]);
    store.rebuildAutomaticRelations(["a", "b"], []);
    assert.deepEqual(store.listRelations(), [manual]);
    store.replaceRelations([]);
    store.rebuildAutomaticRelations(["a", "b"], [inferred]);
    assert.deepEqual(store.listRelations(), [inferred]);
    store.rebuildAutomaticRelations(["a", "b"], []);
    assert.equal(store.listRelations().length, 0);
    assert.ok(store.listRelations(true).length > 0);
  } finally { store.close(); }
});

for (const activeEndpoint of ["a", "b"]) {
  test(`automatic conflicts touching active ${activeEndpoint} survive successful analysis until finalization`, () => {
    const store = makeStore();
    try {
      store.createChangeSet(item("a"));
      store.createChangeSet(item("b"));
      const conflict = { kind: "Conflicts" as const, from: "a", to: "b", confidence: "high" as const, rationale: "Scoped conflict", evidence: "Conflicts with #8" };
      store.rebuildAutomaticRelations(["a", "b"], [conflict]);
      store.createTask({ id: "running", changeSetId: activeEndpoint, role: "implement", attempt: 1 });
      store.rebuildAutomaticRelations(["a", "b"], []);
      assert.deepEqual(store.listRelations(), [conflict]);
      store.finalizeTask({ id: "running", outcome: "failed", summary: "Finished", resultJson: "{}" });
      store.rebuildAutomaticRelations(["a", "b"], []);
      assert.equal(store.listRelations().length, 0);
    } finally { store.close(); }
  });
}

for (const occupiedEndpoint of ["a", "b"]) {
  test(`automatic conflicts touching orphan ${occupiedEndpoint} survive successful analysis until exit`, () => {
    const store = makeStore();
    try {
      store.createChangeSet(item("a"));
      store.createChangeSet(item("b"));
      const conflict = { kind: "Conflicts" as const, from: "a", to: "b", confidence: "high" as const,
        rationale: "Scoped conflict", evidence: "Conflicts with #8" };
      store.rebuildAutomaticRelations(["a", "b"], [conflict]);
      store.rebuildAutomaticRelations(["a", "b"], [], [occupiedEndpoint]);
      assert.deepEqual(store.listRelations(), [conflict]);
      store.rebuildAutomaticRelations(["a", "b"], []);
      assert.equal(store.listRelations().length, 0);
    } finally { store.close(); }
  });
}

test("runtime metadata, relation history, and Decisions survive store round trips", () => {
  const store = makeStore();
  try {
    store.createChangeSet(item("a"));
    store.createChangeSet(item("b"));
    store.replaceRelations([{
      kind: "Requires",
      from: "a",
      to: "b",
      confidence: "explicit",
      rationale: "dependency",
      evidence: "user approved",
    }]);
    assert.equal(store.listRelations()[0]?.from, "a");
    store.replaceRelations([]);
    assert.equal(store.listRelations().length, 0);
    assert.equal(store.listRelations(true).length, 1);

    store.saveChangeSetRuntime({
      changeSetId: "a",
      branchName: "fix/a",
      clonePath: "/tmp/a",
      baseCommit: "abc",
      baseUpdate: { baseRefName: "release", baseCommit: "d".repeat(40) },
      pullRequestNumber: null,
      pullRequestUrl: null,
      pullRequestState: null,
      pullRequestHeadSha: null,
      pullRequestBaseSha: null,
      mergedCommitSha: null,
      lastIssueState: null,
      reviewedDiffHash: null,
      reviewRound: 1,
      infrastructureRetries: 0,
      implementationAttempt: 2,
      lastReworkTrigger: null,
      lastReconciledAt: null,
    });
    assert.equal(store.getChangeSetRuntime("a")?.implementationAttempt, 2);
    assert.deepEqual(store.getChangeSetRuntime("a")?.baseUpdate, { baseRefName: "release", baseCommit: "d".repeat(40) });

    store.createTask({ id: "t1", changeSetId: "a", role: "implement", attempt: 1 });
    store.saveTaskRuntime({
      taskId: "t1",
      runtimeKind: "docker",
      tmuxSession: "merro-p",
      tmuxWindow: "impl-a",
      paneId: "%3",
      containerId: "container",
      processPid: 1,
      processStartedAt: "2026-01-01T00:00:00Z",
      clonePath: "/tmp/a",
      taskFilePath: "/tmp/a/.merro-task.md",
      resultPath: "/tmp/task/.merro-result.json",
      expectedCommit: "abc",
      baseUpdate: { baseRefName: "release", baseCommit: "d".repeat(40) },
      startedAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(store.getTaskRuntime("t1")?.containerId, "container");
    assert.deepEqual(store.getTaskRuntime("t1")?.baseUpdate, { baseRefName: "release", baseCommit: "d".repeat(40) });

    store.createDecision({
      id: "d1",
      subjectType: "ChangeSet",
      subjectId: "a",
      kind: "merge",
      payload: { pullRequest: 4 },
    });
    assert.equal(store.pendingDecisions()[0]?.id, "d1");
    assert.throws(() => store.createDecision({
      id: "d2",
      subjectType: "ChangeSet",
      subjectId: "a",
      kind: "merge",
      payload: {},
    }));
    store.resolveDecision("d1", "approved");
    assert.equal(store.getDecision("d1")?.state, "approved");
    assert.ok(store.snapshot().task_runtime);
  } finally {
    store.close();
  }
});
