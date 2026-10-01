import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MerroConfig } from "../config.js";
import { priorityRank, type Objective, type ObjectiveIssueScope, type Priority, type Project, type Relation, type Task, type TaskRole, type WorkItem } from "../domain/model.js";
import { matchesIssueScope, parseObjectiveIssueScopes } from "../domain/objective.js";
import { assertProjectSlug } from "../domain/project.js";
import { findRequiresCycle } from "../domain/relations.js";
import { schedule } from "../domain/scheduler.js";
import { assertResultMatchesTask, parseImplementResult, parseReviewResult, type ImplementFailedResult, type ImplementSuccessResult, type ReviewFailedResult, type ReviewResult, type Verification, type WorkerResult } from "../protocol/result.js";
import { GitHubClient, GitHubMergeError, type BranchPolicy, type GitHubIssue, type GitHubPullRequest } from "../github/client.js";
import { MerroStore } from "../store/store.js";
import type { TaskRuntimeRecord, WorkItemRuntimeRecord } from "../store/model.js";
import { renderTaskFile } from "./task-file.js";
import { MainLock } from "./main-lock.js";
import { systemCommandRunner, type CommandRunner } from "./commands.js";
import { WorkerRuntime, type WorkerPresence } from "./worker-runtime.js";
import { GitClient } from "../vcs/git.js";

type GitAdapter = Pick<GitClient, "discoverProject" | "createWorkItemClone" | "currentCommit" | "validateTaskCommit" | "pushBranch" | "fetchBaseCommit" | "syncBranchHead" | "effectiveDiffFingerprint">
  & Partial<Pick<GitClient, "remoteBranchCommit" | "ensureWorkItemClone" | "createReadOnlyCheckout" | "deleteClone">>;
type GitHubAdapter = Pick<GitHubClient, "repository" | "repositoryInDirectory" | "listOpenIssues" | "issue" | "createPullRequest" | "pullRequest" | "branchProtection" | "hasWritePermission" | "mergeSquash" | "syncPullRequestContent">
  & Partial<Pick<GitHubClient, "findPullRequest">>;
type WorkerAdapter = Pick<WorkerRuntime, "prepareClone" | "launch" | "inspect" | "cleanup">
  & Partial<Pick<WorkerRuntime, "plan" | "stop">>;

