import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { validateDirectory, type MerroConfig, type WorkerSettings } from "../config.js";
import { priorityRank, type Objective, type ObjectiveIssueScope, type Priority, type DeliveryMode, type Project, type Relation, type Task, type TaskRole, type ChangeSet, type BaseUpdate, type RequiresGate, type ReviewRoundLimit } from "../domain/model.js";
import { matchesIssueScope, parseObjectiveIssueScopes } from "../domain/objective.js";
import { assertProjectSlug } from "../domain/project.js";
import { analyzeIssueRelations, findRequiresCycle, normalizeRelation } from "../domain/relations.js";
import { schedule } from "../domain/scheduler.js";
import { assertResultMatchesTask, parseImplementResult, parseReviewResult, type ImplementFailedResult, type ImplementSuccessResult, type ReviewFailedResult, type ReviewResult, type Verification, type WorkerResult, type DependencySuggestion } from "../protocol/result.js";
import { GitHubClient, GitHubMergeError, isTransientGitHubFailure, supportsPullRequestRemote, type BranchPolicy, type GitHubIssue, type GitHubPullRequest } from "../github/client.js";
import { requiredTeamReviewApplies, teamReviewGateSatisfied } from "../github/team-review.js";
import { MerroStore } from "../store/store.js";
import type { TaskRuntimeRecord, ChangeSetRuntimeRecord } from "../store/model.js";
import { renderTaskFile } from "./task-file.js";
import { loadMarkdownGuidance, renderMarkdownGuidance } from "./guidance.js";
import { normalizedVerification, renderPullRequestContent, withRelatedPullRequests, type RelatedPullRequest } from "./pr-content.js";
import { MainLock } from "./main-lock.js";
import { changeName, issueNumbers, semanticSlug } from "../domain/names.js";
import { requireWorkspace } from "./workspace.js";
import { currentlyReviewedIds } from "./reviewed.js";
import { formatChecks, objectiveName, presentChangeDetails, presentWorkspace, publicText, workerName, reviewRoundsText, workerSettingsText } from "./presentation.js";
import { systemCommandRunner, type CommandRunner } from "./commands.js";
import { taskWindowName, WorkerRuntime, type WorkerPresence } from "./worker-runtime.js";
import { GitClient } from "../vcs/git.js";

type GitAdapter = Pick<GitClient, "discoverProject" | "createChangeSetClone" | "currentCommit" | "validateTaskCommit" | "pushBranch" | "fetchBaseCommit" | "syncBranchHead" | "effectiveDiffFingerprint">
  & Partial<Pick<GitClient, "discardAttempt" | "remoteBranchCommit" | "ensureChangeSetClone" | "createReadOnlyCheckout" | "deleteClone" | "cloneProject" | "inspectLocalDelivery" | "deliverLocal">>;
type GitHubAdapter = Pick<GitHubClient, "repository" | "repositoryInDirectory" | "listOpenIssues" | "issue" | "issues" | "createPullRequest" | "pullRequest" | "branchProtection" | "hasWritePermission" | "merge" | "createIssue" | "syncPullRequestContent">
  & Partial<Pick<GitHubClient, "findPullRequest" | "beginPass">>;
type WorkerAdapter = Pick<WorkerRuntime, "prepareClone" | "launch" | "inspect" | "cleanup" | "listOwnedWorkers">
  & Partial<Pick<WorkerRuntime, "plan" | "stop">>;
type LocalMergeOutcome = "done" | "base_updated" | "blocked" | "declined";

export interface MainOptions {
  workspacePath: string;
  config: MerroConfig;
  commands?: CommandRunner;
  git?: GitAdapter;
  github?: GitHubAdapter;
  workers?: WorkerAdapter;
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  progress?: (message: string) => void;
}

export type RoadmapStatus = "Done" | "In Progress" | "Not Started" | "Parked" | "Future";

export interface ObjectiveRoadmapItem {
  workstream: string;
  projectSlug: string;
  issues: number[];
  order?: string;
  status?: RoadmapStatus;
  changeSet?: string;
  sourceDependencies?: Array<{ workstream: string; projectSlug: string }>;
}

export interface ObjectivePlanningContext {
  items: ObjectiveRoadmapItem[];
  unresolved: Array<{ workstream: string; projectSlug: string; statement: string }>;
}

/** The user's approval predates the plan or decision it would authorize. */
export class StaleApprovalError extends Error {
  constructor() { super("This appeared after your reply, so it is not approved yet. Review it, then reply approve."); }
}

export interface ObjectiveProposal {
  id: string;
  changeSets: ChangeSet[];
  branches: Record<string, string>;
  relations: Relation[];
  relationNames: Record<string, string>;
  unresolved: Array<{ changeSetId: string; references: string[] }>;
  planning?: ObjectivePlanningContext;
  cycle: string[] | null;
  runnableImmediately: number;
}

export interface ObjectiveChangeSetInput {
  name: string;
  projectSlug: string;
  issues: number[];
}

export interface ObjectiveRelationInput {
  kind: "Requires" | "Conflicts";
  from: string;
  to: string;
  gate?: RequiresGate;
}

interface ObjectiveInputOptions {
  goal: string;
  priority?: Priority;
  maxReviewRounds?: number | "unlimited";
  deliveryMode?: DeliveryMode;
}

export interface ObjectiveStartInput extends ObjectiveInputOptions {
  projectSlugs: string[];
  issues: ObjectiveIssueScope[];
  changeSlug?: string;
  delivery?: "together" | "separate";
}

export interface NamedObjectiveStartInput extends ObjectiveInputOptions {
  changeSets: ObjectiveChangeSetInput[];
  relations?: ObjectiveRelationInput[];
  planning?: ObjectivePlanningContext;
}

type ObjectiveRequest = ObjectiveStartInput | NamedObjectiveStartInput;

const emptyRuntime = (changeSetId: string): ChangeSetRuntimeRecord => ({
  changeSetId, branchName: null, clonePath: null, baseCommit: null,
  pullRequestNumber: null, pullRequestUrl: null, pullRequestState: null,
  pullRequestHeadSha: null, pullRequestBaseSha: null, mergedCommitSha: null,
  lastIssueState: null, reviewedDiffHash: null, reviewRound: 0,
  infrastructureRetries: 0, implementationAttempt: 0, lastReworkTrigger: null, lastReconciledAt: null,
});

type ObjectiveGraph = Omit<ObjectiveProposal, "id">;

function relationKey(relation: Relation): string {
  return `${relation.kind}\0${relation.from}\0${relation.to}`;
}

function compactReviewText(text: string, length: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > length ? `${value.slice(0, length - 3).trimEnd()}...` : value;
}

function normalizePlanningContext(
  input: ObjectivePlanningContext,
  store: MerroStore,
  namesToIds: ReadonlyMap<string, string>,
  changeSets: readonly ChangeSet[],
): ObjectivePlanningContext {
  if (!Array.isArray(input.items) || !Array.isArray(input.unresolved)) throw new Error("Planning context requires items and unresolved statements");
  const validStatuses = new Set<RoadmapStatus>(["Done", "In Progress", "Not Started", "Parked", "Future"]);
  const keys = new Set<string>();
  const selected = new Map(changeSets.map((item) => [item.id, item]));
  const mapped = new Set<string>();
  const items = input.items.map((item) => {
    if (!item || typeof item !== "object" || typeof item.workstream !== "string" || !item.workstream.trim()) {
      throw new Error("Planning workstreams must have a name");
    }
    if (typeof item.projectSlug !== "string" || !store.getProject(item.projectSlug)) throw new Error(`unknown planning Project: ${item.projectSlug}`);
    if (!Array.isArray(item.issues) || item.issues.some((number) => !Number.isSafeInteger(number) || number < 1)
      || new Set(item.issues).size !== item.issues.length) throw new Error(`Planning issues for '${item.workstream}' must be unique positive issue numbers`);
    if (item.order !== undefined && (typeof item.order !== "string" || !item.order.trim())) throw new Error(`Planning order for '${item.workstream}' must not be empty`);
    if (item.status !== undefined && !validStatuses.has(item.status)) throw new Error(`Unknown roadmap status for '${item.workstream}'`);
    const workstream = item.workstream.trim();
    const key = `${item.projectSlug}\0${semanticSlug(workstream)}`;
    if (keys.has(key)) throw new Error(`Duplicate planning workstream '${workstream}' in Project '${item.projectSlug}'`);
    keys.add(key);
    let changeSet: string | undefined;
    if (item.changeSet !== undefined) {
      if (typeof item.changeSet !== "string" || !item.changeSet.trim()) throw new Error(`ChangeSet mapping for '${workstream}' must not be empty`);
      const id = namesToIds.get(semanticSlug(item.changeSet));
      const planned = id ? selected.get(id) : undefined;
      if (!planned) throw new Error(`Planning workstream '${workstream}' maps to an unselected ChangeSet '${item.changeSet}'`);
      const plannedIssues = issueNumbers(planned).sort((a, b) => a - b);
      const requestedIssues = [...item.issues].sort((a, b) => a - b);
      if (mapped.has(planned.id)) throw new Error(`ChangeSet '${item.changeSet}' maps to multiple planning workstreams`);
      if (planned.projectSlug !== item.projectSlug || plannedIssues.length !== requestedIssues.length
        || plannedIssues.some((number, index) => number !== requestedIssues[index])) {
        throw new Error(`Planning workstream '${workstream}' does not match ChangeSet '${item.changeSet}'`);
      }
      if (item.status === "Done" || item.status === "Parked" || item.status === "Future") {
        throw new Error(`Roadmap workstream '${workstream}' is ${item.status} and cannot be selected for execution`);
      }
      mapped.add(planned.id);
      changeSet = changeName(planned);
    }
    let sourceDependencies: ObjectiveRoadmapItem["sourceDependencies"];
    if (item.sourceDependencies !== undefined) {
      if (!Array.isArray(item.sourceDependencies)) throw new Error(`Source dependencies for '${workstream}' must be an array`);
      sourceDependencies = item.sourceDependencies.map((dependency) => {
        if (!dependency || typeof dependency !== "object" || typeof dependency.workstream !== "string" || !dependency.workstream.trim()
          || typeof dependency.projectSlug !== "string" || !store.getProject(dependency.projectSlug)) {
          throw new Error(`Invalid source dependency for '${workstream}'`);
        }
        return { workstream: dependency.workstream.trim(), projectSlug: dependency.projectSlug };
      });
      if (new Set(sourceDependencies.map((dependency) => `${dependency.projectSlug}\0${semanticSlug(dependency.workstream)}`)).size !== sourceDependencies.length) {
        throw new Error(`Duplicate source dependency for '${workstream}'`);
      }
    }
    return { workstream, projectSlug: item.projectSlug, issues: [...item.issues],
      ...(item.order === undefined ? {} : { order: item.order.trim() }),
      ...(item.status === undefined ? {} : { status: item.status }),
      ...(changeSet === undefined ? {} : { changeSet }),
      ...(sourceDependencies === undefined ? {} : { sourceDependencies }) };
  });
  for (const item of items) for (const dependency of item.sourceDependencies ?? []) {
    const target = items.find((candidate) => candidate.projectSlug === dependency.projectSlug
      && semanticSlug(candidate.workstream) === semanticSlug(dependency.workstream));
    if (!target || target === item) throw new Error(`Source dependency for '${item.workstream}' references an unknown or identical workstream`);
  }
  if (mapped.size !== changeSets.length) throw new Error("Every selected ChangeSet must map to one planning workstream");
  const unresolved = input.unresolved.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.workstream !== "string" || !entry.workstream.trim()
      || typeof entry.statement !== "string" || !entry.statement.trim()) throw new Error("Unresolved planning statements need a workstream and description");
    if (typeof entry.projectSlug !== "string") throw new Error("Unresolved planning statements need a Project");
    const workstream = entry.workstream.trim();
    const item = items.find((candidate) => candidate.projectSlug === entry.projectSlug
      && semanticSlug(candidate.workstream) === semanticSlug(workstream));
    if (!item) throw new Error(`Unresolved statement references unknown planning workstream '${workstream}'`);
    if (item.changeSet) throw new Error(`Unresolved workstream '${workstream}' must not be selected for execution`);
    return { workstream, projectSlug: entry.projectSlug, statement: entry.statement.trim() };
  });
  return { items, unresolved };
}

function proposalFingerprint(graph: ObjectiveGraph, projects: readonly Project[]): string {
  return JSON.stringify({
    projects: projects.map(({ slug, path, baseRemote, pushRemote, defaultBranch }) => ({ slug, path, baseRemote, pushRemote, defaultBranch })),
    changeSets: graph.changeSets.map((item) => ({ id: item.id, name: changeName(item), projectSlug: item.projectSlug,
      issues: item.issues, generation: item.generation, delivery: item.delivery, targetBranch: item.targetBranch })),
    branches: graph.branches, relations: graph.relations.map(({ consumedReviewedCommit: _consumed, ...relation }) => relation), relationNames: graph.relationNames,
    unresolved: graph.unresolved, planning: graph.planning, cycle: graph.cycle,
  });
}

function sourceId(projectSlug: string, number: number, generation: number): string {
  return `${projectSlug}:issue-${number}:g${generation}`;
}

function branchName(issue: GitHubIssue, slug: string): string {
  const kind = issue.labels.some((label) => /bug|defect/i.test(label)) ? "fix"
    : issue.labels.some((label) => /feature|enhancement/i.test(label)) ? "feat" : "chore";
  return `${kind}/${slug}`;
}

function verificationText(entries: readonly Verification[]): string {
  const commands = [...new Set(entries.filter((entry) => entry.kind === "command" && entry.exit_code === 0)
    .map((entry) => entry.kind === "command" ? `- \`${entry.project}\`: \`${entry.command}\` (cwd \`${entry.cwd}\`)` : ""))];
  const manuals = entries.filter((entry) => entry.kind === "manual").map((entry) => entry.kind === "manual" ? `- \`${entry.project}\`: ${entry.summary}` : "");
  return [...commands, ...manuals].join("\n") || "- No verification recorded.";
}

function ensureMarkdownSection(body: string, title: string, content: string): string {
  const heading = `## ${title}`;
  if (body.split(/\r?\n/).some((line) => line.trim() === heading)) return body.trim();
  return `${body.trim()}\n\n${heading}\n\n${content}`.trim();
}

/** Opened PRs of changes this one requires or that require it, across Projects, so reviewers see the companion set. */
function relatedPullRequests(store: MerroStore, item: ChangeSet): RelatedPullRequest[] {
  const related: RelatedPullRequest[] = [];
  for (const relation of store.listRelations()) {
    if (relation.kind !== "Requires" || (relation.from !== item.id && relation.to !== item.id)) continue;
    const otherId = relation.from === item.id ? relation.to : relation.from;
    const other = store.getChangeSet(otherId);
    const url = other && store.getChangeSetRuntime(other.id)?.pullRequestUrl;
    if (other && url) related.push({ name: changeName(other), relation: relation.from === item.id ? "Requires" : "Required by", url });
  }
  return related.sort((a, b) => a.relation.localeCompare(b.relation) || a.name.localeCompare(b.name));
}

