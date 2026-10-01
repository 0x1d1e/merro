import { DatabaseSync } from "node:sqlite";
import {
  priorityRank,
  type BaseUpdate,
  type BlockReason,
  type Decision,
  type FlowWorkItemState,
  type Objective,
  type ObjectiveIssueScope,
  type Priority,
  type Project,
  type Relation,
  type ReviewRoundLimit,
  type Task,
  type TaskOutcome,
  type TaskRole,
  type WorkItem,
  type WorkItemState,
} from "../domain/model.js";
import { parseObjectiveIssueScopes } from "../domain/objective.js";
import { effectiveRelations, normalizeRelation } from "../domain/relations.js";
import { assertWorkItemTransition } from "../domain/work-item.js";
import type { FinalSummaryRecord, ObjectiveSettingsRecord, ProjectSettingsRecord, TaskRuntimeRecord, WorkItemRuntimeRecord } from "./model.js";
import { MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9, MIGRATION_10, MIGRATION_11, SCHEMA_VERSION } from "./schema.js";

function now(): string {
  return new Date().toISOString();
}

function projectFromRow(row: Record<string, unknown>): Project {
  return {
    slug: String(row.slug),
    path: String(row.path),
    baseRemote: String(row.base_remote),
    pushRemote: String(row.push_remote),
    defaultBranch: String(row.default_branch),
  };
}

function reviewRoundLimit(value: unknown): ReviewRoundLimit | null {
  if (value === null || value === undefined) return null;
  if (value === "unlimited") return "unlimited";
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`invalid stored review-round limit: ${String(value)}`);
  return limit;
}

function workItemFromRow(row: Record<string, unknown>): WorkItem {
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
    guidance: typeof row.guidance === "string" ? row.guidance : "",
  };
}

function taskFromRow(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    workItemId: String(row.work_item_id),
    role: row.role as TaskRole,
    attempt: Number(row.attempt),
    status: row.status as Task["status"],
    outcome: row.outcome === null ? null : row.outcome as TaskOutcome,
    startedAt: String(row.started_at),
    finalizedAt: row.finalized_at === null ? null : String(row.finalized_at),
    commitSha: row.commit_sha === null ? null : String(row.commit_sha),
    reviewedCommit: row.reviewed_commit === null ? null : String(row.reviewed_commit),
    summary: row.summary === null ? null : String(row.summary),
    resultJson: row.result_json === null ? null : String(row.result_json),
  };
}

function relationFromRow(row: Record<string, unknown>): Relation {
  return {
    kind: row.kind as Relation["kind"],
    from: String(row.from_work_item_id),
    to: String(row.to_work_item_id),
    confidence: row.confidence as Relation["confidence"],
    rationale: String(row.rationale),
    evidence: String(row.evidence),
  };
}

