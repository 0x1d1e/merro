import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MerroConfig, WorkerSettings } from "../config.js";
import { priorityRank, type Objective, type ObjectiveIssueScope, type Priority, type Project, type Relation, type Task, type TaskRole, type ChangeSet } from "../domain/model.js";
import { matchesIssueScope, parseObjectiveIssueScopes } from "../domain/objective.js";
import { assertProjectSlug } from "../domain/project.js";
import { analyzeIssueRelations, findRequiresCycle } from "../domain/relations.js";
import { schedule } from "../domain/scheduler.js";
import { assertResultMatchesTask, parseImplementResult, parseReviewResult, type ImplementFailedResult, type ImplementSuccessResult, type ReviewFailedResult, type ReviewResult, type Verification, type WorkerResult } from "../protocol/result.js";
import { GitHubClient, GitHubMergeError, isTransientGitHubFailure, type BranchPolicy, type GitHubIssue, type GitHubPullRequest } from "../github/client.js";
import { MerroStore } from "../store/store.js";
import type { TaskRuntimeRecord, ChangeSetRuntimeRecord } from "../store/model.js";
import { renderTaskFile } from "./task-file.js";
import { loadMarkdownGuidance } from "./guidance.js";
import { MainLock } from "./main-lock.js";
import { changeName, issueNumbers, semanticSlug } from "../domain/names.js";
import { requireWorkspace } from "./workspace.js";
import { presentWorkspace, publicText, workerName } from "./presentation.js";
import { systemCommandRunner, type CommandRunner } from "./commands.js";
import { taskWindowName, WorkerRuntime, type WorkerPresence } from "./worker-runtime.js";
import { GitClient } from "../vcs/git.js";

type GitAdapter = Pick<GitClient, "discoverProject" | "createChangeSetClone" | "currentCommit" | "validateTaskCommit" | "pushBranch" | "fetchBaseCommit" | "syncBranchHead" | "effectiveDiffFingerprint" | "fullDiff">
  & Partial<Pick<GitClient, "discardAttempt" | "remoteBranchCommit" | "ensureChangeSetClone" | "createReadOnlyCheckout" | "deleteClone">>;
type GitHubAdapter = Pick<GitHubClient, "repository" | "repositoryInDirectory" | "listOpenIssues" | "issue" | "issues" | "createPullRequest" | "pullRequest" | "branchProtection" | "hasWritePermission" | "mergeSquash" | "syncPullRequestContent">
  & Partial<Pick<GitHubClient, "findPullRequest" | "beginPass">>;
type WorkerAdapter = Pick<WorkerRuntime, "prepareClone" | "launch" | "inspect" | "cleanup" | "listOwnedWorkers">
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

export interface ObjectiveProposal {
  id: string;
  workerSettings: WorkerSettings;
  changeSets: ChangeSet[];
  branches: Record<string, string>;
  relations: Relation[];
  unresolved: Array<{ changeSetId: string; references: string[] }>;
  cycle: string[] | null;
}

export interface ObjectiveStartInput {
  goal: string;
  projectSlugs: string[];
  issues: ObjectiveIssueScope[];
  priority?: Priority;
  maxReviewRounds?: number | "unlimited";
  changeSlug?: string;
  delivery?: "together" | "separate";
}

const emptyRuntime = (changeSetId: string): ChangeSetRuntimeRecord => ({
  changeSetId, branchName: null, clonePath: null, baseCommit: null,
  pullRequestNumber: null, pullRequestUrl: null, pullRequestState: null,
  pullRequestHeadSha: null, pullRequestBaseSha: null, mergedCommitSha: null,
  lastIssueState: null, reviewedDiffHash: null, reviewRound: 0,
  infrastructureRetries: 0, implementationAttempt: 0, lastReworkTrigger: null, lastReconciledAt: null,
});

type ObjectiveGraph = Omit<ObjectiveProposal, "id" | "workerSettings">;