function reconcilePullRequestBody(body: string, item: ChangeSet, verification: string, related: readonly RelatedPullRequest[] = []): string {
  const updated = withRelatedPullRequests(ensureMarkdownSection(body, "Verification", verification), related);
  if (!item.issues.length) return updated;
  const lines = updated.split(/\r?\n/);
  let issuesStart = lines.findIndex((line) => line.trim() === "## Issues");
  if (issuesStart < 0) {
    lines.push("", "## Issues");
    issuesStart = lines.length - 1;
  }
  let issuesEnd = issuesStart + 1;
  while (issuesEnd < lines.length && !/^##\s/.test(lines[issuesEnd] ?? "")) issuesEnd += 1;
  const missing = issueNumbers(item).filter((number) => !lines.slice(issuesStart + 1, issuesEnd)
    .some((line) => new RegExp(`^Closes\\s+#${number}\\s*$`, "i").test(line.trim())));
  if (missing.length) lines.splice(issuesEnd, 0, "", ...missing.map((number) => `Closes #${number}`));
  return publicText(lines.join("\n").trim());
}

function finalVerification(store: MerroStore, item: ChangeSet, review: ReviewResult): string {
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
  return normalizedVerification([...implementationVerification, ...review.verification]);
}

function finalMergeSummary(
  store: MerroStore,
  item: ChangeSet,
  runtime: ChangeSetRuntimeRecord,
  pullRequest: GitHubPullRequest,
): Record<string, unknown> {
  const tasks = store.listTasks(item.id);
  return {
    changeSet: {
      id: item.id,
      projectSlug: item.projectSlug,
      slug: item.slug,
      issues: item.issues,
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
  return publicText(`<!-- merro:review-notes -->\n\n## Review\n\n${review.summary}\n\n## Verification\n\n${verificationText(review.verification)}\n\n## Non-blocking findings and notes\n\n${notes}`);
}

function terminal(item: ChangeSet): boolean {
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
  // Deterministic outcomes only. Infrastructure outcomes (STARTUP_FAILURE, CANCELLED, ACTION_REQUIRED) never spend a worker round on unchanged code.
  const failures = new Set(["FAILURE", "ERROR", "TIMED_OUT"]);
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
  if (!teamReviewGateSatisfied(pullRequest, policy)) return false;
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

function conciseDiagnostic(value: string): string {
  const line = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > 240 ? `${line.slice(0, 237).trimEnd()}...` : line;
}

function isCommitSha(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{40,64}$/i.test(value);
}

export class MainOrchestrator {
  readonly #workspacePath: string;
  readonly #stateDirectory: string;
  get #workRoot(): string { return join(this.#workspacePath, this.#config.worktreesDir); }
  /** Recorded clone paths stay authoritative after worktreesDir changes: a clone created as <root>/<project>/<change> is removed from that root. */
  #cloneRoot(item: ChangeSet, clonePath: string): string {
    const workspace = resolve(this.#workspacePath);
    const clone = resolve(clonePath);
    const root = dirname(dirname(clone));
    if (basename(clone) !== changeName(item) || basename(dirname(clone)) !== item.projectSlug) return this.#workRoot;
    try {
      const directory = validateDirectory(relative(workspace, root), "worktreesDir");
      const projects = this.#config.projectsDir;
      if (directory === projects || directory.startsWith(`${projects}${sep}`) || projects.startsWith(`${directory}${sep}`)) return this.#workRoot;
      return join(workspace, directory);
    } catch {
      return this.#workRoot;
    }
  }
  readonly #config: MerroConfig;
  readonly #notifiedBySubject = new Map<string, string>();
  readonly #notify: (message: string, level?: "info" | "warning" | "error") => void;
  readonly #progress: (message: string) => void;
  readonly #git: GitAdapter;
  readonly #github: GitHubAdapter;
  readonly #workers: WorkerAdapter;
  readonly #commands: CommandRunner;
  #storeQueue: Promise<unknown> = Promise.resolve();
  readonly #proposals = new Map<string, { input: string; graph: string; names: string[]; createdAt: number }>();
  readonly #pendingNotifications: Array<{ event: string; subjectId: string; message: string }> = [];
  readonly #reviewNotificationsInFlight = new Set<string>();
  readonly #names = new Map<string, string>();
  /** Live workers Merro cannot verify as its own, from the latest safety check; they still occupy capacity. */
  #orphanedTaskCount = 0;

  constructor(options: MainOptions) {
    this.#workspacePath = resolve(options.workspacePath);
    this.#stateDirectory = join(this.#workspacePath, ".merro");
    this.#config = options.config;
    const notify = options.notify ?? ((message: string) => console.log(message));
    // Reconciliation re-derives the same conditions every pass; an equivalent message per subject is shown once until it changes.
    // Progress, new blocks and user actions on a change re-arm only that subject, so a condition that recurs after its change moved on is shown again.
    const lastBySubject = this.#notifiedBySubject;
    this.#notify = (message, level) => {
      const text = publicText(message, this.#names);
      const subject = text.split(/\n| · /, 1)[0]!;
      if (lastBySubject.get(subject) === text) return;
      lastBySubject.set(subject, text);
      notify(text, level);
    };
    this.#progress = (message) => {
      const text = publicText(message, this.#names);
      // Progress means the subject's state moved on, so an identical later warning is new information.
      lastBySubject.delete(text.split(/\n| · /, 1)[0]!);
      options.progress?.(text);
    };
    const commands = options.commands ?? systemCommandRunner;
    this.#commands = commands;
    this.#git = options.git ?? new GitClient(commands);
    this.#github = options.github ?? new GitHubClient(commands);
    this.#workers = options.workers ?? new WorkerRuntime({ workspacePath: join(this.#stateDirectory, "runtime"), config: options.config, commands });
  }

  async listProjects(): Promise<Project[]> {
    return this.#withStore((store) => store.listProjects());
  }

  async presentPlanningContext(input: ObjectivePlanningContext): Promise<ObjectivePlanningContext> {
    return this.#withStore((store) => {
      const planning = normalizePlanningContext(input, store, new Map(), []);
      this.#proposals.clear();
      return planning;
    });
  }

  async discoverIssues(projectSlug: string): Promise<GitHubIssue[]> {
    const project = await this.#withStore((store) => {
      const registered = store.getProject(projectSlug);
      if (!registered) throw new Error(`unknown Project: ${projectSlug}`);
      return registered;
    });
    return this.#github.listOpenIssues(project);
  }

  #issueProject(store: MerroStore, projectSlug?: string): Project {
    if (projectSlug) {
      const project = store.getProject(projectSlug);
      if (!project) throw new Error(`unknown Project: ${projectSlug}`);
      return project;
    }
    const projects = store.listProjects();
    if (projects.length === 1) return projects[0]!;
    throw new Error(projects.length ? `Choose a project: ${projects.map((project) => project.slug).join(", ")}.` : "No projects registered. Register one first.");
  }

  async createIssue(projectSlug: string | undefined, title: string, body = ""): Promise<GitHubIssue & { projectSlug: string }> {
    if (!title.trim()) throw new Error("Issue title must not be empty");
    const project = await this.#withStore((store) => this.#issueProject(store, projectSlug));
    return { ...await this.#github.createIssue(project, title, body), projectSlug: project.slug };
  }

  async listIssues(projectSlug?: string): Promise<{ projectSlug: string; issues: GitHubIssue[] }> {
    const project = await this.#withStore((store) => this.#issueProject(store, projectSlug));
    return { projectSlug: project.slug, issues: await this.#github.listOpenIssues(project) };
  }

  async showIssue(projectSlug: string | undefined, number: number): Promise<GitHubIssue & { projectSlug: string }> {
    const project = await this.#withStore((store) => this.#issueProject(store, projectSlug));
    return { ...await this.#github.issue(project, number), projectSlug: project.slug };
  }

  /** issue -> Objective -> implementation: the command is the user's approval of the single-issue scope. */
  async startIssue(projectSlug: string | undefined, number: number): Promise<{ issue: GitHubIssue; objective: Objective; changeSets: ChangeSet[] }> {
    const project = await this.#withStore((store) => this.#issueProject(store, projectSlug));
    const issue = await this.#github.issue(project, number);
    if (issue.state !== "OPEN") throw new Error(`Issue #${number} is ${issue.state.toLowerCase()}`);
    const started = await this.startObjective({
      goal: issue.title, projectSlugs: [project.slug], issues: [{ projectSlug: project.slug, numbers: [number] }],
    });
    await this.runPass();
    return { issue, ...started };
  }

  /** Issues proposed by workers under issues.create=approval, oldest first; the persisted `position` is the stable user-facing handle. */
  async issueProposals(): Promise<Array<{ position: number; projectSlug: string; title: string; body: string; change: string }>> {
    return this.#withStore((store) => this.#pendingIssueProposals(store).map(({ payload, position }) => ({ ...payload, position })));
  }

  #pendingIssueProposals(store: MerroStore) {
    return store.pendingDecisions().filter((decision) => decision.kind === "issue" && decision.subjectType === "IssueProposal")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((decision, index) => {
        const payload = decision.payload as { projectSlug: string; title: string; body: string; change: string; number?: number };
        // Proposals stored before numbers were persisted fall back to their queue position.
        return { decision, payload, position: payload.number ?? index + 1 };
      })
      // Persisted numbers are monotonic, so they order proposals created within the same timestamp.
      .sort((left, right) => left.position - right.position);
  }

  async resolveIssueProposal(position: number, approved: boolean): Promise<string> {
    return this.#withStore(async (store) => {
      const entry = this.#pendingIssueProposals(store).find((candidate) => candidate.position === position);
      if (!entry) throw new Error(`No proposed issue ${position}. See /merro issue list.`);
      if (!approved) {
        store.resolveDecision(entry.decision.id, "rejected");
        return `Dismissed proposed issue: ${entry.payload.title}`;
      }
      const project = this.#issueProject(store, entry.payload.projectSlug);
      const created = await this.#github.createIssue(project, entry.payload.title, entry.payload.body);
      store.resolveDecision(entry.decision.id, "approved");
      return `Created ${project.slug} #${created.number}: ${created.title}\n${created.url}`;
    });
  }

  async #handleProposedIssues(store: MerroStore, item: ChangeSet, task: Task, result: WorkerResult): Promise<void> {
    const proposals = result.proposed_issues ?? [];
    const policy = this.#config.issues.create;
    if (!proposals.length || policy === "disabled" || store.hasEvent("Task", task.id, "issues_proposed")) return;
    store.appendEvent("Task", task.id, "issues_proposed", { count: proposals.length });
    const project = store.getProject(item.projectSlug);
    if (!project) return;
    const origin = `${task.role === "implement" ? "Implementer" : "Reviewer"} for ${changeName(item)}`;
    for (const proposal of proposals) {
      const body = `${proposal.body.trim()}\n\n---\nProposed by the ${origin}; out of scope for the current change.`;
      if (policy === "auto") {
        try {
          const created = await this.#github.createIssue(project, proposal.title, body);
          this.#notify(`${changeName(item)} · Created follow-up ${project.slug} #${created.number}: ${created.title}`);
        } catch (error) {
          this.#notify(`${changeName(item)} · Could not create follow-up issue "${proposal.title}": ${errorText(error)}`, "warning");
        }
        continue;
      }
      store.createDecision({
        id: randomUUID(), subjectType: "IssueProposal", subjectId: randomUUID(), kind: "issue",
        payload: { projectSlug: project.slug, title: proposal.title, body, change: changeName(item), number: store.nextIssueProposalNumber() },
      });
      const position = this.#pendingIssueProposals(store).at(-1)!.position;
      this.#notify(`${changeName(item)} proposed a follow-up\n\n${position}. ${proposal.title}\nApprove: /merro issue approve ${position} · Dismiss: /merro issue dismiss ${position}`, "warning");
    }
  }

  async statusSnapshot(): Promise<{ projects: Project[]; objectives: Objective[]; changeSets: ChangeSet[]; tasks: Task[]; decisions: ReturnType<MerroStore["pendingDecisions"]> }> {
    return this.#withStore((store) => ({
      projects: store.listProjects(),
      objectives: store.listObjectives(),
      changeSets: store.listChangeSets(),
      tasks: store.listTasks(),
      decisions: store.pendingDecisions(),
    }));
  }

  async publicSnapshot(): Promise<ReturnType<typeof presentWorkspace>> {
    return this.#withStore((store) => presentWorkspace(store, this.#presentationOptions()));
  }

  async changeDetails(name: string) {
    return this.#withStore((store) => presentChangeDetails(store, semanticSlug(name), this.#presentationOptions()));
  }

  /** Resolves the live tmux window of a change's active worker, or null when none is running. */
  async watchTarget(name: string): Promise<{ session: string; window: string } | null> {
    return this.#withStore((store) => {
      const item = store.listChangeSets().find((candidate) => changeName(candidate) === semanticSlug(name));
      if (!item) throw new Error(`Unknown change: ${name}`);
      const active = store.activeTask(item.id);
      const record = active && store.getTaskRuntime(active.id);
      return record?.tmuxSession && record.tmuxWindow ? { session: record.tmuxSession, window: record.tmuxWindow } : null;
    });
  }

  async statusSummary(): Promise<ReturnType<MerroStore["statusSummary"]>> {
    return this.#withStore((store) => store.statusSummary());
  }

  async exportSnapshot(): Promise<ReturnType<MerroStore["snapshot"]>> {
    return this.#withStore((store) => store.snapshot());
  }

  async updateRelations(relations: readonly Relation[]): Promise<void> {
    await this.#withStore((store) => {
      for (const relation of relations) {
        if (!store.getChangeSet(relation.from)) throw new Error(`unknown ChangeSet in relation: ${relation.from}`);
        if (!store.getChangeSet(relation.to)) throw new Error(`unknown ChangeSet in relation: ${relation.to}`);
      }
      store.replaceRelations(relations);
    });
    await this.runPass();
  }

  async addProject(path: string, slug: string): Promise<Project> {
    await requireWorkspace(this.#workspacePath);
    assertProjectSlug(slug);
    const remote = /^(?:https?|ssh|git|file):\/\//.test(path) || /^[^/\s]+@[^:\s]+:.+/.test(path);
    let projectPath: string;
    if (remote) {
      projectPath = join(this.#workspacePath, this.#config.projectsDir, slug);
      const existing = await this.#withStore((store) => store.getProject(slug));
      if (existing) {
        if (existing.path !== projectPath || !sameRemoteRepository(existing.baseRemote, path)) throw new Error(`Project '${slug}' is already registered with different repository identity`);
      } else {
        if (!this.#git.cloneProject) throw new Error("Git adapter cannot clone a remote Project");
        await this.#ensureWorkspaceDirectory(this.#config.projectsDir);
        this.#progress(`Cloning -> ./${this.#config.projectsDir}/${slug}`);
        await this.#git.cloneProject(path, projectPath);
      }
    } else {
      const supplied = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
      projectPath = resolve(this.#workspacePath, supplied);
    }
    const project = await this.#git.discoverProject(projectPath, slug);
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

  proposeObjective(input: NamedObjectiveStartInput): Promise<ObjectiveProposal>;
  proposeObjective(input: ObjectiveStartInput): Promise<ObjectiveProposal>;
  proposeObjective(input: NamedObjectiveStartInput | ObjectiveStartInput): Promise<ObjectiveProposal>;
  async proposeObjective(input: ObjectiveRequest): Promise<ObjectiveProposal> {
    return this.#withStore((store) => this.#recordObjectiveProposal(store, input));
  }

  async #recordObjectiveProposal(store: MerroStore, input: ObjectiveRequest): Promise<ObjectiveProposal> {
    const prepared = await this.#prepareObjective(store, input);
    const id = randomUUID();
    const proposal = { id, ...prepared.graph };
    this.#proposals.clear();
    this.#proposals.set(id, { input: JSON.stringify(input), graph: proposalFingerprint(prepared.graph, prepared.projects),
      names: prepared.graph.changeSets.map((item) => changeName(item)), createdAt: Date.now() });
    return proposal;
  }

  async #prepareObjective(store: MerroStore, input: ObjectiveRequest) {
    const requestedDelivery = input.deliveryMode ?? this.#config.git.defaultDelivery;
    if (requestedDelivery !== "auto" && requestedDelivery !== "local" && requestedDelivery !== "pr") throw new Error("Delivery mode must be auto, local or pr");
    const explicit = "changeSets" in input;
    let projects: Project[];
    let issueScopes: ObjectiveIssueScope[];
    let selections: Array<{ name: string | null; projectSlug: string; scope: ObjectiveIssueScope }>;
    if (explicit) {
      if (!Array.isArray(input.changeSets) || input.changeSets.length === 0) throw new Error("Objective requires at least one ChangeSet");
      if ("projectSlugs" in input || "issues" in input || "changeSlug" in input || "delivery" in input) {
        throw new Error("Use either named ChangeSets or the legacy Project selection, not both");
      }
      const names = input.changeSets.map((item) => semanticSlug(item.name));
      if (new Set(names).size !== names.length) throw new Error("ChangeSet names must be unique in an Objective");
      const projectSlugs = [...new Set(input.changeSets.map((item) => item.projectSlug))];
      projects = projectSlugs.map((slug) => {
        const project = store.getProject(slug);
        if (!project) throw new Error(`unknown Project: ${slug}`);
        return project;
      });
      selections = input.changeSets.map((item, index) => ({
        name: names[index]!, projectSlug: item.projectSlug,
        scope: parseObjectiveIssueScopes([{ projectSlug: item.projectSlug, numbers: item.issues }], [item.projectSlug], { allowEmptyFixedSelections: true })[0]!,
      }));
      issueScopes = [];
    } else {
      if (!Array.isArray(input.projectSlugs) || input.projectSlugs.length === 0 || !Array.isArray(input.issues)) {
        throw new Error("Objective requires registered Projects and issue selections");
      }
      projects = [...new Set(input.projectSlugs)].map((slug) => {
        const project = store.getProject(slug);
        if (!project) throw new Error(`unknown Project: ${slug}`);
        return project;
      });
      issueScopes = parseObjectiveIssueScopes(input.issues, projects.map((project) => project.slug));
      selections = issueScopes.map((scope) => ({ name: null, projectSlug: scope.projectSlug, scope }));
    }

    const deliveryByProject = new Map(projects.map((project) => [project.slug,
      requestedDelivery === "auto"
        ? supportsPullRequestRemote(project.baseRemote) && supportsPullRequestRemote(project.pushRemote) ? "pr" as const : "local" as const
        : requestedDelivery]));
    for (const project of projects) {
      if (deliveryByProject.get(project.slug) !== "pr") continue;
      if (!supportsPullRequestRemote(project.baseRemote) || !supportsPullRequestRemote(project.pushRemote)) {
        throw new Error(`Project '${project.slug}' has no supported remote; use local delivery`);
      }
      const repository = await this.#github.repository(project.baseRemote);
      project.defaultBranch = repository.defaultBranch;
    }
    const projectBySlug = new Map(projects.map((project) => [project.slug, project]));
    const issueRows = new Map<string, GitHubIssue>();
    const selectedGroups: GitHubIssue[][] = [];
    const issueOwners = new Map<string, string>();
    for (const selection of selections) {
      const project = projectBySlug.get(selection.projectSlug);
      if (!project) throw new Error(`unknown Project: ${selection.projectSlug}`);
      const issueFree = "numbers" in selection.scope && selection.scope.numbers.length === 0;
      const open = issueFree ? [] : await this.#github.listOpenIssues(project, "query" in selection.scope ? selection.scope.query : undefined);
      const selected = open.filter((issue) => issue.state.toUpperCase() === "OPEN" && matchesIssueScope(selection.scope, issue))
        .sort((a, b) => a.number - b.number);
      if ("numbers" in selection.scope) {
        for (const number of selection.scope.numbers) {
          if (!selected.some((issue) => issue.number === number)) throw new Error(`issue #${number} is not open in Project '${project.slug}'`);
        }
      }
      for (const issue of selected) {
        const key = `${project.slug}\0${issue.number}`;
        const previousOwner = issueOwners.get(key);
        if (explicit && previousOwner) throw new Error(`Issue #${issue.number} in Project '${project.slug}' is assigned to both '${previousOwner}' and '${selection.name}'`);
        if (explicit) issueOwners.set(key, selection.name!);
        issueRows.set(key, issue);
      }
      selectedGroups.push(selected);
    }

    const groups: Array<{ name: string | null; projectSlug: string; issues: GitHubIssue[] }> = [];
    if (explicit) {
      for (const [index, selection] of selections.entries()) {
        groups.push({ name: selection.name, projectSlug: selection.projectSlug, issues: selectedGroups[index]! });
      }
    } else {
      for (const project of projects) {
        const issues = [...issueRows].filter(([key]) => key.startsWith(`${project.slug}\0`)).map(([, issue]) => issue);
        if (input.delivery === "separate") groups.push(...issues.map((issue) => ({ name: null, projectSlug: project.slug, issues: [issue] })));
        else if (issues.length || input.issues.length === 0) groups.push({ name: null, projectSlug: project.slug, issues });
      }
    }
    const plannedNames = new Set<string>();
    const namesToIds = new Map<string, string>();
    const legacyChangeSlug = "changeSlug" in input ? input.changeSlug : undefined;
    const requestedRelations = "relations" in input ? input.relations ?? [] : [];
    const changeSets = groups.map(({ name, projectSlug, issues }): ChangeSet => {
      const numbers = issues.map((issue) => issue.number);
      const requestedProjectDelivery = deliveryByProject.get(projectSlug);
      if (!requestedProjectDelivery) throw new Error(`unknown Project delivery mode: ${projectSlug}`);
      const preserveExistingDelivery = requestedDelivery === "auto" && this.#config.git.defaultDelivery === "auto";
      const existing = numbers.length ? store.findNonTerminalChangeSet(projectSlug, numbers)
        : name ? store.listChangeSets().find((item) => item.projectSlug === projectSlug && item.slug === name && !terminal(item)) ?? null : null;
      if (existing) {
        if (name && existing.slug !== name) throw new Error(`These issues already belong to ChangeSet '${existing.slug}', not '${name}'`);
        const existingDelivery = existing.delivery ?? "pr";
        if (!preserveExistingDelivery && existingDelivery !== requestedProjectDelivery) {
          throw new Error(`ChangeSet '${existing.slug}' already has ${existingDelivery} delivery; obtain a new plan instead`);
        }
        plannedNames.add(existing.slug);
        if (name) namesToIds.set(name, existing.id);
        return existing;
      }
      const overlaps = store.listChangeSets().filter((item) => item.projectSlug === projectSlug && !terminal(item)
        && issueNumbers(item).some((number) => issues.some((issue) => issue.number === number)));
      if (overlaps.length) throw new Error(`Issues already belong to ${overlaps.map(changeName).join(", ")}. Stop that change before regrouping its issues.`);
      const generation = store.nextGeneration(projectSlug, numbers);
      const baseName = name ?? semanticSlug(legacyChangeSlug ?? (issues.length === 1 ? issues[0]!.title : input.goal));
      const slug = store.availableChangeName(baseName, plannedNames);
      plannedNames.add(slug);
      const id = issues.length === 1 ? sourceId(projectSlug, issues[0]!.number, generation) : `${projectSlug}:change:${slug}:g${generation}`;
      this.#names.set(id, slug);
      if (name) namesToIds.set(name, id);
      return { id, slug, projectSlug, delivery: requestedProjectDelivery,
        targetBranch: projectBySlug.get(projectSlug)!.defaultBranch, issues: numbers.map((number) => ({ projectSlug, number })), generation,
        state: "Planned", priority: input.priority ?? "normal", readySince: null, blockedReason: null, blockedResumeState: null };
    });

    const planning = "changeSets" in input && input.planning
      ? normalizePlanningContext(input.planning, store, namesToIds, changeSets) : undefined;

    const explicitRelations: Relation[] = [];
    const seenExplicitRelations = new Set<string>();
    for (const edge of requestedRelations) {
      if (edge.kind !== "Requires" && edge.kind !== "Conflicts") throw new Error("Relation kind must be Requires or Conflicts");
      const fromName = semanticSlug(edge.from);
      const toName = semanticSlug(edge.to);
      const from = namesToIds.get(fromName);
      const to = namesToIds.get(toName);
      if (!from || !to) throw new Error(`Relation must reference named ChangeSets in this Objective: '${fromName}' -> '${toName}'`);
      if (edge.kind === "Conflicts" && edge.gate !== undefined) throw new Error("Only Requires relations can select a gate");
      const relation = normalizeRelation({ kind: edge.kind, from, to, confidence: "explicit",
        rationale: "Approved in the Objective plan.", evidence: `${fromName} ${edge.kind} ${toName}`,
        ...(edge.kind === "Requires" ? { gate: edge.gate ?? "done" } : {}) });
      const key = `${relation.kind}\0${relation.from}\0${relation.to}`;
      if (!seenExplicitRelations.has(key)) explicitRelations.push(relation);
      seenExplicitRelations.add(key);
    }

    // Shared ChangeSets retain relations to work already approved by another active Objective.
    const objectives = store.listObjectives().filter((candidate) => candidate.state === "Active");
    const automaticRelations: Relation[] = [];
    const unresolved: ObjectiveProposal["unresolved"] = [];
    for (const item of changeSets) {
      const approved = new Map(changeSets.map((candidate) => [candidate.id, candidate]));
      for (const objective of objectives) {
        const attached = store.listChangeSets(objective.id, true);
        if (attached.some((candidate) => candidate.id === item.id)) {
          for (const candidate of attached) approved.set(candidate.id, candidate);
        }
      }
      const references = new Set<string>();
      for (const number of issueNumbers(item)) {
        const issue = issueRows.get(`${item.projectSlug}\0${number}`)!;
        const analysis = analyzeIssueRelations(item, issue, [...approved.values()]);
        automaticRelations.push(...analysis.relations);
        for (const reference of analysis.unresolved) references.add(reference);
      }
      if (references.size) unresolved.push({ changeSetId: item.id, references: [...references] });
    }
    const ids = new Set(changeSets.map((item) => item.id));
    const effective = store.previewAutomaticRelations([...ids], [...automaticRelations, ...explicitRelations])
      .filter((relation) => ids.has(relation.from) || ids.has(relation.to));
    const fixedIssueScopes = projects.map((project) => ({ projectSlug: project.slug,
      numbers: [...issueRows].filter(([key]) => key.startsWith(`${project.slug}\0`)).map(([, issue]) => issue.number) }));
    const approvedIssueScopes = !explicit && input.delivery === "separate" ? issueScopes
      : parseObjectiveIssueScopes(fixedIssueScopes, projects.map((project) => project.slug), { allowEmptyFixedSelections: true });
    const relatedIds = new Set([...ids, ...effective.flatMap((relation) => [relation.from, relation.to])]);
    const relatedChangeSets = [...relatedIds].map((id) => changeSets.find((item) => item.id === id) ?? store.getChangeSet(id))
      .filter((item): item is ChangeSet => item !== null && item !== undefined);
    const relationNames = Object.fromEntries(relatedChangeSets.map((item) => [item.id, changeName(item)]));
    const participants = relatedChangeSets
      .map((item) => item.state === "Planned" ? { ...item, state: "Ready" as const } : item);
    const activeIds = store.listTasks().filter((task) => task.status === "active" && relatedIds.has(task.changeSetId)).map((task) => task.changeSetId);
    const unresolvedIds = new Set(unresolved.map((item) => item.changeSetId));
    const runnableImmediately = schedule({ changeSets: participants, relations: effective, activeTaskCount: 0,
      maxConcurrentTasks: "unlimited", activeChangeSetIds: activeIds, reviewedChangeSetIds: [...currentlyReviewedIds(store)] }).selected
      .filter((item) => ids.has(item.id) && !unresolvedIds.has(item.id)).length;
    return { projects, issueScopes, approvedIssueScopes, issueRows, automaticRelations, explicitRelations,
      graph: { changeSets, branches: Object.fromEntries(changeSets.map((item) => [item.id,
        store.getChangeSetRuntime(item.id)?.branchName ?? (item.issues.length ? branchName(issueRows.get(`${item.projectSlug}\0${issueNumbers(item)[0]}`)!, item.slug) : `chore/${item.slug}`)])),
        relations: effective, relationNames, unresolved, ...(planning ? { planning } : {}),
        cycle: findRequiresCycle(effective), runnableImmediately } };
  }

  startObjective(input: NamedObjectiveStartInput, proposalId?: string): Promise<{ objective: Objective; changeSets: ChangeSet[] }>;
  startObjective(input: ObjectiveStartInput, proposalId?: string): Promise<{ objective: Objective; changeSets: ChangeSet[] }>;
  startObjective(input: NamedObjectiveStartInput | ObjectiveStartInput, proposalId?: string): Promise<{ objective: Objective; changeSets: ChangeSet[] }>;
  async startObjective(input: ObjectiveRequest, proposalId?: string): Promise<{ objective: Objective; changeSets: ChangeSet[] }> {
    if (!input.goal.trim()) throw new Error("Objective goal must not be empty");
    return this.#withStore(async (store) => {
      const { projects, approvedIssueScopes, graph, automaticRelations, explicitRelations } = await this.#prepareObjective(store, input);
      if (proposalId !== undefined) {
        const proposal = this.#proposals.get(proposalId);
        if (!proposal || proposal.input !== JSON.stringify(input) || proposal.graph !== proposalFingerprint(graph, projects)) {
          throw new Error("Objective proposal changed or expired. Run merro_propose_objective and obtain approval again.");
        }
      }
      await this.#validateNewExplicitRelations(store, graph.changeSets, graph.relations, explicitRelations);
      if (proposalId !== undefined) this.#proposals.delete(proposalId);

      const objective: Objective = {
        id: randomUUID(), goal: input.goal.trim(), priority: input.priority ?? "normal", state: "Active",
        projectSlugs: projects.map((project) => project.slug),
        issueScopes: approvedIssueScopes,
        // Materialized at approval so a later config reload cannot change an approved Objective's review limit.
        maxReviewRounds: input.maxReviewRounds ?? this.#config.maxReviewRounds,
      };
      store.createObjective(objective);
      const workerSettings: WorkerSettings = { implement: { ...this.#config.workers.implementer }, review: { ...this.#config.workers.reviewer } };
      store.saveObjectiveWorkerSettings(objective.id, workerSettings);
      this.#names.set(objective.id, objective.goal);
      const items: ChangeSet[] = [];
      for (const planned of graph.changeSets) {
        if (!store.getChangeSet(planned.id)) store.createChangeSet(planned);
        store.attachChangeSet(objective.id, planned.id);
        store.claimChangeSetWorkerSettings(planned.id, workerSettings);
        const item = store.getChangeSet(planned.id)!;
        this.#names.set(item.id, changeName(item));
        const runtime = store.getChangeSetRuntime(item.id) ?? emptyRuntime(item.id);
        if (!runtime.branchName) {
          const approvedBranch = graph.branches[item.id];
          if (!approvedBranch) throw new Error(`Approved branch is missing for ${changeName(item)}`);
          store.saveChangeSetRuntime({ ...runtime, branchName: approvedBranch });
        }
        if (priorityRank(objective.priority) < priorityRank(item.priority)) store.setChangeSetPriority(item.id, objective.priority);
        items.push(store.getChangeSet(item.id)!);
      }
      store.rebuildAutomaticRelations(items.map((item) => item.id), automaticRelations, [], explicitRelations);
      for (const item of items) {
        if (item.state !== "Blocked" || item.blockedReason !== "task_failed" || item.blockedResumeState !== "Implementing") continue;
        const latest = store.listTasks(item.id).at(-1);
        if (latest?.role !== "implement" || latest.outcome !== "failed" || !latest.resultJson) continue;
        let suggestions: DependencySuggestion[] | undefined;
        try { suggestions = parseImplementResult(JSON.parse(latest.resultJson)).dependency_suggestions; } catch { continue; }
        if (!suggestions?.length) continue;
        const approved = suggestions.every((suggestion) => store.listRelations().some((relation) => {
          const prerequisite = store.getChangeSet(relation.to);
          return relation.kind === "Requires" && relation.from === item.id && (relation.gate ?? "done") === suggestion.gate
            && prerequisite?.projectSlug === suggestion.project_slug && issueNumbers(prerequisite).includes(suggestion.issue_number);
        }));
        if (approved) store.transitionChangeSet(item.id, "Implementing");
      }
      return { objective, changeSets: items.map((item) => store.getChangeSet(item.id)!) };
    });
  }

  /**
   * `repliedAt` is when the user's approving message arrived; a plan proposed at or after it was never seen
   * by that reply, so it cannot authorize the plan.
   */
  /** `accepted` fires once the approval started this plan; any failure before that leaves the user's reply usable. */
  async approveObjective(name?: string, options: { repliedAt?: number; accepted?: () => void } = {}): Promise<{ objective: Objective; changeSets: ChangeSet[] }> {
    const [entry] = this.#proposals;
    if (!entry) throw new Error("No pending plan. Propose a plan and obtain approval first.");
    const [id, proposal] = entry;
    if (options.repliedAt !== undefined && proposal.createdAt >= options.repliedAt) throw new StaleApprovalError();
    if (!this.#pendingPlanAccepts(name)) throw new Error("That name does not match the pending plan.");
    const started = await this.startObjective(JSON.parse(proposal.input) as ObjectiveRequest, id);
    options.accepted?.();
    return started;
  }

  /** True when a plan is pending and `name`, if given, names it or one of its changes. */
  #pendingPlanAccepts(name?: string): boolean {
    const [entry] = this.#proposals;
    if (!entry) return false;
    if (!name) return true;
    const proposal = entry[1];
    const input = JSON.parse(proposal.input) as ObjectiveRequest;
    return ["changeSlug" in input ? input.changeSlug : undefined, input.goal,
      ...("changeSets" in input ? input.changeSets.map((item) => item.name) : []), ...proposal.names]
      .filter((candidate): candidate is string => candidate !== undefined).map(semanticSlug).includes(semanticSlug(name));
  }

  /**
   * `/merro approve`: the typed command is itself the user's approval, so it approves the pending plan it names (or
   * the only thing waiting) and otherwise resolves a merge Decision.
   */
  /** `/merro approve [plan|decision] [name]`; the qualifier is needed only when the plan and a pending Decision could both match. */
  async approvePending(target?: string): Promise<string> {
    const [first, ...rest] = target?.trim().split(/\s+/) ?? [];
    const kind = first === "plan" || first === "decision" ? first : undefined;
    const requested = (kind ? rest.join(" ") : target?.trim()) || undefined;
    if (kind === "plan" || (!kind && this.#pendingPlanAccepts(requested))) {
      const decisionAlsoMatches = !kind && await this.#withStore((store) => store.pendingDecisions().some((decision) => {
        const item = decision.subjectType === "ChangeSet" ? store.getChangeSet(decision.subjectId) : null;
        return !!item && (!requested || changeName(item) === semanticSlug(requested));
      }));
      if (decisionAlsoMatches) {
        throw new Error(requested
          ? `The pending plan and a decision both name ${semanticSlug(requested)}. Use /merro approve plan ${semanticSlug(requested)} or /merro approve decision ${semanticSlug(requested)}.`
          : "A plan and a decision are both waiting. Use /merro approve plan or /merro approve decision <change>.");
      }
      const started = await this.approveObjective(requested);
      await this.runPass();
      return `Working: ${started.changeSets.map(changeName).join(", ")}.`;
    }
    return this.resolveDecisionForChange(requested, true);
  }

  async restartChange(name: string, requirements: string): Promise<void> {
    if (!requirements.trim()) throw new Error("Describe the changed requirements for the fresh attempt.");
    await this.#withStore(async (store) => {
      let item = store.listChangeSets().find((item) => item.slug === semanticSlug(name));
      if (!item || terminal(item)) throw new Error("No active change matches that name.");
      this.#rearmNotifications(changeName(item)); // A user action starts a new conversation about the change.
      if (!store.hasActiveObjectiveForChangeSet(item.id)) throw new Error("The objective is stopped. Approve a new plan first.");
      const { projectSlug, slug } = item;
      const assertWorkerSafety = async () => {
        const { unsafeProjects } = await this.#workerSafetyPreflight(store);
        if (unsafeProjects.has(projectSlug)) throw new Error(`Cannot restart ${slug}: worker safety is unverified. Inspect owned workers and retry.`);
      };
      await assertWorkerSafety();
      const task = store.activeTask(item.id);
      const runtime = task && store.getTaskRuntime(task.id);
      if (task && !runtime) throw new Error("Worker identity is missing; inspect the worker before restarting.");
      if (task && runtime) {
        if (!this.#git.discardAttempt || !this.#workers.stop) throw new Error("Cannot safely stop and discard the previous attempt.");
        await this.#workers.stop(runtime, task.id);
        if ((await this.#workers.inspect(runtime, task.id)).alive) throw new Error("Worker is still alive. Retry after it exits.");
        await assertWorkerSafety();
        store.finalizeTask({ id: task.id, outcome: "cancelled", summary: "Stopped for changed requirements", resultJson: "{}" });
        try { await this.#git.discardAttempt(runtime.clonePath, runtime.expectedCommit); }
        catch (error) { this.#block(store, item, "task_failed", `Stopped worker, but could not restore the attempt base: ${errorText(error)}`); throw error; }
      }
      const implementation = store.listTasks(item.id).filter((candidate) => candidate.role === "implement").at(-1);
      if (implementation) store.appendEvent("Task", implementation.id, "dependency_discovery_superseded", {});
      for (const [id, proposal] of this.#proposals) {
        if (proposal.names.includes(item.slug)) this.#proposals.delete(id);
      }
      store.saveChangeSetGuidance(item.id, `${item.guidance ?? ""}\n\nChanged requirements:\n${requirements}`.trim());
      this.#resolvePullRequestDecisions(store, item.id);
      if (item.state === "Blocked" || item.state === "PublishBlocked") {
        store.transitionChangeSet(item.id, item.blockedResumeState!);
        item = store.getChangeSet(item.id)!;
      }
      if (["Reviewing", "Reviewed", "AwaitingLocalMerge", "Publishing", "AwaitingMerge", "AwaitingApproval"].includes(item.state)) store.transitionChangeSet(item.id, "Implementing");
      const workRuntime = store.getChangeSetRuntime(item.id);
      if (workRuntime) {
        workRuntime.infrastructureRetries = 0;
        if (item.delivery === "local") workRuntime.reviewedDiffHash = null;
        store.saveChangeSetRuntime(workRuntime);
      }
      this.#progress(`${changeName(item)} · Updating requirements and restarting.`);
    });
    await this.runPass();
  }

  /** `accepted` fires once the approval is spent on a selected Decision; selection failures leave the user's reply usable. */
  async resolveDecisionForChange(name: string | undefined, approved: boolean, options: { repliedAt?: number; accepted?: () => void } = {}): Promise<string> {
    const requested = name?.trim() || undefined;
    const alreadyMerged = () => this.#withStore((store) => {
      const exact = requested ? store.getChangeSet(requested) : null;
      const normalized = requested ? exact ? changeName(exact) : semanticSlug(requested) : undefined;
      const matches = store.listChangeSets().filter((item) => (!normalized || changeName(item) === normalized)
        && item.state === "Done" && !!store.getChangeSetRuntime(item.id)?.mergedCommitSha);
      if (matches.length !== 1) return null;
      const item = matches[0]!;
      const runtime = store.getChangeSetRuntime(item.id)!;
      return item.delivery === "local" ? `Already completed: ${changeName(item)} · Local delivery to ${item.targetBranch}.`
        : `Already merged: ${changeName(item)} · PR #${runtime.pullRequestNumber ?? "?"} merged.`;
    });
    let decisionId: string;
    try {
      decisionId = await this.decisionForChange(requested ?? "");
    } catch (error) {
      if (approved) {
        const message = await alreadyMerged();
        if (message) { options.accepted?.(); return message; }
      }
      throw error;
    }
    const decision = await this.#withStore((store) => store.getDecision(decisionId));
    const subject = decision && await this.#withStore((store) => store.getChangeSet(decision.subjectId));
    if (subject) this.#rearmNotifications(changeName(subject)); // A user action starts a new conversation about the change.
    if (!approved && decision?.kind === "worker_settings") {
      const { objective } = decision.payload as { objective: string };
      throw new Error(`New work waits for worker settings. Approve: /merro approve ${semanticSlug(requested ?? "") || "<change>"} · Skip: /merro stop ${objective}`);
    }
    if (approved && options.repliedAt !== undefined && decision && Date.parse(decision.createdAt) >= options.repliedAt) throw new StaleApprovalError();
    options.accepted?.();
    const kind = decision?.kind;
    let localMergeOutcome: LocalMergeOutcome | undefined;
    try {
      if (kind === "merge_conflict") await this.resolveMergeConflictDecision(decisionId, approved ? "resolved" : "abandon");
      else if (kind === "worker_settings") await this.#resolveWorkerSettingsDecision(decisionId);
      else if (kind === "local_merge") localMergeOutcome = await this.resolveLocalMergeDecision(decisionId, approved);
      else await this.resolveMergeDecision(decisionId, approved);
    } catch (error) {
      if (approved) {
        const message = await alreadyMerged();
        if (message) return message;
      }
      throw error;
    }
    const resolved = await this.#withStore((store) => {
      const decision = store.getDecision(decisionId);
      const item = decision && store.getChangeSet(decision.subjectId);
      const runtime = item && store.getChangeSetRuntime(item.id);
      return item && runtime ? { name: changeName(item), state: item.state, pr: runtime.pullRequestNumber, targetBranch: item.targetBranch } : null;
    });
    if (!resolved) return "Decision resolved.";
    if (kind === "worker_settings") return `Approved worker settings for ${resolved.name}.`;
    if (kind === "local_merge") {
      if (!approved) return `Local merge declined for ${resolved.name}; no changes applied.`;
      if (localMergeOutcome === "done") return `Applied locally: ${resolved.name} · ${resolved.targetBranch}.`;
      if (localMergeOutcome === "base_updated") return "Local base changed; fresh implementation, verification, review, and approval are required.";
      if (localMergeOutcome === "blocked") {
        const change = (await this.publicSnapshot()).changes.find((candidate) => candidate.name === resolved.name);
        return change?.blocked
          ? `${change.blocked.message} ${change.blocked.next}`
          : `Local merge failed. Check the canonical checkout, then /merro retry ${resolved.name}.`;
      }
      return `Local merge for ${resolved.name} could not be completed; check /merro ${resolved.name}.`;
    }
    if (approved && resolved.state === "Done") return `Merged: ${resolved.name} · PR #${resolved.pr ?? "?"}.`;
    if (kind === "merge_conflict") return approved ? `Approved a fresh implementation for ${resolved.name}.` : `Left ${resolved.name} unchanged.`;
    return approved ? `Merge approved for ${resolved.name}.` : `Left PR #${resolved.pr ?? "?"} open.`;
  }

  async decisionForChange(name = ""): Promise<string> {
    return this.#withStore((store) => {
      const exact = name ? store.getChangeSet(name) : null;
      const normalized = name ? exact ? changeName(exact) : semanticSlug(name) : "";
      const matches = store.pendingDecisions().filter((decision) => {
        if (decision.subjectType !== "ChangeSet") return false;
        const item = store.getChangeSet(decision.subjectId);
        return !normalized || item && changeName(item) === normalized;
      });
      if (matches.length > 1) {
        const names = matches.map((decision) => {
          const item = store.getChangeSet(decision.subjectId);
          return item ? changeName(item) : "change";
        });
        throw new Error(`Choose a change: ${names.join(", ")}.`);
      }
      if (matches.length === 0) throw new Error(name ? `No pending decision for ${normalized}.` : "No pending decisions.");
      return matches[0]!.id;
    });
  }

  async stopObjectives(objectiveId?: string): Promise<number> {
    const stopped = await this.#withStore((store) => {
      const objectives = store.listObjectives();
      const exactObjective = objectiveId ? objectives.find((entry) => entry.id === objectiveId) : undefined;
      const exactChange = objectiveId ? store.getChangeSet(objectiveId) : null;
      const objectiveSlug = objectiveId ? exactObjective ? objectiveName(exactObjective.goal)
        : exactChange ? changeName(exactChange) : semanticSlug(objectiveId) : undefined;
      const objective = objectiveId ? objectives.find((entry) => entry.id === objectiveId || entry.goal === objectiveId
        || objectiveName(entry.goal) === objectiveSlug
        || store.listChangeSets(entry.id).some((item) => changeName(item) === objectiveSlug)) : undefined;
      if (objectiveId && !objective) throw new Error("No active Objective matches that name.");
      return store.stopActiveObjectives(objective?.id);
    });
    await this.runPass();
    return stopped;
  }

  async retryChangeSet(name?: string): Promise<string> {
    const result = await this.#withStore((store) => {
      const requested = name?.trim() || undefined;
      const changes = store.listChangeSets();
      const exact = requested ? store.getChangeSet(requested) : null;
      const normalized = requested ? exact ? changeName(exact) : semanticSlug(requested) : undefined;
      const selected = normalized ? exact ?? changes.find((item) => changeName(item) === normalized) : undefined;
      if (normalized && !selected) return { message: `Nothing to retry. No change named ${normalized}.` };
      if (selected?.state === "Done") {
        const runtime = store.getChangeSetRuntime(selected.id);
        return { message: runtime?.mergedCommitSha
          ? `Already done: ${changeName(selected)} · PR #${runtime.pullRequestNumber ?? "?"} merged.`
          : `Already done: ${changeName(selected)}.` };
      }
      const retryable = (item: ChangeSet) => (item.state === "Blocked" || item.state === "PublishBlocked")
        && !!item.blockedResumeState
        && item.blockedReason !== "github_unavailable"
        && item.blockedReason !== "project_unavailable"
        && store.latestBlock(item.id)?.retryable !== false;
      let candidates = (normalized ? selected ? [selected] : [] : changes).filter(retryable);
      if (!normalized && candidates.length > 1) return { message: `Choose a change to retry: ${candidates.map(changeName).join(", ")}.` };
      const item = candidates[0];
      if (!item) {
        const teamWaiting = (selected ? [selected] : changes).filter((candidate) => candidate.state === "AwaitingApproval");
        if (teamWaiting.length) return { message: `${teamWaiting.map(changeName).join(", ")} · GitHub requires review from a configured team for files changed by this PR. Merro will continue automatically once GitHub reports the merge requirement satisfied.` };
        if (selected?.state === "AwaitingMerge" && store.getChangeSetRuntime(selected.id)?.githubReviewDecision?.toUpperCase() === "REVIEW_REQUIRED") {
          return { message: `Nothing to retry. ${changeName(selected)} needs GitHub reviewer approval.` };
        }
        if (!normalized) {
          const waiting = changes.filter((candidate) => candidate.state === "AwaitingMerge"
            && store.getChangeSetRuntime(candidate.id)?.githubReviewDecision?.toUpperCase() === "REVIEW_REQUIRED");
          if (waiting.length === 1) return { message: `Nothing to retry. ${changeName(waiting[0]!)} needs GitHub reviewer approval.` };
          if (waiting.length > 1) return { message: `Nothing to retry. These changes need GitHub reviewer approval: ${waiting.map(changeName).join(", ")}.` };
        }
        const blocked = selected && (selected.state === "Blocked" || selected.state === "PublishBlocked") ? selected
          : !normalized ? changes.find((candidate) => (candidate.state === "Blocked" || candidate.state === "PublishBlocked")
            && candidate.blockedReason === "policy_unknown" && store.latestBlock(candidate.id)?.retryable === false) : undefined;
        if (blocked?.blockedReason === "policy_unknown") {
          return { message: `Nothing to retry. ${changeName(blocked)} is blocked by a GitHub branch rule Merro cannot interpret. Change the rule; Merro will check again automatically.` };
        }
        if (selected && (selected.state === "Blocked" || selected.state === "PublishBlocked")
          && (selected.blockedReason === "github_unavailable" || selected.blockedReason === "project_unavailable")) {
          return { message: `Nothing to retry. Merro will retry ${changeName(selected)} automatically when GitHub is available.` };
        }
        return { message: normalized ? `Nothing to retry. ${changeName(selected!)} is not waiting for a retry.` : "Nothing to retry." };
      }
      store.transitionChangeSet(item.id, item.blockedResumeState!);
      const runtime = store.getChangeSetRuntime(item.id) ?? emptyRuntime(item.id);
      if (item.blockedReason === "review_cap" || item.blockedReason === "task_failed") runtime.infrastructureRetries = 0;
      if (item.blockedReason === "review_cap") runtime.reviewRound = 0;
      store.saveChangeSetRuntime(runtime);
      return { name: changeName(item) };
    });
    if ("message" in result) return result.message;
    this.#rearmNotifications(result.name); // A user action starts a new conversation about the change.
    await this.runPass();
    return `Retrying ${result.name}.`;
  }

  async continueChangeSet(changeSetId: string): Promise<void> {
    const result = await this.retryChangeSet(changeSetId);
    if (!result.startsWith("Retrying ")) throw new Error(result);
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
    if (decisionKind === "local_merge") {
      await this.resolveLocalMergeDecision(decisionId, approved);
      return;
    }
    if (decisionKind !== "merge") throw new Error(`pending merge Decision not found: ${decisionId}`);

    await this.#withStore((store) => this.#executeMergeDecision(store, decisionId, approved));
    await this.runPass();
  }

  async #executeMergeDecision(store: MerroStore, decisionId: string, approved: boolean): Promise<void> {
    const decision = store.getDecision(decisionId);
    if (!decision || decision.state !== "pending" || decision.kind !== "merge") {
      throw new Error(`pending merge Decision not found: ${decisionId}`);
    }
    const item = store.getChangeSet(decision.subjectId);
    const runtime = item && store.getChangeSetRuntime(item.id);
    const project = item && store.getProject(item.projectSlug);
    if (!item || item.state !== "AwaitingMerge" || !runtime?.pullRequestNumber || !project) {
      throw new Error(`merge Decision ${decisionId} no longer matches an AwaitingMerge ChangeSet`);
    }

    const { unsafeProjects } = await this.#workerSafetyPreflight(store);
    if ((await this.#unapprovedDiscoveredDependencies(store, item)).length || this.#reconcileReviewedDependencies(store, unsafeProjects).has(item.id)) {
      throw new Error("Merge approval expired because prerequisites changed or a discovery still needs approval; reconcile before approving again.");
    }
    if (approved && unsafeProjects.has(project.slug)) {
      throw new Error(`Worker safety prevents merge approval in Project ${project.slug}; retry after live workers exit and inventory succeeds. Decision remains pending.`);
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
        await this.#completeMergedChangeSet(store, item, runtime, project, pullRequest, unsafeProjects);
        store.resolveDecision(decisionId, "resolved");
        await this.#finishObjectives(store, new Set(), unsafeProjects);
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
        await this.#git.ensureChangeSetClone?.(project, runtime.clonePath, runtime.branchName, pullRequest.headRefOid);
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
        if (requiredTeamReviewApplies(pullRequest, policy) && !teamReviewGateSatisfied(pullRequest, policy)) {
          this.#waitForRequiredTeamReview(store, item, runtime, pullRequest);
          return;
        }
        store.resolveDecision(decisionId, "resolved");
        runtime.reviewedDiffHash = null;
        store.saveChangeSetRuntime(runtime);
        this.#progress(`${changeName(item)} · Merge approval expired because the pull request changed. Review is next.`);
        return;
      }
      if (runtime.reviewedDiffHash === null) {
        runtime.reviewedDiffHash = currentDiff;
        store.saveChangeSetRuntime(runtime);
      }

      mergeAttempted = true;
      await this.#github.merge(project, runtime.pullRequestNumber, pullRequest.headRefOid, { method: this.#config.merge.method, deleteBranch: this.#config.merge.deleteBranch });
      mergeCommandSucceeded = true;
      pullRequest = await this.#github.pullRequest(project, runtime.pullRequestNumber);
      if (!pullRequest.mergedAt) throw new Error("GitHub did not report the pull request as merged");
      if (!isCommitSha(pullRequest.mergeCommitSha)) throw new Error("GitHub did not report a valid merged commit SHA");
      await this.#completeMergedChangeSet(store, item, runtime, project, pullRequest, unsafeProjects);
      store.resolveDecision(decisionId, "approved");
    } catch (error) {
      store.resolveDecision(decisionId, "resolved");
      const unavailable = !mergeAttempted || mergeCommandSucceeded
        || (error instanceof GitHubMergeError && error.kind === "unavailable");
      const reason = unavailable ? "github_unavailable" : "merge_failed";
      this.#block(store, item, reason, `Merge ${unavailable ? "reconciliation failed" : "was rejected"}: ${errorText(error)}`);
    }
    await this.#finishObjectives(store, new Set(), unsafeProjects);
  }

  async resolveLocalMergeDecision(decisionId: string, approved: boolean): Promise<LocalMergeOutcome> {
    const outcome = await this.#withStore(async (store): Promise<LocalMergeOutcome> => {
      const decision = store.getDecision(decisionId);
      if (!decision || decision.state !== "pending" || decision.kind !== "local_merge") {
        throw new Error(`pending local merge Decision not found: ${decisionId}`);
      }
      const item = store.getChangeSet(decision.subjectId);
      const runtime = item && store.getChangeSetRuntime(item.id);
      const project = item && store.getProject(item.projectSlug);
      if (!item || item.delivery !== "local" || item.state !== "AwaitingLocalMerge" || !runtime?.clonePath
        || !runtime.baseCommit || !item.targetBranch || !project || !this.#git.inspectLocalDelivery || !this.#git.deliverLocal) {
        throw new Error(`local merge Decision ${decisionId} no longer matches an AwaitingLocalMerge ChangeSet`);
      }
      if (!approved) {
        store.resolveDecision(decisionId, "rejected");
        this.#block(store, item, "merge_rejected", "Local merge declined; the canonical checkout remains unchanged");
        return "declined";
      }
      const { unsafeProjects } = await this.#workerSafetyPreflight(store);
      if ((await this.#unapprovedDiscoveredDependencies(store, item)).length || this.#reconcileReviewedDependencies(store, unsafeProjects).has(item.id)) return "blocked";
      if (unsafeProjects.has(project.slug) || store.activeTask(item.id)) {
        throw new Error(`Worker safety prevents local merge in Project ${project.slug}; retry after workers exit and inventory succeeds. Decision remains pending.`);
      }
      const payload = typeof decision.payload === "object" && decision.payload !== null
        ? decision.payload as Record<string, unknown> : {};
      const reviewedCommit = typeof payload.reviewedCommit === "string" ? payload.reviewedCommit : null;
      const baseCommit = typeof payload.baseCommit === "string" ? payload.baseCommit : null;
      const diffHash = typeof payload.diffHash === "string" ? payload.diffHash : null;
      const reviewTask = store.listTasks(item.id).at(-1);
      if (!reviewedCommit || !baseCommit || !diffHash || baseCommit !== runtime.baseCommit
        || reviewTask?.role !== "review" || reviewTask.outcome !== "pass" || reviewTask.reviewedCommit !== reviewedCommit
        || payload.targetBranch !== item.targetBranch) {
        store.resolveDecision(decisionId, "resolved");
        this.#resolveMergeDecisions(store, item.id);
        this.#block(store, item, "merge_failed", "Local merge approval no longer matches the passing review; inspect the checkout and retry for a fresh approval");
        return "blocked";
      }
      try {
        const inspection = await this.#git.inspectLocalDelivery(project, runtime.clonePath, item.targetBranch, reviewedCommit, baseCommit);
        if ("baseUpdate" in inspection) {
          store.resolveDecision(decisionId, "resolved");
          this.#queueLocalBaseUpdate(store, item, runtime, inspection.baseUpdate);
          return "base_updated";
        }
        if (inspection.diffHash !== diffHash || runtime.reviewedDiffHash !== diffHash) {
          throw new Error("The reviewed diff changed after approval was requested");
        }
        const delivered = await this.#git.deliverLocal(project, runtime.clonePath, item.targetBranch, reviewedCommit, baseCommit, diffHash);
        if ("baseUpdate" in delivered) {
          store.resolveDecision(decisionId, "resolved");
          this.#queueLocalBaseUpdate(store, item, runtime, delivered.baseUpdate);
          return "base_updated";
        }
        store.resolveDecision(decisionId, "approved");
        store.completeLocalChangeSet(item.id, delivered.commit);
        this.#notify(`${changeName(item)} done · Applied locally to ${item.targetBranch}.`);
        await this.#finishObjectives(store, new Set(), unsafeProjects);
        return "done";
      } catch (error) {
        if (store.getDecision(decisionId)?.state === "pending") store.resolveDecision(decisionId, "resolved");
        const current = store.getChangeSet(item.id);
        if (current && current.state !== "Blocked" && !terminal(current)) {
          this.#resolveMergeDecisions(store, item.id);
          this.#block(store, current, "merge_failed", `Local merge failed: ${errorText(error)}`);
        }
        return "blocked";
      }
    });
    await this.runPass();
    return outcome;
  }

  async resolveMergeConflictDecision(decisionId: string, resolution: "resolved" | "abandon"): Promise<void> {
    await this.#withStore(async (store) => {
      const decision = store.getDecision(decisionId);
      if (!decision || decision.state !== "pending" || decision.kind !== "merge_conflict") {
        throw new Error(`pending merge_conflict Decision not found: ${decisionId}`);
      }
      const item = store.getChangeSet(decision.subjectId);
      const runtime = item && store.getChangeSetRuntime(item.id);
      const project = item && store.getProject(item.projectSlug);
      if (!item || item.state !== "AwaitingMerge" && item.state !== "AwaitingApproval" || !runtime?.clonePath || !runtime.branchName
        || !runtime.pullRequestNumber || !project) {
        throw new Error(`merge_conflict Decision ${decisionId} no longer matches an open pull request ChangeSet`);
      }
      const { unsafeProjects } = await this.#workerSafetyPreflight(store);
      if (resolution === "resolved" && unsafeProjects.has(project.slug)) {
        throw new Error(`Worker safety prevents conflict approval in Project ${project.slug}; retry after live workers exit and inventory succeeds. Decision remains pending.`);
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
        await this.#completeMergedChangeSet(store, item, runtime, project, pullRequest, unsafeProjects);
        store.resolveDecision(decisionId, "resolved");
        return;
      }
      if (pullRequest.state !== "OPEN") {
        store.resolveDecision(decisionId, "resolved");
        this.#block(store, item, "pr_closed", "Pull request was closed without merging");
        return;
      }
      if (!this.#git.ensureChangeSetClone) throw new Error("Git adapter cannot restore the conflict branch");
      await this.#git.ensureChangeSetClone(project, runtime.clonePath, runtime.branchName, pullRequest.headRefOid);
      const remoteHead = this.#git.remoteBranchCommit
        ? await this.#git.remoteBranchCommit(project, runtime.branchName)
        : pullRequest.headRefOid;
      if (remoteHead !== pullRequest.headRefOid) throw new Error("remote conflict branch does not match the pull request head");
      this.#queueBaseUpdate(store, item, runtime, pullRequest);
      store.resolveDecision(decisionId, "resolved");
    });
    await this.runPass();
  }

  #presentationOptions() {
    return { maxConcurrentTasks: this.#config.maxConcurrentTasks, orphanedTaskCount: this.#orphanedTaskCount };
  }

  async runPass(): Promise<void> {
    // Completion hooks may query Main, so release ownership before delivering them.
    // A fresh pass rechecks worker and GitHub truth before deferred publication.
    if (await this.#runPassOnce()) await this.#runPassOnce();
  }

  async #runPassOnce(): Promise<boolean> {
    let publicationDeferred = false;
    await this.#withStore(async (store) => {
      const unsafeProjects = new Set<string>();
      const finalizedTaskCount = () => store.listTasks().filter((task) => task.status === "finalized").length;
      let inventoriedFinalizedTaskCount = -1;
      try {
        if (store.listChangeSets().some((item) => !terminal(item) && (item.issues.length || item.delivery === "pr"))) this.#github.beginPass?.();
        const issueCache = new Map<string, Map<number, GitHubIssue>>();
        const unavailableProjects = await this.#reconcileProjects(store);
        let orphans = await this.#workerSafetyPreflight(store, unsafeProjects);
        inventoriedFinalizedTaskCount = finalizedTaskCount();
        const scopeGates = new Set<string>();
        for (const objective of store.listObjectives()) {
          if (objective.state === "Active" && objective.issueScopes?.some((scope) => "query" in scope)) {
            await this.#refreshObjectiveScope(store, objective, unavailableProjects, scopeGates, unsafeProjects, issueCache);
          }
        }
        await this.#reconcileIssues(store, unavailableProjects, orphans.changeSetIds, issueCache);
        await this.#reconcileTasks(store, unavailableProjects, unsafeProjects, orphans.liveTaskIds);
        // Result submission does not prove exit. Newly finalized live workers still occupy their slots.
        if (finalizedTaskCount() !== inventoriedFinalizedTaskCount) {
          orphans = await this.#workerSafetyPreflight(store, unsafeProjects);
          inventoriedFinalizedTaskCount = finalizedTaskCount();
        }
        store.settleScopeDetachments();
        for (const item of store.listChangeSets()) {
          if (!unsafeProjects.has(item.projectSlug)) this.#obsoleteIfUnowned(store, item);
        }
        const discoveredGates = await this.#reconcileDiscoveredDependencies(store);
        const staleDependencies = this.#reconcileReviewedDependencies(store, unsafeProjects);
        for (const id of discoveredGates) staleDependencies.add(id);
        publicationDeferred = await this.#reconcileLocalDelivery(store, unavailableProjects, unsafeProjects, staleDependencies);
        publicationDeferred = await this.#reconcilePublication(store, unavailableProjects, unsafeProjects, staleDependencies) || publicationDeferred;
        await this.#reconcilePullRequests(store, unavailableProjects, unsafeProjects);
        this.#reconcileReviewedDependencies(store, unsafeProjects);
        const relationGates = await this.#rebuildRelations(store, unavailableProjects, orphans.changeSetIds, issueCache);
        for (const id of scopeGates) relationGates.add(id);
        for (const id of discoveredGates) relationGates.add(id);
        this.#settleSettingsDecisions(store);
        for (const decision of store.pendingDecisions()) {
          if (decision.kind === "worker_settings") relationGates.add(decision.subjectId);
        }
        for (const relation of store.listRelations()) {
          if (relation.kind !== "Requires") continue;
          const prerequisite = store.getChangeSet(relation.to);
          if (prerequisite && (unsafeProjects.has(prerequisite.projectSlug) || unavailableProjects.has(prerequisite.projectSlug))) {
            relationGates.add(relation.from);
          }
        }
        const reviewedChangeSetIds = currentlyReviewedIds(store);
        this.#deriveReady(store, unavailableProjects, relationGates, unsafeProjects, orphans.changeSetIds, reviewedChangeSetIds);
        const tasks = store.listTasks();
        const active = tasks.filter((task) => task.status === "active");
        const items = store.listChangeSets();
        const result = schedule({
          changeSets: items.filter((item) => item.state === "Done" || reviewedChangeSetIds.has(item.id)
            || store.hasActiveObjectiveForChangeSet(item.id)
              && !unavailableProjects.has(item.projectSlug) && !unsafeProjects.has(item.projectSlug) && !relationGates.has(item.id)),
          relations: store.listRelations(),
          reviewedChangeSetIds: [...reviewedChangeSetIds],
          activeTaskCount: active.length + orphans.count,
          activeChangeSetIds: [...active.map((task) => task.changeSetId), ...orphans.changeSetIds],
          maxConcurrentTasks: this.#config.maxConcurrentTasks,
        });
        if (result.cycle) this.#blockCycle(store, result.cycle, new Set([...active.map((task) => task.changeSetId), ...orphans.changeSetIds]));
        for (const item of result.selected) {
          const settingsOwner = this.#ownerNeedingSettings(store, item);
          if (settingsOwner) { this.#askSettings(store, settingsOwner, item); continue; }
          if (this.#reviewCapReached(store, item)) continue;
          if (item.state === "Ready") store.transitionChangeSet(item.id, "Implementing");
          await this.#launchTask(store, store.getChangeSet(item.id) ?? item, issueCache);
        }
        await this.#finishObjectives(store, unavailableProjects, unsafeProjects, issueCache);
      } finally {
        // Cover exceptional exits and Tasks finalized by failed launches after scheduling.
        if (finalizedTaskCount() !== inventoriedFinalizedTaskCount) {
          await this.#workerSafetyPreflight(store, unsafeProjects);
        }
        await this.#reconcileFinalizedTasks(store, unsafeProjects);
      }
    });
    return publicationDeferred;
  }

  async #withStore<T>(action: (store: MerroStore) => T | Promise<T>): Promise<T> {
    let notifications: Array<{ event: string; subjectId: string; message: string }> = [];
    const operation = this.#storeQueue.then(async () => {
      try {
        return await this.#lockedStore(action);
      } finally {
        notifications = this.#pendingNotifications.splice(0);
      }
    });
    this.#storeQueue = operation.catch(() => undefined);
    try {
      return await operation;
    } finally {
      // Hooks run after ownership and serialization are released; they may query Main.
      for (const notification of notifications) {
        try {
          await this.#commands.run("bash", ["-lc", this.#config.notifyCommand!], {
            cwd: this.#workspacePath,
            env: { MERRO_EVENT: notification.event, MERRO_CHANGE: this.#names.get(notification.subjectId) ?? "change", MERRO_MESSAGE: publicText(notification.message, this.#names) },
          });
        } catch (error) {
          this.#notify(`notifyCommand failed: ${errorText(error)}`, "warning");
        } finally {
          if (notification.event === "review_complete") this.#reviewNotificationsInFlight.delete(notification.subjectId);
        }
      }
    }
  }

  async #lockedStore<T>(action: (store: MerroStore) => T | Promise<T>): Promise<T> {
    await requireWorkspace(this.#workspacePath);
    const lock = new MainLock(join(this.#stateDirectory, "main.lock.db"));
    await lock.acquire();
    let store: MerroStore | undefined;
    try {
      store = new MerroStore(join(this.#stateDirectory, "state.db"));
      for (const item of store.listChangeSets()) this.#names.set(item.id, changeName(item));
      for (const objective of store.listObjectives()) this.#names.set(objective.id, objective.goal);
      for (const task of store.listTasks()) {
        const item = store.getChangeSet(task.changeSetId);
        if (item) this.#names.set(task.id, workerName(item, task));
      }
      for (const decision of store.pendingDecisions()) this.#names.set(decision.id, this.#names.get(decision.subjectId) ?? decision.kind);
      try { return await action(store); } catch (error) {
        if (error instanceof Error) error.message = publicText(error.message, this.#names);
        throw error;
      }
    } finally {
      try {
        store?.close();
      } finally {
        await lock.release();
      }
    }
  }

  async #launchTask(store: MerroStore, item: ChangeSet, issueCache: Map<string, Map<number, GitHubIssue>>): Promise<void> {
    const role: TaskRole = item.state === "Reviewing" ? "review" : "implement";
    const project = store.getProject(item.projectSlug);
    if (!project) return this.#block(store, item, "project_unavailable", `Project ${item.projectSlug} is not registered`);
    let runtime = store.getChangeSetRuntime(item.id) ?? emptyRuntime(item.id);
    const taskId = randomUUID();
    let expectedCommit: string;
    let runtimeIntent: TaskRuntimeRecord | null = null;
    let workerLaunchStarted = false;
    try {
      assertProjectSlug(project.slug);
      const issues = item.issues.length ? issueNumbers(item).map((number) => {
        const issue = issueCache.get(project.slug)?.get(number);
        if (!issue) throw new Error(`GitHub issue #${number} was not returned during reconciliation`);
        return issue;
      }) : [];
      const issue = issues[0] ?? null;
      const slug = changeName(item);
      this.#names.set(taskId, `${role === "implement" ? "impl" : "rev"}-${slug}`);
      const attempt = store.listTasks(item.id).filter((task) => task.role === role).reduce((highest, task) => Math.max(highest, task.attempt), 0) + 1;
      const taskName = `${role === "implement" ? "implement" : "review"}-${slug}-${attempt}`;
      if (!runtime.clonePath || !runtime.branchName) {
        const branch = runtime.branchName ?? (issue ? branchName(issue, slug) : `chore/${slug}`);
        await this.#ensureWorkspaceDirectory(join(this.#config.worktreesDir, project.slug));
        const clonePath = join(this.#workRoot, project.slug, slug);
        const clone = await this.#git.createChangeSetClone({ ...project, defaultBranch: item.targetBranch ?? project.defaultBranch }, clonePath, branch, item.delivery ?? "pr");
        runtime = { ...runtime, branchName: clone.branchName, clonePath: clone.path, baseCommit: clone.baseCommit };
        store.saveChangeSetRuntime(runtime);
        await this.#workers.prepareClone(project, clone.path, store.getProjectSettings(project.slug));
      }
      const clonePath = runtime.clonePath;
      if (!clonePath) throw new Error("ChangeSet clone path is unavailable");
      const baseUpdate = role === "implement" ? runtime.baseUpdate ?? null : null;
      if (baseUpdate) await this.#git.fetchBaseCommit(clonePath, baseUpdate.baseRefName, baseUpdate.baseCommit);
      expectedCommit = await this.#git.currentCommit(clonePath);
      const objective = store.listObjectives().find((candidate) => store.listChangeSets(candidate.id).some((changeSet) => changeSet.id === item.id));
      if (!objective) throw new Error(`ChangeSet ${item.id} is not attached to an Objective`);
      const previousReview = store.listTasks(item.id).reverse().find((task) => task.role === "review" && task.resultJson);
      const latestReview = previousReview?.resultJson ? this.#reviewContext(previousReview.resultJson) : null;
      const actionablePriorFindings = previousReview?.resultJson ? this.#actionableReviewFindings(previousReview.resultJson) : null;
      const implementationTask = role === "review"
        ? store.listTasks(item.id).reverse().find((task) => task.role === "implement" && task.outcome === "success" && task.resultJson)
        : undefined;
      const implementationResult = implementationTask?.resultJson
        ? parseImplementResult(JSON.parse(implementationTask.resultJson))
        : null;
      const instructions = role === "implement" ? await this.#repositoryInstructions(clonePath) : [];
      const reviewedChangeSetIds = currentlyReviewedIds(store);
      const directDependencies = store.listRelations().filter((relation) => relation.kind === "Requires" && relation.from === item.id)
        .flatMap((relation) => {
          const dependency = store.getChangeSet(relation.to);
          const isDone = dependency?.state === "Done";
          if (!dependency || !isDone && ((relation.gate ?? "done") !== "reviewed" || !reviewedChangeSetIds.has(dependency.id))) return [];
          const depRuntime = store.getChangeSetRuntime(dependency.id);
          const sourceProject = store.getProject(dependency.projectSlug);
          const latestReview = store.listTasks(dependency.id).filter((task) => task.role === "review").at(-1);
          const reviewedCommit = latestReview?.outcome === "pass" ? latestReview.reviewedCommit : null;
          const consumesReview = (relation.gate ?? "done") === "reviewed";
          const commit = consumesReview ? reviewedCommit : depRuntime?.mergedCommitSha ?? null;
          const project = sourceProject && consumesReview && depRuntime?.clonePath
            ? { ...sourceProject, path: depRuntime.clonePath, baseRemote: "", pushRemote: "" }
            : sourceProject && dependency.delivery === "local"
              ? { ...sourceProject, baseRemote: "", pushRemote: "" }
              : sourceProject;
          const summary = latestReview?.summary ?? null;
          return [{
            relation,
            changeSetId: dependency.id,
            projectSlug: dependency.projectSlug,
            project,
            pullRequestUrl: depRuntime?.pullRequestUrl ?? null,
            commit,
            summary,
          }];
        });
      const projectSettings = store.getProjectSettings(project.slug);
      const markdownGuidance = await loadMarkdownGuidance(this.#workspacePath, [project.slug], role);
      const workerSystemPrompt = role === "review"
        ? renderMarkdownGuidance([
          ...(projectSettings?.guidance.trim() ? [{ path: "Persisted Project guidance", text: projectSettings.guidance.trim() }] : []),
          ...markdownGuidance.filter(({ path }) => path.startsWith(".merro/projects/")),
          ...markdownGuidance.filter(({ path }) => path === ".merro/WORKSPACE.md"),
          ...markdownGuidance.filter(({ path }) => path === ".merro/REVIEWER.md"),
        ])
        : "";
      const useDocker = (projectSettings?.sandbox ?? this.#config.sandbox) === "docker";
      const dependencyMounts = directDependencies.map((dependency, index) => {
        if (!dependency.project) throw new Error(`dependency Project ${dependency.projectSlug} is not registered`);
        if (!dependency.commit || !/^[0-9a-f]{40,64}$/i.test(dependency.commit)) {
          throw new Error(`dependency ChangeSet ${dependency.changeSetId} has no exact prerequisite commit`);
        }
        const mountNumber = index + 1;
        return {
          project: dependency.project,
          commit: dependency.commit,
          mount: {
            projectSlug: dependency.projectSlug,
            checkoutPath: join(this.#stateDirectory, "runtime", "tasks", taskName, "dependencies", String(mountNumber)),
            mountPath: `/merro-dependencies/${mountNumber}`,
          },
        };
      });
      const dependencyContext = directDependencies.map((dependency, index) => ({
        change: this.#names.get(dependency.changeSetId) ?? "dependency",
        projectSlug: dependency.projectSlug,
        pullRequestUrl: dependency.pullRequestUrl,
        commit: dependency.commit,
        summary: dependency.summary,
        ...(dependency.relation.gate ? { gate: dependency.relation.gate } : {}),
        ...(dependencyMounts[index] ? {
          checkoutPath: useDocker ? dependencyMounts[index]!.mount.mountPath : dependencyMounts[index]!.mount.checkoutPath,
        } : {}),
      }));
      const taskFile = renderTaskFile({
        role, change: slug, projectSlug: item.projectSlug,
        ...(role === "implement" ? { registeredProjects: store.listProjects().map((registered) => registered.slug) } : {}),
        issues: issueNumbers(item),
        title: slug, scope: issues.length ? issues.map((issue) => `### #${issue.number}: ${issue.title}\n\n${issue.body}`).join("\n\n") : item.guidance ?? objective.goal,
        implementation: implementationResult?.status === "success" ? implementationResult : null,
        objective: objective.goal,
        userGuidance: [item.guidance ?? "", ...(role === "implement" && store.hasEvent("ChangeSet", item.id, "dependency_stale")
          ? ["Previously implemented work is stale against the approved prerequisites. Revalidate the complete change against the exact dependency checkouts below, update code as needed, and rerun verification before committing. Preserve prior finalized commits."] : [])].filter(Boolean).join("\n\n"),
        projectGuidance: projectSettings?.guidance ?? "",
        markdownGuidance: role === "implement" ? markdownGuidance : [],
        repositoryInstructions: instructions,
        dependencies: dependencyContext, latestReview: role === "review" ? actionablePriorFindings : latestReview,
        expectedCommit, baseCommit: runtime.baseCommit ?? expectedCommit, baseUpdate,
        proposeIssues: this.#config.issues.create !== "disabled",
      });
      const launchInput = {
        taskId, changeSetId: item.id, changeSlug: slug, taskName, role, project, clonePath,
        taskFile: publicText(taskFile, this.#names), expectedCommit, baseUpdate, projectSettings,
        workerSettings: store.changeSetWorkerSettings(item.id),
        ...(workerSystemPrompt ? { systemPrompt: workerSystemPrompt } : {}),
        dependencies: dependencyMounts.map(({ mount }) => mount),
      };
      runtimeIntent = this.#workers.plan?.(launchInput) ?? {
        taskId,
        runtimeKind: null,
        tmuxSession: `${this.#config.tmux.session}-${project.slug}`,
        tmuxWindow: taskWindowName(role, slug),
        paneId: null,
        containerId: null,
        processPid: null,
        processStartedAt: null,
        clonePath,
        taskFilePath: join(clonePath, ".merro-task.md"),
        resultPath: join(this.#stateDirectory, "runtime", "tasks", taskName, ".merro-result.json"),
        expectedCommit, ...(baseUpdate ? { baseUpdate } : {}),
        startedAt: new Date().toISOString(),
      } satisfies TaskRuntimeRecord;
      store.createTask({ id: taskId, changeSetId: item.id, role, attempt, runtime: runtimeIntent });
      if (role === "implement") {
        runtime.implementationAttempt = attempt;
        store.saveChangeSetRuntime(runtime);
      }
      for (const dependency of dependencyMounts) {
        if (!this.#git.createReadOnlyCheckout) throw new Error("Git adapter cannot create dependency checkouts");
        await this.#git.createReadOnlyCheckout(dependency.project, dependency.mount.checkoutPath, dependency.commit);
      }
      for (const dependency of directDependencies) {
        if (role === "implement" && (dependency.relation.gate ?? "done") === "reviewed" && dependency.commit) {
          store.recordReviewedDependencyConsumption(item.id, dependency.changeSetId, dependency.commit);
          store.appendEvent("Task", taskId, "reviewed_dependency_consumed", { prerequisite: dependency.changeSetId, commit: dependency.commit });
        }
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
          this.#block(store, store.getChangeSet(item.id) ?? item, "task_failed", `Worker launch failed; Task remains active until it can be stopped safely: ${errorText(stopError)}`);
          return;
        }
      }
      const task = store.getTask(taskId);
      if (task?.status === "active") store.finalizeTask({
        id: taskId, outcome: "failed", summary: "Worker launch failed", resultJson: JSON.stringify({ error: errorText(error) }),
      });
      const current = store.getChangeSet(item.id);
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
        const needsGitHub = store.listChangeSets().some((item) => item.projectSlug === current.slug && !terminal(item) && (item.issues.length || item.delivery === "pr"));
        const repository = needsGitHub ? await this.#github.repository(discovered.baseRemote) : null;
        const reconciled = { ...discovered, defaultBranch: repository?.defaultBranch ?? discovered.defaultBranch };
        store.updateProject(reconciled);
        let resumed = false;
        for (const item of store.listChangeSets().filter((candidate) => candidate.projectSlug === current.slug)) {
          if (item.state === "Blocked" && item.blockedReason === "project_unavailable" && item.blockedResumeState) {
            store.transitionChangeSet(item.id, item.blockedResumeState);
            resumed = true;
          }
        }
        if (resumed) this.#progress(`${current.slug} · Project is available again.`);
      } catch (error) {
        unavailable.add(current.slug);
        const cause = isTransientGitHubFailure(error)
          ? `GitHub API temporarily unavailable. Check your internet connection or https://githubstatus.com.\n${errorText(error)}`
          : errorText(error);
        for (const item of store.listChangeSets().filter((candidate) => candidate.projectSlug === current.slug)) {
          if (!terminal(item) && item.state !== "Blocked" && item.state !== "PublishBlocked") {
            this.#block(store, item, "project_unavailable", `Project reconciliation failed: ${cause}`);
          }
        }
        this.#progress(`${current.slug} · Project is unavailable. Merro will retry automatically.`);
      }
    }
    return unavailable;
  }

  async #reconcileIssues(
    store: MerroStore,
    unavailableProjects: ReadonlySet<string>,
    occupiedChangeSetIds: ReadonlySet<string>,
    issueCache: Map<string, Map<number, GitHubIssue>>,
  ): Promise<void> {
    const byProject = new Map<string, { project: Project; items: ChangeSet[] }>();
    for (const item of store.listChangeSets()) {
      if (unavailableProjects.has(item.projectSlug) || !item.issues.length
        || !store.hasActiveObjectiveForChangeSet(item.id) && !store.activeTask(item.id) && !occupiedChangeSetIds.has(item.id)) continue;
      const project = store.getProject(item.projectSlug);
      if (!project) continue;
      const group = byProject.get(project.slug) ?? { project, items: [] };
      group.items.push(item);
      byProject.set(project.slug, group);
    }

    for (const { project, items } of byProject.values()) {
      let fetched: GitHubIssue[];
      try {
        const cached = issueCache.get(project.slug) ?? new Map<number, GitHubIssue>();
        const numbers = [...new Set(items.flatMap(issueNumbers))].filter((number) => !cached.has(number));
        fetched = numbers.length ? await this.#github.issues(project, numbers) : [];
        for (const issue of fetched) cached.set(issue.number, issue);
        issueCache.set(project.slug, cached);
      } catch (error) {
        issueCache.set(project.slug, new Map());
        for (const item of items) this.#blockForGitHubUnavailable(store, item, `Issue reconciliation failed: ${errorText(error)}`);
        continue;
      }

      const issuesByNumber = issueCache.get(project.slug)!;
      for (let item of items) {
        try {
          const issues = issueNumbers(item).map((number) => {
            const issue = issuesByNumber.get(number);
            if (!issue) throw new Error(`GitHub did not return issue #${number}`);
            return issue;
          });
          if (issues.some((issue) => !["OPEN", "CLOSED"].includes(issue.state.toUpperCase()))) throw new Error("GitHub returned an unsupported issue state.");
          const state = issues.every((issue) => issue.state.toUpperCase() === "CLOSED") ? "CLOSED" : "OPEN";
          const runtime = store.getChangeSetRuntime(item.id) ?? emptyRuntime(item.id);
          const previousState = runtime.lastIssueState;
          runtime.lastIssueState = state;
          store.saveChangeSetRuntime(runtime);

          if (state === "OPEN" && item.state === "Blocked" && item.blockedReason === "github_unavailable" && item.blockedResumeState) {
            store.transitionChangeSet(item.id, item.blockedResumeState);
            item = store.getChangeSet(item.id) ?? item;
          }
          if (state === "CLOSED") {
            const activeTask = store.activeTask(item.id);
            if (activeTask) await this.#cancelTaskForClosedIssue(store, item, activeTask);
            const current = store.getChangeSet(item.id);
            if (current && !terminal(current) && !runtime.pullRequestNumber && !store.activeTask(item.id)) {
              this.#completeClosedIssue(store, current);
            }
            continue;
          }
          if (previousState === "CLOSED" && item.state === "Done") {
            for (const issue of issues.filter((issue) => issue.state.toUpperCase() === "OPEN")) this.#createReopenedIssueGeneration(store, item, issue);
          }
        } catch (error) {
          this.#blockForGitHubUnavailable(store, item, `Issue reconciliation failed: ${errorText(error)}`);
        }
      }
    }
  }

  async #cancelTaskForClosedIssue(store: MerroStore, item: ChangeSet, task: Task): Promise<boolean> {
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
      summary: `GitHub issues ${issueNumbers(item).map((number) => `#${number}`).join(" ")} were closed externally`,
      resultJson: JSON.stringify({ taskId: task.id, reason: "issue_closed_externally" }),
    });
    return true;
  }

  #completeClosedIssue(store: MerroStore, item: ChangeSet): void {
    if (store.activeTask(item.id)) return;
    store.completeChangeSetAfterExternalIssueClosure(item.id);
    this.#resolvePullRequestDecisions(store, item.id);
  }

  #createReopenedIssueGeneration(store: MerroStore, previous: ChangeSet, issue: GitHubIssue): void {
    const owners = store.listObjectives().filter((objective) => objective.state === "Active"
      && objective.projectSlugs.includes(previous.projectSlug)
      && store.listChangeSets(objective.id, true).some((item) => item.id === previous.id));
    if (owners.length === 0) return;
    const existing = store.findNonTerminalChangeSet(previous.projectSlug, [issue.number]);
    if (existing) {
      for (const owner of owners) store.attachChangeSet(owner.id, existing.id);
      const priority = owners.map((owner) => owner.priority).sort((left, right) => priorityRank(left) - priorityRank(right))[0];
      if (priority && priorityRank(priority) < priorityRank(existing.priority)) store.setChangeSetPriority(existing.id, priority);
      const runtime = store.getChangeSetRuntime(existing.id) ?? emptyRuntime(existing.id);
      runtime.lastIssueState = "OPEN";
      store.saveChangeSetRuntime(runtime);
      return;
    }
    const generation = store.nextGeneration(previous.projectSlug, [issue.number]);
    const item: ChangeSet = {
      id: sourceId(previous.projectSlug, issue.number, generation),
      projectSlug: previous.projectSlug,
      slug: store.availableChangeName(semanticSlug(issue.title)),
      issues: [{ projectSlug: previous.projectSlug, number: issue.number }],
      generation,
      state: "Planned",
      priority: owners.map((owner) => owner.priority).sort((left, right) => priorityRank(left) - priorityRank(right))[0] ?? previous.priority,
      readySince: null,
      blockedReason: null,
      blockedResumeState: null,
    };
    store.createChangeSet(item);
    for (const owner of owners) store.attachChangeSet(owner.id, item.id);
    // A reopened issue continues the change it reopened, so it keeps that change's approved worker settings.
    const settings = store.changeSetWorkerSettings(previous.id) ?? store.objectiveWorkerSettings(owners[0]!.id);
    if (settings) store.claimChangeSetWorkerSettings(item.id, settings);
    const runtime = emptyRuntime(item.id);
    runtime.lastIssueState = "OPEN";
    store.saveChangeSetRuntime(runtime);
    this.#progress(`Issue #${issue.number} reopened · ${changeName(item)} is working again.`);
  }

  async #validateNewExplicitRelations(
    store: MerroStore,
    planned: readonly ChangeSet[],
    effective: readonly Relation[],
    explicit: readonly Relation[],
  ): Promise<void> {
    const existing = new Map(store.listRelations().map((relation) => [relationKey(relation), relation]));
    const explicitKeys = new Set(explicit.map(relationKey));
    const additions = effective.filter((relation) => explicitKeys.has(relationKey(relation))
      && (!existing.has(relationKey(relation)) || existing.get(relationKey(relation))?.gate !== relation.gate));
    if (!additions.length) return;

    const { unsafeProjects, changeSetIds } = await this.#workerSafetyPreflight(store);
    const changeSetsById = new Map([...store.listChangeSets(), ...planned].map((item) => [item.id, item]));
    const occupied = new Set([
      ...changeSetIds,
      ...store.listTasks().filter((task) => task.status === "active").map((task) => task.changeSetId),
    ]);
    for (const relation of additions) {
      const from = changeSetsById.get(relation.from);
      const to = changeSetsById.get(relation.to);
      if (!from || !to) throw new Error("Cannot approve a relation with an unknown ChangeSet");
      for (const item of [from, to]) {
        if (unsafeProjects.has(item.projectSlug)) {
          throw new Error(`Cannot approve a new relation involving ${changeName(item)}: Worker safety is unverified in Project ${item.projectSlug}. Inspect Workers and retry.`);
        }
      }
      if (relation.kind === "Conflicts" && occupied.has(from.id) && occupied.has(to.id)) {
        throw new Error(`Cannot approve Conflicts between ${changeName(from)} and ${changeName(to)} while both have active Workers; retry after the Workers safely exit.`);
      }
      if (relation.kind === "Requires" && occupied.has(from.id) && to.state !== "Done") {
        throw new Error(`Cannot approve Requires for ${changeName(from)} while its Worker is active and prerequisite ${changeName(to)} is not Done; retry after the Worker exits or the prerequisite completes.`);
      }
    }
  }

  async #workerSafetyPreflight(store: MerroStore, unsafeProjects = new Set<string>()): Promise<{ unsafeProjects: Set<string>; count: number; changeSetIds: Set<string>; liveTaskIds: Set<string> }> {
    // Finalized runtime identity still links legacy panes and containers, without adopting their workers.
    const runtimes: TaskRuntimeRecord[] = [];
    const runtimesByProject = new Map<string, TaskRuntimeRecord[]>();
    for (const task of store.listTasks()) {
      const runtime = store.getTaskRuntime(task.id);
      if (!runtime) continue;
      runtimes.push(runtime);
      const item = store.getChangeSet(task.changeSetId);
      if (!item) continue;
      const projectRuntimes = runtimesByProject.get(item.projectSlug) ?? [];
      projectRuntimes.push(runtime);
      runtimesByProject.set(item.projectSlug, projectRuntimes);
    }
    const orphanIds = new Set<string>();
    const changeSetIds = new Set<string>();
    const liveTaskIds = new Set<string>();
    const projects = store.listProjects();
    for (const project of projects) {
      try {
        const workers = await this.#workers.listOwnedWorkers(project, store.getProjectSettings(project.slug), runtimesByProject.get(project.slug));
        for (const worker of workers) {
          const matchedRuntime = worker.taskId === null ? runtimes.find((runtime) =>
            (worker.paneId !== null && runtime.paneId === worker.paneId && runtime.tmuxSession === worker.tmuxSession
              && runtime.tmuxWindow === worker.tmuxWindow)
            || (worker.containerId !== null && runtime.containerId === worker.containerId)
            || (runtime.paneId === null && worker.tmuxWindow !== null
              && runtime.tmuxWindow === worker.tmuxWindow && runtime.tmuxSession === worker.tmuxSession)) : undefined;
          const taskId = worker.taskId ?? matchedRuntime?.taskId ?? null;
          const recordedTask = taskId !== null ? store.getTask(taskId) : null;
          if (recordedTask?.status === "active") {
            liveTaskIds.add(recordedTask.id);
            continue;
          }
          orphanIds.add(taskId !== null ? `task:${taskId}` : worker.containerId !== null
            ? `container:${worker.containerId}` : `pane:${worker.tmuxSession}:${worker.paneId}`);
          const item = worker.changeSetId ? store.getChangeSet(worker.changeSetId)
            : recordedTask ? store.getChangeSet(recordedTask.changeSetId) : store.listChangeSets().find((candidate) =>
              worker.clonePath !== null && store.getChangeSetRuntime(candidate.id)?.clonePath === worker.clonePath);
          // Legacy containers may be returned by every Project scan. Stored identity determines their Project.
          if (item) {
            unsafeProjects.add(item.projectSlug);
            changeSetIds.add(item.id);
          } else for (const registered of projects) unsafeProjects.add(registered.slug);
          const concern = recordedTask
            ? "A background process is still attached to completed work"
            : "Merro found unrecognized background work";
          this.#notify(`${item ? changeName(item) : project.slug} · ${concern} in ${project.slug}. New work is paused to protect changes; inspect and stop the process before resuming. Merro will not adopt or stop it.`, "warning");
        }
      } catch (error) {
        // An incomplete inventory cannot prove that a clone is unowned.
        unsafeProjects.add(project.slug);
        for (const item of store.listChangeSets().filter((candidate) => candidate.projectSlug === project.slug)) changeSetIds.add(item.id);
        this.#progress(`${project.slug} · Merro could not inspect background work: ${errorText(error)}. New work is paused to protect changes; it will check again automatically.`);
      }
    }
    this.#orphanedTaskCount = orphanIds.size;
    return { unsafeProjects, count: orphanIds.size, changeSetIds, liveTaskIds };
  }

  async #reconcileTasks(store: MerroStore, unavailableProjects: ReadonlySet<string>, unsafeProjects: Set<string>, liveTaskIds: ReadonlySet<string>): Promise<void> {
    for (const task of store.listTasks().filter((candidate) => candidate.status === "active")) {
      const item = store.getChangeSet(task.changeSetId);
      if (item && unavailableProjects.has(item.projectSlug)) continue;
      const runtime = store.getTaskRuntime(task.id);
      const workRuntime = item && store.getChangeSetRuntime(item.id);
      if (!item || !runtime || !workRuntime) continue;
      if (item.issues.length && item.state === "Blocked" && item.blockedReason === "github_unavailable") continue;
      if (workRuntime.lastIssueState === "CLOSED") {
        try {
          if (await this.#cancelTaskForClosedIssue(store, item, task) && !workRuntime.pullRequestNumber) {
            this.#completeClosedIssue(store, store.getChangeSet(item.id) ?? item);
          }
        } catch (error) {
          this.#blockForGitHubUnavailable(store, item, `Could not stop the worker for ${changeName(item)} after its issues closed: ${errorText(error)}`);
        }
        continue;
      }
      let text: string;
      try {
        text = await readFile(runtime.resultPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          if (liveTaskIds.has(task.id)) unsafeProjects.add(item.projectSlug);
          store.finalizeTask({ id: task.id, outcome: "failed", summary: "Invalid result file", resultJson: JSON.stringify({ error: errorText(error) }) });
          if (!this.#obsoleteIfUnowned(store, item, unsafeProjects)) {
            this.#block(store, item, "task_failed", `Cannot read Task result: ${errorText(error)}`);
          }
          continue;
        }
        let presence: WorkerPresence;
        try {
          presence = await this.#workers.inspect(runtime, task.id);
        } catch (inspectionError) {
          const detail = `Merro could not verify current work for ${changeName(item)}; reconciliation will retry: ${errorText(inspectionError)}`;
          if (item.issues.length) this.#blockForGitHubUnavailable(store, item, detail);
          else this.#progress(`${changeName(item)} · Could not inspect the active work: ${errorText(inspectionError)}. Scheduling is paused; Merro will retry automatically.`);
          continue;
        }
        if (presence.alive) {
          if (!presence.identityMatches) {
            unsafeProjects.add(item.projectSlug);
            this.#notify(`${changeName(item)} · Merro found background work it cannot verify as its own${presence.reason ? ` (${presence.reason})` : ""}.\n${runtime.tmuxSession ? `Inspect: tmux list-panes -t =${runtime.tmuxSession}\n` : runtime.containerId ? `Inspect: docker inspect ${runtime.containerId}\n` : ""}Merro will not adopt or stop it automatically.`, "warning");
          }
          continue;
        }
        const reason = presence.reason ?? "Implementation worker exited without submitting a result";
        if (presence.alive || liveTaskIds.has(task.id)) unsafeProjects.add(item.projectSlug);
        const failure = {
          taskId: task.id,
          reason,
          ...(presence.exitStatus !== undefined ? { exitStatus: presence.exitStatus } : {}),
          ...(presence.exitSignal !== undefined ? { exitSignal: presence.exitSignal } : {}),
          ...(presence.diagnosticPath !== undefined ? { diagnosticPath: presence.diagnosticPath } : {}),
        };
        store.finalizeTask({ id: task.id, outcome: "failed", summary: reason, resultJson: JSON.stringify(failure) });
        if (this.#obsoleteIfUnowned(store, item, unsafeProjects)) continue;
        if (presence.alive && !presence.identityMatches) {
          this.#block(store, item, "task_failed", `Worker identity check failed: ${reason}`);
          continue;
        }
        if (workRuntime.infrastructureRetries < 1) {
          workRuntime.infrastructureRetries += 1;
          store.saveChangeSetRuntime(workRuntime);
          // Infrastructure retry is reflected by the current Working state, not a permanent progress message.
        } else {
          this.#block(store, item, "task_failed", `Worker exited without a valid result after one infrastructure retry: ${reason}`);
        }
        continue;
      }
      // Protect ownerless work as soon as its recorded live Task becomes finalized.
      if (liveTaskIds.has(task.id)) unsafeProjects.add(item.projectSlug);
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
        if (!this.#obsoleteIfUnowned(store, item, unsafeProjects)) {
          this.#block(store, item, "task_failed", `Task result validation failed: ${errorText(error)}`);
        }
        continue;
      }
      await this.#consumeResult(store, item, task, result, runtime, workRuntime, unsafeProjects);
      workRuntime.infrastructureRetries = 0;
      store.saveChangeSetRuntime(workRuntime);
    }
  }

  async #reconcileFinalizedTasks(store: MerroStore, unsafeProjects: ReadonlySet<string>): Promise<void> {
    if (this.#git.deleteClone) {
      for (const item of store.listChangeSets()) {
        if (item.state !== "Done" || unsafeProjects.has(item.projectSlug)
          || !store.hasEvent("ChangeSet", item.id, "dependency_clone_retained")
          || store.hasEvent("ChangeSet", item.id, "dependency_clone_cleanup_complete")) continue;
        const needed = store.listRelations().some((relation) => relation.kind === "Requires" && relation.to === item.id
          && relation.gate === "reviewed" && !terminal(store.getChangeSet(relation.from)!));
        const clonePath = store.getChangeSetRuntime(item.id)?.clonePath;
        if (needed || !clonePath) continue;
        try {
          await this.#git.deleteClone(this.#cloneRoot(item, clonePath), clonePath);
          store.appendEvent("ChangeSet", item.id, "dependency_clone_cleanup_complete", {});
        } catch (error) {
          this.#progress(`${changeName(item)} · Dependency clone cleanup failed: ${errorText(error)}. Merro will retry automatically.`);
        }
      }
    }
    const pending = store.listTasksPendingCleanup();
    if (pending.length === 0) return;
    const activeInputs = new Set(store.listActiveTaskInputPaths());
    for (const task of pending) {
      const runtime = store.getTaskRuntime(task.id);
      const projectSlug = store.getChangeSet(task.changeSetId)?.projectSlug;
      if (!runtime || !projectSlug || unsafeProjects.has(projectSlug)) continue;
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
        store.markTaskCleanupCompleted(task.id);
      } catch (error) {
        const item = store.getChangeSet(task.changeSetId);
        this.#progress(`${item ? changeName(item) : "A completed change"} · Cleanup failed: ${errorText(error)}. Merro will retry automatically.`);
      }
    }
  }

  async #consumeResult(store: MerroStore, item: ChangeSet, task: Task, result: WorkerResult, runtime: TaskRuntimeRecord, workRuntime: ChangeSetRuntimeRecord, unsafeProjects: ReadonlySet<string>): Promise<void> {
    const flowState = task.role === "implement" ? "Implementing" : "Reviewing";
    await this.#handleProposedIssues(store, item, task, result);
    if (result.status !== "failed" && item.state === "Blocked" && item.blockedReason === "task_failed"
      && item.blockedResumeState === flowState) {
      // A worker whose failed launch could not be stopped can still finish its owned Task.
      store.transitionChangeSet(item.id, flowState);
      item = store.getChangeSet(item.id)!;
    }
    if (task.role === "implement") {
      const implementResult = result as ImplementSuccessResult | ImplementFailedResult;
      if (implementResult.status === "failed") {
        store.finalizeTask({ id: task.id, outcome: "failed", summary: implementResult.summary, resultJson: JSON.stringify(implementResult) });
        if (!this.#obsoleteIfUnowned(store, item, unsafeProjects)) {
          this.#block(store, item, "task_failed", `${implementResult.reason}${implementResult.diagnostics ? `: ${implementResult.diagnostics}` : ""}`);
          if (implementResult.dependency_suggestions?.length) {
            await this.#reportDiscoveredDependencies(store, item, implementResult.dependency_suggestions);
          }
        }
        return;
      }
      const typed = implementResult;
      store.finalizeTask({ id: task.id, outcome: "success", summary: typed.summary, resultJson: JSON.stringify(typed), commitSha: typed.commit });
      const commands = typed.verification.filter((entry) => entry.kind === "command");
      if (!commands.length || commands.some((entry) => entry.exit_code !== 0)) {
        if (!this.#obsoleteIfUnowned(store, item, unsafeProjects)) this.#block(store, item, "task_failed", "Local CI is not green. Run repository verification and submit passing command results before review");
        return;
      }
      if (runtime.baseUpdate) {
        workRuntime.baseCommit = runtime.baseUpdate.baseCommit;
        workRuntime.baseUpdate = null;
        store.saveChangeSetRuntime(workRuntime);
      }
      if (typed.dependency_suggestions?.length) await this.#reportDiscoveredDependencies(store, item, typed.dependency_suggestions);
      const awaitingDependencies = (await this.#unapprovedDiscoveredDependencies(store, item)).length > 0;
      const message = `${changeName(item)} · Local verification passed; ${awaitingDependencies ? "awaiting dependency plan approval" : "reviewing the change"}.`;
      this.#progress(message);
      this.#queueNotification("implementation_complete", item.id, message);
      if (!this.#obsoleteIfUnowned(store, item, unsafeProjects)) store.transitionChangeSet(item.id, "Reviewing");
      return;
    }

    const reviewResult = result as ReviewResult | ReviewFailedResult;
    if (reviewResult.status === "failed") {
      store.finalizeTask({ id: task.id, outcome: "failed", summary: reviewResult.summary, resultJson: JSON.stringify(reviewResult), reviewedCommit: reviewResult.reviewed_commit });
      if (!this.#obsoleteIfUnowned(store, item, unsafeProjects)) this.#block(store, item, "task_failed", `${reviewResult.reason}`);
      return;
    }
    const review = reviewResult;
    if (review.status === "pass") {
      store.finalizePassingReview({ id: task.id, summary: review.summary, resultJson: JSON.stringify(review), reviewedCommit: review.reviewed_commit });
    } else {
      store.finalizeTask({ id: task.id, outcome: "reject", summary: review.summary, resultJson: JSON.stringify(review), reviewedCommit: review.reviewed_commit });
      const count = review.findings.filter((finding) => finding.severity === "blocking").length;
      const message = `${changeName(item)} · Review found ${count} issue${count === 1 ? "" : "s"}; fixing automatically.`;
      this.#progress(message);
      this.#queueNotification("review_complete", item.id, message);
    }
    if (this.#obsoleteIfUnowned(store, store.getChangeSet(item.id) ?? item, unsafeProjects)) return;
    if (review.status === "reject") {
      workRuntime.reviewRound += 1;
      store.saveChangeSetRuntime(workRuntime);
      store.transitionChangeSet(item.id, "Implementing");
      // An unapproved limit is settled before the next worker; see #reviewCapReached.
      this.#reviewCapReached(store, store.getChangeSet(item.id) ?? item);
      return;
    }

    workRuntime.reviewedDiffHash = null;
    this.#notifyReviewComplete(store, item, task);
  }

  async #unapprovedDiscoveredDependencies(store: MerroStore, item: ChangeSet): Promise<DependencySuggestion[]> {
    const implementation = store.listTasks(item.id).filter((task) => task.role === "implement").at(-1);
    if (!implementation?.resultJson || implementation.status !== "finalized"
      || store.hasEvent("Task", implementation.id, "dependency_discovery_superseded")) return [];
    let suggestions: DependencySuggestion[] | undefined;
    try { suggestions = parseImplementResult(JSON.parse(implementation.resultJson)).dependency_suggestions; } catch { return []; }
    const unapproved: DependencySuggestion[] = [];
    const changeSets = store.listChangeSets();
    const relations = store.listRelations();
    for (const suggestion of suggestions ?? []) {
      const candidates = changeSets.filter((candidate) => candidate.projectSlug === suggestion.project_slug
        && issueNumbers(candidate).includes(suggestion.issue_number));
      if (!candidates.some((candidate) => !terminal(candidate))) {
        if (candidates.some((candidate) => candidate.state === "Done")) continue;
        const project = store.getProject(suggestion.project_slug);
        if (project && project.slug !== item.projectSlug) {
          try { if ((await this.#github.issue(project, suggestion.issue_number)).state.toUpperCase() === "CLOSED") continue; }
          catch { /* Unknown prerequisite state remains approval-gated. */ }
        }
      }
      const approved = relations.some((relation) => relation.kind === "Requires" && relation.from === item.id
        && (relation.gate ?? "done") === suggestion.gate && candidates.some((candidate) => candidate.id === relation.to));
      if (!approved) unapproved.push(suggestion);
    }
    return unapproved;
  }

  async #reconcileDiscoveredDependencies(store: MerroStore): Promise<Set<string>> {
    const gated = new Set<string>();
    for (const item of store.listChangeSets()) {
      if (terminal(item) || !store.hasActiveObjectiveForChangeSet(item.id)) continue;
      const suggestions = await this.#unapprovedDiscoveredDependencies(store, item);
      if (!suggestions.length) continue;
      gated.add(item.id);
      this.#resolvePullRequestDecisions(store, item.id);
      if (!this.#proposals.size) await this.#reportDiscoveredDependencies(store, item, suggestions);
    }
    return gated;
  }

  async #reportDiscoveredDependencies(store: MerroStore, item: ChangeSet, suggestions: readonly DependencySuggestion[]): Promise<void> {
    try {
      await this.#proposeDiscoveredDependencies(store, item, suggestions);
    } catch (error) {
      const task = store.listTasks(item.id).filter((candidate) => candidate.role === "implement").at(-1);
      if (task && store.hasEvent("Task", task.id, "dependency_proposal_failed")) return;
      this.#notify(`${changeName(item)} · Could not prepare the Worker-reported dependency proposal: ${errorText(error)}. No companion work was started. Suggestions remain in Task history.`, "warning");
      if (task) store.appendEvent("Task", task.id, "dependency_proposal_failed", { detail: errorText(error) });
    }
  }

  async #proposeDiscoveredDependencies(
    store: MerroStore,
    dependent: ChangeSet,
    suggestions: readonly DependencySuggestion[],
  ): Promise<void> {
    const allChangeSets = store.listChangeSets();
    const requested = new Map<string, { projectSlug: string; issueNumber: number; gate: RequiresGate; reason: string; existing: ChangeSet | null; issueTitle: string | null }>();
    const proposalsByPair = new Map<string, { gate: RequiresGate; reason: string }>();
    const skipped: string[] = [];
    for (const suggestion of suggestions) {
      const project = store.getProject(suggestion.project_slug);
      if (!project) throw new Error(`unknown suggested Project '${suggestion.project_slug}'`);
      if (project.slug === dependent.projectSlug) throw new Error(`suggested issue #${suggestion.issue_number} is not cross-Project`);
      const key = `${project.slug}\0${suggestion.issue_number}`;
      const matches = allChangeSets.filter((candidate) => candidate.projectSlug === project.slug
        && issueNumbers(candidate).includes(suggestion.issue_number));
      const existing = matches.filter((candidate) => !terminal(candidate))
        .sort((left, right) => right.generation - left.generation)[0] ?? null;
      if (!existing && matches.some((candidate) => candidate.state === "Done")) {
        skipped.push(`${project.slug} #${suggestion.issue_number} is already Done`);
        continue;
      }
      let issueTitle: string | null = null;
      if (!existing) {
        const issue = await this.#github.issue(project, suggestion.issue_number);
        if (issue.state.toUpperCase() !== "OPEN") {
          skipped.push(`${project.slug} #${suggestion.issue_number} is not open`);
          continue;
        }
        issueTitle = issue.title;
      }
      const previous = requested.get(key);
      if (previous && previous.gate !== suggestion.gate) {
        throw new Error(`suggested issues grouped in '${existing ? changeName(existing) : `${project.slug} #${suggestion.issue_number}`}' have conflicting gates`);
      }
      requested.set(key, { projectSlug: project.slug, issueNumber: suggestion.issue_number, gate: suggestion.gate,
        reason: suggestion.reason, existing, issueTitle });
      const prerequisiteId = existing?.id ?? key;
      const pair = `${dependent.id}\0${prerequisiteId}`;
      const previousPair = proposalsByPair.get(pair);
      if (previousPair && previousPair.gate !== suggestion.gate) {
        throw new Error(`Worker suggested conflicting gates for prerequisite ${existing ? changeName(existing) : `${project.slug} #${suggestion.issue_number}`}`);
      }
      proposalsByPair.set(pair, { gate: suggestion.gate, reason: suggestion.reason });
    }

    const prerequisites = new Map<string, { name: string; projectSlug: string; issues: number[]; existing: ChangeSet | null }>();
    const relations: ObjectiveRelationInput[] = [];
    let missingRelation = false;
    for (const suggestion of requested.values()) {
      const key = `${suggestion.projectSlug}\0${suggestion.issueNumber}`;
      const name = suggestion.existing?.slug ?? semanticSlug(`issue-${suggestion.issueNumber}-${suggestion.projectSlug.slice(0, 32)}`);
      const prerequisiteKey = suggestion.existing?.id ?? key;
      prerequisites.set(prerequisiteKey, {
        name, projectSlug: suggestion.projectSlug,
        issues: suggestion.existing ? issueNumbers(suggestion.existing) : [suggestion.issueNumber], existing: suggestion.existing,
      });
      const existingRelation = store.listRelations().find((relation) => relation.kind === "Requires"
        && relation.from === dependent.id && relation.to === suggestion.existing?.id);
      if (suggestion.existing && existingRelation?.gate === suggestion.gate) continue;
      missingRelation = true;
      relations.push({ kind: "Requires", from: dependent.slug, to: name, gate: suggestion.gate });
    }
    if (!missingRelation) {
      const detail = skipped.length ? ` ${skipped.join("; ")}.` : "";
      this.#notify(`${changeName(dependent)} · Worker-reported dependencies are already approved or complete; no new proposal is needed.${detail}`);
      return;
    }

    const changeSets: ObjectiveChangeSetInput[] = [
      { name: dependent.slug, projectSlug: dependent.projectSlug, issues: issueNumbers(dependent) },
      ...[...prerequisites.values()].map(({ name, projectSlug, issues }) => ({ name, projectSlug, issues })),
    ];
    const input: NamedObjectiveStartInput = {
      goal: `Add discovered prerequisites for ${changeName(dependent)}`,
      priority: dependent.priority,
      changeSets,
      relations,
    };
    if (this.#proposals.size > 0) {
      this.#notify(`${changeName(dependent)} · Worker-reported dependencies need a separate approval proposal. The current pending plan is unchanged. After handling it, propose these prerequisites: ${[...requested.values()].map((suggestion) => `${suggestion.projectSlug} #${suggestion.issueNumber} Requires(${suggestion.gate}): ${suggestion.reason}`).join("; ")}. Suggestions remain in Task history. No companion work was started.`, "warning");
      return;
    }
    const proposal = await this.#recordObjectiveProposal(store, input);
    const names = new Map(proposal.changeSets.map((item) => [item.id, changeName(item)]));
    for (const [id, name] of Object.entries(proposal.relationNames)) names.set(id, name);
    const plan = proposal.changeSets.map((item) => {
      const scope = issueNumbers(item).map((number) => `#${number}`).join(" ") || "existing approved scope";
      const delivery = item.delivery === "local" ? `local delivery to ${item.targetBranch}` : "PR delivery";
      return `- ${changeName(item)} · ${item.projectSlug} · ${scope} · ${delivery} · ${proposal.branches[item.id]}`;
    });
    const edges = proposal.relations.filter((relation) => relation.kind === "Requires").map((relation) =>
      `- ${names.get(relation.from) ?? "change"} Requires(${relation.gate ?? "done"}) ${names.get(relation.to) ?? "prerequisite"}`);
    const reasonLines = [...requested.values()].map((suggestion) => {
      const target = suggestion.existing?.slug ?? [...prerequisites.values()].find((candidate) => candidate.projectSlug === suggestion.projectSlug
        && candidate.issues.includes(suggestion.issueNumber))?.name ?? `#${suggestion.issueNumber}`;
      return `- ${suggestion.projectSlug} #${suggestion.issueNumber} → ${target}: ${suggestion.reason}`;
    });
    const message = [
      `Worker-reported dependencies for ${changeName(dependent)} need a fresh plan approval. No companion work will start before approval.`,
      "",
      "Plan",
      ...plan,
      "",
      "Requires relations",
      ...edges,
      "",
      `${proposal.changeSets.length} changes · ${proposal.changeSets.filter((item) => item.delivery === "pr").length} PRs · ${proposal.runnableImmediately} runnable immediately`,
      "",
      "Worker suggestions (untrusted context)",
      ...reasonLines,
      ...(skipped.length ? ["", "Already satisfied / omitted", ...skipped.map((entry) => `- ${entry}`)] : []),
      "",
      `Approve? Use merro_start_objective after explicit user approval (change: ${changeName(dependent)}).`,
    ].join("\n");
    this.#notify(message, "warning");
  }

  #notifyReviewComplete(store: MerroStore, item: ChangeSet, task: Task): void {
    if (store.hasEvent("Task", task.id, "review_complete_notified")) return;
    const message = `${changeName(item)} · Review passed; ${item.delivery === "local" ? "requesting local merge approval" : "opening PR"}.`;
    this.#progress(message);
    this.#queueNotification("review_complete", item.id, message);
    store.appendEvent("Task", task.id, "review_complete_notified", {});
  }

  async #ensureWorkspaceDirectory(directory: string): Promise<void> {
    let path = this.#workspacePath;
    for (const part of directory.split(/[\\/]/).filter(Boolean)) {
      if (part === "." || part === "..") throw new Error("Invalid workspace directory");
      path = join(path, part);
      try { await mkdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const details = await lstat(path);
      if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`Workspace directory must not be a symlink: ${path}`);
    }
  }

  async #reconcileLocalDelivery(store: MerroStore, unavailableProjects: ReadonlySet<string>, unsafeProjects: ReadonlySet<string>, staleDependencies: ReadonlySet<string>): Promise<boolean> {
    let deferred = false;
    for (let item of store.listChangeSets()) {
      if (item.delivery !== "local" || !["Reviewed", "AwaitingLocalMerge"].includes(item.state) || staleDependencies.has(item.id)
        || unavailableProjects.has(item.projectSlug) || unsafeProjects.has(item.projectSlug) || store.activeTask(item.id)) continue;
      if (item.state === "Reviewed" && this.#reviewNotificationsInFlight.has(item.id)) { deferred = true; continue; }
      try {
        const runtime = store.getChangeSetRuntime(item.id);
        const project = store.getProject(item.projectSlug);
        const reviewTask = store.listTasks(item.id).at(-1);
        if (!project || !runtime?.clonePath || !runtime.baseCommit || !item.targetBranch
          || reviewTask?.role !== "review" || reviewTask.outcome !== "pass" || !reviewTask.reviewedCommit
          || !this.#git.inspectLocalDelivery) {
          throw new Error("Local merge needs the latest passing review, working copy, and approved target base");
        }
        const review = reviewTask.resultJson ? parseReviewResult(JSON.parse(reviewTask.resultJson)) : null;
        if (!review || review.status !== "pass" || review.reviewed_commit !== reviewTask.reviewedCommit) {
          throw new Error("Local merge needs the latest valid passing review result");
        }
        const inspection = await this.#git.inspectLocalDelivery(project, runtime.clonePath, item.targetBranch, reviewTask.reviewedCommit, runtime.baseCommit);
        if ("baseUpdate" in inspection) {
          this.#queueLocalBaseUpdate(store, item, runtime, inspection.baseUpdate);
          continue;
        }
        if (runtime.reviewedDiffHash !== null && runtime.reviewedDiffHash !== inspection.diffHash) {
          throw new Error("Local reviewed diff changed; fresh verification and review are required");
        }
        if (runtime.reviewedDiffHash === null) {
          runtime.reviewedDiffHash = inspection.diffHash;
          store.saveChangeSetRuntime(runtime);
        }
        if (item.state === "Reviewed") {
          store.transitionChangeSet(item.id, "AwaitingLocalMerge");
          item = store.getChangeSet(item.id)!;
        }
        const pending = store.pendingDecisions().find((decision) => decision.kind === "local_merge" && decision.subjectId === item.id);
        const payload = { targetBranch: item.targetBranch, baseCommit: inspection.baseCommit,
          reviewedCommit: reviewTask.reviewedCommit, diffHash: inspection.diffHash };
        if (pending) {
          if (JSON.stringify(pending.payload) === JSON.stringify(payload)) continue;
          store.resolveDecision(pending.id, "resolved");
        }
        store.createDecision({ id: randomUUID(), subjectType: "ChangeSet", subjectId: item.id, kind: "local_merge", payload });
        const verification = finalVerification(store, item, review);
        const message = `${changeName(item)}\n\nReview passed\nVerification passed\n${verification}\n\nReady to apply to ${item.targetBranch}.\n\nApprove? /merro approve ${changeName(item)} · Leave unchanged: /merro leave ${changeName(item)}`;
        this.#notify(message, "warning");
        this.#queueNotification("local_merge_ready", item.id, message);
      } catch (error) {
        this.#resolveMergeDecisions(store, item.id);
        this.#block(store, item, "merge_failed", `Local merge preparation failed: ${errorText(error)}`);
      }
    }
    return deferred;
  }

  #queueLocalBaseUpdate(store: MerroStore, item: ChangeSet, runtime: ChangeSetRuntimeRecord, baseUpdate: BaseUpdate): void {
    this.#resolveMergeDecisions(store, item.id);
    runtime.baseUpdate = baseUpdate;
    runtime.reviewedDiffHash = null;
    store.saveChangeSetRuntime(runtime);
    store.transitionChangeSet(item.id, "Implementing");
    this.#progress(`${changeName(item)} · Local base changed; implementing, verifying, and reviewing again.`);
  }

  async #reconcilePublication(store: MerroStore, unavailableProjects: ReadonlySet<string>, unsafeProjects: ReadonlySet<string>, staleDependencies: ReadonlySet<string>): Promise<boolean> {
    let deferred = false;
    for (let item of store.listChangeSets()) {
      if (staleDependencies.has(item.id) || unavailableProjects.has(item.projectSlug) || unsafeProjects.has(item.projectSlug) || store.activeTask(item.id)) continue;
      if (item.delivery === "local") continue;
      const retrying = item.state === "PublishBlocked" && item.blockedReason === "github_unavailable";
      if (item.state !== "Reviewed" && item.state !== "Publishing" && !retrying) continue;
      const workRuntime = store.getChangeSetRuntime(item.id);
      const project = store.getProject(item.projectSlug);
      const reviewTask = store.listTasks(item.id).reverse().find((task) => task.role === "review" && task.outcome === "pass");
      if (reviewTask) this.#notifyReviewComplete(store, item, reviewTask);
      if (this.#reviewNotificationsInFlight.has(item.id)) {
        deferred = true;
        continue;
      }
      if (item.state === "Reviewed" || retrying) {
        store.transitionChangeSet(item.id, "Publishing");
        item = store.getChangeSet(item.id)!;
      }
      if (!store.hasEvent("ChangeSet", item.id, "publication_started_notified")) {
        store.appendEvent("ChangeSet", item.id, "publication_started_notified", {});
      }
      try {
        if (!project || !workRuntime?.clonePath || !workRuntime.branchName || !reviewTask?.resultJson) throw new Error("Project branch or passing review is missing. Restore reviewed state before retrying.");
        const review = parseReviewResult(JSON.parse(reviewTask.resultJson));
        if (review.status !== "pass") throw new Error("Publication requires a passing review.");
        this.#notifyReviewComplete(store, item, reviewTask);
        // Recover a lost PR-create response without another create or blind push.
        const existing = workRuntime.pullRequestNumber
          ? await this.#github.pullRequest(project, workRuntime.pullRequestNumber)
          : await this.#github.findPullRequest?.(project, workRuntime.branchName) ?? null;
        if (existing) {
          this.#savePullRequest(store, workRuntime, existing);
          if (existing.mergedAt) {
            await this.#completeMergedChangeSet(store, item, workRuntime, project, existing, unsafeProjects);
            continue;
          }
          if (existing.state !== "OPEN") throw new Error("Pull request is closed without merging. Reopen it before retrying publication.");
        }
        if (await this.#git.currentCommit(workRuntime.clonePath) !== review.reviewed_commit) throw new Error("Clone HEAD changed after review. Request fresh review through Main before publication.");
        await this.#git.pushBranch(project, workRuntime.clonePath, workRuntime.branchName, review.reviewed_commit);
        const implementationTask = store.listTasks(item.id).reverse().find((task) => task.role === "implement" && task.outcome === "success" && task.resultJson);
        const result = implementationTask?.resultJson ? parseImplementResult(JSON.parse(implementationTask.resultJson)) : null;
        const objective = store.listObjectives().find((objective) => store.listChangeSets(objective.id).some((change) => change.id === item.id));
        const content = renderPullRequestContent({ change: item, intent: objective?.goal ?? item.slug.replace(/-/g, " "), branch: workRuntime.branchName,
          implementation: result?.status === "success" ? result : null, review });
        let pullRequest: GitHubPullRequest;
        if (existing) {
          pullRequest = await this.#github.pullRequest(project, existing.number);
        } else {
          try {
            pullRequest = await this.#github.createPullRequest(project, workRuntime.branchName, publicText(content.title, this.#names), publicText(content.body, this.#names));
          } catch (error) {
            const recovered = await this.#github.findPullRequest?.(project, workRuntime.branchName);
            if (!recovered) throw error;
            pullRequest = recovered;
          }
        }
        this.#savePullRequest(store, workRuntime, pullRequest);
        if (pullRequest.headRefOid !== review.reviewed_commit) throw new Error("Published PR head differs from the reviewed commit. Reconcile the branch and request fresh review through Main.");
        await this.#github.syncPullRequestContent(project, pullRequest,
          publicText(reconcilePullRequestBody(pullRequest.body, item, content.verification, relatedPullRequests(store, item)), this.#names), publicText(reviewNotes(review), this.#names));
        workRuntime.reviewedDiffHash = await this.#git.effectiveDiffFingerprint(project, workRuntime.clonePath, pullRequest.baseRefName, pullRequest.baseRefOid, pullRequest.headRefOid);
        store.saveChangeSetRuntime(workRuntime);
        store.transitionChangeSet(item.id, "AwaitingMerge");
        this.#progress(`${changeName(item)} · PR opened: #${pullRequest.number}.`);
      } catch (error) {
        this.#blockPublication(store, item, error, retrying);
      }
    }
    return deferred;
  }

  #blockPublication(store: MerroStore, item: ChangeSet, error: unknown, automaticRetry: boolean): void {
    const reason = isTransientGitHubFailure(error) ? "github_unavailable" : "publication_failed";
    const detail = errorText(error);
    const previous = store.latestBlock(item.id);
    store.transitionChangeSet(item.id, "PublishBlocked", reason);
    if (automaticRetry && previous?.reason === reason && previous.detail === detail) return;
    store.appendEvent("ChangeSet", item.id, "blocked", { reason, detail, retryable: true });
    const view = presentWorkspace(store, this.#presentationOptions()).changes.find((change) => change.name === changeName(item));
    const pr = store.getChangeSetRuntime(item.id)?.pullRequestNumber;
    // Merro-owned waiting needs no one: show it transiently, never as a permanent notification. Hooks still get the event.
    if (view?.status === "Waiting") {
      const waiting = `${changeName(item)} · Waiting · ${view.summary}`;
      this.#progress(waiting);
      this.#queueNotification("publication_blocked", item.id, `${waiting}\nDetails: ${detail}`);
      return;
    }
    const message = `${changeName(item)} · Blocked${pr ? ` · PR #${pr}` : ""}\n\n${view?.blocked?.message ?? "Merro could not open the pull request."}${view?.blocked?.next ? `\nNext: ${view.blocked.next}` : ""}${detail ? `\nDetails: ${conciseDiagnostic(publicText(detail, this.#names))}` : ""}`;
    this.#notify(message, "warning");
    this.#queueNotification("publication_blocked", item.id, `${message}\nDetails: ${detail}`);
  }

  async #reconcilePullRequests(store: MerroStore, unavailableProjects: ReadonlySet<string>, unsafeProjects: ReadonlySet<string>): Promise<void> {
    for (let item of store.listChangeSets()) {
      if (unavailableProjects.has(item.projectSlug) || item.delivery === "local") continue;
      const recovering = item.state === "Blocked"
        && (item.blockedResumeState === "AwaitingMerge" || item.blockedResumeState === "AwaitingApproval")
        && (item.blockedReason === "github_unavailable" || item.blockedReason === "policy_unknown");
      const runtime = store.getChangeSetRuntime(item.id);
      const project = store.getProject(item.projectSlug);
      if (!runtime || !project) continue;
      try {
        if (item.issues.length && runtime.lastIssueState === "CLOSED" && !terminal(item)) {
          if (store.activeTask(item.id)) continue;
          if (runtime.pullRequestNumber !== null) {
            const pullRequest = await this.#github.pullRequest(project, runtime.pullRequestNumber);
            this.#savePullRequest(store, runtime, pullRequest);
            if (pullRequest.mergedAt) {
              if (!isCommitSha(pullRequest.mergeCommitSha)) {
                // GitHub confirms the merge; the current status shows that Merro is verifying completion.
                continue;
              }
              await this.#completeMergedChangeSet(store, item, runtime, project, pullRequest, unsafeProjects);
              this.#resolvePullRequestDecisions(store, item.id);
              continue;
            }
          }
          this.#completeClosedIssue(store, store.getChangeSet(item.id) ?? item);
          continue;
        }
        const hasPullRequestIdentity = runtime.pullRequestNumber !== null || runtime.branchName !== null;
        const terminalOnly = (item.state === "Blocked" || item.state === "PublishBlocked") && !recovering && hasPullRequestIdentity;
        if (item.state !== "AwaitingMerge" && item.state !== "AwaitingApproval" && !recovering && !terminalOnly) continue;
        let pullRequest: GitHubPullRequest | null = null;
        if (runtime.pullRequestNumber) {
          pullRequest = await this.#github.pullRequest(project, runtime.pullRequestNumber);
        } else if (runtime.branchName && this.#github.findPullRequest) {
          pullRequest = await this.#github.findPullRequest(project, runtime.branchName);
          if (pullRequest) {
            runtime.pullRequestNumber = pullRequest.number;
            runtime.pullRequestUrl = pullRequest.url;
            store.saveChangeSetRuntime(runtime);
            pullRequest = await this.#github.pullRequest(project, pullRequest.number);
          }
        }
        if (!pullRequest) continue;
        this.#savePullRequest(store, runtime, pullRequest);
        if (pullRequest.mergedAt) {
          if (!isCommitSha(pullRequest.mergeCommitSha)) {
            // GitHub confirms the merge; the current status shows that Merro is verifying completion.
            continue;
          }
          await this.#completeMergedChangeSet(store, item, runtime, project, pullRequest, unsafeProjects);
          this.#resolvePullRequestDecisions(store, item.id);
          continue;
        }
        if (item.state === "PublishBlocked") {
          // Only terminal external truth may bypass an unfinished publication.
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
          const body = reconcilePullRequestBody(pullRequest.body, item, finalVerification(store, item, latestReview), relatedPullRequests(store, item));
          await this.#github.syncPullRequestContent(project, pullRequest, publicText(body, this.#names), publicText(reviewNotes(latestReview), this.#names));
          pullRequest = { ...pullRequest, body };
        }
        // Reconcile external PR state, but never restore or synchronize a clone an orphan may still use.
        if (terminalOnly || unsafeProjects.has(item.projectSlug)) continue;
        if (store.pendingDecisions().some((decision) => decision.subjectId === item.id && decision.kind === "merge_conflict")) continue;
        if (runtime.branchName && this.#git.remoteBranchCommit) {
          const remoteHead = await this.#git.remoteBranchCommit(project, runtime.branchName);
          if (!remoteHead) {
            if (recovering) {
              store.transitionChangeSet(item.id, item.blockedResumeState!);
              item = store.getChangeSet(item.id) ?? item;
            }
            this.#resolveMergeDecisions(store, item.id);
            this.#block(store, item, "remote_branch_deleted", `Remote branch ${runtime.branchName} was deleted`);
            continue;
          }
          if (remoteHead !== pullRequest.headRefOid) {
            this.#resolveMergeDecisions(store, item.id);
            // GitHub branch updates can lag; the next reconciliation checks again.
            continue;
          }
        }
        if (runtime.branchName && runtime.clonePath && this.#git.ensureChangeSetClone) {
          try {
            await this.#git.ensureChangeSetClone(project, runtime.clonePath, runtime.branchName, pullRequest.headRefOid);
          } catch (error) {
            if (recovering) {
              store.transitionChangeSet(item.id, item.blockedResumeState!);
              item = store.getChangeSet(item.id) ?? item;
            }
            this.#block(store, item, "clone_lost", `Could not restore the local ChangeSet clone: ${errorText(error)}`);
            continue;
          }
        }
        const policy = await this.#github.branchProtection(project, pullRequest.baseRefName);
        if (!policy.known) {
          if (recovering && item.blockedReason !== "policy_unknown") {
            store.transitionChangeSet(item.id, item.blockedResumeState!);
            item = store.getChangeSet(item.id) ?? item;
          }
          this.#block(store, item, "policy_unknown", policy.reason, policy.retryable);
          continue;
        }
        if (recovering) {
          store.transitionChangeSet(item.id, item.blockedResumeState!);
          item = store.getChangeSet(item.id) ?? item;
        }

        if (pullRequest.mergeable === "CONFLICTING") {
          this.#resolveMergeDecisions(store, item.id);
          store.createDecision({
            id: randomUUID(), subjectType: "ChangeSet", subjectId: item.id, kind: "merge_conflict",
            payload: {
              pullRequest: pullRequest.number, url: pullRequest.url,
              baseRefName: pullRequest.baseRefName, baseCommit: pullRequest.baseRefOid,
              detail: "GitHub reports conflicts with the updated base; an implementer must resolve and verify them.",
            },
          });
          this.#notify(`${changeName(item)}\nNeeds you · PR #${pullRequest.number} · Merge conflicts need a resolution.\nApprove a fresh attempt? /merro approve ${changeName(item)} · Leave unchanged: /merro leave ${changeName(item)}`, "warning");
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
            throw new Error("cannot rework pull request: ChangeSet branch runtime is incomplete");
          }
          await this.#git.syncBranchHead(project, runtime.clonePath, runtime.branchName, pullRequest.headRefOid);
          if (newChangeRequest && reviewTrigger) {
            runtime.lastReworkTrigger = reviewTrigger;
            store.markPullRequestRework(runtime);
          } else {
            store.transitionChangeSet(item.id, "Implementing");
          }
          // The single GitHub checks field in /merro explains failed required checks.
          continue;
        }
        if (!runtime.clonePath) throw new Error("cannot compare the pull request diff without a ChangeSet clone");
        const currentDiffHash = await this.#git.effectiveDiffFingerprint(
          project, runtime.clonePath, pullRequest.baseRefName, pullRequest.baseRefOid, pullRequest.headRefOid,
        );
        const reviewedDiffHash = runtime.reviewedDiffHash
          ?? (latestReviewTask?.reviewedCommit === pullRequest.headRefOid ? currentDiffHash : null);
        if (!latestReview || latestReview.status !== "pass" || reviewedDiffHash !== currentDiffHash) {
          this.#resolveMergeDecisions(store, item.id);
          runtime.reviewedDiffHash = null;
          store.saveChangeSetRuntime(runtime);
          if (!runtime.clonePath || !runtime.branchName || !this.#git.syncBranchHead) {
            throw new Error("cannot re-review pull request head: ChangeSet branch runtime is incomplete");
          }
          await this.#git.syncBranchHead(project, runtime.clonePath, runtime.branchName, pullRequest.headRefOid);
          store.transitionChangeSet(item.id, "Reviewing");
          // The Working state shows that Merro is checking the latest changes.
          continue;
        }
        if (runtime.reviewedDiffHash === null) {
          runtime.reviewedDiffHash = currentDiffHash;
          store.saveChangeSetRuntime(runtime);
        }
        const teamReviewPending = requiredTeamReviewApplies(pullRequest, policy)
          && !teamReviewGateSatisfied(pullRequest, policy);
        if (teamReviewPending) {
          this.#waitForRequiredTeamReview(store, item, runtime, pullRequest);
          continue;
        }
        if (runtime.githubTeamReviewPending || item.state === "AwaitingApproval") {
          runtime.githubTeamReviewPending = false;
          store.saveChangeSetRuntime(runtime);
          if (item.state === "AwaitingApproval") {
            store.transitionChangeSet(item.id, "AwaitingMerge");
            item = store.getChangeSet(item.id) ?? item;
          }
        }
        if (!await satisfiesBranchPolicy(pullRequest, policy, (username) => this.#github.hasWritePermission(project, username))) {
          this.#resolveMergeDecisions(store, item.id);
          continue;
        }
        // Auto-merge waits for CI; GitHub rulesets were already enforced by satisfiesBranchPolicy above.
        const autoMerge = this.#config.merge.auto;
        if (autoMerge && runtime.githubChecks === "pending") continue;
        const autoReady = autoMerge && runtime.githubChecks !== "failed";
        const pendingDecision = store.pendingDecisions().find((decision) => decision.kind === "merge" && decision.subjectId === item.id);
        if (pendingDecision) {
          const payload = typeof pendingDecision.payload === "object" && pendingDecision.payload !== null
            ? pendingDecision.payload as Record<string, unknown>
            : {};
          if (payload.pullRequest === pullRequest.number && payload.url === pullRequest.url
            && payload.title === pullRequest.title && payload.headRefOid === pullRequest.headRefOid) {
            if (autoReady) await this.#executeMergeDecision(store, pendingDecision.id, true);
            continue;
          }
          store.resolveDecision(pendingDecision.id, "resolved");
        }
        const decisionId = randomUUID();
        store.createDecision({
          id: decisionId, subjectType: "ChangeSet", subjectId: item.id, kind: "merge",
          payload: {
            pullRequest: pullRequest.number,
            url: pullRequest.url,
            title: pullRequest.title,
            headRefOid: pullRequest.headRefOid,
            diffHash: currentDiffHash,
          },
        });
        if (autoReady) {
          this.#progress(`${changeName(item)} · Review passed and GitHub checks are green. Merging PR #${pullRequest.number} (${this.#config.merge.method}).`);
          await this.#executeMergeDecision(store, decisionId, true);
          continue;
        }
        const checks = formatChecks({ source: "GitHub", state: runtime.githubChecks === "green" ? "passed" : runtime.githubChecks === "failed" ? "failed" : runtime.githubChecks === "pending" ? "waiting" : "not reported", observedAt: runtime.githubChecksAt ?? null }, true);
        const message = `${changeName(item)}\nReady to merge · PR #${pullRequest.number}\n${checks} · Merro review passed\n\nApprove merge? /merro approve ${changeName(item)} · Leave open: /merro leave ${changeName(item)}`;
        this.#notify(message, "warning");
        this.#queueNotification("merge_ready", item.id, message);
      } catch (error) {
        this.#blockForGitHubUnavailable(store, item, `GitHub reconciliation failed: ${errorText(error)}`);
      }
    }
  }

  #blockForGitHubUnavailable(store: MerroStore, item: ChangeSet, detail: string): void {
    let current = store.getChangeSet(item.id) ?? item;
    this.#resolveMergeDecisions(store, current.id);
    if (terminal(current)) return;
    if (current.state === "Blocked") {
      if (current.blockedReason !== "github_unavailable" || !current.blockedResumeState) {
        this.#progress(`${changeName(current)} remains blocked. Merro will check again automatically.`);
        return;
      }
      store.transitionChangeSet(current.id, current.blockedResumeState);
      current = store.getChangeSet(current.id) ?? current;
    }
    this.#block(store, current, "github_unavailable", detail);
  }

  #resolveMergeDecisions(store: MerroStore, changeSetId: string): void {
    for (const decision of store.pendingDecisions()) {
      if ((decision.kind === "merge" || decision.kind === "local_merge") && decision.subjectId === changeSetId) {
        store.resolveDecision(decision.id, "resolved");
      }
    }
  }

  #waitForRequiredTeamReview(store: MerroStore, item: ChangeSet, runtime: ChangeSetRuntimeRecord, pullRequest: GitHubPullRequest): void {
    const shouldNotify = !runtime.githubTeamReviewPending || item.state !== "AwaitingApproval";
    runtime.githubTeamReviewPending = true;
    store.saveChangeSetRuntime(runtime);
    this.#resolveMergeDecisions(store, item.id);
    if (item.state !== "AwaitingApproval") store.transitionChangeSet(item.id, "AwaitingApproval");
    if (shouldNotify) {
      const message = `${changeName(item)} · Awaiting required team review for PR #${pullRequest.number}. GitHub requires review from a configured team for files changed by this PR. Merro will continue automatically once GitHub reports the merge requirement satisfied.`;
      this.#progress(message);
      this.#queueNotification("team_review_pending", item.id, message);
    }
  }

  #resolvePullRequestDecisions(store: MerroStore, changeSetId: string): void {
    for (const decision of store.pendingDecisions()) {
      if (decision.subjectId === changeSetId) store.resolveDecision(decision.id, "resolved");
    }
  }

  async #completeMergedChangeSet(
    store: MerroStore,
    item: ChangeSet,
    runtime: ChangeSetRuntimeRecord,
    project: Project,
    pullRequest: GitHubPullRequest,
    unsafeProjects: ReadonlySet<string>,
  ): Promise<void> {
    if (!pullRequest.mergedAt || !isCommitSha(pullRequest.mergeCommitSha)) {
      throw new Error("cannot finalize a pull request without confirmed merge metadata");
    }
    this.#savePullRequest(store, runtime, pullRequest);
    runtime.pullRequestState = "MERGED";
    runtime.mergedCommitSha = pullRequest.mergeCommitSha;
    store.saveChangeSetRuntime(runtime);
    const newlyCompleted = store.completeChangeSetAfterMerge(
      item.id,
      finalMergeSummary(store, item, runtime, pullRequest),
    );
    if (newlyCompleted) this.#notify(`${changeName(item)} done · PR #${pullRequest.number} merged.`);

    if (item.issues.length) {
      try {
        const issues = await this.#github.issues(project, issueNumbers(item));
        for (const issue of issues) {
          if (issue.state.toUpperCase() !== "CLOSED") this.#notify(`Issue #${issue.number} is still open after the pull request merged. Check the issue on GitHub.`, "warning");
        }
      } catch (error) {
        const detail = conciseDiagnostic(publicText(errorText(error), this.#names));
        this.#notify(`${changeName(item)} merged, but Merro could not confirm whether its issues closed. Check GitHub. Details: ${detail}`, "warning");
      }
    }

    const neededReviewedCheckout = store.listRelations().some((relation) => relation.kind === "Requires"
      && relation.to === item.id && relation.gate === "reviewed" && !terminal(store.getChangeSet(relation.from)!));
    if (runtime.clonePath && neededReviewedCheckout) store.appendEvent("ChangeSet", item.id, "dependency_clone_retained", {});
    if (runtime.clonePath && this.#git.deleteClone && !unsafeProjects.has(item.projectSlug) && !neededReviewedCheckout) {
      try {
        await this.#git.deleteClone(this.#cloneRoot(item, runtime.clonePath), runtime.clonePath);
      } catch (error) {
        this.#notify(`${changeName(item)} is done, but Merro could not remove its working copy: ${errorText(error)}. Remove it manually if disk space is a concern.`, "warning");
      }
    }
  }

  #savePullRequest(store: MerroStore, runtime: ChangeSetRuntimeRecord, pr: GitHubPullRequest): void {
    if (runtime.pullRequestHeadSha !== pr.headRefOid || runtime.pullRequestBaseSha !== pr.baseRefOid) {
      runtime.githubTeamReviewPending = false;
    }
    runtime.pullRequestNumber = pr.number;
    runtime.pullRequestUrl = pr.url;
    runtime.pullRequestState = pr.mergedAt ? "MERGED" : pr.state;
    const successful = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
    const failed = new Set(["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "CANCELLED", "ACTION_REQUIRED"]);
    const states = pr.checks.map((check) => (check.conclusion ?? check.state).toUpperCase());
    runtime.githubChecks = !states.length ? "none" : states.some((state) => failed.has(state)) ? "failed"
      : states.every((state) => successful.has(state)) ? "green" : "pending";
    runtime.githubChecksAt = new Date().toISOString();
    runtime.githubReviewDecision = pr.reviewDecision?.toUpperCase() ?? null;
    runtime.pullRequestHeadSha = pr.headRefOid;
    runtime.pullRequestBaseSha = pr.baseRefOid;
    if (pr.mergedAt && isCommitSha(pr.mergeCommitSha)) runtime.mergedCommitSha = pr.mergeCommitSha;
    store.saveChangeSetRuntime(runtime);
  }

  #obsoleteIfUnowned(store: MerroStore, item: ChangeSet, unsafeProjects: ReadonlySet<string> = new Set()): boolean {
    if (store.hasActiveObjectiveForChangeSet(item.id)) return false;
    if (unsafeProjects.has(item.projectSlug)) return true;
    const current = store.getChangeSet(item.id);
    if (current && !terminal(current) && !store.activeTask(item.id)) {
      store.transitionChangeSet(item.id, "Obsolete");
      this.#resolvePullRequestDecisions(store, item.id);
      // Ownerless changes are omitted from the user-facing active-work view.
    }
    return true;
  }

  async #rebuildRelations(
    store: MerroStore,
    unavailableProjects: ReadonlySet<string>,
    occupiedChangeSetIds: ReadonlySet<string>,
    issueCache: Map<string, Map<number, GitHubIssue>>,
  ): Promise<Set<string>> {
    const gated = new Set<string>();
    const analyzed: string[] = [];
    const relations: Relation[] = [];
    const objectives = store.listObjectives().filter((objective) => objective.state === "Active");
    for (const item of store.listChangeSets()) {
      if (unavailableProjects.has(item.projectSlug)) { gated.add(item.id); continue; }
      if ((terminal(item) || !store.hasActiveObjectiveForChangeSet(item.id)) && !occupiedChangeSetIds.has(item.id)) {
        if (!store.activeTask(item.id)) analyzed.push(item.id);
        continue;
      }
      if (!item.issues.length) { analyzed.push(item.id); continue; }
      try {
        const projectIssues = issueCache.get(item.projectSlug);
        if (!projectIssues) throw new Error("Issue data was not loaded during reconciliation");
        const issues = issueNumbers(item).map((number) => {
          const issue = projectIssues.get(number);
          if (!issue) throw new Error(`Issue #${number} was not returned during reconciliation`);
          return issue;
        });
        const approved = new Map<string, ChangeSet>();
        for (const objective of objectives) {
          const attached = store.listChangeSets(objective.id, true);
          if (!occupiedChangeSetIds.has(item.id) && !attached.some((candidate) => candidate.id === item.id)) continue;
          for (const candidate of attached) approved.set(candidate.id, candidate);
        }
        analyzed.push(item.id);
        for (const issue of issues) {
          const analysis = analyzeIssueRelations(item, issue, [...approved.values()]);
          relations.push(...analysis.relations);
          if (analysis.unresolved.length > 0) {
            gated.add(item.id);
            this.#notify(`${changeName(item)} cannot start because ${analysis.unresolved.join(", ")} is outside approved work. Add it to the Objective or remove the dependency.`, "warning");
          }
        }
      } catch (error) {
        gated.add(item.id);
        const detail = conciseDiagnostic(publicText(errorText(error), this.#names));
        this.#progress(`${changeName(item)} · Merro could not refresh dependency information. It will retry automatically. Details: ${detail}`);
      }
    }
    store.rebuildAutomaticRelations(analyzed, relations, [...occupiedChangeSetIds]);
    return gated;
  }

  #reconcileReviewedDependencies(store: MerroStore, unsafeProjects: ReadonlySet<string>): Set<string> {
    const eligible = currentlyReviewedIds(store);
    const stale = new Set<string>();
    for (const relation of store.listRelations()) {
      if (relation.kind !== "Requires") continue;
      const item = store.getChangeSet(relation.from);
      if (!item || terminal(item) || item.state === "Planned" || item.state === "Ready") continue;
      if ((relation.gate ?? "done") === "done") {
        if (store.getChangeSet(relation.to)?.state !== "Done") {
          stale.add(item.id);
          this.#resolvePullRequestDecisions(store, item.id);
        }
        continue;
      }
      const review = store.listTasks(relation.to).filter((task) => task.role === "review").at(-1);
      if (eligible.has(relation.to) && relation.consumedReviewedCommit === review?.reviewedCommit) continue;
      stale.add(item.id);
      this.#resolvePullRequestDecisions(store, item.id);
      if (store.activeTask(item.id) || unsafeProjects.has(item.projectSlug)
        || item.state === "Blocked" || item.state === "PublishBlocked") continue;
      const runtime = store.getChangeSetRuntime(item.id);
      if (runtime) {
        runtime.reviewedDiffHash = null;
        store.saveChangeSetRuntime(runtime);
      }
      if (item.state !== "Implementing") {
        store.transitionChangeSet(item.id, "Implementing");
        store.appendEvent("ChangeSet", item.id, "dependency_stale", {
          prerequisite: relation.to, consumedCommit: relation.consumedReviewedCommit ?? null,
          currentReviewedCommit: review?.reviewedCommit ?? null,
        });
        this.#progress(`${changeName(item)} · Approved prerequisite changed; waiting for its passing review, then revalidating with a fresh implementation and review.`);
      }
    }
    return stale;
  }

  #deriveReady(store: MerroStore, unavailableProjects: ReadonlySet<string>, relationGates: ReadonlySet<string>, unsafeProjects: ReadonlySet<string>, occupiedChangeSetIds: ReadonlySet<string>, reviewedChangeSetIds: ReadonlySet<string>): void {
    const items = store.listChangeSets();
    const byId = new Map(items.map((item) => [item.id, item]));
    const relations = store.listRelations();
    const active = new Set([
      ...store.listTasks().filter((task) => task.status === "active").map((task) => task.changeSetId),
      ...items.filter((item) => unavailableProjects.has(item.projectSlug)).map((item) => item.id),
      ...occupiedChangeSetIds,
    ]);
    const cycle = findRequiresCycle(relations);
    if (cycle) this.#blockCycle(store, cycle, active);
    for (const item of store.listChangeSets()) {
      if (unavailableProjects.has(item.projectSlug)
        || (item.state !== "Planned" && item.state !== "Ready") || active.has(item.id)) continue;
      if (!store.hasActiveObjectiveForChangeSet(item.id)) {
        if (unsafeProjects.has(item.projectSlug)) continue;
        store.transitionChangeSet(item.id, "Obsolete");
        continue;
      }
      const requirements = relations.filter((relation) => relation.kind === "Requires" && relation.from === item.id);
      const ready = !relationGates.has(item.id) && requirements.every((relation) => {
        const prerequisite = byId.get(relation.to);
        return (relation.gate ?? "done") === "reviewed"
          ? reviewedChangeSetIds.has(relation.to) : prerequisite?.state === "Done";
      });
      if (item.state === "Planned" && ready) store.transitionChangeSet(item.id, "Ready");
      else if (item.state === "Ready" && !ready) store.transitionChangeSet(item.id, "Planned");
    }
  }

  #blockCycle(store: MerroStore, cycle: readonly string[], active: ReadonlySet<string>): void {
    for (const id of new Set(cycle)) {
      const item = store.getChangeSet(id);
      if (!item || active.has(id) || item.state === "Blocked" || item.state === "PublishBlocked" || terminal(item)) continue;
      this.#block(store, item, "cycle", `Requires cycle: ${cycle.join(" -> ")}`);
    }
  }

  #block(store: MerroStore, item: ChangeSet, reason: ChangeSet["blockedReason"] & string, detail: string, retryable = true): void {
    const current = store.getChangeSet(item.id) ?? item;
    const previous = store.latestBlock(item.id);
    const changed = current.state !== "Blocked" || current.blockedReason !== reason
      || previous?.reason !== reason || previous.detail !== detail || previous.retryable !== retryable;
    if (!changed) return;
    if (current.state !== "Blocked" || current.blockedReason !== reason) store.transitionChangeSet(item.id, "Blocked", reason);
    store.appendEvent("ChangeSet", item.id, "blocked", { reason, detail, retryable });
    const view = presentWorkspace(store, this.#presentationOptions()).changes.find((change) => change.name === changeName(item));
    const pr = store.getChangeSetRuntime(item.id)?.pullRequestNumber;
    const dependents = store.listRelations().filter((relation) => relation.kind === "Requires" && relation.to === item.id)
      .map((relation) => store.getChangeSet(relation.from)).filter((dependent): dependent is ChangeSet => dependent !== null)
      .map(changeName);
    const waiting = dependents.length ? `\nAlso waiting: ${dependents.join(", ")}.` : "";
    // Merro-owned waiting shows transiently; hooks get the event once, not on every automatic recovery attempt.
    if (view?.status === "Waiting") {
      const text = `${changeName(item)} · Waiting · ${view.summary}`;
      this.#progress(text);
      if (previous?.reason !== reason || previous.detail !== detail) this.#queueNotification("blocked", item.id, `${text}${detail ? `\nDetails: ${detail}` : ""}`);
      return;
    }
    const message = `${changeName(item)} · Blocked${pr ? ` · PR #${pr}` : ""}\n\n${view?.blocked?.message ?? "This change needs attention."}${view?.blocked?.next ? `\nNext: ${view.blocked.next}` : ""}${waiting}${detail ? `\nDetails: ${conciseDiagnostic(publicText(detail, this.#names))}` : ""}`;
    // The guard above already proves this block is new, even when its text matches an earlier one.
    this.#notifiedBySubject.delete(publicText(changeName(item), this.#names));
    this.#notify(message, "warning");
    this.#queueNotification("blocked", item.id, `${message}${detail ? `\nDetails: ${detail}` : ""}`);
  }

  /** Notification dedupe is per subject; a user action on one change never re-shows warnings about others. */
  #rearmNotifications(change: string): void {
    this.#notifiedBySubject.delete(publicText(change, this.#names));
  }

  /** The strictest approved limit; null while an owner has none approved, which never falls back to live config. */
  #reviewLimit(store: MerroStore, item: ChangeSet): number | "unlimited" | null {
    const limits = this.#activeOwners(store, item).map((objective) => objective.maxReviewRounds ?? null);
    if (limits.includes(null)) return null;
    if (limits.length === 0 || limits.every((limit) => limit === "unlimited")) return "unlimited";
    return Math.min(...limits.filter((limit): limit is number => limit !== null && limit !== "unlimited"));
  }

  /** Blocks rejected work that used its approved review rounds, so no implementer starts past the cap. */
  #reviewCapReached(store: MerroStore, item: ChangeSet): boolean {
    const round = store.getChangeSetRuntime(item.id)?.reviewRound ?? 0;
    const limit = this.#reviewLimit(store, item);
    if (item.state !== "Implementing" || round === 0 || limit === null || limit === "unlimited" || round < limit) return false;
    const review = store.listTasks(item.id).filter((task) => task.role === "review" && task.outcome === "reject").at(-1);
    let findings: Array<{ severity?: string; summary?: string }> = [];
    try { findings = (JSON.parse(review?.resultJson ?? "{}") as { findings?: typeof findings }).findings ?? []; } catch { /* findings stay in /merro <change> */ }
    this.#block(store, item, "review_cap", `Reached review cap. Blocking findings:\n${findings.filter((finding) => finding.severity === "blocking").map((finding) => `- ${finding.summary}`).join("\n")}`);
    return true;
  }

  #reviewContext(json: string): string {
    try {
      const result = parseReviewResult(JSON.parse(json));
      return [result.summary, ...result.findings.map((finding) => `${finding.severity}: ${finding.summary}`), verificationText(result.verification)].join("\n");
    } catch {
      return "Prior review result could not be parsed.";
    }
  }

  #actionableReviewFindings(json: string): string | null {
    try {
      const findings = parseReviewResult(JSON.parse(json)).findings.filter((finding) => finding.severity === "blocking");
      if (findings.length === 0) return null;
      return findings.map((finding) => {
        const lines = finding.line_start === undefined ? ""
          : `:${finding.line_start}${finding.line_end !== undefined && finding.line_end !== finding.line_start ? `-${finding.line_end}` : ""}`;
        const location = finding.file ? ` (${compactReviewText(finding.file, 160)}${lines})` : lines ? ` (line ${lines.slice(1)})` : "";
        return `- ${compactReviewText(finding.summary, 300)}${location}`;
      }).join("\n");
    } catch {
      return null;
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
    if (this.#config.notifyCommand?.trim()) {
      this.#pendingNotifications.push({ event, subjectId, message });
      if (event === "review_complete") this.#reviewNotificationsInFlight.add(subjectId);
    }
  }

  #queueBaseUpdate(store: MerroStore, item: ChangeSet, runtime: ChangeSetRuntimeRecord, pullRequest: GitHubPullRequest): void {
    if (!runtime.clonePath || !runtime.branchName || !isCommitSha(pullRequest.baseRefOid)) throw new Error("cannot schedule updated base: ChangeSet runtime or base commit is invalid");
    this.#resolveMergeDecisions(store, item.id);
    runtime.baseUpdate = { baseRefName: pullRequest.baseRefName, baseCommit: pullRequest.baseRefOid };
    runtime.reviewedDiffHash = null;
    store.saveChangeSetRuntime(runtime);
    store.transitionChangeSet(item.id, "Implementing");
    this.#progress(`${changeName(item)} · The pull request's base changed; Merro is rechecking the changes.`);
  }

  /** Active Objectives whose approved scope includes the ChangeSet, highest priority first. */
  #activeOwners(store: MerroStore, item: ChangeSet): Objective[] {
    return store.listObjectives()
      .filter((objective) => objective.state === "Active" && store.listChangeSets(objective.id, true).some((owned) => owned.id === item.id))
      .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority));
  }

  /**
   * Work approved before Merro snapshotted settings (schema 22 and earlier) has none, and live config was never approved for it.
   * The ChangeSet takes an owner's worker snapshot when one exists; otherwise the returned owner must approve settings
   * before another worker starts. An owner without a review-round snapshot needs the same approval.
   */
  #ownerNeedingSettings(store: MerroStore, item: ChangeSet): Objective | null {
    const owners = this.#activeOwners(store, item);
    if (!store.changeSetWorkerSettings(item.id)) {
      const snapshot = owners.map((owner) => store.objectiveWorkerSettings(owner.id)).find((settings) => settings !== null);
      if (snapshot) store.claimChangeSetWorkerSettings(item.id, snapshot);
    }
    return owners.find((owner) => owner.maxReviewRounds === null || owner.maxReviewRounds === undefined)
      ?? (store.changeSetWorkerSettings(item.id) ? null : owners[0] ?? null);
  }

  /** Settings requests end once their Objective no longer needs to answer them: settings arrived another way, it stopped, or the change finished. */
  #settleSettingsDecisions(store: MerroStore): void {
    for (const decision of store.pendingDecisions()) {
      if (decision.kind !== "worker_settings") continue;
      const item = store.getChangeSet(decision.subjectId);
      const owner = item && !terminal(item) ? this.#ownerNeedingSettings(store, item) : null;
      const asked = decision.payload as { objectiveId?: string; settings?: WorkerSettings };
      const current = item && store.changeSetWorkerSettings(item.id);
      // A request whose change gained other settings would approve settings the change will not use; ask again.
      const outdated = current && JSON.stringify(current) !== JSON.stringify(asked.settings);
      if (owner?.id !== asked.objectiveId || outdated) store.resolveDecision(decision.id, "resolved");
    }
  }

  #askSettings(store: MerroStore, objective: Objective, item: ChangeSet): void {
    if (store.pendingDecisions().some((decision) => decision.kind === "worker_settings" && decision.subjectId === item.id)) return;
    const settings: WorkerSettings = store.changeSetWorkerSettings(item.id) ?? store.objectiveWorkerSettings(objective.id)
      ?? { implement: { ...this.#config.workers.implementer }, review: { ...this.#config.workers.reviewer } };
    const maxReviewRounds = objective.maxReviewRounds ?? this.#config.maxReviewRounds;
    const objectiveSlug = objectiveName(objective.goal);
    // One notification per Objective: approving any of its changes answers for all of them.
    const alreadyAsked = store.pendingDecisions().some((decision) => decision.kind === "worker_settings"
      && (decision.payload as { objectiveId?: string }).objectiveId === objective.id);
    store.createDecision({
      id: randomUUID(), subjectType: "ChangeSet", subjectId: item.id, kind: "worker_settings",
      payload: { objectiveId: objective.id, objective: objectiveSlug, settings, maxReviewRounds },
    });
    // A request raised again after an earlier one settled is new, even when its text matches.
    if (!alreadyAsked) this.#rearmNotifications(changeName(item));
    if (!alreadyAsked) this.#notify(`${changeName(item)} · Needs you\n\n${objectiveSlug} was approved before Merro recorded its worker settings. Start its work with ${workerSettingsText(settings)}, ${reviewRoundsText(maxReviewRounds)}?\nApprove: /merro approve ${changeName(item)} · Skip: /merro stop ${objectiveSlug}`, "warning");
  }

  /** Approving settings for one change records them for its Objective, so its other waiting changes start too. */
  async #resolveWorkerSettingsDecision(decisionId: string): Promise<void> {
    await this.#withStore((store) => {
      this.#settleSettingsDecisions(store);
      const decision = store.getDecision(decisionId);
      const item = decision && store.getChangeSet(decision.subjectId);
      if (decision?.state !== "pending" || decision.kind !== "worker_settings") {
        throw new Error(`${item ? changeName(item) : "This change"} no longer needs settings approval; nothing changed.`);
      }
      const { objectiveId, settings, maxReviewRounds } = decision.payload as { objectiveId: string; settings: WorkerSettings; maxReviewRounds?: ReviewRoundLimit };
      store.resolveDecision(decision.id, "approved");
      if (!store.objectiveWorkerSettings(objectiveId)) store.saveObjectiveWorkerSettings(objectiveId, settings);
      const objective = store.getObjective(objectiveId);
      if (objective && (objective.maxReviewRounds === null || objective.maxReviewRounds === undefined)) {
        store.saveObjectiveSettings(objectiveId, { maxReviewRounds: maxReviewRounds ?? this.#config.maxReviewRounds });
      }
      this.#settleSettingsDecisions(store);
    });
  }

  #attachIssue(store: MerroStore, objective: Objective, projectSlug: string, issue: GitHubIssue): ChangeSet {
    // Issues entering approved scope run with the settings their Objective was approved with.
    const settings = store.objectiveWorkerSettings(objective.id);
    const existing = store.findNonTerminalChangeSet(projectSlug, [issue.number]);
    if (existing) {
      store.attachChangeSet(objective.id, existing.id);
      if (settings) store.claimChangeSetWorkerSettings(existing.id, settings);
      if (priorityRank(objective.priority) < priorityRank(existing.priority)) store.setChangeSetPriority(existing.id, objective.priority);
      return store.getChangeSet(existing.id)!;
    }
    const generation = store.nextGeneration(projectSlug, [issue.number]);
    const item: ChangeSet = {
      id: sourceId(projectSlug, issue.number, generation), projectSlug,
      slug: store.availableChangeName(semanticSlug(issue.title)), issues: [{ projectSlug, number: issue.number }], generation, state: "Planned", priority: objective.priority,
      readySince: null, blockedReason: null, blockedResumeState: null,
    };
    store.createChangeSet(item);
    store.attachChangeSet(objective.id, item.id);
    if (settings) store.claimChangeSetWorkerSettings(item.id, settings);
    const runtime = emptyRuntime(item.id);
    runtime.lastIssueState = issue.state.toUpperCase();
    store.saveChangeSetRuntime(runtime);
    return item;
  }

  async #refreshObjectiveScope(
    store: MerroStore,
    objective: Objective,
    unavailableProjects: ReadonlySet<string>,
    schedulingGates: Set<string>,
    unsafeProjects: ReadonlySet<string>,
    issueCache: Map<string, Map<number, GitHubIssue>>,
  ): Promise<boolean> {
    try {
      let scopes = objective.issueScopes;
      if (scopes === undefined) {
        // Older databases record selections only through attached ChangeSets. Never infer a broader query from the goal.
        const numbers = new Map<string, number[]>(objective.projectSlugs.map((slug) => [slug, []]));
        for (const item of store.listChangeSets(objective.id)) {
          if (!item.issues.length) continue;
          const selected = numbers.get(item.projectSlug) ?? [];
          selected.push(...issueNumbers(item));
          numbers.set(item.projectSlug, selected);
        }
        scopes = parseObjectiveIssueScopes([...numbers].map(([projectSlug, selected]) => ({ projectSlug, numbers: selected })), objective.projectSlugs, { allowEmptyFixedSelections: true });
        store.restoreObjectiveIssueScopes(objective.id, scopes);
      }
      const discovered: Array<{ projectSlug: string; issue: GitHubIssue }> = [];
      const queryResults = new Map<string, Set<number>>();
      let refreshed = true;
      for (const scope of scopes) {
        try {
          const project = store.getProject(scope.projectSlug);
          if (!project || unavailableProjects.has(project.slug)) throw new Error(`Project '${scope.projectSlug}' is unavailable`);
          const issues = "query" in scope
            ? await this.#github.listOpenIssues(project, scope.query)
            : scope.numbers.length ? await this.#github.issues(project, scope.numbers) : [];
          const cached = issueCache.get(project.slug) ?? new Map<number, GitHubIssue>();
          for (const issue of issues) cached.set(issue.number, issue);
          issueCache.set(project.slug, cached);
          const matching = issues.filter((issue) => issue.state.toUpperCase() === "OPEN" && matchesIssueScope(scope, issue));
          if ("query" in scope) queryResults.set(project.slug, new Set(matching.map((issue) => issue.number)));
          for (const issue of matching) discovered.push({ projectSlug: project.slug, issue });
        } catch (error) {
          refreshed = false;
          for (const item of store.listChangeSets(objective.id)) {
            if (item.projectSlug === scope.projectSlug) schedulingGates.add(item.id);
          }
          const detail = conciseDiagnostic(publicText(errorText(error), this.#names));
          this.#progress(`${objectiveName(objective.goal)} · Could not refresh the approved GitHub scope for ${scope.projectSlug}. Merro will retry automatically. Details: ${detail}`);
        }
      }
      for (const item of store.listChangeSets(objective.id)) {
        if (!item.issues.length || !queryResults.has(item.projectSlug)
          || issueNumbers(item).some((number) => queryResults.get(item.projectSlug)!.has(number))) continue;
        try {
          const project = store.getProject(item.projectSlug)!;
          let issue = issueCache.get(item.projectSlug)?.get(issueNumbers(item)[0]!);
          if (!issue) {
            issue = await this.#github.issue(project, issueNumbers(item)[0]!);
            const cached = issueCache.get(item.projectSlug) ?? new Map<number, GitHubIssue>();
            cached.set(issue.number, issue);
            issueCache.set(item.projectSlug, cached);
          }
          // Closure is authoritative satisfaction, not scope removal. Issue reconciliation handles it.
          if (issue.state.toUpperCase() === "CLOSED") continue;
          const scope = scopes.find((entry) => entry.projectSlug === item.projectSlug)!;
          if (matchesIssueScope(scope, issue)) throw new Error(`issue #${issue.number} changed during scope enumeration`);
          store.detachChangeSet(objective.id, item.id);
          this.#obsoleteIfUnowned(store, item, unsafeProjects);
        } catch (error) {
          refreshed = false;
          schedulingGates.add(item.id);
          const detail = conciseDiagnostic(publicText(errorText(error), this.#names));
          this.#progress(`${changeName(item)} · Could not verify whether it is still in the approved GitHub scope. Merro will retry automatically. Details: ${detail}`);
        }
      }
      const attached = new Map<string, ChangeSet>();
      for (const item of store.listChangeSets(objective.id)) {
        if (!item.issues.length) continue;
        for (const number of issueNumbers(item)) {
          const key = `${item.projectSlug}\0${number}`;
          if ((attached.get(key)?.generation ?? 0) < item.generation) attached.set(key, item);
        }
      }
      for (const { projectSlug, issue } of discovered) {
        const key = `${projectSlug}\0${issue.number}`;
        const existing = attached.get(key);
        if (existing) {
          store.attachChangeSet(objective.id, existing.id);
          if (!terminal(existing) && priorityRank(objective.priority) < priorityRank(existing.priority)) {
            store.setChangeSetPriority(existing.id, objective.priority);
          }
          if ((existing.state === "Done" || existing.state === "Obsolete")
            && store.getChangeSetRuntime(existing.id)?.lastIssueState === "CLOSED") {
            this.#createReopenedIssueGeneration(store, existing, issue);
          }
          continue;
        }
        attached.set(key, this.#attachIssue(store, objective, projectSlug, issue));
      }
      return refreshed;
    } catch (error) {
      for (const item of store.listChangeSets(objective.id)) schedulingGates.add(item.id);
      const detail = conciseDiagnostic(publicText(errorText(error), this.#names));
      this.#progress(`${objectiveName(objective.goal)} · Could not refresh its approved GitHub scope. Merro will retry automatically. Details: ${detail}`);
      return false;
    }
  }

  async #finishObjectives(
    store: MerroStore,
    unavailableProjects: ReadonlySet<string>,
    unsafeProjects: ReadonlySet<string>,
    issueCache: Map<string, Map<number, GitHubIssue>> = new Map(),
  ): Promise<void> {
    for (const objective of store.listObjectives()) {
      if (objective.state !== "Active") continue;
      const items = store.listChangeSets(objective.id);
      if (!items.every(terminal)) continue;
      if (!await this.#refreshObjectiveScope(store, objective, unavailableProjects, new Set(), unsafeProjects, issueCache)) continue;
      if (!store.listChangeSets(objective.id).every(terminal)) continue;
      store.setObjectiveState(objective.id, "Done");
      const message = `${objectiveName(objective.goal)} done.`;
      this.#notify(message);
      this.#queueNotification("objective_done", objective.id, message);
    }
  }
}
