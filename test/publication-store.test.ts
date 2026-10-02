import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MerroStore } from "../src/store/store.js";
import { MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9, MIGRATION_10, MIGRATION_11, MIGRATION_12, SCHEMA_VERSION } from "../src/store/schema.js";

const migrations = [MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9, MIGRATION_10, MIGRATION_11, MIGRATION_12];

test("passing review and Reviewed transition commit atomically or both roll back", () => {
  const store = new MerroStore(":memory:");
  try {
    store.createProject({ slug: "p", path: "/tmp/p", baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" });
    store.createChangeSet({ id: "change", slug: "change", projectSlug: "p", issues: [], generation: 1, state: "Implementing", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null });
    store.createTask({ id: "review", changeSetId: "change", role: "review", attempt: 1 });
    const result = { id: "review", summary: "Passed", resultJson: "{}", reviewedCommit: "a".repeat(40) };
    assert.throws(() => store.finalizePassingReview(result), /invalid ChangeSet transition/);
    assert.equal(store.getTask("review")?.status, "active");
    assert.equal(store.hasEvent("Task", "review", "finalized"), false);
    store.transitionChangeSet("change", "Reviewing");
    store.finalizePassingReview(result);
    assert.equal(store.getTask("review")?.outcome, "pass");
    assert.equal(store.getChangeSet("change")?.state, "Reviewed");
    store.transitionChangeSet("change", "Publishing");
    store.transitionChangeSet("change", "PublishBlocked", "publication_failed");
    assert.equal(store.getChangeSet("change")?.blockedResumeState, "Publishing");
    assert.throws(() => store.transitionChangeSet("change", "Reviewing"), /invalid/);
    store.transitionChangeSet("change", "Publishing");
    store.transitionChangeSet("change", "AwaitingMerge");
  } finally { store.close(); }
});

test("publication migration rolls back schema and state when foreign keys are invalid", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "merro-publication-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.db");
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(migrations.join("\n"));
    legacy.exec("PRAGMA foreign_keys = OFF; INSERT INTO schema_meta VALUES (13); INSERT INTO objective_work_items(objective_id, work_item_id) VALUES ('missing', 'missing')");
    assert.throws(() => new MerroStore(path), /invalid foreign keys/);
    assert.equal(legacy.prepare("SELECT version FROM schema_meta").get()?.version, 14);
    assert.equal(legacy.prepare("SELECT sql FROM sqlite_schema WHERE name = 'work_items'").get()?.sql?.toString().includes("PublishBlocked"), false);
    assert.equal(legacy.prepare("PRAGMA table_info(work_item_runtime)").all().some((row) => row.name === "github_checks"), false);
    assert.equal(legacy.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name = 'work_items_publication'").get()?.count, 0);
    legacy.exec("DELETE FROM objective_work_items");
  } finally { legacy.close(); }
  const recovered = new MerroStore(path);
  recovered.close();
});

test("legacy publication failures migrate without changing Tasks, ownership or protections", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "merro-publication-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.db");
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(migrations.join("\n"));
    legacy.exec(`INSERT INTO schema_meta VALUES (13);
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES ('p', '/tmp/p', 'origin', 'origin', 'main', '2026-01-01');
      INSERT INTO objectives(id, goal, priority, state, created_at, updated_at, issue_scopes_json)
      VALUES ('goal', 'Fix publication', 'normal', 'Active', '2026-01-01', '2026-01-01', '[{"projectSlug":"p","numbers":[1,2,3,4]}]');
      INSERT INTO objective_projects VALUES ('goal', 'p');`);
    for (const [id, number, blocked, pass] of [["unpublished", 1, false, true], ["blocked", 2, true, true], ["published", 3, false, true], ["unfinished", 4, true, false]] as const) {
      legacy.prepare(`INSERT INTO work_items(id, project_slug, source_type, source_ref, generation, state, priority, blocked_reason, blocked_resume_state, created_at, updated_at)
        VALUES (?, 'p', 'issue', ?, 1, ?, 'normal', ?, ?, '2026-01-01', '2026-01-01')`)
        .run(id, String(number), blocked ? "Blocked" : "AwaitingMerge", blocked ? "github_unavailable" : null, blocked ? "AwaitingMerge" : null);
      legacy.prepare("INSERT INTO objective_work_items(objective_id, work_item_id) VALUES ('goal', ?)").run(id);
      legacy.prepare(`INSERT INTO tasks(id, work_item_id, role, attempt, status, outcome, started_at, finalized_at, summary, result_json, reviewed_commit)
        VALUES (?, ?, 'review', 1, 'finalized', ?, '2026-01-01', '2026-01-02', 'Original review', '{"unchanged":true}', ?)`)
        .run(`review-${id}`, id, pass ? "pass" : "failed", "a".repeat(40));
    }
    legacy.exec("INSERT INTO work_item_runtime(work_item_id, pull_request_number) VALUES ('published', 42)");
  } finally { legacy.close(); }
  for (let restart = 0; restart < 2; restart++) {
    const store = new MerroStore(path);
    try {
      assert.equal(store.getChangeSet("unpublished")?.state, "Reviewed");
      assert.equal(store.getChangeSet("blocked")?.state, "PublishBlocked");
      assert.equal(store.getChangeSet("blocked")?.blockedResumeState, "Publishing");
      assert.equal(store.getChangeSet("published")?.state, "AwaitingMerge");
      assert.equal(store.getChangeSet("unfinished")?.state, "Blocked");
      assert.equal(store.getChangeSetRuntime("published")?.pullRequestNumber, 42);
      assert.equal(store.listChangeSets("goal").length, 4);
      assert.equal(store.getTask("review-blocked")?.resultJson, '{"unchanged":true}');
    } finally { store.close(); }
  }
  const database = new DatabaseSync(path);
  try {
    assert.equal(database.prepare("SELECT version FROM schema_meta").get()?.version, SCHEMA_VERSION);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => database.exec("UPDATE tasks SET summary = 'Changed' WHERE id = 'review-blocked'"), /immutable/);
    assert.throws(() => database.exec("UPDATE work_items SET slug = 'renamed' WHERE id = 'blocked'"), /immutable/);
    assert.throws(() => database.exec("UPDATE work_items SET state = 'Reviewing', blocked_reason = NULL, blocked_resume_state = NULL WHERE id = 'blocked'"), /resume previous flow/);
    assert.throws(() => database.exec("UPDATE work_items SET state = 'PublishBlocked', blocked_reason = 'publication_failed', blocked_resume_state = 'Ready' WHERE id = 'unpublished'"));
    assert.throws(() => database.exec("INSERT INTO work_items(id, project_slug, source_type, source_ref, generation, state, priority, created_at, updated_at, slug) VALUES ('overlap', 'p', 'issue', '2', 2, 'Ready', 'normal', '2026-01-01', '2026-01-01', 'overlap')"), /active ChangeSet/);
  } finally { database.close(); }
});
