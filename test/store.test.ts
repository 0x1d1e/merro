import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MIGRATION_1, SCHEMA_VERSION } from "../src/store/schema.js";
import { MerroStore } from "../src/store/store.js";

function makeStore(): MerroStore {
  const store = new MerroStore(":memory:");
  store.createProject({ slug: "p", path: "/tmp/p", baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" });
  return store;
}

test("store enforces one non-terminal generation per source", () => {
  const store = makeStore();
  try {
    store.createWorkItem({ id: "p:issue-1:g1", projectSlug: "p", sourceType: "issue", sourceRef: "1", generation: 1, state: "Ready", priority: "normal", readySince: "2026-01-01T00:00:00Z", blockedReason: null, blockedResumeState: null });
    assert.throws(() => store.createWorkItem({ id: "p:issue-1:g2", projectSlug: "p", sourceType: "issue", sourceRef: "1", generation: 2, state: "Planned", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null }));
  } finally {
    store.close();
  }
});

test("terminal generation allows a fresh generation", () => {
  const store = makeStore();
  try {
    store.createWorkItem({ id: "p:issue-1:g1", projectSlug: "p", sourceType: "issue", sourceRef: "1", generation: 1, state: "AwaitingMerge", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null });
    store.transitionWorkItem("p:issue-1:g1", "Done");
    store.createWorkItem({ id: "p:issue-1:g2", projectSlug: "p", sourceType: "issue", sourceRef: "1", generation: 2, state: "Planned", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null });
    assert.equal(store.getWorkItem("p:issue-1:g2")?.generation, 2);
  } finally {
    store.close();
  }
});

test("external PR merge completes a blocked WorkItem regardless of its resume state", () => {
  const store = makeStore();
  try {
    store.createWorkItem({
      id: "blocked-implement",
      projectSlug: "p",
      sourceType: "issue",
      sourceRef: "8",
      generation: 1,
      state: "Implementing",
      priority: "normal",
      readySince: null,
      blockedReason: null,
      blockedResumeState: null,
    });
    store.transitionWorkItem("blocked-implement", "Blocked", "task_failed");

    store.completeWorkItemAfterExternalMerge("blocked-implement");

    assert.equal(store.getWorkItem("blocked-implement")?.state, "Done");
  } finally {
    store.close();
  }
});

test("store enforces one active Task per WorkItem and immutable finalization", () => {
  const store = makeStore();
  try {
    store.createWorkItem({ id: "w", projectSlug: "p", sourceType: "local", sourceRef: "w", generation: 1, state: "Implementing", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null });
    store.createTask({ id: "t1", workItemId: "w", role: "implement", attempt: 1 });
    assert.throws(() => store.createTask({ id: "t2", workItemId: "w", role: "review", attempt: 1 }));
    assert.throws(() => store.transitionWorkItem("w", "Obsolete"), /active Task/);
    store.finalizeTask({ id: "t1", outcome: "success", summary: "done", resultJson: "{}", commitSha: "abc" });
    assert.equal(store.getTask("t1")?.outcome, "success");
    store.transitionWorkItem("w", "Obsolete");
    assert.throws(() => store.finalizeTask({ id: "t1", outcome: "failed", summary: "changed", resultJson: "{}" }), /already finalized/);
  } finally {
    store.close();
  }
});

test("SQLite trigger protects terminal WorkItem core fields", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MIGRATION_1);
    db.prepare(`
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("p", "/tmp/p", "origin", "origin", "main", "2026-01-01T00:00:00Z");
    db.prepare(`
      INSERT INTO work_items(
        id, project_slug, source_type, source_ref, generation, state, priority,
        ready_since, blocked_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("done", "p", "issue", "1", 1, "Done", "normal", null, null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");

    assert.throws(
      () => db.prepare("UPDATE work_items SET priority = 'high' WHERE id = 'done'").run(),
      /terminal WorkItem core fields are immutable/,
    );
    assert.throws(
      () => db.prepare("UPDATE work_items SET state = 'Ready' WHERE id = 'done'").run(),
      /terminal WorkItem core fields are immutable/,
    );

    assert.doesNotThrow(() => db.prepare("UPDATE work_items SET updated_at = ? WHERE id = 'done'").run("2026-01-02T00:00:00Z"));
  } finally {
    db.close();
  }
});


test("Blocked transition requires a typed reason and resumes only to the previous flow state", () => {
  const store = makeStore();
  try {
    store.createWorkItem({
      id: "blocked",
      projectSlug: "p",
      sourceType: "issue",
      sourceRef: "2",
      generation: 1,
      state: "Ready",
      priority: "normal",
      readySince: "2026-01-01T00:00:00Z",
      blockedReason: null,
      blockedResumeState: null,
    });

    assert.throws(() => store.transitionWorkItem("blocked", "Blocked"), /requires a BlockReason/);

    store.transitionWorkItem("blocked", "Blocked", "task_failed");
    const blocked = store.getWorkItem("blocked");
    assert.equal(blocked?.state, "Blocked");
    assert.equal(blocked?.blockedReason, "task_failed");
    assert.equal(blocked?.blockedResumeState, "Ready");

    assert.throws(
      () => store.transitionWorkItem("blocked", "Reviewing"),
      /invalid WorkItem transition/,
    );

    store.transitionWorkItem("blocked", "Ready");
    const resumed = store.getWorkItem("blocked");
    assert.equal(resumed?.state, "Ready");
    assert.equal(resumed?.blockedReason, null);
    assert.equal(resumed?.blockedResumeState, null);
    assert.equal(resumed?.readySince, "2026-01-01T00:00:00Z");
  } finally {
    store.close();
  }
});

test("SQLite rejects Blocked WorkItems without reason and resume state", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MIGRATION_1);
    db.prepare(`
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("p", "/tmp/p", "origin", "origin", "main", "2026-01-01T00:00:00Z");
    db.prepare(`
      INSERT INTO work_items(
        id, project_slug, source_type, source_ref, generation, state, priority,
        ready_since, blocked_reason, blocked_resume_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "ready",
      "p",
      "issue",
      "3",
      1,
      "Ready",
      "normal",
      "2026-01-01T00:00:00Z",
      null,
      null,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );

    assert.throws(
      () => db.prepare("UPDATE work_items SET state = 'Blocked' WHERE id = 'ready'").run(),
    );
    assert.throws(
      () => db.prepare(
        "UPDATE work_items SET state = 'Blocked', blocked_reason = 'not_a_reason', blocked_resume_state = 'Ready' WHERE id = 'ready'",
      ).run(),
    );

    db.prepare(
      "UPDATE work_items SET state = 'Blocked', blocked_reason = 'task_failed', blocked_resume_state = 'Ready' WHERE id = 'ready'",
    ).run();

    assert.throws(
      () => db.prepare(
        "UPDATE work_items SET state = 'Reviewing', blocked_reason = NULL, blocked_resume_state = NULL WHERE id = 'ready'",
      ).run(),
      /must resume previous flow state/,
    );
  } finally {
    db.close();
  }
});