function proposalFingerprint(graph: ObjectiveGraph): string {
  return JSON.stringify({ changeSets: graph.changeSets.map((item) => item.id), branches: graph.branches, relations: graph.relations,
    unresolved: graph.unresolved, cycle: graph.cycle });
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

function issueBody(item: ChangeSet, summary: string, verification: string): string {
  const closes = issueNumbers(item).length ? `\n\n## Issues\n\n${issueNumbers(item).map((number) => `Closes #${number}`).join("\n")}` : "";
  return publicText(`## Summary\n\n${summary}\n\n## Verification\n\n${verification}${closes}`);
}

function ensureMarkdownSection(body: string, title: string, content: string): string {
  const heading = `## ${title}`;
  if (body.split(/\r?\n/).some((line) => line.trim() === heading)) return body.trim();
  return `${body.trim()}\n\n${heading}\n\n${content}`.trim();
}

function reconcilePullRequestBody(body: string, item: ChangeSet, verification: string): string {
  const updated = ensureMarkdownSection(body, "Verification", verification);
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
  if (implementationVerification.length === 0) return verificationText(review.verification);
  return `### Implementer\n${verificationText(implementationVerification)}\n\n### Reviewer\n${verificationText(review.verification)}`;
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
  #storeQueue: Promise<unknown> = Promise.resolve();
  readonly #proposals = new Map<string, { input: string; graph: string }>();
  readonly #pendingNotifications: Array<{ event: string; subjectId: string; message: string }> = [];
  readonly #names = new Map<string, string>();

  constructor(options: MainOptions) {
    this.#workspacePath = resolve(options.workspacePath);
    this.#stateDirectory = join(this.#workspacePath, ".merro");
    this.#workRoot = join(this.#workspacePath, ".wt");
    this.#config = options.config;
    const notify = options.notify ?? ((message: string) => console.log(message));
    this.#notify = (message, level) => notify(publicText(message, this.#names), level);
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
    return this.#withStore(async (store) => {
      const snapshot = presentWorkspace(store);
      for (const item of store.listChangeSets()) {
        const task = store.activeTask(item.id);
        const runtime = task && store.getTaskRuntime(task.id);
        const change = snapshot.changes.find((change) => change.name === changeName(item));
        if (!runtime || !change) continue;
        try {
          const state: unknown = JSON.parse(await readFile(join(dirname(runtime.resultPath), "worker-state.json"), "utf8"));
          if (typeof state === "object" && state !== null && "state" in state && ["busy", "idle", "finished"].includes(String(state.state))) {
            change.workerState = String(state.state);
            if ("lastActivity" in state) change.lastActivity = publicText(String(state.lastActivity), this.#names);
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") change.lastActivity = "Worker state unreadable; reconciliation will verify identity."; }
      }
      return snapshot;
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

  async proposeObjective(input: ObjectiveStartInput): Promise<ObjectiveProposal> {
    return this.#withStore(async (store) => {
      const prepared = await this.#prepareObjective(store, input);
      const id = randomUUID();
      const workerSettings: WorkerSettings = {
        implement: { model: this.#config.worker_models.implement, thinking: this.#config.worker_thinking.implement },
        review: { model: this.#config.worker_models.review, thinking: this.#config.worker_thinking.review },
      };
      const proposal = { id, workerSettings, ...prepared.graph };
      this.#proposals.clear();
      this.#proposals.set(id, { input: JSON.stringify(input), graph: proposalFingerprint(prepared.graph) });
      return proposal;
    });
  }

  async #prepareObjective(store: MerroStore, input: ObjectiveStartInput) {
    const projects = [...new Set(input.projectSlugs)].map((slug) => {
      const project = store.getProject(slug);
      if (!project) throw new Error(`unknown Project: ${slug}`);
      return project;
    });
    const issueScopes = parseObjectiveIssueScopes(input.issues, projects.map((project) => project.slug));
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
      for (const issue of selected.sort((a, b) => a.number - b.number)) issueRows.set(`${project.slug}\0${issue.number}`, issue);
    }
    const groups: Array<{ projectSlug: string; issues: GitHubIssue[] }> = [];
    for (const project of projects) {
      const issues = [...issueRows].filter(([key]) => key.startsWith(`${project.slug}\0`)).map(([, issue]) => issue);
      if (input.delivery === "separate") groups.push(...issues.map((issue) => ({ projectSlug: project.slug, issues: [issue] })));
      else if (issues.length) groups.push({ projectSlug: project.slug, issues });
    }
    const plannedNames = new Set<string>();
    const changeSets = groups.map(({ projectSlug, issues }): ChangeSet => {
      const numbers = issues.map((issue) => issue.number);
      const existing = store.findNonTerminalChangeSet(projectSlug, numbers);
      if (existing) return existing;
      const overlaps = store.listChangeSets().filter((item) => item.projectSlug === projectSlug && !terminal(item)
        && issueNumbers(item).some((number) => issues.some((issue) => issue.number === number)));
      if (overlaps.length) throw new Error(`Issues already belong to ${overlaps.map(changeName).join(", ")}. Stop that change before regrouping its issues.`);
      const generation = store.nextGeneration(projectSlug, numbers);
      const baseName = semanticSlug(input.changeSlug ?? (issues.length === 1 ? issues[0]!.title : input.goal));
      const slug = store.availableChangeName(baseName, plannedNames);
      plannedNames.add(slug);
      const id = issues.length === 1 ? sourceId(projectSlug, issues[0]!.number, generation) : `${projectSlug}:change:${slug}:g${generation}`;
      this.#names.set(id, slug);
      return { id, slug, projectSlug, issues: numbers.map((number) => ({ projectSlug, number })), generation,
        state: "Planned", priority: input.priority ?? "normal", readySince: null, blockedReason: null, blockedResumeState: null };
    });
    // Shared ChangeSets retain relations to work already approved by another active Objective.
    const objectives = store.listObjectives().filter((candidate) => candidate.state === "Active");
    const relations: Relation[] = [];
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
        relations.push(...analysis.relations);
        for (const reference of analysis.unresolved) references.add(reference);
      }
      if (references.size) unresolved.push({ changeSetId: item.id, references: [...references] });
    }
    const ids = new Set(changeSets.map((item) => item.id));
    const effective = store.previewAutomaticRelations([...ids], relations)
      .filter((relation) => ids.has(relation.from) || ids.has(relation.to));
    return { projects, issueScopes, issueRows, automaticRelations: relations,
      graph: { changeSets, branches: Object.fromEntries(changeSets.map((item) => [item.id,
        store.getChangeSetRuntime(item.id)?.branchName ?? branchName(issueRows.get(`${item.projectSlug}\0${issueNumbers(item)[0]}`)!, item.slug)])),
        relations: effective, unresolved, cycle: findRequiresCycle(effective) } };
  }

  async startObjective(input: ObjectiveStartInput, proposalId?: string): Promise<{ objective: Objective; changeSets: ChangeSet[] }> {
    if (!input.goal.trim()) throw new Error("Objective goal must not be empty");
    if (input.projectSlugs.length === 0) throw new Error("Objective requires at least one Project");
    return this.#withStore(async (store) => {
      const { projects, issueScopes, issueRows, graph, automaticRelations } = await this.#prepareObjective(store, input);
      if (proposalId !== undefined) {
        const proposal = this.#proposals.get(proposalId);
        if (!proposal || proposal.input !== JSON.stringify(input) || proposal.graph !== proposalFingerprint(graph)) {
          throw new Error("Objective proposal changed or expired. Run merro_propose_objective and obtain approval again.");
        }
        this.#proposals.delete(proposalId);
      }

      const objective: Objective = {
        id: randomUUID(), goal: input.goal.trim(), priority: input.priority ?? "normal", state: "Active",
        projectSlugs: projects.map((project) => project.slug),
        issueScopes: input.delivery === "separate" ? issueScopes : projects.map((project) => ({ projectSlug: project.slug,
          numbers: [...issueRows].filter(([key]) => key.startsWith(`${project.slug}\0`)).map(([, issue]) => issue.number) })),
        ...(input.maxReviewRounds === undefined ? {} : { maxReviewRounds: input.maxReviewRounds }),
      };
      store.createObjective(objective);
      this.#names.set(objective.id, objective.goal);
      const items: ChangeSet[] = [];
      for (const planned of graph.changeSets) {
        if (!store.getChangeSet(planned.id)) store.createChangeSet(planned);
        store.attachChangeSet(objective.id, planned.id);
        const item = store.getChangeSet(planned.id)!;
        this.#names.set(item.id, changeName(item));
        if (priorityRank(objective.priority) < priorityRank(item.priority)) store.setChangeSetPriority(item.id, objective.priority);
        items.push(store.getChangeSet(item.id)!);
      }
      store.rebuildAutomaticRelations(items.map((item) => item.id), automaticRelations);
      this.#notify(`Started ${items.map(changeName).join(", ")}.`);
      return { objective, changeSets: items };
    });
  }

  async approveObjective(name?: string): Promise<{ objective: Objective; changeSets: ChangeSet[] }> {
    const [entry] = this.#proposals;
    if (!entry) throw new Error("No pending plan. Propose a plan and obtain approval first.");
    const [id, proposal] = entry;
    const input = JSON.parse(proposal.input) as ObjectiveStartInput;
    if (name && semanticSlug(name) !== semanticSlug(input.changeSlug ?? input.goal)) throw new Error("That name does not match the pending plan.");
    return this.startObjective(input, id);
  }

  async restartChange(name: string, requirements: string): Promise<void> {
    if (!requirements.trim()) throw new Error("Describe the changed requirements for the fresh attempt.");
    await this.#withStore(async (store) => {
      let item = store.listChangeSets().find((item) => item.slug === semanticSlug(name));
      if (!item || terminal(item)) throw new Error("No active change matches that name.");
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
      store.saveChangeSetGuidance(item.id, `${item.guidance ?? ""}\n\nChanged requirements:\n${requirements}`.trim());
      this.#resolvePullRequestDecisions(store, item.id);
      if (item.state === "Blocked") {
        store.transitionChangeSet(item.id, item.blockedResumeState!);
        item = store.getChangeSet(item.id)!;
      }
      if (item.state === "Reviewing" || item.state === "AwaitingMerge") store.transitionChangeSet(item.id, "Implementing");
      const workRuntime = store.getChangeSetRuntime(item.id);
      if (workRuntime) { workRuntime.infrastructureRetries = 0; store.saveChangeSetRuntime(workRuntime); }
      this.#notify(`Stopped the previous attempt for ${item.slug}. Starting a fresh implementation with the changed requirements.`);
    });
    await this.runPass();
  }

  async resolveDecisionForChange(name: string, approved: boolean): Promise<void> {
    const id = await this.decisionForChange(name);
    const kind = await this.#withStore((store) => store.getDecision(id)?.kind);
    if (kind === "merge_conflict") await this.resolveMergeConflictDecision(id, approved ? "resolved" : "abandon");
    else await this.resolveMergeDecision(id, approved);
  }

  async decisionForChange(name = ""): Promise<string> {
    return this.#withStore((store) => {
      const matches = store.pendingDecisions().filter((decision) => {
        const item = store.getChangeSet(decision.subjectId);
        return !name || item && changeName(item) === semanticSlug(name);
      });
      if (matches.length !== 1) throw new Error(matches.length ? "Which change? Name the change you want to approve." : "No pending decision for that change.");
      return matches[0]!.id;
    });
  }

  async stopObjectives(objectiveId?: string): Promise<number> {
    const stopped = await this.#withStore((store) => {
      const objective = objectiveId ? store.listObjectives().find((entry) => entry.id === objectiveId || entry.goal === objectiveId
        || store.listChangeSets(entry.id).some((item) => changeName(item) === objectiveId)) : undefined;
      if (objectiveId && !objective) throw new Error("No active objective matches that name.");
      return store.stopActiveObjectives(objective?.id);
    });
    await this.runPass();
    return stopped;
  }

  async continueChangeSet(changeSetId: string): Promise<void> {
    await this.#withStore((store) => {
      const item = store.getChangeSet(changeSetId) ?? store.listChangeSets().find((item) => changeName(item) === semanticSlug(changeSetId));
      if (!item || item.state !== "Blocked" || !item.blockedResumeState) throw new Error(`ChangeSet ${changeSetId} is not Blocked`);
      if (item.blockedReason === "policy_unknown" && store.latestBlock(item.id)?.retryable === false) {
        throw new Error(`${changeName(item)} is blocked by deterministic GitHub branch policy. Fix the rules or API response; /merro-continue cannot help and Main will retry during reconciliation.`);
      }
      store.transitionChangeSet(item.id, item.blockedResumeState);
      const runtime = store.getChangeSetRuntime(item.id) ?? emptyRuntime(item.id);
      if (item.blockedReason === "review_cap" || item.blockedReason === "task_failed") runtime.infrastructureRetries = 0;
      if (item.blockedReason === "review_cap") runtime.reviewRound = 0;
      store.saveChangeSetRuntime(runtime);
      this.#notify(`Continued ${changeName(item)}.`);
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
      const item = store.getChangeSet(decision.subjectId);
      const runtime = item && store.getChangeSetRuntime(item.id);
      const project = item && store.getProject(item.projectSlug);
      if (!item || item.state !== "AwaitingMerge" || !runtime?.pullRequestNumber || !project) {
        throw new Error(`merge Decision ${decisionId} no longer matches an AwaitingMerge ChangeSet`);
      }

      const { unsafeProjects } = await this.#workerSafetyPreflight(store);
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
          store.resolveDecision(decisionId, "resolved");
          runtime.reviewedDiffHash = null;
          store.saveChangeSetRuntime(runtime);
          this.#notify(`Merge approval for ChangeSet ${item.id} expired because the pull request diff changed or is no longer merge-ready.`, "warning");
          return;
        }
        if (runtime.reviewedDiffHash === null) {
          runtime.reviewedDiffHash = currentDiff;
          store.saveChangeSetRuntime(runtime);
        }

        mergeAttempted = true;
        await this.#github.mergeSquash(project, runtime.pullRequestNumber, pullRequest.headRefOid);
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
    });
    await this.runPass();
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
      if (!item || item.state !== "AwaitingMerge" || !runtime?.clonePath || !runtime.branchName
        || !runtime.pullRequestNumber || !project) {
        throw new Error(`merge_conflict Decision ${decisionId} no longer matches an AwaitingMerge ChangeSet`);
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

  async runPass(): Promise<void> {
    await this.#withStore(async (store) => {
      const unsafeProjects = new Set<string>();
      const finalizedTaskCount = () => store.listTasks().filter((task) => task.status === "finalized").length;
      let inventoriedFinalizedTaskCount = -1;
      try {
        this.#github.beginPass?.();
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
        await this.#reconcilePullRequests(store, unavailableProjects, unsafeProjects);
        const relationGates = await this.#rebuildRelations(store, unavailableProjects, orphans.changeSetIds, issueCache);
        for (const id of scopeGates) relationGates.add(id);
        this.#deriveReady(store, unavailableProjects, relationGates, unsafeProjects, orphans.changeSetIds);
        const tasks = store.listTasks();
        const active = tasks.filter((task) => task.status === "active");
        const items = store.listChangeSets();
        const result = schedule({
          changeSets: items.filter((item) => store.hasActiveObjectiveForChangeSet(item.id)
            && !unavailableProjects.has(item.projectSlug) && !unsafeProjects.has(item.projectSlug) && !relationGates.has(item.id)),
          relations: store.listRelations(),
          activeTaskCount: active.length + orphans.count,
          activeChangeSetIds: [...active.map((task) => task.changeSetId), ...orphans.changeSetIds],
          maxConcurrentTasks: this.#config.max_concurrent_tasks,
        });
        if (result.cycle) this.#blockCycle(store, result.cycle, new Set([...active.map((task) => task.changeSetId), ...orphans.changeSetIds]));
        for (const item of result.selected) {
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
          await this.#commands.run("bash", ["-lc", this.#config.notify_command!], {
            cwd: this.#workspacePath,
            env: { MERRO_EVENT: notification.event, MERRO_CHANGE: this.#names.get(notification.subjectId) ?? "change", MERRO_MESSAGE: publicText(notification.message, this.#names) },
          });
        } catch (error) {
          this.#notify(`notify_command failed: ${errorText(error)}`, "warning");
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
        const clonePath = join(this.#workRoot, slug);
        const clone = await this.#git.createChangeSetClone(project, clonePath, branch);
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
      const instructions = await this.#repositoryInstructions(clonePath);
      const directDependencies = store.listRelations().filter((relation) => relation.kind === "Requires" && relation.from === item.id)
        .flatMap((relation) => {
          const dependency = store.getChangeSet(relation.to);
          if (!dependency || dependency.state !== "Done") return [];
          const depRuntime = store.getChangeSetRuntime(dependency.id);
          const summary = store.listTasks(dependency.id).reverse().find((task) => task.role === "review" && task.summary)?.summary ?? null;
          return [{
            changeSetId: dependency.id,
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
          throw new Error(`dependency ChangeSet ${dependency.changeSetId} has no exact merged commit`);
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
      }) : [];
      const dependencyContext = directDependencies.map((dependency, index) => ({
        change: this.#names.get(dependency.changeSetId) ?? "dependency",
        projectSlug: dependency.projectSlug,
        pullRequestUrl: dependency.pullRequestUrl,
        commit: dependency.commit,
        summary: dependency.summary,
        ...(dependencyMounts[index] ? {
          checkoutPath: useDocker ? dependencyMounts[index]!.mount.mountPath : dependencyMounts[index]!.mount.checkoutPath,
        } : {}),
      }));
      const taskFile = renderTaskFile({
        role, change: slug, projectSlug: item.projectSlug,
        issues: issueNumbers(item),
        title: slug, scope: issues.length ? issues.map((issue) => `### #${issue.number}: ${issue.title}\n\n${issue.body}`).join("\n\n") : item.guidance ?? objective.goal,
        implementation: role === "review" ? store.listTasks(item.id).reverse().find((task) => task.role === "implement" && task.outcome === "success")?.resultJson ?? null : null,
        diff: role === "review" ? await this.#git.fullDiff(clonePath, runtime.baseCommit ?? expectedCommit) : "",
        objective: objective.goal,
        userGuidance: item.guidance ?? "",
        projectGuidance: projectSettings?.guidance ?? "",
        markdownGuidance: await loadMarkdownGuidance(this.#workspacePath, [project.slug], role),
        repositoryInstructions: instructions,
        dependencies: dependencyContext, latestReview, expectedCommit, baseUpdate,
      });
      const launchInput = {
        taskId, changeSetId: item.id, changeSlug: slug, taskName, role, project, clonePath,
        taskFile: publicText(taskFile, this.#names), expectedCommit, baseUpdate, projectSettings, dependencies: dependencyMounts.map(({ mount }) => mount),
      };
      runtimeIntent = this.#workers.plan?.(launchInput) ?? {
        taskId,
        runtimeKind: null,
        tmuxSession: `merro-${project.slug}`,
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
        const repository = await this.#github.repository(discovered.baseRemote);
        const reconciled = { ...discovered, defaultBranch: repository.defaultBranch };
        store.updateProject(reconciled);
        let resumed = false;
        for (const item of store.listChangeSets().filter((candidate) => candidate.projectSlug === current.slug)) {
          if (item.state === "Blocked" && item.blockedReason === "project_unavailable" && item.blockedResumeState) {
            store.transitionChangeSet(item.id, item.blockedResumeState);
            resumed = true;
          }
        }
        if (resumed) this.#notify(`Project ${current.slug} is available again; affected changes resumed.`, "info");
      } catch (error) {
        unavailable.add(current.slug);
        const cause = isTransientGitHubFailure(error)
          ? `GitHub API temporarily unavailable. Check your internet connection or https://githubstatus.com.\n${errorText(error)}`
          : errorText(error);
        for (const item of store.listChangeSets().filter((candidate) => candidate.projectSlug === current.slug)) {
          if (!terminal(item) && item.state !== "Blocked") {
            this.#block(store, item, "project_unavailable", `Project reconciliation failed: ${cause}`);
          }
        }
        this.#notify(`Project ${current.slug} is unavailable: ${cause}\nMain will retry automatically and resume affected changes after recovery.`, "warning");
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
    const runtime = emptyRuntime(item.id);
    runtime.lastIssueState = "OPEN";
    store.saveChangeSetRuntime(runtime);
    this.#notify(`Reopened issue #${issue.number} created ChangeSet generation ${generation}.`);
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
          this.#notify(`${recordedTask ? "Worker for finalized Task" : "Orphan worker"} in Project ${item?.projectSlug ?? project.slug}${item ? ` for ${item.slug}` : ""}. Inspect tmux ${worker.tmuxSession ?? "unavailable"} / ${worker.tmuxWindow ?? "unavailable"}${worker.containerId ? " and its Docker worker" : ""}. Scheduling gated; worker not adopted or stopped.`, "warning");
        }
      } catch (error) {
        // An incomplete inventory cannot prove that a clone is unowned.
        unsafeProjects.add(project.slug);
        for (const item of store.listChangeSets().filter((candidate) => candidate.projectSlug === project.slug)) changeSetIds.add(item.id);
        this.#notify(`Could not enumerate owned workers for Project ${project.slug}; scheduling gated: ${errorText(error)}`, "warning");
      }
    }
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
          const detail = `Could not inspect active Task ${task.id}; reconciliation will retry: ${errorText(inspectionError)}`;
          if (item.issues.length) this.#blockForGitHubUnavailable(store, item, detail);
          else this.#notify(detail, "warning");
          continue;
        }
        if (presence.alive) {
          if (!presence.identityMatches) {
            unsafeProjects.add(item.projectSlug);
            this.#notify(`${item.slug}: ${presence.reason ?? "Worker identity is ambiguous"}. Scheduling paused; inspect the worker before retrying.`, "warning");
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
          this.#notify(`Retrying ChangeSet ${item.id} once after worker infrastructure failure.`, "warning");
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
        this.#notify(`Could not clean up finalized Task ${task.id}; reconciliation will retry: ${errorText(error)}`, "warning");
      }
    }
  }

  async #consumeResult(store: MerroStore, item: ChangeSet, task: Task, result: WorkerResult, runtime: TaskRuntimeRecord, workRuntime: ChangeSetRuntimeRecord, unsafeProjects: ReadonlySet<string>): Promise<void> {
    const flowState = task.role === "implement" ? "Implementing" : "Reviewing";
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
    store.finalizeTask({ id: task.id, outcome: review.status, summary: review.summary, resultJson: JSON.stringify(review), reviewedCommit: review.reviewed_commit });
    if (this.#obsoleteIfUnowned(store, item, unsafeProjects)) return;
    if (review.status === "reject") {
      workRuntime.reviewRound += 1;
      store.saveChangeSetRuntime(workRuntime);
      store.transitionChangeSet(item.id, "Implementing");
      const limit = this.#reviewLimit(store, item);
      if (limit !== "unlimited" && workRuntime.reviewRound >= limit) {
        this.#block(store, item, "review_cap", `Reached review cap. Blocking findings:\n${review.findings.filter((finding) => finding.severity === "blocking").map((finding) => `- ${finding.summary}`).join("\n")}`);
      }
      return;
    }

    store.transitionChangeSet(item.id, "AwaitingMerge");
    try {
      const project = store.getProject(item.projectSlug);
      if (!project || !workRuntime.clonePath || !workRuntime.branchName) throw new Error("Project branch runtime is incomplete");
      await this.#git.pushBranch(project, workRuntime.clonePath, workRuntime.branchName);
      const implementation = store.listTasks(item.id).reverse().find((candidate) => candidate.role === "implement" && candidate.resultJson);
      const parsedImplementation = implementation?.resultJson ? parseImplementResult(JSON.parse(implementation.resultJson)) : null;
      const title = parsedImplementation && "pr" in parsedImplementation ? parsedImplementation.pr?.title : undefined;
      const body = publicText(issueBody(item, parsedImplementation?.summary ?? review.summary, finalVerification(store, item, review)), this.#names);
      const pullRequest = await this.#github.createPullRequest(project, workRuntime.branchName,
        publicText(title ?? parsedImplementation?.summary.split(/\r?\n/)[0] ?? changeName(item).replace(/-/g, " "), this.#names), body);
      await this.#github.syncPullRequestContent(
        project,
        pullRequest,
        reconcilePullRequestBody(pullRequest.body, item, finalVerification(store, item, review)),
        publicText(reviewNotes(review), this.#names),
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
      store.saveChangeSetRuntime(workRuntime);
    } catch (error) {
      this.#block(store, store.getChangeSet(item.id) ?? item, "github_unavailable", `Could not publish reviewed branch: ${errorText(error)}`);
    }
  }

  async #reconcilePullRequests(store: MerroStore, unavailableProjects: ReadonlySet<string>, unsafeProjects: ReadonlySet<string>): Promise<void> {
    for (let item of store.listChangeSets()) {
      if (unavailableProjects.has(item.projectSlug)) continue;
      const recovering = item.state === "Blocked"
        && item.blockedResumeState === "AwaitingMerge"
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
                this.#notify(`Merged pull request ${pullRequest.url} has no valid merge commit SHA; reconciliation will retry.`, "warning");
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
            store.saveChangeSetRuntime(runtime);
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
          await this.#completeMergedChangeSet(store, item, runtime, project, pullRequest, unsafeProjects);
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
            this.#notify(`Pull request ${pullRequest.url} head does not match its remote branch yet; reconciliation will retry.`, "warning");
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
          this.#notify(`${changeName(item)} has a base merge conflict: ${pullRequest.url}. Approve a fresh implementation attempt to resolve it?`, "warning");
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
          this.#notify(`Pull request ${pullRequest.url} has a failed required check or a new change-request review; scheduling fresh implementation and review.`, "warning");
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
          this.#notify(`Pull request ${pullRequest.url} changed since its last reviewed diff; scheduling a fresh review.`, "warning");
          continue;
        }
        if (runtime.reviewedDiffHash === null) {
          runtime.reviewedDiffHash = currentDiffHash;
          store.saveChangeSetRuntime(runtime);
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
        store.createDecision({
          id: randomUUID(), subjectType: "ChangeSet", subjectId: item.id, kind: "merge",
          payload: {
            pullRequest: pullRequest.number,
            url: pullRequest.url,
            title: pullRequest.title,
            headRefOid: pullRequest.headRefOid,
            diffHash: currentDiffHash,
            summary: store.listTasks(item.id).filter((task) => task.role === "implement" || task.role === "review").map((task) => task.summary).filter(Boolean),
          },
        });
        const message = `${changeName(item)} is ready to merge: ${pullRequest.url}. Approve?`;
        this.#notify(message);
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
        this.#notify(`ChangeSet ${current.id} remains blocked (${current.blockedReason ?? "unknown"}) after: ${detail}`, "warning");
        return;
      }
      store.transitionChangeSet(current.id, current.blockedResumeState);
      current = store.getChangeSet(current.id) ?? current;
    }
    this.#block(store, current, "github_unavailable", detail);
  }

  #resolveMergeDecisions(store: MerroStore, changeSetId: string): void {
    for (const decision of store.pendingDecisions()) {
      if (decision.kind === "merge" && decision.subjectId === changeSetId) {
        store.resolveDecision(decision.id, "resolved");
      }
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
    if (newlyCompleted) this.#notify(`ChangeSet ${item.id} merged and Done.`);

    if (item.issues.length) {
      try {
        const issues = await this.#github.issues(project, issueNumbers(item));
        for (const issue of issues) {
          if (issue.state.toUpperCase() !== "CLOSED") this.#notify(`GitHub issue #${issue.number} remains open after merging ${pullRequest.url}; verify its Closes directive.`, "warning");
        }
      } catch (error) {
        this.#notify(`Could not verify issue closures for ${changeName(item)} after merging ${pullRequest.url}: ${errorText(error)}`, "warning");
      }
    }

    if (runtime.clonePath && this.#git.deleteClone && !unsafeProjects.has(item.projectSlug)) {
      try {
        await this.#git.deleteClone(this.#workRoot, runtime.clonePath);
      } catch (error) {
        this.#notify(`Could not clean up terminal ChangeSet clone ${runtime.clonePath}: ${errorText(error)}`, "warning");
      }
    }
  }

  #savePullRequest(store: MerroStore, runtime: ChangeSetRuntimeRecord, pr: GitHubPullRequest): void {
    runtime.pullRequestNumber = pr.number;
    runtime.pullRequestUrl = pr.url;
    runtime.pullRequestState = pr.state;
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
      this.#notify(`ChangeSet ${item.id} is obsolete because no active Objective owns it.`);
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
            this.#notify(`${changeName(item)} awaits relation analysis: unresolved references ${analysis.unresolved.join(", ")} outside approved work.`, "warning");
          }
        }
      } catch (error) {
        gated.add(item.id);
        this.#notify(`ChangeSet ${item.id} awaits relation analysis: ${errorText(error)}`, "warning");
      }
    }
    store.rebuildAutomaticRelations(analyzed, relations, [...occupiedChangeSetIds]);
    return gated;
  }

  #deriveReady(store: MerroStore, unavailableProjects: ReadonlySet<string>, relationGates: ReadonlySet<string>, unsafeProjects: ReadonlySet<string>, occupiedChangeSetIds: ReadonlySet<string>): void {
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
      const ready = !relationGates.has(item.id) && requirements.every((relation) => byId.get(relation.to)?.state === "Done");
      if (item.state === "Planned" && ready) store.transitionChangeSet(item.id, "Ready");
      else if (item.state === "Ready" && !ready) store.transitionChangeSet(item.id, "Planned");
    }
  }

  #blockCycle(store: MerroStore, cycle: readonly string[], active: ReadonlySet<string>): void {
    for (const id of new Set(cycle)) {
      const item = store.getChangeSet(id);
      if (!item || active.has(id) || item.state === "Blocked" || terminal(item)) continue;
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
    const dependents = store.listRelations()
      .filter((relation) => relation.kind === "Requires" && relation.to === item.id)
      .map((relation) => store.getChangeSet(relation.from))
      .filter((dependent): dependent is ChangeSet => dependent !== null)
      .map((dependent) => `${changeName(dependent)} (${dependent.state})`);
    const dependentsNote = dependents.length > 0 ? ` Direct dependents: ${dependents.join(", ")}.` : "";
    const recovery = reason === "project_unavailable"
      ? "Main will retry automatically and resume this change after Project reconciliation succeeds. No manual continuation is needed."
      : retryable
        ? `Retry available after fixing the cause: /merro-continue ${changeName(item)}`
        : "Fix the underlying GitHub policy/API response; Main will retry on reconciliation. /merro-continue cannot retry this deterministic blocker.";
    const message = `${changeName(item)} blocked\n\n${publicText(detail, this.#names)}.${dependentsNote}\n${recovery}`;
    this.#notify(message, "warning");
    this.#queueNotification("blocked", item.id, message);
  }

  #reviewLimit(store: MerroStore, item: ChangeSet): number | "unlimited" {
    const limits = store.listObjectives()
      .filter((objective) => objective.state === "Active"
        && store.listChangeSets(objective.id, true).some((changeSet) => changeSet.id === item.id))
      .map((objective) => objective.maxReviewRounds ?? this.#config.max_review_rounds);
    if (limits.length === 0 || limits.every((limit) => limit === "unlimited")) return "unlimited";
    return Math.min(...limits.filter((limit): limit is number => limit !== "unlimited"));
  }

  #reviewContext(json: string): string {
    try {
      const result = parseReviewResult(JSON.parse(json));
      return [result.summary, ...result.findings.map((finding) => `${finding.severity}: ${finding.summary}`), verificationText(result.verification)].join("\n");
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

  #queueBaseUpdate(store: MerroStore, item: ChangeSet, runtime: ChangeSetRuntimeRecord, pullRequest: GitHubPullRequest): void {
    if (!runtime.clonePath || !runtime.branchName || !isCommitSha(pullRequest.baseRefOid)) throw new Error("cannot schedule updated base: ChangeSet runtime or base commit is invalid");
    this.#resolveMergeDecisions(store, item.id);
    runtime.baseUpdate = { baseRefName: pullRequest.baseRefName, baseCommit: pullRequest.baseRefOid };
    runtime.reviewedDiffHash = null;
    store.saveChangeSetRuntime(runtime);
    store.transitionChangeSet(item.id, "Implementing");
    this.#notify(`Scheduling an implementer to merge and verify the updated base for ${pullRequest.url}, then a fresh review.`, "warning");
  }

  #attachIssue(store: MerroStore, objective: Objective, projectSlug: string, issue: GitHubIssue): ChangeSet {
    const existing = store.findNonTerminalChangeSet(projectSlug, [issue.number]);
    if (existing) {
      store.attachChangeSet(objective.id, existing.id);
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
            : await this.#github.issues(project, scope.numbers);
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
          this.#notify(`Objective ${objective.id} remains Active: approved scope for Project '${scope.projectSlug}' could not be refreshed: ${errorText(error)}`, "warning");
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
          this.#notify(`Objective ${objective.id} scope removal for ${item.id} could not be checked: ${errorText(error)}`, "warning");
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
      this.#notify(`Objective ${objective.id} remains Active: approved GitHub scope could not be refreshed: ${errorText(error)}`, "warning");
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
      const message = `${objective.goal} is Done.`;
      this.#notify(message);
      this.#queueNotification("objective_done", objective.id, message);
    }
  }
}
