import test from "node:test";
import assert from "node:assert/strict";
import type { Relation, WorkItem } from "../src/domain/model.js";
import { parseObjectiveIssueScopes } from "../src/domain/objective.js";
import { analyzeIssueRelations, findRequiresCycle, normalizeRelation } from "../src/domain/relations.js";
import { schedule } from "../src/domain/scheduler.js";
import { assertWorkItemTransition } from "../src/domain/work-item.js";

function item(id: string, state: WorkItem["state"], priority: WorkItem["priority"] = "normal", readySince = "2026-01-01T00:00:00Z"): WorkItem {
  return {
    id,
    projectSlug: "p",
    sourceType: "issue",
    sourceRef: id,
    generation: 1,
    state,
    priority,
    readySince: state === "Ready" ? readySince : null,
    blockedReason: null,
    blockedResumeState: null,
  };
}

function requires(from: string, to: string): Relation {
  return { kind: "Requires", from, to, confidence: "explicit", rationale: "test", evidence: "test" };
}

function conflicts(left: string, right: string): Relation {
  return { kind: "Conflicts", from: left, to: right, confidence: "high", rationale: "test", evidence: "test" };
}

test("Objective issue scopes cover exactly the normalized linked Project set", () => {
  const scopes = [{ projectSlug: "web", numbers: [8, 8] }, { projectSlug: "api", query: {} }];
  assert.deepEqual(parseObjectiveIssueScopes(scopes, ["api", "web", "api"]), [
    { projectSlug: "web", numbers: [8] }, { projectSlug: "api", query: { labels: [] } },
  ]);
  assert.throws(() => parseObjectiveIssueScopes(scopes, ["api", "web", "infra"]), /missing issue scope for Project 'infra'/);
  assert.throws(() => parseObjectiveIssueScopes([], ["api"]), /missing issue scope for Project 'api'/);
  assert.throws(() => parseObjectiveIssueScopes(scopes, ["api"]), /unlinked Project/);
  assert.throws(() => parseObjectiveIssueScopes([...scopes, { projectSlug: "api", numbers: [7] }], ["api", "web"]), /duplicate issue scope/);
});

test("terminal WorkItems cannot reactivate", () => {
  assert.throws(() => assertWorkItemTransition("Done", "Ready"), /invalid WorkItem transition/);
  assert.doesNotThrow(() => assertWorkItemTransition("Reviewing", "Implementing"));
  assert.doesNotThrow(() => assertWorkItemTransition("AwaitingMerge", "Done"));
});

test("unfinished WorkItems can become Obsolete when no Objective owns them", () => {
  assert.doesNotThrow(() => assertWorkItemTransition("Implementing", "Obsolete"));
  assert.doesNotThrow(() => assertWorkItemTransition("Reviewing", "Obsolete"));
  assert.doesNotThrow(() => assertWorkItemTransition("AwaitingMerge", "Obsolete"));
  assert.doesNotThrow(() => assertWorkItemTransition("Blocked", "Obsolete"));
  assert.doesNotThrow(() => assertWorkItemTransition("AwaitingMerge", "Implementing"));
});

test("Blocked WorkItems resume only to their persisted previous flow state", () => {
  assert.doesNotThrow(() => assertWorkItemTransition("Blocked", "Ready", "Ready"));
  assert.throws(() => assertWorkItemTransition("Blocked", "Reviewing", "Ready"), /invalid WorkItem transition/);
  assert.throws(() => assertWorkItemTransition("Blocked", "Planned", null), /invalid WorkItem transition/);
  assert.doesNotThrow(() => assertWorkItemTransition("Blocked", "Cancelled", "Ready"));
});

test("Conflicts are canonicalized symmetrically", () => {
  const relation = normalizeRelation({ kind: "Conflicts", from: "z", to: "a", confidence: "high", rationale: "x", evidence: "x" });
  assert.equal(relation.from, "a");
  assert.equal(relation.to, "z");
});