function decisionFromRow(row: Record<string, unknown>): Decision {
  let payload: unknown;
  try {
    payload = JSON.parse(String(row.payload_json));
  } catch (error) {
    throw new Error(`invalid Decision payload for ${String(row.id)}`, { cause: error });
  }
  return {
    id: String(row.id),
    subjectType: String(row.subject_type),
    subjectId: String(row.subject_id),
    kind: String(row.kind),
    state: row.state as Decision["state"],
    payload,
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
  };
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
    let row = this.#db.prepare("SELECT version FROM schema_meta LIMIT 1").get();
    if (!row) {
      this.#db.prepare("INSERT INTO schema_meta(version) VALUES (1)").run();
      row = { version: 1 };
    }
    let version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1 || version > SCHEMA_VERSION) {
      throw new Error(`unsupported Merro schema version ${String(row.version)}; expected 1-${SCHEMA_VERSION}`);
    }
    if (version < 2) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_2);
        this.#db.prepare("UPDATE schema_meta SET version = 2").run();
        this.#db.exec("COMMIT");
        version = 2;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 3) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_3);
        this.#db.prepare("UPDATE schema_meta SET version = 3").run();
        this.#db.exec("COMMIT");
        version = 3;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 4) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_4);
        this.#db.prepare("UPDATE schema_meta SET version = 4").run();
        this.#db.exec("COMMIT");
        version = 4;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 5) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_5);
        this.#db.prepare("UPDATE schema_meta SET version = 5").run();
        this.#db.exec("COMMIT");
        version = 5;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 6) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_6);
        this.#db.prepare("UPDATE schema_meta SET version = 6").run();
        this.#db.exec("COMMIT");
        version = 6;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 7) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_7);
        this.#db.prepare("UPDATE schema_meta SET version = 7").run();
        this.#db.exec("COMMIT");
        version = 7;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 8) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_8);
        this.#db.prepare("UPDATE schema_meta SET version = 8").run();
        this.#db.exec("COMMIT");
        version = 8;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 9) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_9);
        this.#db.prepare("UPDATE schema_meta SET version = 9").run();
        this.#db.exec("COMMIT");
        version = 9;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 10) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_10);
        this.#db.prepare("UPDATE schema_meta SET version = 10").run();
        this.#db.exec("COMMIT");
        version = 10;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 11) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_11);
        this.#db.prepare("UPDATE schema_meta SET version = 11").run();
        this.#db.exec("COMMIT");
        version = 11;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version !== SCHEMA_VERSION) {
      throw new Error(`unsupported Merro schema version ${version}; expected ${SCHEMA_VERSION}`);
    }
  }

  createProject(project: Project): void {
    this.#db.prepare(`
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(project.slug, project.path, project.baseRemote, project.pushRemote, project.defaultBranch, now());
    this.appendEvent("Project", project.slug, "created", project);
  }

  getProject(slug: string): Project | null {
    const row = this.#db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug);
    return row ? projectFromRow(row) : null;
  }

  updateProject(project: Project): void {
    const current = this.getProject(project.slug);
    if (!current) throw new Error(`unknown Project: ${project.slug}`);
    if (current.path === project.path && current.baseRemote === project.baseRemote
      && current.pushRemote === project.pushRemote && current.defaultBranch === project.defaultBranch) return;
    this.#db.prepare(`
      UPDATE projects
      SET path = ?, base_remote = ?, push_remote = ?, default_branch = ?
      WHERE slug = ?
    `).run(project.path, project.baseRemote, project.pushRemote, project.defaultBranch, project.slug);
    this.appendEvent("Project", project.slug, "reconciled", { from: current, to: project });
  }

  listProjects(): Project[] {
    return this.#db.prepare("SELECT * FROM projects ORDER BY slug").all().map(projectFromRow);
  }

  saveProjectSettings(slug: string, settings: ProjectSettingsRecord): void {
    this.#db.prepare(`
      INSERT INTO project_settings(project_slug, guidance, image, setup_command, sandbox, network, worker_github)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_slug) DO UPDATE SET
        guidance = excluded.guidance,
        image = excluded.image,
        setup_command = excluded.setup_command,
        sandbox = excluded.sandbox,
        network = excluded.network,
        worker_github = excluded.worker_github
    `).run(
      slug,
      settings.guidance,
      settings.image,
      settings.setupCommand,
      settings.sandbox,
      settings.network,
      settings.workerGithub === null ? null : Number(settings.workerGithub),
    );
    this.appendEvent("Project", slug, "settings_changed", settings);
  }

  getProjectSettings(slug: string): ProjectSettingsRecord | null {
    const row = this.#db.prepare("SELECT * FROM project_settings WHERE project_slug = ?").get(slug);
    if (!row) return null;
    return {
      guidance: String(row.guidance),
      image: row.image === null ? null : String(row.image),
      setupCommand: row.setup_command === null ? null : String(row.setup_command),
      sandbox: row.sandbox === null ? null : row.sandbox as ProjectSettingsRecord["sandbox"],
      network: row.network === null ? null : row.network as ProjectSettingsRecord["network"],
      workerGithub: row.worker_github === null ? null : Number(row.worker_github) === 1,
    };
  }

  createObjective(objective: Objective): void {
    if (objective.projectSlugs.length === 0) throw new Error("Objective requires at least one Project");
    const timestamp = now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT INTO objectives(id, goal, priority, state, created_at, updated_at, issue_scopes_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(objective.id, objective.goal, objective.priority, objective.state, timestamp, timestamp,
        objective.issueScopes === undefined ? null : JSON.stringify(parseObjectiveIssueScopes(objective.issueScopes, objective.projectSlugs)));
      const attach = this.#db.prepare("INSERT INTO objective_projects(objective_id, project_slug) VALUES (?, ?)");
      for (const slug of [...new Set(objective.projectSlugs)]) attach.run(objective.id, slug);
      if (objective.maxReviewRounds !== undefined && objective.maxReviewRounds !== null) {
        this.#db.prepare("INSERT INTO objective_settings(objective_id, max_review_rounds) VALUES (?, ?)")
          .run(objective.id, String(objective.maxReviewRounds));
      }
      this.appendEvent("Objective", objective.id, "created", objective);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  restoreObjectiveIssueScopes(id: string, scopes: ObjectiveIssueScope[]): void {
    const objective = this.getObjective(id);
    if (!objective) throw new Error(`unknown Objective: ${id}`);
    if (objective.issueScopes !== undefined) throw new Error("Objective already has approved issue scopes");
    const normalized = parseObjectiveIssueScopes(scopes, objective.projectSlugs);
    this.#db.prepare("UPDATE objectives SET issue_scopes_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(normalized), now(), id);
    this.appendEvent("Objective", id, "scope_restored", normalized);
  }

  getObjective(id: string): Objective | null {
    const row = this.#db.prepare(`
      SELECT o.*, s.max_review_rounds
      FROM objectives o LEFT JOIN objective_settings s ON s.objective_id = o.id
      WHERE o.id = ?
    `).get(id);
    return row ? this.#objectiveFromRow(row) : null;
  }

  listObjectives(): Objective[] {
    return this.#db.prepare(`
      SELECT o.*, s.max_review_rounds
      FROM objectives o LEFT JOIN objective_settings s ON s.objective_id = o.id
      ORDER BY o.created_at, o.id
    `).all().map((row) => this.#objectiveFromRow(row));
  }

  saveObjectiveSettings(id: string, settings: ObjectiveSettingsRecord): void {
    this.#db.prepare(`
      INSERT INTO objective_settings(objective_id, max_review_rounds) VALUES (?, ?)
      ON CONFLICT(objective_id) DO UPDATE SET max_review_rounds = excluded.max_review_rounds
    `).run(id, settings.maxReviewRounds === null ? null : String(settings.maxReviewRounds));
    this.appendEvent("Objective", id, "settings_changed", settings);
  }

  setObjectiveState(id: string, state: Objective["state"]): void {
    const row = this.#db.prepare("SELECT state FROM objectives WHERE id = ?").get(id);
    if (!row) throw new Error(`unknown Objective: ${id}`);
    const from = row.state as Objective["state"];
    this.#db.prepare("UPDATE objectives SET state = ?, updated_at = ? WHERE id = ?").run(state, now(), id);
    this.appendEvent("Objective", id, "state_changed", { from, to: state });
  }

  replaceRelations(relations: readonly Relation[]): void {
    const effective = effectiveRelations(relations.map(normalizeRelation));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE relations SET active = 0 WHERE active = 1").run();
      const upsert = this.#db.prepare(`
        INSERT INTO relations(kind, from_work_item_id, to_work_item_id, confidence, rationale, evidence, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(kind, from_work_item_id, to_work_item_id) DO UPDATE SET
          confidence = excluded.confidence,
          rationale = excluded.rationale,
          evidence = excluded.evidence,
          automatic = 0,
          active = 1
      `);
      for (const relation of effective) {
        upsert.run(relation.kind, relation.from, relation.to, relation.confidence, relation.rationale, relation.evidence, now());
      }
      this.appendEvent("Relations", "workspace", "replaced", effective);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  rebuildAutomaticRelations(analyzedIds: readonly string[], relations: readonly Relation[], occupiedWorkItemIds: readonly string[] = []): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const deactivate = this.#db.prepare("UPDATE relations SET active = 0 WHERE automatic = 1 AND kind = 'Requires' AND from_work_item_id = ?");
      for (const id of analyzedIds) deactivate.run(id);
      // Either endpoint may supply a symmetric relation. Preserve it until both were checked successfully.
      const analyzed = new Set(analyzedIds);
      const occupied = new Set(occupiedWorkItemIds);
      const deactivateConflict = this.#db.prepare(`
        UPDATE relations SET active = 0
        WHERE automatic = 1 AND kind = 'Conflicts' AND from_work_item_id = ? AND to_work_item_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM tasks WHERE status = 'active'
              AND work_item_id IN (relations.from_work_item_id, relations.to_work_item_id)
          )
      `);
      for (const relation of this.#db.prepare("SELECT from_work_item_id, to_work_item_id FROM relations WHERE automatic = 1 AND kind = 'Conflicts' AND active = 1").all()) {
        if (analyzed.has(String(relation.from_work_item_id)) && analyzed.has(String(relation.to_work_item_id))
          && !occupied.has(String(relation.from_work_item_id)) && !occupied.has(String(relation.to_work_item_id))) {
          deactivateConflict.run(String(relation.from_work_item_id), String(relation.to_work_item_id));
        }
      }
      const upsert = this.#db.prepare(`
        INSERT INTO relations(kind, from_work_item_id, to_work_item_id, confidence, rationale, evidence, active, automatic, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
        ON CONFLICT(kind, from_work_item_id, to_work_item_id) DO UPDATE SET
          confidence = excluded.confidence, rationale = excluded.rationale, evidence = excluded.evidence, active = 1, automatic = 1
        WHERE relations.automatic = 1 OR relations.active = 0
      `);
      for (const relation of relations.map(normalizeRelation)) {
        upsert.run(relation.kind, relation.from, relation.to, relation.confidence, relation.rationale, relation.evidence, now());
      }
      const rebuilt = this.listRelations();
      const previous = this.#db.prepare("SELECT payload_json FROM event_log WHERE entity_type = 'Relations' AND event_type = 'rebuilt' ORDER BY id DESC LIMIT 1").get();
      if (previous?.payload_json !== JSON.stringify(rebuilt)) this.appendEvent("Relations", "workspace", "rebuilt", rebuilt);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listRelations(includeInactive = false): Relation[] {
    const where = includeInactive ? "" : "WHERE active = 1";
    const relations = this.#db.prepare(`SELECT * FROM relations ${where} ORDER BY id`).all().map(relationFromRow);
    return includeInactive ? relations : effectiveRelations(relations);
  }

  createDecision(input: Omit<Decision, "createdAt" | "resolvedAt" | "state"> & { state?: Decision["state"] }): Decision {
    const decision: Decision = {
      ...input,
      state: input.state ?? "pending",
      createdAt: now(),
      resolvedAt: null,
    };
    this.#db.prepare(`
      INSERT INTO decisions(id, subject_type, subject_id, kind, state, payload_json, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id,
      decision.subjectType,
      decision.subjectId,
      decision.kind,
      decision.state,
      JSON.stringify(decision.payload),
      decision.createdAt,
      decision.resolvedAt,
    );
    this.appendEvent("Decision", decision.id, "created", decision);
    return decision;
  }

  getDecision(id: string): Decision | null {
    const row = this.#db.prepare("SELECT * FROM decisions WHERE id = ?").get(id);
    return row ? decisionFromRow(row) : null;
  }

  pendingDecisions(): Decision[] {
    return this.#db.prepare("SELECT * FROM decisions WHERE state = 'pending' ORDER BY created_at, id")
      .all().map(decisionFromRow);
  }

  resolveDecision(id: string, state: Exclude<Decision["state"], "pending">): void {
    const decision = this.getDecision(id);
    if (!decision) throw new Error(`unknown Decision: ${id}`);
    if (decision.state !== "pending") throw new Error(`Decision already resolved: ${id}`);
    const resolvedAt = now();
    this.#db.prepare("UPDATE decisions SET state = ?, resolved_at = ? WHERE id = ?").run(state, resolvedAt, id);
    this.appendEvent("Decision", id, "resolved", { state, resolvedAt });
  }

  getWorkItemRuntime(workItemId: string): WorkItemRuntimeRecord | null {
    const row = this.#db.prepare("SELECT * FROM work_item_runtime WHERE work_item_id = ?").get(workItemId);
    if (!row) return null;
    return {
      workItemId,
      branchName: row.branch_name === null ? null : String(row.branch_name),
      clonePath: row.clone_path === null ? null : String(row.clone_path),
      baseCommit: row.base_commit === null ? null : String(row.base_commit),
      ...(row.base_update_json === null ? {} : { baseUpdate: JSON.parse(String(row.base_update_json)) as BaseUpdate }),
      pullRequestNumber: row.pull_request_number === null ? null : Number(row.pull_request_number),
      pullRequestUrl: row.pull_request_url === null ? null : String(row.pull_request_url),
      pullRequestState: row.pull_request_state === null ? null : String(row.pull_request_state),
      pullRequestHeadSha: row.pull_request_head_sha === null ? null : String(row.pull_request_head_sha),
      pullRequestBaseSha: row.pull_request_base_sha === null ? null : String(row.pull_request_base_sha),
      mergedCommitSha: row.merged_commit_sha === null ? null : String(row.merged_commit_sha),
      lastIssueState: row.last_issue_state === null ? null : String(row.last_issue_state),
      reviewedDiffHash: row.reviewed_diff_hash === null ? null : String(row.reviewed_diff_hash),
      reviewRound: Number(row.review_round),
      infrastructureRetries: Number(row.infrastructure_retries),
      implementationAttempt: Number(row.implementation_attempt),
      lastReworkTrigger: row.last_rework_trigger === null ? null : String(row.last_rework_trigger),
      lastReconciledAt: row.last_reconciled_at === null ? null : String(row.last_reconciled_at),
    };
  }

  saveWorkItemRuntime(record: WorkItemRuntimeRecord): void {
    this.#db.prepare(`
      INSERT INTO work_item_runtime(
        work_item_id, branch_name, clone_path, base_commit, pull_request_number, pull_request_url,
        pull_request_state, pull_request_head_sha, pull_request_base_sha, merged_commit_sha, last_issue_state,
        reviewed_diff_hash, review_round, infrastructure_retries, implementation_attempt, last_reconciled_at,
        last_rework_trigger, base_update_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET
        branch_name = excluded.branch_name, clone_path = excluded.clone_path, base_commit = excluded.base_commit,
        pull_request_number = excluded.pull_request_number, pull_request_url = excluded.pull_request_url,
        pull_request_state = excluded.pull_request_state, pull_request_head_sha = excluded.pull_request_head_sha,
        pull_request_base_sha = excluded.pull_request_base_sha, merged_commit_sha = excluded.merged_commit_sha,
        last_issue_state = excluded.last_issue_state, reviewed_diff_hash = excluded.reviewed_diff_hash,
        review_round = excluded.review_round, infrastructure_retries = excluded.infrastructure_retries,
        implementation_attempt = excluded.implementation_attempt, last_reconciled_at = excluded.last_reconciled_at,
        last_rework_trigger = excluded.last_rework_trigger, base_update_json = excluded.base_update_json
    `).run(
      record.workItemId, record.branchName, record.clonePath, record.baseCommit, record.pullRequestNumber,
      record.pullRequestUrl, record.pullRequestState, record.pullRequestHeadSha, record.pullRequestBaseSha,
      record.mergedCommitSha, record.lastIssueState, record.reviewedDiffHash, record.reviewRound,
      record.infrastructureRetries, record.implementationAttempt, record.lastReconciledAt, record.lastReworkTrigger,
      record.baseUpdate ? JSON.stringify(record.baseUpdate) : null,
    );
  }

  markPullRequestRework(runtime: WorkItemRuntimeRecord): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getWorkItem(runtime.workItemId);
      if (!item || item.state !== "AwaitingMerge") {
        throw new Error(`WorkItem ${runtime.workItemId} is not AwaitingMerge`);
      }
      this.saveWorkItemRuntime(runtime);
      this.transitionWorkItem(item.id, "Implementing");
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getTaskRuntime(taskId: string): TaskRuntimeRecord | null {
    const row = this.#db.prepare("SELECT * FROM task_runtime WHERE task_id = ?").get(taskId);
    if (!row) return null;
    return {
      taskId,
      runtimeKind: row.runtime_kind === "docker" || row.runtime_kind === "host" ? row.runtime_kind : null,
      tmuxSession: String(row.tmux_session),
      tmuxWindow: String(row.tmux_window),
      paneId: row.pane_id === null ? null : String(row.pane_id),
      containerId: row.container_id === null ? null : String(row.container_id),
      processPid: row.process_pid === null ? null : Number(row.process_pid),
      processStartedAt: row.process_started_at === null ? null : String(row.process_started_at),
      clonePath: String(row.clone_path),
      taskFilePath: String(row.task_file_path),
      resultPath: String(row.result_path),
      expectedCommit: String(row.expected_commit),
      ...(row.base_update_json === null ? {} : { baseUpdate: JSON.parse(String(row.base_update_json)) as BaseUpdate }),
      startedAt: String(row.started_at),
    };
  }

  saveTaskRuntime(record: TaskRuntimeRecord): void {
    this.#db.prepare(`
      INSERT INTO task_runtime(task_id, tmux_session, tmux_window, pane_id, container_id, process_pid, process_started_at, clone_path, task_file_path, result_path, expected_commit, started_at, runtime_kind, base_update_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        tmux_session = excluded.tmux_session, tmux_window = excluded.tmux_window, pane_id = excluded.pane_id,
        container_id = excluded.container_id, process_pid = excluded.process_pid, process_started_at = excluded.process_started_at,
        clone_path = excluded.clone_path, task_file_path = excluded.task_file_path,
        result_path = excluded.result_path, expected_commit = excluded.expected_commit, started_at = excluded.started_at,
        runtime_kind = excluded.runtime_kind, base_update_json = excluded.base_update_json
    `).run(record.taskId, record.tmuxSession, record.tmuxWindow, record.paneId, record.containerId,
      record.processPid, record.processStartedAt, record.clonePath, record.taskFilePath, record.resultPath, record.expectedCommit, record.startedAt, record.runtimeKind, record.baseUpdate ? JSON.stringify(record.baseUpdate) : null);
  }

  #objectiveFromRow(row: Record<string, unknown>): Objective {
    const id = String(row.id);
    const projectSlugs = this.#db.prepare(`
      SELECT project_slug FROM objective_projects WHERE objective_id = ? ORDER BY project_slug
    `).all(id).map((link) => String(link.project_slug));
    return {
      id,
      goal: String(row.goal),
      priority: row.priority as Objective["priority"],
      state: row.state as Objective["state"],
      projectSlugs,
      maxReviewRounds: reviewRoundLimit(row.max_review_rounds),
      ...(row.issue_scopes_json === null ? {} : { issueScopes: parseObjectiveIssueScopes(JSON.parse(String(row.issue_scopes_json)), projectSlugs) }),
    };
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
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT INTO work_items(
          id, project_slug, source_type, source_ref, generation, state, priority,
          ready_since, blocked_reason, blocked_resume_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.id, item.projectSlug, item.sourceType, item.sourceRef, item.generation, item.state,
        item.priority, item.readySince, item.blockedReason, item.blockedResumeState, timestamp, timestamp,
      );
      this.#db.prepare("INSERT INTO work_item_settings(work_item_id, guidance) VALUES (?, ?)")
        .run(item.id, item.guidance ?? "");
      this.#db.prepare("INSERT INTO work_item_runtime(work_item_id) VALUES (?)").run(item.id);
      this.appendEvent("WorkItem", item.id, "created", item);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  findNonTerminalWorkItem(projectSlug: string, sourceType: WorkItem["sourceType"], sourceRef: string): WorkItem | null {
    const row = this.#db.prepare(`
      SELECT w.*, s.guidance FROM work_items w
      LEFT JOIN work_item_settings s ON s.work_item_id = w.id
      WHERE w.project_slug = ? AND w.source_type = ? AND w.source_ref = ?
        AND w.state NOT IN ('Done', 'Obsolete', 'Cancelled')
      ORDER BY w.generation DESC LIMIT 1
    `).get(projectSlug, sourceType, sourceRef);
    return row ? workItemFromRow(row) : null;
  }

  setWorkItemPriority(id: string, priority: WorkItem["priority"]): void {
    const item = this.getWorkItem(id);
    if (!item) throw new Error(`unknown WorkItem: ${id}`);
    if (item.state === "Done" || item.state === "Obsolete" || item.state === "Cancelled") return;
    this.#db.prepare("UPDATE work_items SET priority = ?, updated_at = ? WHERE id = ?").run(priority, now(), id);
    this.appendEvent("WorkItem", id, "priority_changed", { from: item.priority, to: priority });
  }

  nextGeneration(projectSlug: string, sourceType: WorkItem["sourceType"], sourceRef: string): number {
    const row = this.#db.prepare(`
      SELECT COALESCE(MAX(generation), 0) AS generation FROM work_items
      WHERE project_slug = ? AND source_type = ? AND source_ref = ?
    `).get(projectSlug, sourceType, sourceRef);
    return Number(row?.generation ?? 0) + 1;
  }

  listWorkItems(objectiveId?: string, inScopeOnly = false): WorkItem[] {
    const rows = objectiveId === undefined
      ? this.#db.prepare(`
          SELECT w.*, s.guidance FROM work_items w
          LEFT JOIN work_item_settings s ON s.work_item_id = w.id
          ORDER BY w.created_at, w.id
        `).all()
      : this.#db.prepare(`
          SELECT w.*, s.guidance FROM work_items w
          LEFT JOIN work_item_settings s ON s.work_item_id = w.id
          JOIN objective_work_items ow ON ow.work_item_id = w.id
          WHERE ow.objective_id = ? ${inScopeOnly ? "AND ow.in_scope = 1" : ""} ORDER BY w.created_at, w.id
        `).all(objectiveId);
    return rows.map(workItemFromRow);
  }

  saveWorkItemGuidance(id: string, guidance: string): void {
    this.#db.prepare(`
      INSERT INTO work_item_settings(work_item_id, guidance) VALUES (?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET guidance = excluded.guidance
    `).run(id, guidance);
    this.appendEvent("WorkItem", id, "guidance_changed", { guidance });
  }

  attachWorkItem(objectiveId: string, workItemId: string): void {
    const result = this.#db.prepare(`
      INSERT INTO objective_work_items(objective_id, work_item_id)
      VALUES (?, ?)
      ON CONFLICT(objective_id, work_item_id) DO UPDATE SET in_scope = 1 WHERE in_scope = 0
    `).run(objectiveId, workItemId);
    if (Number(result.changes) > 0) {
      this.appendEvent("WorkItem", workItemId, "attached_to_objective", { objectiveId });
    }
  }

  detachWorkItem(objectiveId: string, workItemId: string): void {
    // Retain the attachment until the current Task finishes, but stop counting it as ownership immediately.
    const result = this.activeTask(workItemId)
      ? this.#db.prepare("UPDATE objective_work_items SET in_scope = 0 WHERE objective_id = ? AND work_item_id = ? AND in_scope = 1").run(objectiveId, workItemId)
      : this.#db.prepare("DELETE FROM objective_work_items WHERE objective_id = ? AND work_item_id = ?").run(objectiveId, workItemId);
    if (Number(result.changes) === 0) return;
    this.appendEvent("WorkItem", workItemId, "detached_from_objective", { objectiveId, deferred: this.activeTask(workItemId) !== null });
    const item = this.getWorkItem(workItemId);
    if (!item || item.state === "Done" || item.state === "Obsolete" || item.state === "Cancelled") return;
    const priorities = this.#db.prepare(`
      SELECT o.priority FROM objectives o JOIN objective_work_items ow ON ow.objective_id = o.id
      WHERE ow.work_item_id = ? AND o.state = 'Active' AND ow.in_scope = 1
    `).all(workItemId).map((row) => row.priority as Priority);
    const highest = priorities.sort((left, right) => priorityRank(left) - priorityRank(right))[0];
    if (highest && highest !== item.priority) this.setWorkItemPriority(workItemId, highest);
  }

  settleScopeDetachments(): void {
    this.#db.prepare(`DELETE FROM objective_work_items WHERE in_scope = 0 AND NOT EXISTS (
      SELECT 1 FROM tasks WHERE tasks.work_item_id = objective_work_items.work_item_id AND tasks.status = 'active'
    )`).run();
  }

  hasActiveObjectiveForWorkItem(workItemId: string): boolean {
    return this.#db.prepare(`
      SELECT 1 FROM objective_work_items ow JOIN objectives o ON o.id = ow.objective_id
      WHERE ow.work_item_id = ? AND o.state = 'Active' AND ow.in_scope = 1 LIMIT 1
    `).get(workItemId) !== undefined;
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.#db.prepare(`
      SELECT w.*, s.guidance FROM work_items w
      LEFT JOIN work_item_settings s ON s.work_item_id = w.id
      WHERE w.id = ?
    `).get(id);
    return row ? workItemFromRow(row) : null;
  }

  getFinalSummary(workItemId: string): FinalSummaryRecord | null {
    const row = this.#db.prepare("SELECT * FROM final_summaries WHERE work_item_id = ?").get(workItemId);
    if (!row) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(String(row.payload_json));
    } catch (error) {
      throw new Error(`invalid final summary for WorkItem ${workItemId}`, { cause: error });
    }
    return { workItemId, payload, createdAt: String(row.created_at) };
  }

  listFinalSummaries(): FinalSummaryRecord[] {
    return this.#db.prepare("SELECT * FROM final_summaries ORDER BY created_at, work_item_id").all()
      .map((row) => {
        const workItemId = String(row.work_item_id);
        const summary = this.getFinalSummary(workItemId);
        if (!summary) throw new Error(`missing final summary for WorkItem ${workItemId}`);
        return summary;
      });
  }

  completeWorkItemAfterMerge(id: string, payload: unknown): boolean {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error("final summary must be JSON serializable");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getWorkItem(id);
      if (!item) throw new Error(`unknown WorkItem: ${id}`);
      const existing = this.getFinalSummary(id);
      if (existing) {
        if (item.state !== "Done") throw new Error(`WorkItem ${id} has a final summary but is not Done`);
        this.#db.exec("COMMIT");
        return false;
      }
      if (item.state !== "AwaitingMerge" && item.state !== "Blocked" && item.state !== "Done") {
        throw new Error(`WorkItem ${id} is not awaiting a pull request merge`);
      }
      if (this.activeTask(id)) throw new Error(`WorkItem ${id} still has an active Task`);
      const createdAt = now();
      this.#db.prepare("INSERT INTO final_summaries(work_item_id, payload_json, created_at) VALUES (?, ?, ?)")
        .run(id, serialized, createdAt);
      if (item.state !== "Done") {
        this.#db.prepare(`
          UPDATE work_items
          SET state = 'Done', blocked_reason = NULL, blocked_resume_state = NULL, updated_at = ?
          WHERE id = ?
        `).run(createdAt, id);
        this.appendEvent("WorkItem", id, "state_changed", {
          from: item.state,
          to: "Done",
          reason: "pull_request_merged",
          blockedReason: null,
          blockedResumeState: null,
        });
      }
      this.appendEvent("WorkItem", id, "final_summary_written", { createdAt });
      this.#db.exec("COMMIT");
      return true;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  completeWorkItemAfterExternalMerge(id: string): void {
    const item = this.getWorkItem(id);
    if (!item) throw new Error(`unknown WorkItem: ${id}`);
    if (item.state !== "AwaitingMerge" && item.state !== "Blocked") {
      throw new Error(`WorkItem ${id} is not awaiting an external pull request merge`);
    }
    if (this.activeTask(id)) throw new Error(`WorkItem ${id} still has an active Task`);
    this.#db.prepare(`
      UPDATE work_items
      SET state = 'Done', blocked_reason = NULL, blocked_resume_state = NULL, updated_at = ?
      WHERE id = ?
    `).run(now(), id);
    this.appendEvent("WorkItem", id, "state_changed", {
      from: item.state,
      to: "Done",
      reason: "pull_request_merged_externally",
      blockedReason: null,
      blockedResumeState: null,
    });
  }

  completeWorkItemAfterExternalIssueClosure(id: string): void {
    const item = this.getWorkItem(id);
    if (!item) throw new Error(`unknown WorkItem: ${id}`);
    if (item.state === "Done") return;
    if (item.state === "Obsolete" || item.state === "Cancelled") return;
    if (this.activeTask(id)) throw new Error(`WorkItem ${id} still has an active Task`);
    this.#db.prepare(`
      UPDATE work_items
      SET state = 'Done', blocked_reason = NULL, blocked_resume_state = NULL, updated_at = ?
      WHERE id = ?
    `).run(now(), id);
    this.appendEvent("WorkItem", id, "state_changed", {
      from: item.state,
      to: "Done",
      reason: "issue_closed_externally",
      blockedReason: null,
      blockedResumeState: null,
    });
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
    if (to === "Obsolete" && this.activeTask(id)) {
      throw new Error(`cannot obsolete WorkItem with an active Task: ${id}`);
    }

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
    this.appendEvent("WorkItem", id, "state_changed", {
      from: item.state,
      to,
      blockedReason: nextBlockedReason,
      blockedResumeState: nextBlockedResumeState,
    });
  }

  createTask(input: { id: string; workItemId: string; role: TaskRole; attempt: number; runtime?: TaskRuntimeRecord }): void {
    if (input.runtime && input.runtime.taskId !== input.id) {
      throw new Error("Task runtime identity does not match Task ID");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT INTO tasks(id, work_item_id, role, attempt, status, started_at)
        VALUES (?, ?, ?, ?, 'active', ?)
      `).run(input.id, input.workItemId, input.role, input.attempt, now());
      if (input.runtime) this.saveTaskRuntime(input.runtime);
      this.appendEvent("Task", input.id, "created", { ...input, runtime: undefined });
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
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
    this.appendEvent("Task", input.id, "finalized", input);
  }

  getTask(id: string): Task | null {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? taskFromRow(row) : null;
  }

  listTasks(workItemId?: string): Task[] {
    const rows = workItemId === undefined
      ? this.#db.prepare("SELECT * FROM tasks ORDER BY started_at, id").all()
      : this.#db.prepare("SELECT * FROM tasks WHERE work_item_id = ? ORDER BY started_at, id").all(workItemId);
    return rows.map(taskFromRow);
  }

  activeTask(workItemId: string): Task | null {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE work_item_id = ? AND status = 'active'").get(workItemId);
    return row ? taskFromRow(row) : null;
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
    const tables = [
      "projects", "project_settings", "objectives", "objective_projects", "objective_settings",
      "work_items", "work_item_settings", "work_item_runtime", "objective_work_items",
      "relations", "tasks", "task_runtime", "decisions", "event_log",
    ];
    return Object.fromEntries(tables.map((table) => [table, this.#db.prepare(`SELECT * FROM ${table}`).all()]));
  }

  stopActiveObjectives(objectiveId?: string): number {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const requested = objectiveId === undefined ? null : this.getObjective(objectiveId);
      if (objectiveId !== undefined && !requested) throw new Error(`unknown Objective: ${objectiveId}`);
      const objectives = requested
        ? requested.state === "Active" ? [requested] : []
        : this.listObjectives().filter((objective) => objective.state === "Active");
      const affectedWorkItemIds = new Set(objectives.flatMap((objective) =>
        this.listWorkItems(objective.id).map((item) => item.id),
      ));
      for (const objective of objectives) this.setObjectiveState(objective.id, "Stopped");

      for (const workItemId of affectedWorkItemIds) {
        const item = this.getWorkItem(workItemId);
        if (!item || item.state === "Done" || item.state === "Obsolete" || item.state === "Cancelled") continue;
        if (this.hasActiveObjectiveForWorkItem(item.id)) {
          const priorities = this.#db.prepare(`
            SELECT o.priority FROM objectives o
            JOIN objective_work_items ow ON ow.objective_id = o.id
            WHERE ow.work_item_id = ? AND o.state = 'Active' AND ow.in_scope = 1
          `).all(item.id).map((row) => row.priority as Priority);
          const highest = priorities.sort((left, right) => priorityRank(left) - priorityRank(right))[0];
          if (highest && highest !== item.priority) this.setWorkItemPriority(item.id, highest);
          continue;
        }
        if (this.activeTask(item.id)) continue;
        this.transitionWorkItem(item.id, "Obsolete");
        for (const decision of this.pendingDecisions()) {
          if ((decision.kind === "merge" || decision.kind === "merge_conflict") && decision.subjectId === item.id) {
            this.resolveDecision(decision.id, "resolved");
          }
        }
      }
      this.#db.exec("COMMIT");
      return objectives.length;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  appendEvent(entityType: string, entityId: string, eventType: string, payload: unknown): void {
    this.#db.prepare(`
      INSERT INTO event_log(entity_type, entity_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(entityType, entityId, eventType, JSON.stringify(payload), now());
  }
}
