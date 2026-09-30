export const SCHEMA_VERSION = 1;

export const MIGRATION_1 = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  base_remote TEXT NOT NULL,
  push_remote TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high', 'normal', 'low')),
  state TEXT NOT NULL CHECK (state IN ('Active', 'Done', 'Stopped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects(slug),
  source_type TEXT NOT NULL CHECK (source_type IN ('issue', 'local')),
  source_ref TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('Planned','Ready','Implementing','Reviewing','AwaitingMerge','Blocked','Done','Obsolete','Cancelled')),
  priority TEXT NOT NULL CHECK (priority IN ('high', 'normal', 'low')),
  ready_since TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_slug, source_type, source_ref, generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS work_items_one_live_generation
ON work_items(project_slug, source_type, source_ref)
WHERE state NOT IN ('Done', 'Obsolete', 'Cancelled');

CREATE TRIGGER IF NOT EXISTS terminal_work_items_core_immutable_update
BEFORE UPDATE ON work_items
WHEN OLD.state IN ('Done', 'Obsolete', 'Cancelled')
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.project_slug IS NOT OLD.project_slug
    OR NEW.source_type IS NOT OLD.source_type
    OR NEW.source_ref IS NOT OLD.source_ref
    OR NEW.generation IS NOT OLD.generation
    OR NEW.state IS NOT OLD.state
    OR NEW.priority IS NOT OLD.priority
    OR NEW.ready_since IS NOT OLD.ready_since
    OR NEW.blocked_reason IS NOT OLD.blocked_reason
    OR NEW.created_at IS NOT OLD.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'terminal WorkItem core fields are immutable');
END;

CREATE TABLE IF NOT EXISTS objective_work_items (
  objective_id TEXT NOT NULL REFERENCES objectives(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  PRIMARY KEY (objective_id, work_item_id)
);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('Requires', 'Conflicts')),
  from_work_item_id TEXT NOT NULL REFERENCES work_items(id),
  to_work_item_id TEXT NOT NULL REFERENCES work_items(id),
  confidence TEXT NOT NULL CHECK (confidence IN ('explicit', 'high')),
  rationale TEXT NOT NULL,
  evidence TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (from_work_item_id <> to_work_item_id),
  UNIQUE(kind, from_work_item_id, to_work_item_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  role TEXT NOT NULL CHECK (role IN ('implement', 'review')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'finalized')),
  outcome TEXT CHECK (outcome IN ('success', 'failed', 'cancelled', 'pass', 'reject')),
  started_at TEXT NOT NULL,
  finalized_at TEXT,
  commit_sha TEXT,
  reviewed_commit TEXT,
  summary TEXT,
  result_json TEXT,
  CHECK ((status = 'active' AND outcome IS NULL AND finalized_at IS NULL) OR (status = 'finalized' AND outcome IS NOT NULL AND finalized_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active_per_work_item
ON tasks(work_item_id)
WHERE status = 'active';

CREATE TRIGGER IF NOT EXISTS finalized_tasks_are_immutable_update
BEFORE UPDATE ON tasks
WHEN OLD.status = 'finalized'
BEGIN
  SELECT RAISE(ABORT, 'finalized Task is immutable');
END;

CREATE TRIGGER IF NOT EXISTS finalized_tasks_are_immutable_delete
BEFORE DELETE ON tasks
WHEN OLD.status = 'finalized'
BEGIN
  SELECT RAISE(ABORT, 'finalized Task is immutable');
END;

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'resolved')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS decisions_one_pending_per_subject
ON decisions(subject_type, subject_id)
WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
