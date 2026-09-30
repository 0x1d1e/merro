import { DatabaseSync } from "node:sqlite";
import type {
  BlockReason,
  FlowWorkItemState,
  Objective,
  Project,
  TaskOutcome,
  TaskRole,
  WorkItem,
  WorkItemState,
} from "../domain/model.js";
import { assertWorkItemTransition } from "../domain/work-item.js";
import { MIGRATION_1, SCHEMA_VERSION } from "./schema.js";

function now(): string {
  return new Date().toISOString();
}

export class MerroStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  #migrate(): void {
    this.#db.exec(MIGRATION_1);
    const row = this.#db.prepare("SELECT version FROM schema_meta LIMIT 1").get();
    if (!row) {
      this.#db.prepare("INSERT INTO schema_meta(version) VALUES (?)").run(SCHEMA_VERSION);
      return;
    }
    if (Number(row.version) !== SCHEMA_VERSION) {
      throw new Error(`unsupported Merro schema version ${String(row.version)}; expected ${SCHEMA_VERSION}`);
    }
  }

  createProject(project: Project): void {
    this.#db.prepare(`
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(project.slug, project.path, project.baseRemote, project.pushRemote, project.defaultBranch, now());
  }

  createObjective(objective: Objective): void {
    const timestamp = now();
    this.#db.prepare(`
      INSERT INTO objectives(id, goal, priority, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(objective.id, objective.goal, objective.priority, objective.state, timestamp, timestamp);
  }

  createWorkItem(item: WorkItem): void {
    const hasBlockedMetadata = item.blockedReason !== null || item.blockedResumeState !== null;
    if (item.state === "Blocked") {
      if (item.blockedReason === null || item.blockedResumeState === null) {
        throw new Error("Blocked WorkItem requires BlockReason and resume state");
      }
    } else if (hasBlockedMetadata) {
      throw new Error("non-Blocked WorkItem cannot carry Blocked metadata");
    }

    const timestamp = now();
    this.#db.prepare(`
      INSERT INTO work_items(
        id, project_slug, source_type, source_ref, generation, state, priority,
        ready_since, blocked_reason, blocked_resume_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.projectSlug,
      item.sourceType,
      item.sourceRef,
      item.generation,
      item.state,
      item.priority,
      item.readySince,
      item.blockedReason,
      item.blockedResumeState,
      timestamp,
      timestamp,
    );
  }

  attachWorkItem(objectiveId: string, workItemId: string): void {
    this.#db.prepare(`
      INSERT OR IGNORE INTO objective_work_items(objective_id, work_item_id)
      VALUES (?, ?)
    `).run(objectiveId, workItemId);
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.#db.prepare("SELECT * FROM work_items WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: String(row.id),
      projectSlug: String(row.project_slug),
      sourceType: row.source_type === "issue" ? "issue" : "local",
      sourceRef: String(row.source_ref),
      generation: Number(row.generation),
      state: row.state as WorkItemState,
      priority: row.priority as WorkItem["priority"],
      readySince: row.ready_since === null ? null : String(row.ready_since),
      blockedReason: row.blocked_reason === null ? null : row.blocked_reason as BlockReason,
      blockedResumeState: row.blocked_resume_state === null ? null : row.blocked_resume_state as FlowWorkItemState,
    };
  }

  transitionWorkItem(id: string, to: WorkItemState, blockedReason: BlockReason | null = null): void {
    const item = this.getWorkItem(id);
    if (!item) throw new Error(`unknown WorkItem: ${id}`);

    if (to === "Blocked" && blockedReason === null) {
      throw new Error("Blocked WorkItem requires a BlockReason");
    }
    if (to !== "Blocked" && blockedReason !== null) {
      throw new Error("BlockReason is only valid when entering or updating Blocked");
    }

    assertWorkItemTransition(item.state, to, item.blockedResumeState);

    let nextBlockedReason: BlockReason | null = null;
    let nextBlockedResumeState: FlowWorkItemState | null = null;
    if (to === "Blocked") {
      nextBlockedReason = blockedReason;
      nextBlockedResumeState = item.state === "Blocked"
        ? item.blockedResumeState
        : item.state as FlowWorkItemState;
      if (nextBlockedResumeState === null) {
        throw new Error("Blocked WorkItem requires a resume state");
      }
    }

    const readySince = to === "Ready" && item.state !== "Ready" && item.state !== "Blocked"
      ? now()
      : item.readySince;
    this.#db.prepare(`
      UPDATE work_items
      SET state = ?, ready_since = ?, blocked_reason = ?, blocked_resume_state = ?, updated_at = ?
      WHERE id = ?
    `).run(to, readySince, nextBlockedReason, nextBlockedResumeState, now(), id);
  }

  createTask(input: { id: string; workItemId: string; role: TaskRole; attempt: number }): void {
    this.#db.prepare(`
      INSERT INTO tasks(id, work_item_id, role, attempt, status, started_at)
      VALUES (?, ?, ?, ?, 'active', ?)
    `).run(input.id, input.workItemId, input.role, input.attempt, now());
  }

  finalizeTask(input: {
    id: string;
    outcome: TaskOutcome;
    summary: string;
    resultJson: string;
    commitSha?: string | null;
    reviewedCommit?: string | null;
  }): void {
    const row = this.#db.prepare("SELECT role, status FROM tasks WHERE id = ?").get(input.id);
    if (!row) throw new Error(`unknown Task: ${input.id}`);
    if (row.status !== "active") throw new Error(`Task already finalized: ${input.id}`);
    const role = String(row.role);
    const allowed = role === "implement"
      ? new Set<TaskOutcome>(["success", "failed", "cancelled"])
      : new Set<TaskOutcome>(["pass", "reject", "failed", "cancelled"]);
    if (!allowed.has(input.outcome)) throw new Error(`invalid ${role} Task outcome: ${input.outcome}`);

    this.#db.prepare(`
      UPDATE tasks
      SET status = 'finalized', outcome = ?, finalized_at = ?, commit_sha = ?, reviewed_commit = ?, summary = ?, result_json = ?
      WHERE id = ?
    `).run(
      input.outcome,
      now(),
      input.commitSha ?? null,
      input.reviewedCommit ?? null,
      input.summary,
      input.resultJson,
      input.id,
    );
  }

  getTask(id: string): Record<string, unknown> | null {
    return this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) ?? null;
  }

  statusSummary(): { projects: number; objectives: number; workItems: number; activeTasks: number; blockedWorkItems: number } {
    const count = (table: string, where = "") => {
      const row = this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get();
      return Number(row?.count ?? 0);
    };
    return {
      projects: count("projects"),
      objectives: count("objectives", "WHERE state = 'Active'"),
      workItems: count("work_items", "WHERE state NOT IN ('Done','Obsolete','Cancelled')"),
      activeTasks: count("tasks", "WHERE status = 'active'"),
      blockedWorkItems: count("work_items", "WHERE state = 'Blocked'"),
    };
  }

  snapshot(): Record<string, Array<Record<string, unknown>>> {
    const tables = ["projects", "objectives", "work_items", "objective_work_items", "relations", "tasks", "decisions", "event_log"];
    return Object.fromEntries(tables.map((table) => [table, this.#db.prepare(`SELECT * FROM ${table}`).all()]));
  }

  stopActiveObjectives(): number {
    const result = this.#db.prepare("UPDATE objectives SET state = 'Stopped', updated_at = ? WHERE state = 'Active'").run(now());
    return Number(result.changes);
  }

  appendEvent(entityType: string, entityId: string, eventType: string, payload: unknown): void {
    this.#db.prepare(`
      INSERT INTO event_log(entity_type, entity_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(entityType, entityId, eventType, JSON.stringify(payload), now());
  }
}
