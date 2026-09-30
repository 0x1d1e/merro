import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MerroConfig } from "../config.js";
import { priorityRank, type Objective, type Priority, type Project, type Relation, type Task, type TaskRole, type WorkItem } from "../domain/model.js";
import { findRequiresCycle } from "../domain/relations.js";
import { schedule } from "../domain/scheduler.js";
import { assertResultMatchesTask, parseImplementResult, parseReviewResult, type ImplementFailedResult, type ImplementSuccessResult, type ReviewFailedResult, type ReviewResult, type Verification, type WorkerResult } from "../protocol/result.js";
import { GitHubClient, type BranchPolicy, type GitHubIssue, type GitHubPullRequest } from "../github/client.js";
import { MerroStore } from "../store/store.js";
import type { TaskRuntimeRecord, WorkItemRuntimeRecord } from "../store/model.js";
import { renderTaskFile } from "./task-file.js";
import { MainLock } from "./main-lock.js";
import { systemCommandRunner, type CommandRunner } from "./commands.js";
import { WorkerRuntime } from "./worker-runtime.js";
import { GitClient } from "../vcs/git.js";

type GitAdapter = Pick<GitClient, "discoverProject" | "createWorkItemClone" | "currentCommit" | "validateTaskCommit" | "pushBranch">
  & Partial<Pick<GitClient, "remoteBranchCommit" | "syncBranchHead" | "ensureWorkItemClone" | "createReadOnlyCheckout">>;
type GitHubAdapter = Pick<GitHubClient, "repositoryInDirectory" | "listOpenIssues" | "issue" | "createPullRequest" | "pullRequest" | "branchProtection" | "mergeSquash">
  & Partial<Pick<GitHubClient, "findPullRequest">>;
type WorkerAdapter = Pick<WorkerRuntime, "prepareClone" | "launch" | "inspect" | "cleanup">
  & Partial<Pick<WorkerRuntime, "plan">>;

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
  issues: Array<{ projectSlug: string; numbers: number[] }>;
  priority?: Priority;
  maxReviewRounds?: number | "unlimited";
}

const emptyRuntime = (workItemId: string): WorkItemRuntimeRecord => ({
  workItemId, branchName: null, clonePath: null, baseCommit: null,
  pullRequestNumber: null, pullRequestUrl: null, pullRequestState: null,
  pullRequestHeadSha: null, pullRequestBaseSha: null, mergedCommitSha: null, reviewRound: 0,
  infrastructureRetries: 0, implementationAttempt: 0, lastReconciledAt: null,
});

function sourceId(projectSlug: string, number: number, generation: number): string {
  return `${projectSlug}:issue-${number}:g${generation}`;
}

