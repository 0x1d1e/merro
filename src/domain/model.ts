export type Priority = "high" | "normal" | "low";
export type ObjectiveState = "Active" | "Done" | "Stopped";
export type FlowWorkItemState = "Planned" | "Ready" | "Implementing" | "Reviewing" | "AwaitingMerge";
export type WorkItemState =
  | FlowWorkItemState
  | "Blocked"
  | "Done"
  | "Obsolete"
  | "Cancelled";
export type BlockReason =
  | "review_cap"
  | "cycle"
  | "task_failed"
  | "clone_lost"
  | "policy_unknown"
  | "github_unavailable"
  | "structural_rejected"
  | "merge_rejected"
  | "merge_failed"
  | "pr_closed"
  | "remote_branch_deleted"
  | "project_unavailable";
export type TaskRole = "implement" | "review";
export type TaskOutcome = "success" | "failed" | "cancelled" | "pass" | "reject";
export type RelationKind = "Requires" | "Conflicts";
export type RelationConfidence = "explicit" | "high";
export type ReviewRoundLimit = number | "unlimited";
export type DecisionState = "pending" | "approved" | "rejected" | "resolved";

export interface Project {
  slug: string;
  path: string;
  baseRemote: string;
  pushRemote: string;
  defaultBranch: string;
}

export interface Objective {
  id: string;
  goal: string;
  priority: Priority;
  state: ObjectiveState;
  projectSlugs: string[];
  maxReviewRounds?: ReviewRoundLimit | null;
}

export interface WorkItem {
  id: string;
  projectSlug: string;
  sourceType: "issue" | "local";
  sourceRef: string;
  generation: number;
  state: WorkItemState;
  priority: Priority;
  readySince: string | null;
  blockedReason: BlockReason | null;
  blockedResumeState: FlowWorkItemState | null;
  guidance?: string;
}

export interface Task {
  id: string;
  workItemId: string;
  role: TaskRole;
  attempt: number;
  status: "active" | "finalized";
  outcome: TaskOutcome | null;
  startedAt: string;
  finalizedAt: string | null;
  commitSha: string | null;
  reviewedCommit: string | null;
  summary: string | null;
  resultJson: string | null;
}

export interface Decision {
  id: string;
  subjectType: string;
  subjectId: string;
  kind: string;
  state: DecisionState;
  payload: unknown;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Relation {
  kind: RelationKind;
  from: string;
  to: string;
  confidence: RelationConfidence;
  rationale: string;
  evidence: string;
}

export interface SchedulingInput {
  workItems: readonly WorkItem[];
  relations: readonly Relation[];
  activeTaskCount: number;
  maxConcurrentTasks: number | "unlimited";
  activeWorkItemIds?: readonly string[];
}

export const FLOW_WORK_ITEM_STATES = new Set<FlowWorkItemState>([
  "Planned",
  "Ready",
  "Implementing",
  "Reviewing",
  "AwaitingMerge",
]);

export const TERMINAL_WORK_ITEM_STATES = new Set<WorkItemState>([
  "Done",
  "Obsolete",
  "Cancelled",
]);

export function priorityRank(priority: Priority): number {
  return priority === "high" ? 0 : priority === "normal" ? 1 : 2;
}
