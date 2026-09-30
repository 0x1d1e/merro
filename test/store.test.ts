import test from "node:test";
import assert from "node:assert/strict";
import { MerroStore } from "../src/store/store.js";

function makeStore(): MerroStore {
  const store = new MerroStore(":memory:");
  store.createProject({ slug: "p", path: "/tmp/p", baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" });
  return store;
}

test("store enforces one non-terminal generation per source", () => {
  const store = makeStore();
  try {
    store.createWorkItem({ id: "p:issue-1:g1", projectSlug: "p", sourceType: "issue", sourceRef: "1", generation: 1, state: "Ready", priority: "normal", readySince: "2026-01-01T00:00:00Z", blockedReason: null });
    assert.throws(() => store.createWorkItem({ id: "p:issue-1:g2", projectSlug: "p", sourceType: "issue", sourceRef: "1", generation: 2, state: "Planned", priority: "normal", readySince: null, blockedReason: null }));
  } finally {
    store.close();
  }
});

test("terminal generation allows a fresh generation", () => {
  const store = makeStore();
  try {
    store.createWorkItem({ id: "p:issue-1:g1", projectSlug: "p", sourceType: "issue", sourceRef: "1", generation: 1, state: "AwaitingMerge", priority: "normal", readySince: null, blockedReason: null });
    store.transitionWorkItem("p:issue-1:g1", "Done");
    store.createWorkItem({ id: "p:issue-1:g2", projectSlug: "p", sourceType: "issue", sourceRef: "1", generation: 2, state: "Planned", priority: "normal", readySince: null, blockedReason: null });
    assert.equal(store.getWorkItem("p:issue-1:g2")?.generation, 2);
  } finally {
    store.close();
  }
});

test("store enforces one active Task per WorkItem and immutable finalization", () => {
  const store = makeStore();
  try {
    store.createWorkItem({ id: "w", projectSlug: "p", sourceType: "local", sourceRef: "w", generation: 1, state: "Implementing", priority: "normal", readySince: null, blockedReason: null });
    store.createTask({ id: "t1", workItemId: "w", role: "implement", attempt: 1 });
    assert.throws(() => store.createTask({ id: "t2", workItemId: "w", role: "review", attempt: 1 }));
    store.finalizeTask({ id: "t1", outcome: "success", summary: "done", resultJson: "{}", commitSha: "abc" });
    assert.equal(store.getTask("t1")?.outcome, "success");
    assert.throws(() => store.finalizeTask({ id: "t1", outcome: "failed", summary: "changed", resultJson: "{}" }), /already finalized/);
  } finally {
    store.close();
  }
});
