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
    sourceType: "issue" as const,
    sourceRef: id,
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
    });
    assert.deepEqual(store.getObjective("o1")?.projectSlugs, ["p", "q"]);
    assert.equal(store.listObjectives()[0]?.maxReviewRounds, "unlimited");
    store.saveObjectiveSettings("o1", { maxReviewRounds: 2 });
    assert.equal(store.getObjective("o1")?.maxReviewRounds, 2);
  } finally {
    store.close();
  }
});

test("runtime metadata, relation history, and Decisions survive store round trips", () => {
  const store = makeStore();
  try {
    store.createWorkItem(item("a"));
    store.createWorkItem(item("b"));
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

    store.saveWorkItemRuntime({
      workItemId: "a",
      branchName: "fix/a",
      clonePath: "/tmp/a",
      baseCommit: "abc",
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
    assert.equal(store.getWorkItemRuntime("a")?.implementationAttempt, 2);

    store.createTask({ id: "t1", workItemId: "a", role: "implement", attempt: 1 });
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
      startedAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(store.getTaskRuntime("t1")?.containerId, "container");

    store.createDecision({
      id: "d1",
      subjectType: "WorkItem",
      subjectId: "a",
      kind: "merge",
      payload: { pullRequest: 4 },
    });
    assert.equal(store.pendingDecisions()[0]?.id, "d1");
    assert.throws(() => store.createDecision({
      id: "d2",
      subjectType: "WorkItem",
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
