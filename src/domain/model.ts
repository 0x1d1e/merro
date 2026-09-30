export type Priority = "high" | "normal" | "low";
export type ObjectiveState = "Active" | "Done" | "Stopped";
export type WorkItemState =
  | "Planned"
  | "Ready"
  | "Implementing"
  | "Reviewing"
  | "AwaitingMerge"
  | "Blocked"
  | "Done"
  | "Obsolete"
  | "Cancelled";
export type TaskRole = "implement" | "review";
export type TaskOutcome = "success" | "failed" | "cancelled" | "pass" | "reject";
export type RelationKind = "Requires" | "Conflicts";
export type RelationConfidence = "explicit" | "high";

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
  blockedReason: string | null;
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
}

export const TERMINAL_WORK_ITEM_STATES = new Set<WorkItemState>([
  "Done",
  "Obsolete",
  "Cancelled",
]);

export function priorityRank(priority: Priority): number {
  return priority === "high" ? 0 : priority === "normal" ? 1 : 2;
}
