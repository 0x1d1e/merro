import type { BaseUpdate, ReviewRoundLimit } from "../domain/model.js";

export type ProjectSandbox = "docker" | "none";
export type ProjectNetwork = "on" | "off";

export interface ProjectSettingsRecord {
  guidance: string;
  image: string | null;
  setupCommand: string | null;
  sandbox: ProjectSandbox | null;
  network: ProjectNetwork | null;
  workerGithub: boolean | null;
}

export interface ObjectiveSettingsRecord {
  maxReviewRounds: ReviewRoundLimit | null;
}

export interface WorkItemRuntimeRecord {
  workItemId: string;
  branchName: string | null;
  clonePath: string | null;
  // Last base verified in this branch, not the latest observed GitHub tip.
  baseCommit: string | null;
  baseUpdate?: BaseUpdate | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  pullRequestState: string | null;
  pullRequestHeadSha: string | null;
  pullRequestBaseSha: string | null;
  mergedCommitSha: string | null;
  lastIssueState: string | null;
  reviewedDiffHash: string | null;
  reviewRound: number;
  infrastructureRetries: number;
  implementationAttempt: number;
  lastReworkTrigger: string | null;
  lastReconciledAt: string | null;
}

export interface FinalSummaryRecord {
  workItemId: string;
  payload: unknown;
  createdAt: string;
}

export interface TaskRuntimeRecord {
  taskId: string;
  runtimeKind: "docker" | "host" | null;
  tmuxSession: string;
  tmuxWindow: string;
  paneId: string | null;
  containerId: string | null;
  processPid: number | null;
  processStartedAt: string | null;
  clonePath: string;
  taskFilePath: string;
  resultPath: string;
  expectedCommit: string;
  baseUpdate?: BaseUpdate | null;
  startedAt: string;
  readonly cleanupCompletedAt?: string | null;
}
