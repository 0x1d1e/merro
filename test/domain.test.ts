import test from "node:test";
import assert from "node:assert/strict";
import type { Relation, WorkItem } from "../src/domain/model.js";
import { findRequiresCycle, normalizeRelation } from "../src/domain/relations.js";
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

test("terminal WorkItems cannot reactivate", () => {
  assert.throws(() => assertWorkItemTransition("Done", "Ready"), /invalid WorkItem transition/);
  assert.doesNotThrow(() => assertWorkItemTransition("Reviewing", "Implementing"));
  assert.doesNotThrow(() => assertWorkItemTransition("AwaitingMerge", "Done"));
});

test("active WorkItems cannot become Obsolete before their Task finishes", () => {
  assert.throws(() => assertWorkItemTransition("Implementing", "Obsolete"), /invalid WorkItem transition/);
  assert.throws(() => assertWorkItemTransition("Reviewing", "Obsolete"), /invalid WorkItem transition/);
  assert.throws(() => assertWorkItemTransition("AwaitingMerge", "Obsolete"), /invalid WorkItem transition/);
  assert.doesNotThrow(() => assertWorkItemTransition("Blocked", "Obsolete"));
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