test("store migrates v1 state without losing WorkItems", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "merro-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.db");
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(MIGRATION_1);
    legacy.prepare("INSERT INTO schema_meta(version) VALUES (1)").run();
    legacy.prepare(`
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES ('p', '/tmp/p', 'origin', 'origin', 'main', '2026-01-01T00:00:00Z')
    `).run();
    legacy.prepare(`
      INSERT INTO work_items(
        id, project_slug, source_type, source_ref, generation, state, priority,
        ready_since, blocked_reason, blocked_resume_state, created_at, updated_at
      ) VALUES ('legacy', 'p', 'issue', '1', 1, 'Ready', 'normal', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();
  } finally {
    legacy.close();
  }

  const store = new MerroStore(path);
  try {
    assert.equal(store.getWorkItem("legacy")?.state, "Ready");
  } finally {
    store.close();
  }

  const migrated = new DatabaseSync(path);
  try {
    assert.equal(Number(migrated.prepare("SELECT version FROM schema_meta").get()?.version), SCHEMA_VERSION);
    assert.doesNotThrow(() => migrated.prepare("SELECT runtime_kind, base_update_json FROM task_runtime").all());
    assert.doesNotThrow(() => migrated.prepare("SELECT base_update_json FROM work_item_runtime").all());
    assert.doesNotThrow(() => migrated.prepare("SELECT issue_scopes_json FROM objectives").all());
  } finally {
    migrated.close();
  }
});
