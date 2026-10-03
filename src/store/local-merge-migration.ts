import type { DatabaseSync } from "node:sqlite";

/** Add the approval-gated local merge state while preserving work-item protections and child rows. */
export function migrateLocalMergeState(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    const protections = db.prepare(`SELECT name, sql FROM sqlite_schema
      WHERE tbl_name = 'work_items' AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all();
    db.exec(`CREATE TABLE work_items_local_merge (
      id TEXT PRIMARY KEY,
      project_slug TEXT NOT NULL REFERENCES projects(slug),
      source_type TEXT NOT NULL CHECK (source_type IN ('issue', 'local')),
      source_ref TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      state TEXT NOT NULL CHECK (state IN ('Planned','Ready','Implementing','Reviewing','Reviewed','AwaitingLocalMerge','Publishing','AwaitingMerge','Blocked','PublishBlocked','Done','Obsolete','Cancelled')),
      priority TEXT NOT NULL CHECK (priority IN ('high', 'normal', 'low')),
      ready_since TEXT,
      blocked_reason TEXT CHECK (blocked_reason IN (
        'review_cap','cycle','task_failed','clone_lost','policy_unknown','github_unavailable',
        'structural_rejected','merge_rejected','merge_failed','pr_closed',
        'remote_branch_deleted','project_unavailable','publication_failed'
      )),
      blocked_resume_state TEXT CHECK (blocked_resume_state IN ('Planned','Ready','Implementing','Reviewing','Reviewed','AwaitingLocalMerge','Publishing','AwaitingMerge')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      slug TEXT,
      delivery TEXT NOT NULL DEFAULT 'pr' CHECK (delivery IN ('local','pr')),
      target_branch TEXT CHECK (delivery = 'pr' OR (target_branch IS NOT NULL AND length(trim(target_branch)) > 0)),
      CHECK ((state IN ('Blocked','PublishBlocked') AND blocked_reason IS NOT NULL AND blocked_resume_state IS NOT NULL)
        OR (state NOT IN ('Blocked','PublishBlocked') AND blocked_reason IS NULL AND blocked_resume_state IS NULL)),
      CHECK (state <> 'PublishBlocked' OR blocked_resume_state = 'Publishing'),
      UNIQUE(project_slug, source_type, source_ref, generation)
    );
    INSERT INTO work_items_local_merge SELECT * FROM work_items;
    DROP TABLE work_items;
    ALTER TABLE work_items_local_merge RENAME TO work_items;`);
    for (const protection of protections) {
      if (protection.name === "work_items_block_from_current_flow" || protection.name === "blocked_work_items_resume_previous_flow") continue;
      db.exec(String(protection.sql));
    }
    db.exec(`CREATE TRIGGER work_items_block_from_current_flow
      BEFORE UPDATE ON work_items
      WHEN OLD.state NOT IN ('Blocked','PublishBlocked') AND NEW.state IN ('Blocked','PublishBlocked')
        AND NEW.blocked_resume_state IS NOT OLD.state
      BEGIN SELECT RAISE(ABORT, 'Blocked ChangeSet resume state must match previous flow state'); END;
      CREATE TRIGGER blocked_work_items_resume_previous_flow
      BEFORE UPDATE ON work_items
      WHEN OLD.state IN ('Blocked','PublishBlocked') AND NEW.state NOT IN ('Blocked','PublishBlocked','Obsolete','Cancelled','Done')
        AND NEW.state IS NOT OLD.blocked_resume_state
      BEGIN SELECT RAISE(ABORT, 'Blocked ChangeSet must resume previous flow state'); END;
      UPDATE schema_meta SET version = 18;`);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Local merge migration found invalid foreign keys");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