function branchName(issue: GitHubIssue): string {
  const kind = issue.labels.some((label) => /bug|defect/i.test(label)) ? "fix"
    : issue.labels.some((label) => /feature|enhancement/i.test(label)) ? "feat" : "chore";
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "work";
  return `${kind}/${slug}-${issue.number}`;
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

function terminal(item: WorkItem): boolean {
  return item.state === "Done" || item.state === "Obsolete" || item.state === "Cancelled";
}

function satisfiesBranchPolicy(pullRequest: GitHubPullRequest, policy: BranchPolicy): boolean {
  if (!policy.known) return false;
  const checksReady = policy.requiredStatusChecks.every((name) => pullRequest.checks.some((check) =>
    check.name === name && ((check.state.toUpperCase() === "COMPLETED" && check.conclusion?.toUpperCase() === "SUCCESS") || check.state.toUpperCase() === "SUCCESS"),
  ));
  const approvals = pullRequest.reviews.filter((review) =>
    review.state.toUpperCase() === "APPROVED" && review.commitId === pullRequest.headRefOid,
  ).length;
  const reviewsReady = approvals >= policy.requiredApprovingReviewCount
    && (!policy.requireCodeOwnerReviews || pullRequest.reviewDecision === "APPROVED");
  return pullRequest.state === "OPEN" && !pullRequest.isDraft
    && pullRequest.mergeable === "MERGEABLE" && checksReady && reviewsReady;
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

  constructor(options: MainOptions) {
    this.#workspacePath = resolve(options.workspacePath);
    this.#stateDirectory = join(this.#workspacePath, ".merro");
    this.#workRoot = resolve(options.config.work_root ?? `${this.#workspacePath}-work`);
    this.#config = options.config;
    this.#notify = options.notify ?? ((message) => console.log(message));
    const commands = options.commands ?? systemCommandRunner;
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
    const projectPath = resolve(path);
    const gitProject = await this.#git.discoverProject(projectPath, slug);
    const repository = await this.#github.repositoryInDirectory(projectPath);
    const project: Project = { ...gitProject, defaultBranch: repository.defaultBranch };
    return this.#withStore((store) => {
      const existing = store.getProject(slug);
      if (existing) {
        if (existing.path !== project.path || existing.baseRemote !== project.baseRemote || existing.pushRemote !== project.pushRemote) {
          throw new Error(`Project '${slug}' is already registered with different repository identity`);
        }
        return existing;
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
      const issueSelections = new Map(input.issues.map((entry) => [entry.projectSlug, new Set(entry.numbers)]));
      const issueRows = new Map<string, GitHubIssue>();
      for (const project of projects) {
        const selected = issueSelections.get(project.slug) ?? new Set<number>();
        if (selected.size === 0) continue;
        const open = await this.#github.listOpenIssues(project);
        for (const number of selected) {
          const issue = open.find((candidate) => candidate.number === number);
          if (!issue) throw new Error(`issue #${number} is not open in Project '${project.slug}'`);
          issueRows.set(`${project.slug}\0${number}`, issue);
        }
      }
      if (issueRows.size === 0) throw new Error("Objective must select at least one open issue");
      for (const slug of issueSelections.keys()) {
        if (!projects.some((project) => project.slug === slug)) throw new Error(`issue selection references unlinked Project '${slug}'`);
      }

      const objective: Objective = {
        id: randomUUID(), goal: input.goal.trim(), priority: input.priority ?? "normal", state: "Active",
        projectSlugs: projects.map((project) => project.slug),
        ...(input.maxReviewRounds === undefined ? {} : { maxReviewRounds: input.maxReviewRounds }),
      };
      store.createObjective(objective);
      const items: WorkItem[] = [];
      for (const [key, issue] of issueRows) {
        const projectSlug = key.split("\0")[0] ?? "";
        const existing = store.findNonTerminalWorkItem(projectSlug, "issue", String(issue.number));
        if (existing) {
          store.attachWorkItem(objective.id, existing.id);
          if (priorityRank(objective.priority) < priorityRank(existing.priority)) store.setWorkItemPriority(existing.id, objective.priority);
          items.push(store.getWorkItem(existing.id) ?? existing);
          continue;
        }
        const generation = store.nextGeneration(projectSlug, "issue", String(issue.number));
        const item: WorkItem = {
          id: sourceId(projectSlug, issue.number, generation), projectSlug, sourceType: "issue",
          sourceRef: String(issue.number), generation, state: "Ready", priority: objective.priority,
          readySince: new Date().toISOString(), blockedReason: null, blockedResumeState: null,
        };
        store.createWorkItem(item);
        store.attachWorkItem(objective.id, item.id);
        items.push(item);
      }
      this.#notify(`Objective ${objective.id} approved with ${items.length} WorkItem(s).`);
      return { objective, workItems: items };
    });
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
    await this.#withStore(async (store) => {
      const decision = store.getDecision(decisionId);
      if (!decision || decision.state !== "pending" || decision.kind !== "merge") throw new Error(`pending merge Decision not found: ${decisionId}`);
      const item = store.getWorkItem(decision.subjectId);
      const runtime = item && store.getWorkItemRuntime(item.id);
      const project = item && store.getProject(item.projectSlug);
      if (!item || item.state !== "AwaitingMerge" || !runtime?.pullRequestNumber || !project) {
        throw new Error(`merge Decision ${decisionId} no longer matches an AwaitingMerge WorkItem`);
      }

      try {
        let pullRequest = await this.#github.pullRequest(project, runtime.pullRequestNumber);
        this.#savePullRequest(store, runtime, pullRequest);
        if (pullRequest.mergedAt) {
          store.resolveDecision(decisionId, "resolved");
          if (!isCommitSha(pullRequest.mergeCommitSha)) {
            this.#block(store, item, "github_unavailable", "Merged pull request has no valid merge commit SHA");
            return;
          }
          runtime.mergedCommitSha = pullRequest.mergeCommitSha;
          store.saveWorkItemRuntime(runtime);
          store.transitionWorkItem(item.id, "Done");
          this.#finishObjectives(store);
          return;
        }
        if (pullRequest.state !== "OPEN") {
          store.resolveDecision(decisionId, "resolved");
          this.#block(store, item, "pr_closed", "Pull request was closed without merging");
          return;
        }
        if (!approved) {
          store.resolveDecision(decisionId, "rejected");
          store.transitionWorkItem(item.id, "Blocked", "merge_rejected");
          this.#notify(`Merge rejected for WorkItem ${item.id}; PR and branch remain open.`, "warning");
          return;
        }

        const payload = typeof decision.payload === "object" && decision.payload !== null
          ? decision.payload as Record<string, unknown>
          : {};
        const expectedHead = typeof payload.headRefOid === "string" ? payload.headRefOid : null;
        const latestReview = store.listTasks(item.id).reverse()
          .find((task) => task.role === "review" && task.outcome === "pass");
        const policy = await this.#github.branchProtection(project);
        const remoteHead = runtime.branchName && this.#git.remoteBranchCommit
          ? await this.#git.remoteBranchCommit(project, runtime.branchName)
          : pullRequest.headRefOid;

        if (!remoteHead) {
          store.resolveDecision(decisionId, "resolved");
          this.#block(store, item, "remote_branch_deleted", `Remote branch ${runtime.branchName ?? "(unknown)"} was deleted`);
          return;
        }
        if (!expectedHead || pullRequest.headRefOid !== expectedHead || remoteHead !== pullRequest.headRefOid
          || !latestReview || latestReview.reviewedCommit !== pullRequest.headRefOid
          || !satisfiesBranchPolicy(pullRequest, policy)) {
          store.resolveDecision(decisionId, "resolved");
          this.#notify(`Merge approval for WorkItem ${item.id} expired because the pull request changed or is no longer merge-ready.`, "warning");
          return;
        }

        await this.#github.mergeSquash(project, runtime.pullRequestNumber, expectedHead);
        pullRequest = await this.#github.pullRequest(project, runtime.pullRequestNumber);
        if (!pullRequest.mergedAt) throw new Error("GitHub did not report the pull request as merged");
        if (!isCommitSha(pullRequest.mergeCommitSha)) throw new Error("GitHub did not report a valid merged commit SHA");
        runtime.mergedCommitSha = pullRequest.mergeCommitSha;
        store.saveWorkItemRuntime(runtime);
        store.resolveDecision(decisionId, "approved");
        store.transitionWorkItem(item.id, "Done");
        runtime.pullRequestState = "MERGED";
        store.saveWorkItemRuntime(runtime);
        this.#notify(`WorkItem ${item.id} merged and Done.`);
      } catch (error) {
        store.resolveDecision(decisionId, "resolved");
        this.#block(store, item, "github_unavailable", `Merge reconciliation failed: ${errorText(error)}`);
      }
      this.#finishObjectives(store);
    });
    await this.runPass();
  }

  async runPass(): Promise<void> {
    await this.#withStore(async (store) => {
      await this.#reconcileTasks(store);
      await this.#reconcilePullRequests(store);
      this.#deriveReady(store);
      const tasks = store.listTasks();
      const active = tasks.filter((task) => task.status === "active");
      const items = store.listWorkItems();
      const result = schedule({
        workItems: items,
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
      this.#finishObjectives(store);
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
      if (!runtime.clonePath || !runtime.branchName) {
        const issue = await this.#github.issue(project, Number(item.sourceRef));
        const branch = branchName(issue);
        const clonePath = join(this.#workRoot, project.slug, item.id);
        const clone = await this.#git.createWorkItemClone(project, clonePath, branch);
        runtime = { ...runtime, branchName: clone.branchName, clonePath: clone.path, baseCommit: clone.baseCommit };
        store.saveWorkItemRuntime(runtime);
        await this.#workers.prepareClone(project, clone.path, store.getProjectSettings(project.slug));
      }
      const clonePath = runtime.clonePath;
      if (!clonePath) throw new Error("WorkItem clone path is unavailable");
      expectedCommit = await this.#git.currentCommit(clonePath);
      const objective = store.listObjectives().find((candidate) => store.listWorkItems(candidate.id).some((workItem) => workItem.id === item.id));
      if (!objective) throw new Error(`WorkItem ${item.id} is not attached to an Objective`);
      const issue = await this.#github.issue(project, Number(item.sourceRef));
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
        title: issue.title, scope: issue.body,
        objective: { id: objective.id, goal: objective.goal },
        userGuidance: item.guidance ?? "",
        projectGuidance: projectSettings?.guidance ?? "",
        repositoryInstructions: instructions,
        dependencies: dependencyContext, latestReview, expectedCommit,
      });
      const previousTasks = store.listTasks(item.id).filter((task) => task.role === role);
      const attempt = previousTasks.reduce((highest, task) => Math.max(highest, task.attempt), 0) + 1;
      const launchInput = {
        taskId, workItemId: item.id, role, project, clonePath,
        taskFile, expectedCommit, projectSettings, dependencies: dependencyMounts.map(({ mount }) => mount),
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
        expectedCommit,
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
      store.saveTaskRuntime(record);
    } catch (error) {
      if (!workerLaunchStarted && runtimeIntent) await this.#workers.cleanup(runtimeIntent).catch(() => {});
      const task = store.getTask(taskId);
      if (task?.status === "active") store.finalizeTask({
        id: taskId, outcome: "failed", summary: "Worker launch failed", resultJson: JSON.stringify({ error: errorText(error) }),
      });
      const current = store.getWorkItem(item.id);
      if (current && current.state !== "Blocked") this.#block(store, current, "task_failed", `Could not start ${role} Task: ${errorText(error)}`);
    }
  }

  async #reconcileTasks(store: MerroStore): Promise<void> {
    for (const task of store.listTasks().filter((candidate) => candidate.status === "active")) {
      const item = store.getWorkItem(task.workItemId);
      const runtime = store.getTaskRuntime(task.id);
      const workRuntime = item && store.getWorkItemRuntime(item.id);
      if (!item || !runtime || !workRuntime) continue;
      let text: string;
      try {
        text = await readFile(runtime.resultPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.#block(store, item, "task_failed", `Cannot read Task result: ${errorText(error)}`);
          store.finalizeTask({ id: task.id, outcome: "failed", summary: "Invalid result file", resultJson: JSON.stringify({ error: errorText(error) }) });
          continue;
        }
        const presence = await this.#workers.inspect(runtime, task.id);
        if (presence.alive && presence.identityMatches) continue;
        const reason = presence.reason ?? "worker exited without a result";
        store.finalizeTask({ id: task.id, outcome: "failed", summary: reason, resultJson: JSON.stringify({ taskId: task.id, reason }) });
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
            await this.#git.validateTaskCommit(runtime.clonePath, runtime.expectedCommit, implementResult.commit);
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
        this.#block(store, item, "task_failed", `Task result validation failed: ${errorText(error)}`);
        store.finalizeTask({ id: task.id, outcome: "failed", summary: "Task result validation failed", resultJson: text });
        continue;
      }
      await this.#consumeResult(store, item, task, result, runtime, workRuntime);
      await this.#workers.cleanup(runtime);
      workRuntime.infrastructureRetries = 0;
      store.saveWorkItemRuntime(workRuntime);
    }
  }

  async #consumeResult(store: MerroStore, item: WorkItem, task: Task, result: WorkerResult, runtime: TaskRuntimeRecord, workRuntime: WorkItemRuntimeRecord): Promise<void> {
    if (task.role === "implement") {
      const implementResult = result as ImplementSuccessResult | ImplementFailedResult;
      if (implementResult.status === "failed") {
        store.finalizeTask({ id: task.id, outcome: "failed", summary: implementResult.summary, resultJson: JSON.stringify(implementResult) });
        this.#block(store, item, "task_failed", `${implementResult.reason}${implementResult.diagnostics ? `: ${implementResult.diagnostics}` : ""}`);
        return;
      }
      const typed = implementResult;
      store.finalizeTask({ id: task.id, outcome: "success", summary: typed.summary, resultJson: JSON.stringify(typed), commitSha: typed.commit });
      store.transitionWorkItem(item.id, "Reviewing");
      return;
    }

    const reviewResult = result as ReviewResult | ReviewFailedResult;
    if (reviewResult.status === "failed") {
      store.finalizeTask({ id: task.id, outcome: "failed", summary: reviewResult.summary, resultJson: JSON.stringify(reviewResult), reviewedCommit: reviewResult.reviewed_commit });
      this.#block(store, item, "task_failed", `${reviewResult.reason}`);
      return;
    }
    const review = reviewResult;
    store.finalizeTask({ id: task.id, outcome: review.status, summary: review.summary, resultJson: JSON.stringify(review), reviewedCommit: review.reviewed_commit });
    if (review.status === "reject") {
      workRuntime.reviewRound += 1;
      store.saveWorkItemRuntime(workRuntime);
      store.transitionWorkItem(item.id, "Implementing");
      const limit = this.#reviewLimit(store, item);
      if (limit !== "unlimited" && workRuntime.reviewRound >= limit) {
        store.transitionWorkItem(item.id, "Blocked", "review_cap");
        this.#notify(`WorkItem ${item.id} reached its review cap. Blocking findings:\n${review.findings.filter((finding) => finding.severity === "blocking").map((finding) => `- ${finding.summary}`).join("\n")}`, "warning");
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
      const body = issueBody(item, review.summary, verificationText(review.verification));
      const pullRequest = await this.#github.createPullRequest(project, workRuntime.branchName, title ?? `Work ${item.sourceRef}: ${parsedImplementation?.summary ?? review.summary}`, body);
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

  async #reconcilePullRequests(store: MerroStore): Promise<void> {
    for (let item of store.listWorkItems()) {
      const recovering = item.state === "Blocked"
        && item.blockedResumeState === "AwaitingMerge"
        && (item.blockedReason === "github_unavailable" || item.blockedReason === "pr_closed");
      if (item.state !== "AwaitingMerge" && !recovering) continue;
      const runtime = store.getWorkItemRuntime(item.id);
      const project = store.getProject(item.projectSlug);
      if (!runtime || !project) continue;
      try {
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
          runtime.mergedCommitSha = pullRequest.mergeCommitSha;
          store.saveWorkItemRuntime(runtime);
          if (recovering) store.transitionWorkItem(item.id, item.blockedResumeState!);
          this.#resolveMergeDecisions(store, item.id);
          store.transitionWorkItem(item.id, "Done");
          continue;
        }
        if (pullRequest.state === "CLOSED") {
          if (item.state === "Blocked" && item.blockedReason === "pr_closed") continue;
          if (recovering) {
            store.transitionWorkItem(item.id, item.blockedResumeState!);
            item = store.getWorkItem(item.id) ?? item;
          }
          this.#resolveMergeDecisions(store, item.id);
          this.#block(store, item, "pr_closed", "Pull request was closed without merging");
          continue;
        }
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
        const policy = await this.#github.branchProtection(project);
        if (!policy.known) {
          if (recovering) {
            store.transitionWorkItem(item.id, item.blockedResumeState!);
            item = store.getWorkItem(item.id) ?? item;
          }
          this.#block(store, item, "policy_unknown", policy.reason);
          continue;
        }
        const latestReview = store.listTasks(item.id).reverse()
          .find((task) => task.role === "review" && task.outcome === "pass");
        if (!latestReview || latestReview.reviewedCommit !== pullRequest.headRefOid) {
          this.#resolveMergeDecisions(store, item.id);
          if (!runtime.clonePath || !runtime.branchName || !this.#git.syncBranchHead) {
            throw new Error("cannot re-review pull request head: WorkItem branch runtime is incomplete");
          }
          await this.#git.syncBranchHead(project, runtime.clonePath, runtime.branchName, pullRequest.headRefOid);
          if (recovering) store.transitionWorkItem(item.id, item.blockedResumeState!);
          store.transitionWorkItem(item.id, "Reviewing");
          this.#notify(`Pull request ${pullRequest.url} changed since its last review; scheduling a fresh review.`, "warning");
          continue;
        }
        if (recovering) store.transitionWorkItem(item.id, item.blockedResumeState!);
        if (!satisfiesBranchPolicy(pullRequest, policy)) {
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
          payload: { pullRequest: pullRequest.number, url: pullRequest.url, title: pullRequest.title, headRefOid: pullRequest.headRefOid, summary: store.listTasks(item.id).filter((task) => task.role === "implement" || task.role === "review").map((task) => task.summary).filter(Boolean) },
        });
        this.#notify(`Merge approval required for ${pullRequest.url} (Decision ${decision.id}).`);
      } catch (error) {
        if (!recovering) this.#block(store, item, "github_unavailable", `GitHub reconciliation failed: ${errorText(error)}`);
      }
    }
  }

  #resolveMergeDecisions(store: MerroStore, workItemId: string): void {
    for (const decision of store.pendingDecisions()) {
      if (decision.kind === "merge" && decision.subjectId === workItemId) {
        store.resolveDecision(decision.id, "resolved");
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

  #deriveReady(store: MerroStore): void {
    const items = store.listWorkItems();
    const byId = new Map(items.map((item) => [item.id, item]));
    const relations = store.listRelations();
    const active = new Set(store.listTasks().filter((task) => task.status === "active").map((task) => task.workItemId));
    const cycle = findRequiresCycle(relations);
    if (cycle) this.#blockCycle(store, cycle, active);
    for (const item of store.listWorkItems()) {
      if ((item.state !== "Planned" && item.state !== "Ready") || active.has(item.id)) continue;
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
    if (item.state !== "Blocked") store.transitionWorkItem(item.id, "Blocked", reason);
    store.appendEvent("WorkItem", item.id, "blocked", { reason, detail });
    const dependents = store.listRelations()
      .filter((relation) => relation.kind === "Requires" && relation.to === item.id)
      .map((relation) => store.getWorkItem(relation.from))
      .filter((dependent): dependent is WorkItem => dependent !== null)
      .map((dependent) => `${dependent.id} (${dependent.state})`);
    const dependentsNote = dependents.length > 0 ? ` Direct dependents: ${dependents.join(", ")}.` : "";
    this.#notify(`WorkItem ${item.id} blocked (${reason}): ${detail}.${dependentsNote}`, "warning");
  }

  #reviewLimit(store: MerroStore, item: WorkItem): number | "unlimited" {
    const objective = store.listObjectives().find((candidate) => store.listWorkItems(candidate.id).some((workItem) => workItem.id === item.id));
    return objective?.maxReviewRounds ?? this.#config.max_review_rounds;
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

  #finishObjectives(store: MerroStore): void {
    for (const objective of store.listObjectives()) {
      if (objective.state !== "Active") continue;
      const items = store.listWorkItems(objective.id);
      if (items.length > 0 && items.every(terminal)) {
        store.setObjectiveState(objective.id, "Done");
        this.#notify(`Objective ${objective.id} is Done.`);
      }
    }
  }
}