test("issue relation analysis accepts affirmative references and rejects speculative or quoted evidence", () => {
  const source = { ...item("source", "Planned"), sourceRef: "8" };
  const target = { ...item("target", "Ready"), sourceRef: "7" };
  for (const body of ["Requires #7", "Depends on: #7", "Blocked by #7", "#8 requires #7"]) {
    assert.equal(analyzeIssueRelations(source, { title: "Work", body }, [source, target]).relations[0]?.to, target.id);
  }
  for (const body of ["Does not require #7", "Does not depend on #7", "Never requires #7", "If this requires #7", "Requires #7?", "Example: requires #7", "Requires #7 or #99",
    "`Requires #7`", "> Requires #7", "```\nRequires #7\n```", 'Example: "requires #7"']) {
    assert.deepEqual(analyzeIssueRelations(source, { title: "Work", body }, [source, target]).relations, []);
  }
  const newer = { ...target, id: "newer", generation: 2 };
  assert.equal(analyzeIssueRelations(source, { title: "Work", body: "Requires #7" }, [source, target, newer]).relations[0]?.to, "newer");
  assert.deepEqual(analyzeIssueRelations(source, { title: "Work", body: "Requires #99 and #8" }, [source, target]).unresolved, ["#99", "#8"]);
  const crossProject = { ...target, projectSlug: "q" };
  assert.equal(analyzeIssueRelations(source, { title: "Work", body: "Requires q#7" }, [source, crossProject]).relations[0]?.to, target.id);
});

test("Requires cycles are detected", () => {
  assert.deepEqual(findRequiresCycle([requires("a", "b"), requires("b", "c"), requires("c", "a")]), ["a", "b", "c", "a"]);
});

test("scheduler blocks dependents until prerequisite is Done", () => {
  const result = schedule({
    workItems: [item("dependent", "Ready"), item("base", "AwaitingMerge")],
    relations: [requires("dependent", "base")],
    activeTaskCount: 0,
    maxConcurrentTasks: 3,
  });
  assert.deepEqual(result.selected.map((entry) => entry.id), []);
});

test("scheduler orders priority, downstream unblock count, age, then ID", () => {
  const items = [
    item("low", "Ready", "low", "2026-01-01T00:00:00Z"),
    item("high-leaf", "Ready", "high", "2026-01-01T00:00:00Z"),
    item("high-root", "Ready", "high", "2026-01-02T00:00:00Z"),
    item("child", "Planned"),
  ];
  const result = schedule({
    workItems: items,
    relations: [requires("child", "high-root")],
    activeTaskCount: 0,
    maxConcurrentTasks: 2,
  });
  assert.deepEqual(result.selected.map((entry) => entry.id), ["high-root", "high-leaf"]);
});

test("scheduler never selects conflicting Ready WorkItems together", () => {
  const result = schedule({
    workItems: [
      item("first", "Ready", "high", "2026-01-01T00:00:00Z"),
      item("second", "Ready", "high", "2026-01-02T00:00:00Z"),
    ],
    relations: [conflicts("first", "second")],
    activeTaskCount: 0,
    maxConcurrentTasks: 2,
  });
  assert.deepEqual(result.selected.map((entry) => entry.id), ["first"]);
});

test("scheduler blocks a conflict against an already active WorkItem", () => {
  const result = schedule({
    workItems: [item("ready", "Ready"), item("active", "Implementing")],
    relations: [conflicts("ready", "active")],
    activeTaskCount: 1,
    maxConcurrentTasks: 2,
  });
  assert.deepEqual(result.selected, []);
});

test("Requires cycle does not stall unrelated Ready work", () => {
  const result = schedule({
    workItems: [item("a", "Ready"), item("b", "Ready"), item("unrelated", "Ready")],
    relations: [requires("a", "b"), requires("b", "a")],
    activeTaskCount: 0,
    maxConcurrentTasks: 3,
  });
  assert.deepEqual(result.selected.map((entry) => entry.id), ["unrelated"]);
  assert.ok(result.cycle);
});