export interface MainOptions {
  workspacePath: string;
  config: MerroConfig;
  commands?: CommandRunner;
  git?: GitAdapter;
  github?: GitHubAdapter;
  workers?: WorkerAdapter;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

export interface ObjectiveStartInput {
  goal: string;
  projectSlugs: string[];
  issues: ObjectiveIssueScope[];
  priority?: Priority;
  maxReviewRounds?: number | "unlimited";
}

const emptyRuntime = (workItemId: string): WorkItemRuntimeRecord => ({
  workItemId, branchName: null, clonePath: null, baseCommit: null,
  pullRequestNumber: null, pullRequestUrl: null, pullRequestState: null,
  pullRequestHeadSha: null, pullRequestBaseSha: null, mergedCommitSha: null,
  lastIssueState: null, reviewedDiffHash: null, reviewRound: 0,
  infrastructureRetries: 0, implementationAttempt: 0, lastReworkTrigger: null, lastReconciledAt: null,
});

function sourceId(projectSlug: string, number: number, generation: number): string {
  return `${projectSlug}:issue-${number}:g${generation}`;
}

function branchName(issue: GitHubIssue, generation: number): string {
  const kind = issue.labels.some((label) => /bug|defect/i.test(label)) ? "fix"
    : issue.labels.some((label) => /feature|enhancement/i.test(label)) ? "feat" : "chore";
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "work";
  return `${kind}/${slug}-${issue.number}-g${generation}`;
}

function verificationText(entries: readonly Verification[]): string {
  const commands = [...new Set(entries.filter((entry) => entry.kind === "command" && entry.exit_code === 0)
    .map((entry) => entry.kind === "command" ? `- \`${entry.project}\`: \`${entry.command}\` (cwd \`${entry.cwd}\`)` : ""))];
  const manuals = entries.filter((entry) => entry.kind === "manual").map((entry) => entry.kind === "manual" ? `- \`${entry.project}\`: ${entry.summary}` : "");
  return [...commands, ...manuals].join("\n") || "- No verification recorded.";
}

function issueBody(item: WorkItem, summary: string, verification: string): string {
  const closes = item.sourceType === "issue" ? `\n\n## Issues\n\nCloses #${item.sourceRef}` : "";
  return `## Summary\n\n${summary}\n\n## Verification\n\n${verification}${closes}`;
}

function ensureMarkdownSection(body: string, title: string, content: string): string {
  const heading = `## ${title}`;
  if (body.split(/\r?\n/).some((line) => line.trim() === heading)) return body.trim();
  return `${body.trim()}\n\n${heading}\n\n${content}`.trim();
}

function reconcilePullRequestBody(body: string, item: WorkItem, verification: string): string {
  let updated = ensureMarkdownSection(body, "Verification", verification);
  if (item.sourceType !== "issue") return updated;
  const lines = updated.split(/\r?\n/);
  let issuesStart = lines.findIndex((line) => line.trim() === "## Issues");
  if (issuesStart < 0) {
    lines.push("", "## Issues");
    issuesStart = lines.length - 1;
  }
  let issuesEnd = issuesStart + 1;
  while (issuesEnd < lines.length && !/^##\s/.test(lines[issuesEnd] ?? "")) issuesEnd += 1;
  if (lines.slice(issuesStart + 1, issuesEnd).some((line) => new RegExp(`^Closes\\s+#${item.sourceRef}\\s*$`, "i").test(line.trim()))) {
    return lines.join("\n").trim();
  }
  lines.splice(issuesEnd, 0, "", `Closes #${item.sourceRef}`);
  return lines.join("\n").trim();
}

function finalVerification(store: MerroStore, item: WorkItem, review: ReviewResult): string {
  const implementation = store.listTasks(item.id).reverse().find((task) =>
    task.role === "implement" && task.outcome === "success" && task.resultJson !== null,
  );
  let implementationVerification: Verification[] = [];
  if (implementation?.resultJson) {
    try {
      const result = parseImplementResult(JSON.parse(implementation.resultJson));
      if (result.status === "success") implementationVerification = result.verification;
    } catch {
      implementationVerification = [];
    }
  }
  if (implementationVerification.length === 0) return verificationText(review.verification);
  return `### Implementer\n${verificationText(implementationVerification)}\n\n### Reviewer\n${verificationText(review.verification)}`;
}

function finalMergeSummary(
  store: MerroStore,
  item: WorkItem,
  runtime: WorkItemRuntimeRecord,
  pullRequest: GitHubPullRequest,
): Record<string, unknown> {
  const tasks = store.listTasks(item.id);
  return {
    workItem: {
      id: item.id,
      projectSlug: item.projectSlug,
      sourceType: item.sourceType,
      sourceRef: item.sourceRef,
      generation: item.generation,
    },
    diff: {
      baseRefOid: pullRequest.baseRefOid,
      headRefOid: pullRequest.headRefOid,
      effectiveFingerprint: runtime.reviewedDiffHash,
    },
    pullRequest: {
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      baseRefName: pullRequest.baseRefName,
      baseRefOid: pullRequest.baseRefOid,
      headRefName: pullRequest.headRefName,
      headRefOid: pullRequest.headRefOid,
      mergedAt: pullRequest.mergedAt,
      mergeCommitSha: pullRequest.mergeCommitSha,
    },
    implementerSummaries: tasks.filter((task) => task.role === "implement" && task.outcome === "success")
      .map((task) => ({ attempt: task.attempt, summary: task.summary, commitSha: task.commitSha })),
    reviewerOutcomes: tasks.filter((task) => task.role === "review")
      .map((task) => ({ attempt: task.attempt, outcome: task.outcome, summary: task.summary, reviewedCommit: task.reviewedCommit })),
  };
}

function reviewNotes(review: ReviewResult): string {
  const findings = review.findings.filter((finding) => finding.severity !== "blocking");
  const notes = findings.length > 0
    ? findings.map((finding) => `- **${finding.severity}**: ${finding.summary}`).join("\n")
    : "- None.";
  return `<!-- merro:review-notes -->\n\n## Review\n\n${review.summary}\n\n## Verification\n\n${verificationText(review.verification)}\n\n## Non-blocking findings and notes\n\n${notes}`;
}

function terminal(item: WorkItem): boolean {
  return item.state === "Done" || item.state === "Obsolete" || item.state === "Cancelled";
}

function remoteRepositoryIdentity(remote: string): string | null {
  const value = remote.trim();
  const ssh = value.match(/^([^@]+@)?([^:]+):(.+)$/);
  if (ssh && !value.includes("://")) {
    return `${ssh[2]?.toLowerCase()}/${ssh[3]?.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "").toLowerCase()}`;
  }
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
    return path ? `${url.hostname.toLowerCase()}/${path.toLowerCase()}` : null;
  } catch {
    return null;
  }
}

function sameRemoteRepository(current: string, discovered: string): boolean {
  if (current === discovered) return true;
  const currentIdentity = remoteRepositoryIdentity(current);
  const discoveredIdentity = remoteRepositoryIdentity(discovered);
  return currentIdentity !== null && currentIdentity === discoveredIdentity;
}

function requiredCheckFailed(pullRequest: GitHubPullRequest, policy: BranchPolicy): boolean {
  if (!policy.known) return false;
  const failures = new Set(["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"]);
  return policy.requiredStatusChecks.some((name) => pullRequest.checks.some((check) =>
    check.name === name
      && (failures.has(check.state.toUpperCase()) || (check.conclusion !== null && failures.has(check.conclusion.toUpperCase()))),
  ));
}

async function satisfiesBranchPolicy(
  pullRequest: GitHubPullRequest,
  policy: BranchPolicy,
  hasWritePermission: (username: string) => Promise<boolean>,
): Promise<boolean> {
  const reviewDecision = pullRequest.reviewDecision?.toUpperCase();
  if (!policy.known || reviewDecision === "CHANGES_REQUESTED") return false;
  const successfulConclusions = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
  const checksReady = policy.requiredStatusChecks.every((name) => pullRequest.checks.some((check) => {
    const state = check.state.toUpperCase();
    return check.name === name && (successfulConclusions.has(state)
      || state === "COMPLETED" && check.conclusion !== null && successfulConclusions.has(check.conclusion.toUpperCase()));
  }));
  const latestReviewByAuthor = new Map<string, { author: string; state: string; commitId: string | null; submittedAt: string; index: number }>();
  pullRequest.reviews.forEach((review, index) => {
    const author = review.author.trim();
    if (!author) return;
    const key = author.toLowerCase();
    const latest = latestReviewByAuthor.get(key);
    const submittedAt = review.submittedAt ?? "";
    if (!latest || submittedAt > latest.submittedAt || submittedAt === latest.submittedAt && index > latest.index) {
      latestReviewByAuthor.set(key, { author, state: review.state, commitId: review.commitId, submittedAt, index });
    }
  });
  const authorLogin = pullRequest.authorLogin?.toLowerCase();
  let eligibleApprovals = 0;
  if (policy.requiredApprovingReviewCount > 0) {
    for (const review of latestReviewByAuthor.values()) {
      if (review.state.toUpperCase() !== "APPROVED"
        || review.author.toLowerCase() === authorLogin
        || policy.dismissStaleApprovals && review.commitId !== pullRequest.headRefOid) continue;
      if (await hasWritePermission(review.author)) eligibleApprovals += 1;
      if (eligibleApprovals >= policy.requiredApprovingReviewCount) break;
    }
  }
  const approvalsReady = eligibleApprovals >= policy.requiredApprovingReviewCount;
  const codeOwnersReady = !policy.requireCodeOwnerReviews || reviewDecision === "APPROVED";
  return pullRequest.state === "OPEN" && !pullRequest.isDraft
    && pullRequest.mergeable === "MERGEABLE" && checksReady && approvalsReady && codeOwnersReady;
}

function changeRequestTrigger(pullRequest: GitHubPullRequest): string | null {
  if (pullRequest.reviewDecision?.toUpperCase() !== "CHANGES_REQUESTED") return null;
  const latestReview = pullRequest.reviews
    .map((review, index) => ({ review, index }))
    .filter(({ review }) => review.state.toUpperCase() === "CHANGES_REQUESTED")
    .sort((left, right) => (left.review.submittedAt ?? "").localeCompare(right.review.submittedAt ?? "") || left.index - right.index)
    .at(-1)?.review;
  if (!latestReview) return null;
  const identity = latestReview.id ?? JSON.stringify([
    latestReview.author,
    latestReview.submittedAt,
    latestReview.commitId,
    latestReview.state.toUpperCase(),
  ]);
  if (!latestReview.id && !latestReview.author && !latestReview.submittedAt && !latestReview.commitId) return null;
  return `review:${pullRequest.number}:${identity}:head:${latestReview.commitId ?? "unknown"}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCommitSha(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{40,64}$/i.test(value);
}

export class MainOrchestrator {
  readonly #workspacePath: string;
  readonly #stateDirectory: string;
  readonly #workRoot: string;
  readonly #config: MerroConfig;
  readonly #notify: (message: string, level?: "info" | "warning" | "error") => void;
  readonly #git: GitAdapter;
  readonly #github: GitHubAdapter;
  readonly #workers: WorkerAdapter;
  readonly #commands: CommandRunner;
  readonly #pendingNotifications: Array<{ event: string; subjectId: string; message: string }> = [];

  constructor(options: MainOptions) {
    this.#workspacePath = resolve(options.workspacePath);
    this.#stateDirectory = join(this.#workspacePath, ".merro");
    this.#workRoot = resolve(options.config.work_root ?? `${this.#workspacePath}-work`);
    this.#config = options.config;
    this.#notify = options.notify ?? ((message) => console.log(message));
    const commands = options.commands ?? systemCommandRunner;
    this.#commands = commands;
    this.#git = options.git ?? new GitClient(commands);
    this.#github = options.github ?? new GitHubClient(commands);
    this.#workers = options.workers ?? new WorkerRuntime({ workspacePath: join(this.#stateDirectory, "runtime"), config: options.config, commands });
  }

  async listProjects(): Promise<Project[]> {
    return this.#withStore((store) => store.listProjects());
  }

  async discoverIssues(projectSlug: string): Promise<GitHubIssue[]> {
    const project = await this.#withStore((store) => {
      const registered = store.getProject(projectSlug);
      if (!registered) throw new Error(`unknown Project: ${projectSlug}`);
      return registered;
    });
    return this.#github.listOpenIssues(project);
  }

  async statusSnapshot(): Promise<{ projects: Project[]; objectives: Objective[]; workItems: WorkItem[]; tasks: Task[]; decisions: ReturnType<MerroStore["pendingDecisions"]> }> {
    return this.#withStore((store) => ({
      projects: store.listProjects(),
      objectives: store.listObjectives(),
      workItems: store.listWorkItems(),
      tasks: store.listTasks(),
      decisions: store.pendingDecisions(),
    }));
  }

  async updateRelations(relations: readonly Relation[]): Promise<void> {
    await this.#withStore((store) => {
      for (const relation of relations) {
        if (!store.getWorkItem(relation.from)) throw new Error(`unknown WorkItem in relation: ${relation.from}`);
        if (!store.getWorkItem(relation.to)) throw new Error(`unknown WorkItem in relation: ${relation.to}`);
      }
      store.replaceRelations(relations);
    });
    await this.runPass();
  }

  async addProject(path: string, slug: string): Promise<Project> {
    assertProjectSlug(slug);
    const projectPath = resolve(path);
    const gitProject = await this.#git.discoverProject(projectPath, slug);
    const repository = await this.#github.repositoryInDirectory(projectPath);
    const project: Project = { ...gitProject, defaultBranch: repository.defaultBranch };
    return this.#withStore((store) => {
      const existing = store.getProject(slug);
      if (existing) {
        if (!sameRemoteRepository(existing.baseRemote, project.baseRemote) || !sameRemoteRepository(existing.pushRemote, project.pushRemote)) {
          throw new Error(`Project '${slug}' is already registered with different repository identity`);
        }
        store.updateProject(project);
        return project;
      }
      store.createProject(project);
      return project;
    });
  }

  async startObjective(input: ObjectiveStartInput): Promise<{ objective: Objective; workItems: WorkItem[] }> {
    if (!input.goal.trim()) throw new Error("Objective goal must not be empty");
    if (input.projectSlugs.length === 0) throw new Error("Objective requires at least one Project");
    return this.#withStore(async (store) => {
      const projects = input.projectSlugs.map((slug) => {
        const project = store.getProject(slug);
        if (!project) throw new Error(`unknown Project: ${slug}`);
        return project;
      });
      const issueScopes = parseObjectiveIssueScopes(input.issues, input.projectSlugs);
      if (issueScopes.length === 0) throw new Error("Objective requires an approved issue scope");
      const issueRows = new Map<string, GitHubIssue>();
      for (const scope of issueScopes) {
        const project = projects.find((candidate) => candidate.slug === scope.projectSlug)!;
        const open = await this.#github.listOpenIssues(project, "query" in scope ? scope.query : undefined);
        const selected = open.filter((issue) => issue.state.toUpperCase() === "OPEN" && matchesIssueScope(scope, issue));
        if ("numbers" in scope) {
          for (const number of scope.numbers) {
            if (!selected.some((issue) => issue.number === number)) throw new Error(`issue #${number} is not open in Project '${project.slug}'`);
          }
        }
        for (const issue of selected) issueRows.set(`${project.slug}\0${issue.number}`, issue);
      }

      const objective: Objective = {
        id: randomUUID(), goal: input.goal.trim(), priority: input.priority ?? "normal", state: "Active",
        projectSlugs: projects.map((project) => project.slug), issueScopes,
        ...(input.maxReviewRounds === undefined ? {} : { maxReviewRounds: input.maxReviewRounds }),
      };
      store.createObjective(objective);
      const items: WorkItem[] = [];
      for (const [key, issue] of issueRows) {
        const projectSlug = key.split("\0")[0] ?? "";
        items.push(this.#attachIssue(store, objective, projectSlug, issue));
      }
      this.#notify(`Objective ${objective.id} approved with ${items.length} WorkItem(s).`);
      return { objective, workItems: items };
    });
  }

  async stopObjectives(objectiveId?: string): Promise<number> {
    const stopped = await this.#withStore((store) => store.stopActiveObjectives(objectiveId));
    await this.runPass();
    return stopped;
  }

  async continueWorkItem(workItemId: string): Promise<void> {
    await this.#withStore((store) => {
      const item = store.getWorkItem(workItemId);
      if (!item || item.state !== "Blocked" || !item.blockedResumeState) throw new Error(`WorkItem ${workItemId} is not Blocked`);
      store.transitionWorkItem(item.id, item.blockedResumeState);
      const runtime = store.getWorkItemRuntime(item.id) ?? emptyRuntime(item.id);
      if (item.blockedReason === "review_cap" || item.blockedReason === "task_failed") runtime.infrastructureRetries = 0;
      if (item.blockedReason === "review_cap") runtime.reviewRound = 0;
      store.saveWorkItemRuntime(runtime);
      this.#notify(`Continued WorkItem ${workItemId}.`);
    });
    await this.runPass();
  }

  async resolveMergeDecision(decisionId: string, approved: boolean): Promise<void> {
    const decisionKind = await this.#withStore((store) => {
      const decision = store.getDecision(decisionId);
      return decision?.state === "pending" ? decision.kind : null;
    });
    if (decisionKind === "merge_conflict") {
      await this.resolveMergeConflictDecision(decisionId, approved ? "resolved" : "abandon");
      return;
    }
    if (decisionKind !== "merge") throw new Error(`pending merge Decision not found: ${decisionId}`);

    await this.#withStore(async (store) => {
      const decision = store.getDecision(decisionId);
      if (!decision || decision.state !== "pending" || decision.kind !== "merge") {
        throw new Error(`pending merge Decision not found: ${decisionId}`);
      }
      const item = store.getWorkItem(decision.subjectId);
      const runtime = item && store.getWorkItemRuntime(item.id);
      const project = item && store.getProject(item.projectSlug);
      if (!item || item.state !== "AwaitingMerge" || !runtime?.pullRequestNumber || !project) {
        throw new Error(`merge Decision ${decisionId} no longer matches an AwaitingMerge WorkItem`);
      }

      let mergeAttempted = false;
      let mergeCommandSucceeded = false;
      try {
        let pullRequest = await this.#github.pullRequest(project, runtime.pullRequestNumber);
        this.#savePullRequest(store, runtime, pullRequest);
        if (pullRequest.mergedAt) {
          if (!isCommitSha(pullRequest.mergeCommitSha)) {
            store.resolveDecision(decisionId, "resolved");
            this.#block(store, item, "github_unavailable", "Merged pull request has no valid merge commit SHA");
            return;
          }
          await this.#completeMergedWorkItem(store, item, runtime, project, pullRequest);
          store.resolveDecision(decisionId, "resolved");
          await this.#finishObjectives(store);
          return;
        }
        if (pullRequest.state !== "OPEN") {
          store.resolveDecision(decisionId, "resolved");
          this.#block(store, item, "pr_closed", "Pull request was closed without merging");
          return;
        }
        if (!approved) {
          store.resolveDecision(decisionId, "rejected");
          this.#block(store, item, "merge_rejected", "Merge rejected; PR and branch remain open");
          return;
        }

        const payload = typeof decision.payload === "object" && decision.payload !== null
          ? decision.payload as Record<string, unknown>
          : {};
        const expectedDiff = typeof payload.diffHash === "string" ? payload.diffHash : null;
        if (runtime.clonePath && runtime.branchName) {
          await this.#git.ensureWorkItemClone?.(project, runtime.clonePath, runtime.branchName, pullRequest.headRefOid);
        }
        const currentDiff = runtime.clonePath
          ? await this.#git.effectiveDiffFingerprint(project, runtime.clonePath, pullRequest.baseRefName, pullRequest.baseRefOid, pullRequest.headRefOid)
          : null;
        const latestReview = store.listTasks(item.id).reverse()
          .find((task) => task.role === "review" && task.outcome === "pass");
        const policy = await this.#github.branchProtection(project, pullRequest.baseRefName);
        const remoteHead = runtime.branchName && this.#git.remoteBranchCommit
          ? await this.#git.remoteBranchCommit(project, runtime.branchName)
          : pullRequest.headRefOid;
        const reviewHash = runtime.reviewedDiffHash
          ?? (latestReview?.reviewedCommit === pullRequest.headRefOid ? currentDiff : null);

        if (!remoteHead) {
          store.resolveDecision(decisionId, "resolved");
          this.#block(store, item, "remote_branch_deleted", `Remote branch ${runtime.branchName ?? "(unknown)"} was deleted`);
          return;
        }
        if (!currentDiff || (expectedDiff ? currentDiff !== expectedDiff : payload.headRefOid !== pullRequest.headRefOid)
          || remoteHead !== pullRequest.headRefOid || !latestReview || reviewHash !== currentDiff
          || !await satisfiesBranchPolicy(pullRequest, policy, (username) => this.#github.hasWritePermission(project, username))) {
          store.resolveDecision(decisionId, "resolved");
          runtime.reviewedDiffHash = null;
          store.saveWorkItemRuntime(runtime);
          this.#notify(`Merge approval for WorkItem ${item.id} expired because the pull request diff changed or is no longer merge-ready.`, "warning");
          return;
        }
        if (runtime.reviewedDiffHash === null) {
          runtime.reviewedDiffHash = currentDiff;
          store.saveWorkItemRuntime(runtime);
        }

        mergeAttempted = true;
        await this.#github.mergeSquash(project, runtime.pullRequestNumber, pullRequest.headRefOid);
        mergeCommandSucceeded = true;
        pullRequest = await this.#github.pullRequest(project, runtime.pullRequestNumber);
        if (!pullRequest.mergedAt) throw new Error("GitHub did not report the pull request as merged");
        if (!isCommitSha(pullRequest.mergeCommitSha)) throw new Error("GitHub did not report a valid merged commit SHA");
        await this.#completeMergedWorkItem(store, item, runtime, project, pullRequest);
        store.resolveDecision(decisionId, "approved");
      } catch (error) {
        store.resolveDecision(decisionId, "resolved");
        const unavailable = !mergeAttempted || mergeCommandSucceeded
          || (error instanceof GitHubMergeError && error.kind === "unavailable");
        const reason = unavailable ? "github_unavailable" : "merge_failed";
        this.#block(store, item, reason, `Merge ${unavailable ? "reconciliation failed" : "was rejected"}: ${errorText(error)}`);
      }
      await this.#finishObjectives(store);
    });
    await this.runPass();
  }

  async resolveMergeConflictDecision(decisionId: string, resolution: "resolved" | "abandon"): Promise<void> {
    await this.#withStore(async (store) => {
      const decision = store.getDecision(decisionId);
      if (!decision || decision.state !== "pending" || decision.kind !== "merge_conflict") {
        throw new Error(`pending merge_conflict Decision not found: ${decisionId}`);
      }
      const item = store.getWorkItem(decision.subjectId);
      const runtime = item && store.getWorkItemRuntime(item.id);
      const project = item && store.getProject(item.projectSlug);
      if (!item || item.state !== "AwaitingMerge" || !runtime?.clonePath || !runtime.branchName
        || !runtime.pullRequestNumber || !project) {
        throw new Error(`merge_conflict Decision ${decisionId} no longer matches an AwaitingMerge WorkItem`);
      }
      if (resolution === "abandon") {
        store.resolveDecision(decisionId, "rejected");
        this.#block(store, item, "merge_rejected", "Conflict resolution abandoned; the PR remains open");
        return;
      }

      const pullRequest = await this.#github.pullRequest(project, runtime.pullRequestNumber);
      this.#savePullRequest(store, runtime, pullRequest);
      if (pullRequest.mergedAt) {
        if (!isCommitSha(pullRequest.mergeCommitSha)) throw new Error("merged pull request has no valid merge commit SHA");
        await this.#completeMergedWorkItem(store, item, runtime, project, pullRequest);
        store.resolveDecision(decisionId, "resolved");
        return;
      }
      if (pullRequest.state !== "OPEN") {
        store.resolveDecision(decisionId, "resolved");
        this.#block(store, item, "pr_closed", "Pull request was closed without merging");
        return;
      }
      if (!this.#git.ensureWorkItemClone) throw new Error("Git adapter cannot restore the conflict branch");
      await this.#git.ensureWorkItemClone(project, runtime.clonePath, runtime.branchName, pullRequest.headRefOid);
      const remoteHead = this.#git.remoteBranchCommit
        ? await this.#git.remoteBranchCommit(project, runtime.branchName)
        : pullRequest.headRefOid;
      if (remoteHead !== pullRequest.headRefOid) throw new Error("remote conflict branch does not match the pull request head");
      this.#queueBaseUpdate(store, item, runtime, pullRequest);
      store.resolveDecision(decisionId, "resolved");
    });
    await this.runPass();
  }

  async runPass(): Promise<void> {
    await this.#withStore(async (store) => {
      try {
        const unavailableProjects = await this.#reconcileProjects(store);
        for (const objective of store.listObjectives()) {
          if (objective.state === "Active" && objective.issueScopes?.some((scope) => "query" in scope)) {
            await this.#refreshObjectiveScope(store, objective, unavailableProjects);
          }
        }
        await this.#reconcileIssues(store, unavailableProjects);
        await this.#reconcileTasks(store, unavailableProjects);
        await this.#reconcilePullRequests(store, unavailableProjects);
        this.#deriveReady(store, unavailableProjects);
        const tasks = store.listTasks();
        const active = tasks.filter((task) => task.status === "active");
        const items = store.listWorkItems();
        const result = schedule({
          workItems: items.filter((item) => store.hasActiveObjectiveForWorkItem(item.id) && !unavailableProjects.has(item.projectSlug)),
          relations: store.listRelations(),
          activeTaskCount: active.length,
          activeWorkItemIds: active.map((task) => task.workItemId),
          maxConcurrentTasks: this.#config.max_concurrent_tasks,
        });
        if (result.cycle) this.#blockCycle(store, result.cycle, new Set(active.map((task) => task.workItemId)));
        for (const item of result.selected) {
          if (item.state === "Ready") store.transitionWorkItem(item.id, "Implementing");
          await this.#launchTask(store, store.getWorkItem(item.id) ?? item);
        }
        await this.#finishObjectives(store, unavailableProjects);
      } finally {
        await this.#reconcileFinalizedTasks(store);
      }
    });
  }

  async #withStore<T>(action: (store: MerroStore) => T | Promise<T>): Promise<T> {
    await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
    const lock = new MainLock(join(this.#stateDirectory, "main.lock.db"));
    await lock.acquire();
    let store: MerroStore | undefined;
    try {
      store = new MerroStore(join(this.#stateDirectory, "state.db"));
      return await action(store);
    } finally {
      try {
        store?.close();
      } finally {
        await lock.release();
        const notifications = this.#pendingNotifications.splice(0);
        for (const notification of notifications) {
          try {
            await this.#commands.run("bash", ["-lc", this.#config.notify_command!], {
              cwd: this.#workspacePath,
              env: { MERRO_EVENT: notification.event, MERRO_SUBJECT_ID: notification.subjectId, MERRO_MESSAGE: notification.message },
            });
          } catch (error) {
            this.#notify(`notify_command failed: ${errorText(error)}`, "warning");
          }
        }
      }
    }
  }

  async #launchTask(store: MerroStore, item: WorkItem): Promise<void> {
    const role: TaskRole = item.state === "Reviewing" ? "review" : "implement";
    const project = store.getProject(item.projectSlug);
    if (!project) return this.#block(store, item, "project_unavailable", `Project ${item.projectSlug} is not registered`);
    let runtime = store.getWorkItemRuntime(item.id) ?? emptyRuntime(item.id);
    const taskId = randomUUID();
    let expectedCommit: string;
    let runtimeIntent: TaskRuntimeRecord | null = null;
    let workerLaunchStarted = false;
    try {
      assertProjectSlug(project.slug);
      if (item.id === "." || item.id === ".." || /[/\\\\]/.test(item.id)) throw new Error(`invalid WorkItem path identity: ${item.id}`);
      const issue = item.sourceType === "issue" ? await this.#github.issue(project, Number(item.sourceRef)) : null;
      if (!runtime.clonePath || !runtime.branchName) {
        const localSlug = item.sourceRef.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "work";
        const branch = issue ? branchName(issue, item.generation) : `chore/local-${localSlug}-g${item.generation}`;
        const clonePath = join(this.#workRoot, project.slug, item.id);
        const clone = await this.#git.createWorkItemClone(project, clonePath, branch);
        runtime = { ...runtime, branchName: clone.branchName, clonePath: clone.path, baseCommit: clone.baseCommit };
        store.saveWorkItemRuntime(runtime);
        await this.#workers.prepareClone(project, clone.path, store.getProjectSettings(project.slug));
      }
      const clonePath = runtime.clonePath;
      if (!clonePath) throw new Error("WorkItem clone path is unavailable");
      const baseUpdate = role === "implement" ? runtime.baseUpdate ?? null : null;
      if (baseUpdate) await this.#git.fetchBaseCommit(clonePath, baseUpdate.baseRefName, baseUpdate.baseCommit);
      expectedCommit = await this.#git.currentCommit(clonePath);
      const objective = store.listObjectives().find((candidate) => store.listWorkItems(candidate.id).some((workItem) => workItem.id === item.id));
      if (!objective) throw new Error(`WorkItem ${item.id} is not attached to an Objective`);
      const previousReview = store.listTasks(item.id).reverse().find((task) => task.role === "review" && task.resultJson);
      const latestReview = previousReview?.resultJson ? this.#reviewContext(previousReview.resultJson) : null;
      const instructions = await this.#repositoryInstructions(clonePath);
      const directDependencies = store.listRelations().filter((relation) => relation.kind === "Requires" && relation.from === item.id)
        .flatMap((relation) => {
          const dependency = store.getWorkItem(relation.to);
          if (!dependency || dependency.state !== "Done") return [];
          const depRuntime = store.getWorkItemRuntime(dependency.id);
          const summary = store.listTasks(dependency.id).reverse().find((task) => task.role === "review" && task.summary)?.summary ?? null;
          return [{
            workItemId: dependency.id,
            projectSlug: dependency.projectSlug,
            project: store.getProject(dependency.projectSlug),
            pullRequestUrl: depRuntime?.pullRequestUrl ?? null,
            commit: depRuntime?.mergedCommitSha ?? null,
            summary,
          }];
        });
      const projectSettings = store.getProjectSettings(project.slug);
      const useDocker = (projectSettings?.sandbox ?? this.#config.sandbox) === "docker";
      const dependencyMounts = role === "review" ? directDependencies.map((dependency, index) => {
        if (!dependency.project) throw new Error(`dependency Project ${dependency.projectSlug} is not registered`);
        if (!dependency.commit || !/^[0-9a-f]{40,64}$/i.test(dependency.commit)) {
          throw new Error(`dependency WorkItem ${dependency.workItemId} has no exact merged commit`);
        }
        const mountNumber = index + 1;
        return {
          project: dependency.project,
          commit: dependency.commit,
          mount: {
            projectSlug: dependency.projectSlug,
            checkoutPath: join(this.#stateDirectory, "runtime", "tasks", taskId, "dependencies", String(mountNumber)),
            mountPath: `/merro-dependencies/${mountNumber}`,
          },
        };
      }) : [];
      const dependencyContext = directDependencies.map((dependency, index) => ({
        workItemId: dependency.workItemId,
        projectSlug: dependency.projectSlug,
        pullRequestUrl: dependency.pullRequestUrl,
        commit: dependency.commit,
        summary: dependency.summary,
        ...(dependencyMounts[index] ? {
          checkoutPath: useDocker ? dependencyMounts[index]!.mount.mountPath : dependencyMounts[index]!.mount.checkoutPath,
        } : {}),
      }));
      const taskFile = renderTaskFile({
        role, taskId, workItemId: item.id, projectSlug: item.projectSlug,
        sourceType: item.sourceType, sourceRef: item.sourceRef,
        title: issue?.title ?? item.sourceRef, scope: issue?.body ?? item.guidance ?? objective.goal,
        objective: { id: objective.id, goal: objective.goal },
        userGuidance: item.guidance ?? "",
        projectGuidance: projectSettings?.guidance ?? "",
        repositoryInstructions: instructions,
        dependencies: dependencyContext, latestReview, expectedCommit, baseUpdate,
      });
      const previousTasks = store.listTasks(item.id).filter((task) => task.role === role);
      const attempt = previousTasks.reduce((highest, task) => Math.max(highest, task.attempt), 0) + 1;
      const launchInput = {
        taskId, workItemId: item.id, role, project, clonePath,
        taskFile, expectedCommit, baseUpdate, projectSettings, dependencies: dependencyMounts.map(({ mount }) => mount),
      };
      runtimeIntent = this.#workers.plan?.(launchInput) ?? {
        taskId,
        runtimeKind: null,
        tmuxSession: `merro-${project.slug}`,
        tmuxWindow: `${role}-${taskId}`,
        paneId: null,
        containerId: null,
        processPid: null,
        processStartedAt: null,
        clonePath,
        taskFilePath: join(clonePath, ".merro-task.md"),
        resultPath: join(this.#stateDirectory, "runtime", "tasks", taskId, ".merro-result.json"),
        expectedCommit, ...(baseUpdate ? { baseUpdate } : {}),
        startedAt: new Date().toISOString(),
      } satisfies TaskRuntimeRecord;
      store.createTask({ id: taskId, workItemId: item.id, role, attempt, runtime: runtimeIntent });
      if (role === "implement") {
        runtime.implementationAttempt = attempt;
        store.saveWorkItemRuntime(runtime);
      }
      for (const dependency of dependencyMounts) {
        if (!this.#git.createReadOnlyCheckout) throw new Error("Git adapter cannot create dependency review checkouts");
        await this.#git.createReadOnlyCheckout(dependency.project, dependency.mount.checkoutPath, dependency.commit);
      }
      workerLaunchStarted = true;
      const record = await this.#workers.launch(launchInput, runtimeIntent);
      runtimeIntent = record;
      store.saveTaskRuntime(record);
    } catch (error) {
      if (runtimeIntent) {
        try {
          if (workerLaunchStarted) {
            if (!this.#workers.stop) throw new Error("worker stop is unavailable");
            await this.#workers.stop(runtimeIntent, taskId);
          }
        } catch (stopError) {
          this.#block(store, store.getWorkItem(item.id) ?? item, "task_failed", `Worker launch failed; Task remains active until it can be stopped safely: ${errorText(stopError)}`);
          return;
        }
        await this.#workers.cleanup(runtimeIntent).catch((cleanupError: unknown) => {
          this.#notify(`Could not clean up failed Task ${taskId}: ${errorText(cleanupError)}`, "warning");
        });
      }
      const task = store.getTask(taskId);
      if (task?.status === "active") store.finalizeTask({
        id: taskId, outcome: "failed", summary: "Worker launch failed", resultJson: JSON.stringify({ error: errorText(error) }),
      });
      const current = store.getWorkItem(item.id);
      if (current) this.#block(store, current, "task_failed", `Could not start ${role} Task: ${errorText(error)}`);
    }
  }

  async #reconcileProjects(store: MerroStore): Promise<Set<string>> {
    const unavailable = new Set<string>();
    for (const current of store.listProjects()) {
      try {
        const discovered = await this.#git.discoverProject(current.path, current.slug);
        if (!sameRemoteRepository(current.baseRemote, discovered.baseRemote)
          || !sameRemoteRepository(current.pushRemote, discovered.pushRemote)) {
          throw new Error("Git remotes now identify a different repository; explicit confirmation is required");
        }
        const repository = await this.#github.repository(discovered.baseRemote);
        const reconciled = { ...discovered, defaultBranch: repository.defaultBranch };
        store.updateProject(reconciled);
        for (const item of store.listWorkItems().filter((candidate) => candidate.projectSlug === current.slug)) {
          if (item.state === "Blocked" && item.blockedReason === "project_unavailable" && item.blockedResumeState) {
            store.transitionWorkItem(item.id, item.blockedResumeState);
          }
        }
      } catch (error) {
        unavailable.add(current.slug);
        for (const item of store.listWorkItems().filter((candidate) => candidate.projectSlug === current.slug)) {
          if (!terminal(item) && item.state !== "Blocked") {
            this.#block(store, item, "project_unavailable", `Project reconciliation failed: ${errorText(error)}`);
          }
        }
        this.#notify(`Project ${current.slug} is unavailable: ${errorText(error)}`, "warning");
      }
    }
    return unavailable;
  }

  async #reconcileIssues(store: MerroStore, unavailableProjects: ReadonlySet<string>): Promise<void> {
    for (let item of store.listWorkItems()) {
      if (unavailableProjects.has(item.projectSlug)
        || item.sourceType !== "issue" || !store.hasActiveObjectiveForWorkItem(item.id) && !store.activeTask(item.id)) continue;
      const project = store.getProject(item.projectSlug);
      if (!project) continue;
      try {
        const issue = await this.#github.issue(project, Number(item.sourceRef));
        const state = issue.state.toUpperCase();
        if (state !== "OPEN" && state !== "CLOSED") throw new Error(`GitHub returned unsupported issue state '${issue.state}' for #${issue.number}`);
        const runtime = store.getWorkItemRuntime(item.id) ?? emptyRuntime(item.id);
        const previousState = runtime.lastIssueState;
        runtime.lastIssueState = state;
        store.saveWorkItemRuntime(runtime);

        if (state === "OPEN" && item.state === "Blocked" && item.blockedReason === "github_unavailable" && item.blockedResumeState) {
          store.transitionWorkItem(item.id, item.blockedResumeState);
          item = store.getWorkItem(item.id) ?? item;
        }
        if (state === "CLOSED") {
          const activeTask = store.activeTask(item.id);
          if (activeTask) await this.#cancelTaskForClosedIssue(store, item, activeTask);
          const current = store.getWorkItem(item.id);
          if (current && !terminal(current) && !runtime.pullRequestNumber && !store.activeTask(item.id)) {
            this.#completeClosedIssue(store, current);
          }
          continue;
        }
        if (previousState === "CLOSED" && item.state === "Done") this.#createReopenedIssueGeneration(store, item, issue);
      } catch (error) {
        this.#blockForGitHubUnavailable(store, item, `Issue reconciliation failed: ${errorText(error)}`);
      }
    }
  }

  async #cancelTaskForClosedIssue(store: MerroStore, item: WorkItem, task: Task): Promise<boolean> {
    const runtime = store.getTaskRuntime(task.id);
    if (!runtime) throw new Error(`Task ${task.id} has no runtime identity`);
    const presence = await this.#workers.inspect(runtime, task.id);
    if (presence.alive) {
      if (!presence.identityMatches || !this.#workers.stop) {
        throw new Error(`Task ${task.id} could not be stopped safely: ${presence.reason ?? "worker stop is unavailable"}`);
      }
      await this.#workers.stop(runtime, task.id);
    }
    store.finalizeTask({
      id: task.id,
      outcome: "cancelled",
      summary: `GitHub issue #${item.sourceRef} was closed externally`,
      resultJson: JSON.stringify({ taskId: task.id, reason: "issue_closed_externally" }),
    });
    return true;
  }

  #completeClosedIssue(store: MerroStore, item: WorkItem): void {
    if (store.activeTask(item.id)) return;
    store.completeWorkItemAfterExternalIssueClosure(item.id);
    this.#resolvePullRequestDecisions(store, item.id);
  }

  #createReopenedIssueGeneration(store: MerroStore, previous: WorkItem, issue: GitHubIssue): void {
    const owners = store.listObjectives().filter((objective) => objective.state === "Active"
      && objective.projectSlugs.includes(previous.projectSlug)
      && store.listWorkItems(objective.id).some((item) => item.id === previous.id));
    if (owners.length === 0) return;
    const existing = store.findNonTerminalWorkItem(previous.projectSlug, "issue", String(issue.number));
    if (existing) {
      for (const owner of owners) store.attachWorkItem(owner.id, existing.id);
      const priority = owners.map((owner) => owner.priority).sort((left, right) => priorityRank(left) - priorityRank(right))[0];
      if (priority && priorityRank(priority) < priorityRank(existing.priority)) store.setWorkItemPriority(existing.id, priority);
      const runtime = store.getWorkItemRuntime(existing.id) ?? emptyRuntime(existing.id);
      runtime.lastIssueState = "OPEN";
      store.saveWorkItemRuntime(runtime);
      return;
    }
    const generation = store.nextGeneration(previous.projectSlug, "issue", String(issue.number));
    const item: WorkItem = {
      id: sourceId(previous.projectSlug, issue.number, generation),
      projectSlug: previous.projectSlug,
      sourceType: "issue",
      sourceRef: String(issue.number),
      generation,
      state: "Ready",
      priority: owners.map((owner) => owner.priority).sort((left, right) => priorityRank(left) - priorityRank(right))[0] ?? previous.priority,
      readySince: new Date().toISOString(),
      blockedReason: null,
      blockedResumeState: null,
    };
    store.createWorkItem(item);
    for (const owner of owners) store.attachWorkItem(owner.id, item.id);
    const runtime = emptyRuntime(item.id);
    runtime.lastIssueState = "OPEN";
    store.saveWorkItemRuntime(runtime);
    this.#notify(`Reopened issue #${issue.number} created WorkItem generation ${generation}.`);
  }

  async #reconcileTasks(store: MerroStore, unavailableProjects: ReadonlySet<string>): Promise<void> {
    for (const task of store.listTasks().filter((candidate) => candidate.status === "active")) {
      const item = store.getWorkItem(task.workItemId);
      if (item && unavailableProjects.has(item.projectSlug)) continue;
      const runtime = store.getTaskRuntime(task.id);
      const workRuntime = item && store.getWorkItemRuntime(item.id);
      if (!item || !runtime || !workRuntime) continue;
      if (item.sourceType === "issue" && item.state === "Blocked" && item.blockedReason === "github_unavailable") continue;
      if (workRuntime.lastIssueState === "CLOSED") {
        try {
          if (await this.#cancelTaskForClosedIssue(store, item, task) && !workRuntime.pullRequestNumber) {
            this.#completeClosedIssue(store, store.getWorkItem(item.id) ?? item);
          }
        } catch (error) {
          this.#blockForGitHubUnavailable(store, item, `Could not stop the worker for closed issue #${item.sourceRef}: ${errorText(error)}`);
        }
        continue;
      }
      let text: string;
      try {
        text = await readFile(runtime.resultPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          store.finalizeTask({ id: task.id, outcome: "failed", summary: "Invalid result file", resultJson: JSON.stringify({ error: errorText(error) }) });
          if (!this.#obsoleteIfUnowned(store, item)) {
            this.#block(store, item, "task_failed", `Cannot read Task result: ${errorText(error)}`);
          }
          continue;
        }
        let presence: WorkerPresence;
        try {
          presence = await this.#workers.inspect(runtime, task.id);
        } catch (inspectionError) {
          const detail = `Could not inspect active Task ${task.id}; reconciliation will retry: ${errorText(inspectionError)}`;
          if (item.sourceType === "issue") this.#blockForGitHubUnavailable(store, item, detail);
          else this.#notify(detail, "warning");
          continue;
        }
        if (presence.alive && presence.identityMatches) continue;
        const reason = presence.reason ?? "worker exited without a result";
        store.finalizeTask({ id: task.id, outcome: "failed", summary: reason, resultJson: JSON.stringify({ taskId: task.id, reason }) });
        if (this.#obsoleteIfUnowned(store, item)) continue;
        if (presence.alive && !presence.identityMatches) {
          this.#block(store, item, "task_failed", `Worker identity check failed: ${reason}`);
          continue;
        }
        if (workRuntime.infrastructureRetries < 1) {
          workRuntime.infrastructureRetries += 1;
          store.saveWorkItemRuntime(workRuntime);
          this.#notify(`Retrying WorkItem ${item.id} once after worker infrastructure failure.`, "warning");
        } else {
          this.#block(store, item, "task_failed", `Worker exited without a valid result after one infrastructure retry: ${reason}`);
        }
        continue;
      }
      let result: WorkerResult;
      try {
        const raw: unknown = JSON.parse(text);
        if (task.role === "implement") {
          const implementResult = parseImplementResult(raw);
          assertResultMatchesTask({ expectedTaskId: task.id, result: implementResult });
          if (implementResult.status === "success") {
            await this.#git.validateTaskCommit(runtime.clonePath, runtime.expectedCommit, implementResult.commit, runtime.baseUpdate);
          } else if (await this.#git.currentCommit(runtime.clonePath) !== implementResult.commit) {
            throw new Error(`failed result commit does not match clone HEAD: ${implementResult.commit}`);
          }
          result = implementResult;
        } else {
          const reviewResult = parseReviewResult(raw);
          assertResultMatchesTask({ expectedTaskId: task.id, expectedCommit: runtime.expectedCommit, result: reviewResult });
          result = reviewResult;
        }
      } catch (error) {
        store.finalizeTask({ id: task.id, outcome: "failed", summary: "Task result validation failed", resultJson: text });
        if (!this.#obsoleteIfUnowned(store, item)) {
          this.#block(store, item, "task_failed", `Task result validation failed: ${errorText(error)}`);
        }
        continue;
      }
      await this.#consumeResult(store, item, task, result, runtime, workRuntime);
      workRuntime.infrastructureRetries = 0;
      store.saveWorkItemRuntime(workRuntime);
    }
  }

  async #reconcileFinalizedTasks(store: MerroStore): Promise<void> {
    // Finalized Tasks remain the durable cleanup queue, including across Main restarts.
    const tasks = store.listTasks();
    const activeInputs = new Set(tasks.filter((task) => task.status === "active")
      .map((task) => store.getTaskRuntime(task.id)?.taskFilePath));
    for (const task of tasks.filter((candidate) => candidate.status === "finalized")) {
      const runtime = store.getTaskRuntime(task.id);
      if (!runtime) continue;
      let preserveResult = false;
      try {
        const raw: unknown = JSON.parse(task.resultJson ?? "null");
        preserveResult = typeof raw === "object" && raw !== null && "task_id" in raw
          && typeof raw.task_id === "string" && raw.task_id !== task.id;
      } catch {
        // Malformed output is already retained in immutable Task history.
      }
      try {
        await this.#workers.cleanup(runtime, { preserveResult, preserveTaskInput: activeInputs.has(runtime.taskFilePath) });
      } catch (error) {
        this.#notify(`Could not clean up finalized Task ${task.id}; reconciliation will retry: ${errorText(error)}`, "warning");
      }
    }
  }

  async #consumeResult(store: MerroStore, item: WorkItem, task: Task, result: WorkerResult, runtime: TaskRuntimeRecord, workRuntime: WorkItemRuntimeRecord): Promise<void> {
    const flowState = task.role === "implement" ? "Implementing" : "Reviewing";
    if (result.status !== "failed" && item.state === "Blocked" && item.blockedReason === "task_failed"
      && item.blockedResumeState === flowState) {
      // A worker whose failed launch could not be stopped can still finish its owned Task.
      store.transitionWorkItem(item.id, flowState);
      item = store.getWorkItem(item.id)!;
    }
    if (task.role === "implement") {
      const implementResult = result as ImplementSuccessResult | ImplementFailedResult;
      if (implementResult.status === "failed") {
        store.finalizeTask({ id: task.id, outcome: "failed", summary: implementResult.summary, resultJson: JSON.stringify(implementResult) });
        if (!this.#obsoleteIfUnowned(store, item)) {
          this.#block(store, item, "task_failed", `${implementResult.reason}${implementResult.diagnostics ? `: ${implementResult.diagnostics}` : ""}`);
        }
        return;
      }
      const typed = implementResult;
      store.finalizeTask({ id: task.id, outcome: "success", summary: typed.summary, resultJson: JSON.stringify(typed), commitSha: typed.commit });
      if (runtime.baseUpdate) {
        workRuntime.baseCommit = runtime.baseUpdate.baseCommit;
        workRuntime.baseUpdate = null;
        store.saveWorkItemRuntime(workRuntime);
      }
      if (!this.#obsoleteIfUnowned(store, item)) store.transitionWorkItem(item.id, "Reviewing");
      return;
    }

    const reviewResult = result as ReviewResult | ReviewFailedResult;
    if (reviewResult.status === "failed") {
      store.finalizeTask({ id: task.id, outcome: "failed", summary: reviewResult.summary, resultJson: JSON.stringify(reviewResult), reviewedCommit: reviewResult.reviewed_commit });
      if (!this.#obsoleteIfUnowned(store, item)) this.#block(store, item, "task_failed", `${reviewResult.reason}`);
      return;
    }
    const review = reviewResult;
    store.finalizeTask({ id: task.id, outcome: review.status, summary: review.summary, resultJson: JSON.stringify(review), reviewedCommit: review.reviewed_commit });
    if (this.#obsoleteIfUnowned(store, item)) return;
    if (review.status === "reject") {
      workRuntime.reviewRound += 1;
      store.saveWorkItemRuntime(workRuntime);
      store.transitionWorkItem(item.id, "Implementing");
      const limit = this.#reviewLimit(store, item);
      if (limit !== "unlimited" && workRuntime.reviewRound >= limit) {
        this.#block(store, item, "review_cap", `Reached review cap. Blocking findings:\n${review.findings.filter((finding) => finding.severity === "blocking").map((finding) => `- ${finding.summary}`).join("\n")}`);
      }
      return;
    }

    store.transitionWorkItem(item.id, "AwaitingMerge");
    try {
      const project = store.getProject(item.projectSlug);
      if (!project || !workRuntime.clonePath || !workRuntime.branchName) throw new Error("Project branch runtime is incomplete");
      await this.#git.pushBranch(project, workRuntime.clonePath, workRuntime.branchName);
      const implementation = store.listTasks(item.id).reverse().find((candidate) => candidate.role === "implement" && candidate.resultJson);
      const parsedImplementation = implementation?.resultJson ? parseImplementResult(JSON.parse(implementation.resultJson)) : null;
      const title = parsedImplementation && "pr" in parsedImplementation ? parsedImplementation.pr?.title : undefined;
      const body = issueBody(item, review.summary, finalVerification(store, item, review));
      const pullRequest = await this.#github.createPullRequest(project, workRuntime.branchName, title ?? `Work ${item.sourceRef}: ${parsedImplementation?.summary ?? review.summary}`, body);
      await this.#github.syncPullRequestContent(
        project,
        pullRequest,
        reconcilePullRequestBody(pullRequest.body, item, finalVerification(store, item, review)),
        reviewNotes(review),
      );
      workRuntime.reviewedDiffHash = await this.#git.effectiveDiffFingerprint(
        project, workRuntime.clonePath, pullRequest.baseRefName, pullRequest.baseRefOid, pullRequest.headRefOid,
      );
      workRuntime.pullRequestNumber = pullRequest.number;
      workRuntime.pullRequestUrl = pullRequest.url;
      workRuntime.pullRequestState = pullRequest.state;
      workRuntime.pullRequestHeadSha = pullRequest.headRefOid;
      workRuntime.pullRequestBaseSha = pullRequest.baseRefOid;
      workRuntime.mergedCommitSha = null;
      store.saveWorkItemRuntime(workRuntime);
    } catch (error) {
      this.#block(store, store.getWorkItem(item.id) ?? item, "github_unavailable", `Could not publish reviewed branch: ${errorText(error)}`);
    }
  }

  async #reconcilePullRequests(store: MerroStore, unavailableProjects: ReadonlySet<string>): Promise<void> {
    for (let item of store.listWorkItems()) {
      if (unavailableProjects.has(item.projectSlug)) continue;
      const recovering = item.state === "Blocked"
        && item.blockedResumeState === "AwaitingMerge"
        && (item.blockedReason === "github_unavailable" || item.blockedReason === "policy_unknown");
      const runtime = store.getWorkItemRuntime(item.id);
      const project = store.getProject(item.projectSlug);
      if (!runtime || !project) continue;
      try {
        if (item.sourceType === "issue" && runtime.lastIssueState === "CLOSED" && !terminal(item)) {
          if (store.activeTask(item.id)) continue;
          if (runtime.pullRequestNumber !== null) {
            const pullRequest = await this.#github.pullRequest(project, runtime.pullRequestNumber);
            this.#savePullRequest(store, runtime, pullRequest);
            if (pullRequest.mergedAt) {
              if (!isCommitSha(pullRequest.mergeCommitSha)) {
                this.#notify(`Merged pull request ${pullRequest.url} has no valid merge commit SHA; reconciliation will retry.`, "warning");
                continue;
              }
              await this.#completeMergedWorkItem(store, item, runtime, project, pullRequest);
              this.#resolvePullRequestDecisions(store, item.id);
              continue;
            }
          }
          this.#completeClosedIssue(store, store.getWorkItem(item.id) ?? item);
          continue;
        }
        const hasPullRequestIdentity = runtime.pullRequestNumber !== null || runtime.branchName !== null;
        const terminalOnly = item.state === "Blocked" && !recovering && hasPullRequestIdentity;
        if (item.state !== "AwaitingMerge" && !recovering && !terminalOnly) continue;
        let pullRequest: GitHubPullRequest | null = null;
        if (runtime.pullRequestNumber) {
          pullRequest = await this.#github.pullRequest(project, runtime.pullRequestNumber);
        } else if (runtime.branchName && this.#github.findPullRequest) {
          pullRequest = await this.#github.findPullRequest(project, runtime.branchName);
          if (pullRequest) {
            runtime.pullRequestNumber = pullRequest.number;
            runtime.pullRequestUrl = pullRequest.url;
            store.saveWorkItemRuntime(runtime);
            pullRequest = await this.#github.pullRequest(project, pullRequest.number);
          }
        }
        if (!pullRequest) continue;
        this.#savePullRequest(store, runtime, pullRequest);
        if (pullRequest.mergedAt) {
          if (!isCommitSha(pullRequest.mergeCommitSha)) {
            this.#notify(`Merged pull request ${pullRequest.url} has no valid merge commit SHA; reconciliation will retry.`, "warning");
            continue;
          }
          await this.#completeMergedWorkItem(store, item, runtime, project, pullRequest);
          this.#resolvePullRequestDecisions(store, item.id);
          continue;
        }
        if (pullRequest.state === "CLOSED") {
          if (item.state === "Blocked") {
            if (item.blockedReason !== "pr_closed") {
              this.#resolvePullRequestDecisions(store, item.id);
              this.#block(store, item, "pr_closed", "Pull request was closed without merging");
            }
            continue;
          }
          this.#resolvePullRequestDecisions(store, item.id);
          this.#block(store, item, "pr_closed", "Pull request was closed without merging");
          continue;
        }
        const latestReviewTask = store.listTasks(item.id).reverse()
          .find((task) => task.role === "review" && task.outcome === "pass" && task.resultJson !== null);
        const latestReview = latestReviewTask?.resultJson
          ? parseReviewResult(JSON.parse(latestReviewTask.resultJson))
          : null;
        if (pullRequest.state === "OPEN" && latestReview?.status === "pass") {
          const body = reconcilePullRequestBody(pullRequest.body, item, finalVerification(store, item, latestReview));
          await this.#github.syncPullRequestContent(project, pullRequest, body, reviewNotes(latestReview));
          pullRequest = { ...pullRequest, body };
        }
        if (terminalOnly) continue;
        if (store.pendingDecisions().some((decision) => decision.subjectId === item.id && decision.kind === "merge_conflict")) continue;
        if (runtime.branchName && this.#git.remoteBranchCommit) {
          const remoteHead = await this.#git.remoteBranchCommit(project, runtime.branchName);
          if (!remoteHead) {
            if (recovering) {
              store.transitionWorkItem(item.id, item.blockedResumeState!);
              item = store.getWorkItem(item.id) ?? item;
            }
            this.#resolveMergeDecisions(store, item.id);
            this.#block(store, item, "remote_branch_deleted", `Remote branch ${runtime.branchName} was deleted`);
            continue;
          }
          if (remoteHead !== pullRequest.headRefOid) {
            this.#resolveMergeDecisions(store, item.id);
            this.#notify(`Pull request ${pullRequest.url} head does not match its remote branch yet; reconciliation will retry.`, "warning");
            continue;
          }
        }
        if (runtime.branchName && runtime.clonePath && this.#git.ensureWorkItemClone) {
          try {
            await this.#git.ensureWorkItemClone(project, runtime.clonePath, runtime.branchName, pullRequest.headRefOid);
          } catch (error) {
            if (recovering) {
              store.transitionWorkItem(item.id, item.blockedResumeState!);
              item = store.getWorkItem(item.id) ?? item;
            }
            this.#block(store, item, "clone_lost", `Could not restore the local WorkItem clone: ${errorText(error)}`);
            continue;
          }
        }
        const policy = await this.#github.branchProtection(project, pullRequest.baseRefName);
        if (!policy.known) {
          if (recovering && item.blockedReason !== "policy_unknown") {
            store.transitionWorkItem(item.id, item.blockedResumeState!);
            item = store.getWorkItem(item.id) ?? item;
          }
          this.#block(store, item, "policy_unknown", policy.reason);
          continue;
        }
        if (recovering) {
          store.transitionWorkItem(item.id, item.blockedResumeState!);
          item = store.getWorkItem(item.id) ?? item;
        }

        if (pullRequest.mergeable === "CONFLICTING") {
          this.#resolveMergeDecisions(store, item.id);
          const decision = store.createDecision({
            id: randomUUID(), subjectType: "WorkItem", subjectId: item.id, kind: "merge_conflict",
            payload: {
              pullRequest: pullRequest.number, url: pullRequest.url,
              baseRefName: pullRequest.baseRefName, baseCommit: pullRequest.baseRefOid,
              detail: "GitHub reports conflicts with the updated base; an implementer must resolve and verify them.",
            },
          });
          this.#notify(`Base merge conflict requires a decision for ${pullRequest.url} (Decision ${decision.id}).`, "warning");
          continue;
        }
        if (runtime.baseCommit !== null && pullRequest.baseRefOid !== runtime.baseCommit) {
          this.#queueBaseUpdate(store, item, runtime, pullRequest);
          continue;
        }

        const reviewTrigger = changeRequestTrigger(pullRequest);
        const newChangeRequest = reviewTrigger !== null && reviewTrigger !== runtime.lastReworkTrigger;
        if (newChangeRequest || requiredCheckFailed(pullRequest, policy)) {
          this.#resolveMergeDecisions(store, item.id);
          if (!runtime.clonePath || !runtime.branchName || !this.#git.syncBranchHead) {
            throw new Error("cannot rework pull request: WorkItem branch runtime is incomplete");
          }
          await this.#git.syncBranchHead(project, runtime.clonePath, runtime.branchName, pullRequest.headRefOid);
          if (newChangeRequest && reviewTrigger) {
            runtime.lastReworkTrigger = reviewTrigger;
            store.markPullRequestRework(runtime);
          } else {
            store.transitionWorkItem(item.id, "Implementing");
          }
          this.#notify(`Pull request ${pullRequest.url} has a failed required check or a new change-request review; scheduling fresh implementation and review.`, "warning");
          continue;
        }
        if (!runtime.clonePath) throw new Error("cannot compare the pull request diff without a WorkItem clone");
        const currentDiffHash = await this.#git.effectiveDiffFingerprint(
          project, runtime.clonePath, pullRequest.baseRefName, pullRequest.baseRefOid, pullRequest.headRefOid,
        );
        const reviewedDiffHash = runtime.reviewedDiffHash
          ?? (latestReviewTask?.reviewedCommit === pullRequest.headRefOid ? currentDiffHash : null);
        if (!latestReview || latestReview.status !== "pass" || reviewedDiffHash !== currentDiffHash) {
          this.#resolveMergeDecisions(store, item.id);
          runtime.reviewedDiffHash = null;
          store.saveWorkItemRuntime(runtime);
          if (!runtime.clonePath || !runtime.branchName || !this.#git.syncBranchHead) {
            throw new Error("cannot re-review pull request head: WorkItem branch runtime is incomplete");
          }
          await this.#git.syncBranchHead(project, runtime.clonePath, runtime.branchName, pullRequest.headRefOid);
          store.transitionWorkItem(item.id, "Reviewing");
          this.#notify(`Pull request ${pullRequest.url} changed since its last reviewed diff; scheduling a fresh review.`, "warning");
          continue;
        }
        if (runtime.reviewedDiffHash === null) {
          runtime.reviewedDiffHash = currentDiffHash;
          store.saveWorkItemRuntime(runtime);
        }
        if (!await satisfiesBranchPolicy(pullRequest, policy, (username) => this.#github.hasWritePermission(project, username))) {
          this.#resolveMergeDecisions(store, item.id);
          continue;
        }
        const pendingDecision = store.pendingDecisions().find((decision) => decision.kind === "merge" && decision.subjectId === item.id);
        if (pendingDecision) {
          const payload = typeof pendingDecision.payload === "object" && pendingDecision.payload !== null
            ? pendingDecision.payload as Record<string, unknown>
            : {};
          if (payload.pullRequest === pullRequest.number && payload.url === pullRequest.url
            && payload.title === pullRequest.title && payload.headRefOid === pullRequest.headRefOid) continue;
          store.resolveDecision(pendingDecision.id, "resolved");
        }
        const decision = store.createDecision({
          id: randomUUID(), subjectType: "WorkItem", subjectId: item.id, kind: "merge",
          payload: {
            pullRequest: pullRequest.number,
            url: pullRequest.url,
            title: pullRequest.title,
            headRefOid: pullRequest.headRefOid,
            diffHash: currentDiffHash,
            summary: store.listTasks(item.id).filter((task) => task.role === "implement" || task.role === "review").map((task) => task.summary).filter(Boolean),
          },
        });
        const message = `Merge approval required for ${pullRequest.url} (Decision ${decision.id}).`;
        this.#notify(message);
        this.#queueNotification("merge_ready", item.id, message);
      } catch (error) {
        this.#blockForGitHubUnavailable(store, item, `GitHub reconciliation failed: ${errorText(error)}`);
      }
    }
  }

  #blockForGitHubUnavailable(store: MerroStore, item: WorkItem, detail: string): void {
    let current = store.getWorkItem(item.id) ?? item;
    this.#resolveMergeDecisions(store, current.id);
    if (terminal(current)) return;
    if (current.state === "Blocked") {
      if (current.blockedReason !== "github_unavailable" || !current.blockedResumeState) {
        this.#notify(`WorkItem ${current.id} remains blocked (${current.blockedReason ?? "unknown"}) after: ${detail}`, "warning");
        return;
      }
      store.transitionWorkItem(current.id, current.blockedResumeState);
      current = store.getWorkItem(current.id) ?? current;
    }
    this.#block(store, current, "github_unavailable", detail);
  }

  #resolveMergeDecisions(store: MerroStore, workItemId: string): void {
    for (const decision of store.pendingDecisions()) {
      if (decision.kind === "merge" && decision.subjectId === workItemId) {
        store.resolveDecision(decision.id, "resolved");
      }
    }
  }

  #resolvePullRequestDecisions(store: MerroStore, workItemId: string): void {
    for (const decision of store.pendingDecisions()) {
      if (decision.subjectId === workItemId) store.resolveDecision(decision.id, "resolved");
    }
  }

  async #completeMergedWorkItem(
    store: MerroStore,
    item: WorkItem,
    runtime: WorkItemRuntimeRecord,
    project: Project,
    pullRequest: GitHubPullRequest,
  ): Promise<void> {
    if (!pullRequest.mergedAt || !isCommitSha(pullRequest.mergeCommitSha)) {
      throw new Error("cannot finalize a pull request without confirmed merge metadata");
    }
    this.#savePullRequest(store, runtime, pullRequest);
    runtime.pullRequestState = "MERGED";
    runtime.mergedCommitSha = pullRequest.mergeCommitSha;
    store.saveWorkItemRuntime(runtime);
    const newlyCompleted = store.completeWorkItemAfterMerge(
      item.id,
      finalMergeSummary(store, item, runtime, pullRequest),
    );
    if (newlyCompleted) this.#notify(`WorkItem ${item.id} merged and Done.`);

    if (item.sourceType === "issue") {
      try {
        const issue = await this.#github.issue(project, Number(item.sourceRef));
        if (issue.state.toUpperCase() !== "CLOSED") {
          this.#notify(`GitHub issue #${item.sourceRef} remains open after merging ${pullRequest.url}; verify its Closes directive.`, "warning");
        }
      } catch (error) {
        this.#notify(`Could not verify whether GitHub issue #${item.sourceRef} closed after merging ${pullRequest.url}: ${errorText(error)}`, "warning");
      }
    }

    if (runtime.clonePath && this.#git.deleteClone) {
      try {
        await this.#git.deleteClone(this.#workRoot, runtime.clonePath);
      } catch (error) {
        this.#notify(`Could not clean up terminal WorkItem clone ${runtime.clonePath}: ${errorText(error)}`, "warning");
      }
    }
  }

  #savePullRequest(store: MerroStore, runtime: WorkItemRuntimeRecord, pr: GitHubPullRequest): void {
    runtime.pullRequestNumber = pr.number;
    runtime.pullRequestUrl = pr.url;
    runtime.pullRequestState = pr.state;
    runtime.pullRequestHeadSha = pr.headRefOid;
    runtime.pullRequestBaseSha = pr.baseRefOid;
    if (pr.mergedAt && isCommitSha(pr.mergeCommitSha)) runtime.mergedCommitSha = pr.mergeCommitSha;
    store.saveWorkItemRuntime(runtime);
  }

  #obsoleteIfUnowned(store: MerroStore, item: WorkItem): boolean {
    if (store.hasActiveObjectiveForWorkItem(item.id)) return false;
    const current = store.getWorkItem(item.id);
    if (current && !terminal(current) && !store.activeTask(item.id)) {
      store.transitionWorkItem(item.id, "Obsolete");
      this.#resolveMergeDecisions(store, item.id);
      this.#notify(`WorkItem ${item.id} is obsolete because no active Objective owns it.`);
    }
    return true;
  }

  #deriveReady(store: MerroStore, unavailableProjects: ReadonlySet<string>): void {
    const items = store.listWorkItems();
    const byId = new Map(items.map((item) => [item.id, item]));
    const relations = store.listRelations();
    const active = new Set(store.listTasks().filter((task) => task.status === "active").map((task) => task.workItemId));
    const cycle = findRequiresCycle(relations);
    if (cycle) this.#blockCycle(store, cycle, active);
    for (const item of store.listWorkItems()) {
      if (unavailableProjects.has(item.projectSlug)
        || (item.state !== "Planned" && item.state !== "Ready") || active.has(item.id)) continue;
      if (!store.hasActiveObjectiveForWorkItem(item.id)) {
        store.transitionWorkItem(item.id, "Obsolete");
        continue;
      }
      const requirements = relations.filter((relation) => relation.kind === "Requires" && relation.from === item.id);
      const ready = requirements.every((relation) => byId.get(relation.to)?.state === "Done");
      if (item.state === "Planned" && ready) store.transitionWorkItem(item.id, "Ready");
      else if (item.state === "Ready" && !ready) store.transitionWorkItem(item.id, "Planned");
    }
  }

  #blockCycle(store: MerroStore, cycle: readonly string[], active: ReadonlySet<string>): void {
    for (const id of new Set(cycle)) {
      const item = store.getWorkItem(id);
      if (!item || active.has(id) || item.state === "Blocked" || terminal(item)) continue;
      this.#block(store, item, "cycle", `Requires cycle: ${cycle.join(" -> ")}`);
    }
  }

  #block(store: MerroStore, item: WorkItem, reason: WorkItem["blockedReason"] & string, detail: string): void {
    const current = store.getWorkItem(item.id) ?? item;
    const changed = current.state !== "Blocked" || current.blockedReason !== reason;
    if (changed) store.transitionWorkItem(item.id, "Blocked", reason);
    store.appendEvent("WorkItem", item.id, "blocked", { reason, detail });
    const dependents = store.listRelations()
      .filter((relation) => relation.kind === "Requires" && relation.to === item.id)
      .map((relation) => store.getWorkItem(relation.from))
      .filter((dependent): dependent is WorkItem => dependent !== null)
      .map((dependent) => `${dependent.id} (${dependent.state})`);
    const dependentsNote = dependents.length > 0 ? ` Direct dependents: ${dependents.join(", ")}.` : "";
    const message = `WorkItem ${item.id} blocked (${reason}): ${detail}.${dependentsNote}`;
    this.#notify(message, "warning");
    if (changed) this.#queueNotification("blocked", item.id, message);
  }

  #reviewLimit(store: MerroStore, item: WorkItem): number | "unlimited" {
    const limits = store.listObjectives()
      .filter((objective) => objective.state === "Active"
        && store.listWorkItems(objective.id).some((workItem) => workItem.id === item.id))
      .map((objective) => objective.maxReviewRounds ?? this.#config.max_review_rounds);
    if (limits.length === 0 || limits.every((limit) => limit === "unlimited")) return "unlimited";
    return Math.min(...limits.filter((limit): limit is number => limit !== "unlimited"));
  }

  #reviewContext(json: string): string {
    try {
      const result = parseReviewResult(JSON.parse(json));
      return [result.summary, ...result.findings.map((finding) => `${finding.severity}: ${finding.summary}`)].join("\n");
    } catch {
      return "Prior review result could not be parsed.";
    }
  }

  async #repositoryInstructions(clonePath: string): Promise<Array<{ path: string; text: string }>> {
    for (const path of ["AGENTS.md", "README.md"]) {
      try {
        const text = await readFile(join(clonePath, path), "utf8");
        if (text.trim()) return [{ path, text }];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return [];
  }

  #queueNotification(event: string, subjectId: string, message: string): void {
    if (this.#config.notify_command?.trim()) this.#pendingNotifications.push({ event, subjectId, message });
  }

  #queueBaseUpdate(store: MerroStore, item: WorkItem, runtime: WorkItemRuntimeRecord, pullRequest: GitHubPullRequest): void {
    if (!runtime.clonePath || !runtime.branchName || !isCommitSha(pullRequest.baseRefOid)) throw new Error("cannot schedule updated base: WorkItem runtime or base commit is invalid");
    this.#resolveMergeDecisions(store, item.id);
    runtime.baseUpdate = { baseRefName: pullRequest.baseRefName, baseCommit: pullRequest.baseRefOid };
    runtime.reviewedDiffHash = null;
    store.saveWorkItemRuntime(runtime);
    store.transitionWorkItem(item.id, "Implementing");
    this.#notify(`Scheduling an implementer to merge and verify the updated base for ${pullRequest.url}, then a fresh review.`, "warning");
  }

  #attachIssue(store: MerroStore, objective: Objective, projectSlug: string, issue: GitHubIssue): WorkItem {
    const existing = store.findNonTerminalWorkItem(projectSlug, "issue", String(issue.number));
    if (existing) {
      store.attachWorkItem(objective.id, existing.id);
      if (priorityRank(objective.priority) < priorityRank(existing.priority)) store.setWorkItemPriority(existing.id, objective.priority);
      return store.getWorkItem(existing.id)!;
    }
    const generation = store.nextGeneration(projectSlug, "issue", String(issue.number));
    const item: WorkItem = {
      id: sourceId(projectSlug, issue.number, generation), projectSlug, sourceType: "issue",
      sourceRef: String(issue.number), generation, state: "Ready", priority: objective.priority,
      readySince: new Date().toISOString(), blockedReason: null, blockedResumeState: null,
    };
    store.createWorkItem(item);
    store.attachWorkItem(objective.id, item.id);
    const runtime = emptyRuntime(item.id);
    runtime.lastIssueState = issue.state.toUpperCase();
    store.saveWorkItemRuntime(runtime);
    return item;
  }

  async #refreshObjectiveScope(store: MerroStore, objective: Objective, unavailableProjects: ReadonlySet<string> = new Set()): Promise<boolean> {
    try {
      let scopes = objective.issueScopes;
      if (scopes === undefined) {
        // Older databases record selections only through attached WorkItems. Never infer a broader query from the goal.
        const numbers = new Map<string, number[]>();
        for (const item of store.listWorkItems(objective.id)) {
          if (item.sourceType !== "issue") continue;
          const selected = numbers.get(item.projectSlug) ?? [];
          selected.push(Number(item.sourceRef));
          numbers.set(item.projectSlug, selected);
        }
        scopes = parseObjectiveIssueScopes([...numbers].map(([projectSlug, selected]) => ({ projectSlug, numbers: selected })), objective.projectSlugs);
        store.restoreObjectiveIssueScopes(objective.id, scopes);
      }
      const discovered: Array<{ projectSlug: string; issue: GitHubIssue }> = [];
      let refreshed = true;
      for (const scope of scopes) {
        try {
          const project = store.getProject(scope.projectSlug);
          if (!project || unavailableProjects.has(project.slug)) throw new Error(`Project '${scope.projectSlug}' is unavailable`);
          const issues = "query" in scope
            ? await this.#github.listOpenIssues(project, scope.query)
            : await Promise.all(scope.numbers.map((number) => this.#github.issue(project, number)));
          for (const issue of issues) {
            if (issue.state.toUpperCase() === "OPEN" && matchesIssueScope(scope, issue)) discovered.push({ projectSlug: project.slug, issue });
          }
        } catch (error) {
          refreshed = false;
          this.#notify(`Objective ${objective.id} remains Active: approved scope for Project '${scope.projectSlug}' could not be refreshed: ${errorText(error)}`, "warning");
        }
      }
      const attached = new Map<string, WorkItem>();
      for (const item of store.listWorkItems(objective.id)) {
        if (item.sourceType !== "issue") continue;
        const key = `${item.projectSlug}\0${item.sourceRef}`;
        if ((attached.get(key)?.generation ?? 0) < item.generation) attached.set(key, item);
      }
      for (const { projectSlug, issue } of discovered) {
        const key = `${projectSlug}\0${issue.number}`;
        const existing = attached.get(key);
        if (existing) {
          if ((existing.state === "Done" || existing.state === "Obsolete")
            && store.getWorkItemRuntime(existing.id)?.lastIssueState === "CLOSED") {
            this.#createReopenedIssueGeneration(store, existing, issue);
          }
          continue;
        }
        attached.set(key, this.#attachIssue(store, objective, projectSlug, issue));
      }
      return refreshed;
    } catch (error) {
      this.#notify(`Objective ${objective.id} remains Active: approved GitHub scope could not be refreshed: ${errorText(error)}`, "warning");
      return false;
    }
  }

  async #finishObjectives(store: MerroStore, unavailableProjects: ReadonlySet<string> = new Set()): Promise<void> {
    for (const objective of store.listObjectives()) {
      if (objective.state !== "Active") continue;
      const items = store.listWorkItems(objective.id);
      if (!items.every(terminal) || (items.length === 0 && !objective.issueScopes?.some((scope) => "query" in scope))) continue;
      if (!await this.#refreshObjectiveScope(store, objective, unavailableProjects)) continue;
      if (!store.listWorkItems(objective.id).every(terminal)) continue;
      store.setObjectiveState(objective.id, "Done");
      const message = `Objective ${objective.id} is Done.`;
      this.#notify(message);
      this.#queueNotification("objective_done", objective.id, message);
    }
  }
}
