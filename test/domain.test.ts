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
  };
}

function requires(from: string, to: string): Relation {
  return { kind: "Requires", from, to, confidence: "explicit", rationale: "test", evidence: "test" };
}

test("terminal WorkItems cannot reactivate", () => {
  assert.throws(() => assertWorkItemTransition("Done", "Ready"), /invalid WorkItem transition/);
  assert.doesNotThrow(() => assertWorkItemTransition("Reviewing", "Implementing"));
  assert.doesNotThrow(() => assertWorkItemTransition("AwaitingMerge", "Done"));
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

test("scheduler returns cycle instead of selecting work", () => {
  const result = schedule({
    workItems: [item("a", "Ready"), item("b", "Ready")],
    relations: [requires("a", "b"), requires("b", "a")],
    activeTaskCount: 0,
    maxConcurrentTasks: 3,
  });
  assert.equal(result.selected.length, 0);
  assert.ok(result.cycle);
});
