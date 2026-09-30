import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Project, Relation } from "../src/domain/model.js";
import type { GitHubIssue, GitHubPullRequest } from "../src/github/client.js";
import { MainOrchestrator } from "../src/runtime/main.js";
import type { WorkerLaunchInput, WorkerPresence } from "../src/runtime/worker-runtime.js";
import type { TaskRuntimeRecord } from "../src/store/model.js";

interface FixtureProject {
  slug: string;
  issueNumbers: number[];
}

interface HarnessOptions {
  projects?: FixtureProject[];
  maxConcurrentTasks?: number;
  requireExternalApproval?: boolean;
  failAfterPullRequestCreate?: boolean;
  remoteBranchExists?: boolean;
  localCloneMissing?: boolean;
  inspect?: () => Promise<WorkerPresence>;
  result?: (input: WorkerLaunchInput, launchNumber: number, defaultResult: Record<string, unknown>) => Record<string, unknown> | null;
}

interface MainHarness {
  workspacePath: string;
  main: MainOrchestrator;
  projects: Map<string, Project>;
  issues: Map<string, GitHubIssue>;
  launches: WorkerLaunchInput[];
  pullRequests: Map<number, GitHubPullRequest>;
  notifications: string[];
  synchronizedHeads: string[];
  restoredClones: Array<{ projectSlug: string; branchName: string; headCommit: string }>;
  setPullRequest(number: number, update: Partial<GitHubPullRequest>): void;
}

async function createHarness(t: test.TestContext, options: HarnessOptions = {}): Promise<MainHarness> {
  const workspacePath = await mkdtemp(join(tmpdir(), "merro-main-"));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const fixtures = options.projects ?? [{ slug: "example", issueNumbers: [7] }];
  const projects = new Map<string, Project>();
  const issues = new Map<string, GitHubIssue>();
  const paths = new Map<string, string>();
  const heads = new Map<string, string>();
  const cloneProjects = new Map<string, string>();
  const synchronizedHeads: string[] = [];
  const restoredClones: Array<{ projectSlug: string; branchName: string; headCommit: string }> = [];
  for (const fixture of fixtures) {
    const path = join(workspacePath, fixture.slug);
    await mkdir(path);
    paths.set(fixture.slug, path);
    projects.set(fixture.slug, {
      slug: fixture.slug,
      path,
      baseRemote: `https://github.com/example/${fixture.slug}.git`,
      pushRemote: `https://github.com/example/${fixture.slug}.git`,
      defaultBranch: "main",
    });
    for (const number of fixture.issueNumbers) {
      issues.set(`${fixture.slug}:${number}`, {
        number,
        title: `Issue ${number} for ${fixture.slug}`,
        body: "Implement the approved issue scope.",
        url: `https://github.com/example/${fixture.slug}/issues/${number}`,
        state: "OPEN",
        labels: ["feature"],
        updatedAt: "2026-01-01T00:00:00Z",
      });
    }
  }

  const launches: WorkerLaunchInput[] = [];
  const notifications: string[] = [];
  const pullRequests = new Map<number, GitHubPullRequest>();
  let nextPullRequest = 13;
  const github = {
    async repositoryInDirectory(path: string) {
      const project = [...projects.values()].find((candidate) => candidate.path === path);
      if (!project) throw new Error(`unknown project path ${path}`);
      return {
        nameWithOwner: `example/${project.slug}`,
        url: `https://github.com/example/${project.slug}`,
        sshUrl: `git@github.com:example/${project.slug}.git`,
        defaultBranch: "main",
      };
    },
    async listOpenIssues(project: Project) {
      return [...issues.values()].filter((candidate) => candidate.url.includes(`/${project.slug}/issues/`));
    },
    async issue(project: Project, number: number) {
      const found = issues.get(`${project.slug}:${number}`);
      if (!found) throw new Error(`issue ${number} not found`);
      return found;
    },
    async createPullRequest(project: Project, branchName: string, title: string, body: string) {
      const existing = [...pullRequests.values()].find((candidate) => candidate.headRefName === branchName);
      if (existing) return existing;
      const number = nextPullRequest++;
      const clonePath = [...cloneProjects].find(([, slug]) => slug === project.slug)?.[0];
      const headRefOid = clonePath ? heads.get(clonePath) ?? "base-sha" : "implementation-sha";
      const pullRequest: GitHubPullRequest = {
        number,
        title,
        body,
        url: `https://github.com/example/repo/pull/${number}`,
        state: "OPEN",
        isDraft: false,
        mergedAt: null,
        mergeCommitSha: null,
        mergeable: "MERGEABLE",
        headRefName: branchName,
        baseRefName: "main",
        headRefOid,
        baseRefOid: "base-sha",
        reviewDecision: null,
        reviews: [],
        checks: [],
      };
      pullRequests.set(number, pullRequest);
      if (options.failAfterPullRequestCreate) throw new Error("GitHub response lost after pull request creation");
      return pullRequest;
    },
    async findPullRequest(_project: Project, branchName: string) {
      return [...pullRequests.values()].find((candidate) => candidate.headRefName === branchName) ?? null;
    },
    async pullRequest(_project: Project, number: number) {
      const pullRequest = pullRequests.get(number);
      if (!pullRequest) throw new Error(`pull request ${number} not found`);
      return pullRequest;
    },
    async branchProtection() {
      return {
        known: true as const,
        requiredStatusChecks: options.requireExternalApproval ? ["CI"] : [],
        requiredApprovingReviewCount: options.requireExternalApproval ? 1 : 0,
        requireCodeOwnerReviews: false,
      };
    },
    async mergeSquash(_project: Project, number: number, expectedHead: string) {
      const pullRequest = pullRequests.get(number);
      if (!pullRequest) throw new Error(`pull request ${number} not found`);
      if (pullRequest.headRefOid !== expectedHead) throw new Error("pull request head changed before merge");
      pullRequests.set(number, {
        ...pullRequest,
        state: "CLOSED",
        mergedAt: "2026-01-02T00:00:00Z",
        mergeCommitSha: "e".repeat(40),
      });
    },
  };

  const git = {
    async discoverProject(path: string, slug: string) {
      const project = projects.get(slug);
      if (!project) throw new Error(`unknown project ${slug}`);
      return { ...project, path };
    },
    async createWorkItemClone(project: Project, path: string, branchName: string) {
      cloneProjects.set(path, project.slug);
      heads.set(path, "base-sha");
      return { path, branchName, baseCommit: "base-sha" };
    },
    async currentCommit(path: string) {
      return heads.get(path) ?? "base-sha";
    },
    async validateTaskCommit(path: string, expected: string, reported: string) {
      assert.equal(heads.get(path) ?? "base-sha", expected);
      heads.set(path, reported);
      return reported;
    },
    async pushBranch(_project: Project, _path: string, _branchName: string) {},
    async remoteBranchCommit(_project: Project, branchName: string) {
      if (options.remoteBranchExists === false) return null;
      return [...pullRequests.values()].find((candidate) => candidate.headRefName === branchName)?.headRefOid ?? "branch-present";
    },
    async syncBranchHead(_project: Project, path: string, _branchName: string, expectedCommit: string) {
      heads.set(path, expectedCommit);
      synchronizedHeads.push(expectedCommit);
    },
    async createReadOnlyCheckout(_project: Project, path: string, commit: string) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "MERRO_COMMIT"), `${commit}\n`);
    },
    async ensureWorkItemClone(project: Project, _path: string, branchName: string, headCommit: string) {
      if (options.localCloneMissing) restoredClones.push({ projectSlug: project.slug, branchName, headCommit });
    },
  };

  const workers = {
    async prepareClone() {},
    async launch(input: WorkerLaunchInput): Promise<TaskRuntimeRecord> {
      launches.push(input);
      const taskDir = join(workspacePath, "worker-results", input.taskId);
      await mkdir(taskDir, { recursive: true });
      const resultPath = join(taskDir, "result.json");
      const commit = createHash("sha1").update(input.taskId).digest("hex");
      const result = input.role === "implement"
        ? {
          task_id: input.taskId,
          status: "success",
          summary: `Implemented ${input.workItemId}.`,
          commit,
          verification: [{ kind: "manual", project: input.project.slug, summary: "Checked the change." }],
        }
        : {
          task_id: input.taskId,
          status: "pass",
          summary: "The implementation meets the issue scope.",
          reviewed_commit: input.expectedCommit,
          findings: [],
          verification: [{ kind: "manual", project: input.project.slug, summary: "Reviewed the change." }],
        };
      const chosen = options.result ? options.result(input, launches.length, result) : result;
      if (chosen !== null) await writeFile(resultPath, JSON.stringify(chosen));
      return {
        taskId: input.taskId,
        runtimeKind: "host",
        tmuxSession: `merro-${input.project.slug}`,
        tmuxWindow: `${input.role}-${input.taskId}`,
        paneId: "%1",
        containerId: null,
        processPid: 1,
        processStartedAt: "2026-01-01T00:00:00Z",
        clonePath: input.clonePath,
        taskFilePath: join(input.clonePath, ".merro-task.md"),
        resultPath,
        expectedCommit: input.expectedCommit,
        startedAt: "2026-01-01T00:00:00Z",
      };
    },
    async inspect() {
      return options.inspect?.() ?? { alive: false, identityMatches: false, reason: "finished" };
    },
    async cleanup() {},
  };

  const main = new MainOrchestrator({
    workspacePath,
    config: { ...DEFAULT_CONFIG, sandbox: "none", max_concurrent_tasks: options.maxConcurrentTasks ?? 3, work_root: join(workspacePath, "workers") },
    notify: (message) => { notifications.push(message); },
    git,
    github,
    workers,
  });
  for (const fixture of fixtures) {
    await main.addProject(paths.get(fixture.slug) ?? "", fixture.slug);
  }
  return {
    workspacePath,
    main,
    projects,
    issues,
    launches,
    pullRequests,
    notifications,
    synchronizedHeads,
    restoredClones,
    setPullRequest(number, update) {
      const current = pullRequests.get(number);
      assert.ok(current, `unknown pull request ${number}`);
      pullRequests.set(number, { ...current, ...update });
    },
  };
}

async function startDefaultObjective(main: MainOrchestrator): Promise<string> {
  const started = await main.startObjective({
    goal: "Ship the tracer bullet",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
  });
  const workItemId = started.workItems[0]?.id;
  assert.ok(workItemId);
  return workItemId;
}

test("Main runs one issue through implement, review, PR approval, merge, and Objective completion", async (t) => {
  const { main } = await createHarness(t);
  await startDefaultObjective(main);

  await main.runPass();
  await main.runPass();
  await main.runPass();
  await main.runPass();

  const beforeApproval = await main.statusSnapshot();
  assert.equal(beforeApproval.workItems[0]?.state, "AwaitingMerge");
  assert.equal(beforeApproval.tasks.filter((task) => task.status === "finalized").length, 2);
  assert.equal(beforeApproval.decisions.length, 1);
  const decision = beforeApproval.decisions[0];
  assert.ok(decision);

  await main.resolveMergeDecision(decision.id, true);

  const completed = await main.statusSnapshot();
  assert.equal(completed.workItems[0]?.state, "Done");
  assert.equal(completed.objectives[0]?.state, "Done");
  assert.equal(completed.decisions.length, 0);
});

test("one active WorkItem can serve multiple Objectives and completion updates both", async (t) => {
  const harness = await createHarness(t);
  const first = await harness.main.startObjective({
    goal: "Ship the initial scope",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
  });
  const second = await harness.main.startObjective({
    goal: "Ship the same issue as a higher priority",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
    priority: "high",
  });
  assert.equal(first.workItems[0]?.id, second.workItems[0]?.id);
  assert.equal(second.workItems[0]?.priority, "high");
  assert.equal((await harness.main.statusSnapshot()).workItems.length, 1);

  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const decision = (await harness.main.statusSnapshot()).decisions[0];
  assert.ok(decision);
  await harness.main.resolveMergeDecision(decision.id, true);

  const completed = await harness.main.statusSnapshot();
  assert.equal(completed.workItems.length, 1);
  assert.equal(completed.objectives.length, 2);
  assert.ok(completed.objectives.every((objective) => objective.state === "Done"));
  assert.equal(harness.launches.length, 2);
});

test("new Main consumes a healthy worker result after a crash without restarting its Task", async (t) => {
  let alive = true;
  const harness = await createHarness(t, {
    inspect: async () => ({ alive, identityMatches: true, reason: null }),
    result: (_input, _launchNumber, result) => null,
  });
  const workItemId = await startDefaultObjective(harness.main);
  await harness.main.runPass();
  assert.equal(harness.launches.length, 1);

  const firstTaskId = (await harness.main.statusSnapshot()).tasks[0]?.id;
  const taskRuntimePath = join(harness.workspacePath, "worker-results", firstTaskId ?? "", "result.json");
  const commit = createHash("sha1").update(firstTaskId ?? "").digest("hex");
  await writeFile(taskRuntimePath, JSON.stringify({
    task_id: firstTaskId,
    status: "success",
    summary: "Recovered implementation result.",
    commit,
    verification: [{ kind: "manual", project: "example", summary: "Checked after Main restart." }],
  }));
  alive = false;

  const recoveredMain = new MainOrchestrator({
    workspacePath: harness.workspacePath,
    config: { ...DEFAULT_CONFIG, sandbox: "none", work_root: join(harness.workspacePath, "workers") },
    notify: () => {},
    git: {
      async discoverProject(path, slug) {
        const project = harness.projects.get(slug);
        if (!project) throw new Error(`unknown project ${slug}`);
        return { ...project, path };
      },
      async createWorkItemClone(_project, path, branchName) { return { path, branchName, baseCommit: "base-sha" }; },
      async currentCommit() { return "base-sha"; },
      async validateTaskCommit(_path, expected, reported) {
        assert.equal(expected, "base-sha");
        assert.equal(reported, commit);
        return reported;
      },
      async pushBranch() {},
    },
    github: {
      async repositoryInDirectory(path) {
        const project = [...harness.projects.values()].find((candidate) => candidate.path === path);
        assert.ok(project);
        return { nameWithOwner: `example/${project.slug}`, url: "https://github.com/example/repo", sshUrl: "git@github.com:example/repo.git", defaultBranch: "main" };
      },
      async listOpenIssues() { return [harness.issues.get("example:7")!]; },
      async issue() { return harness.issues.get("example:7")!; },
      async createPullRequest() { throw new Error("not reached"); },
      async pullRequest() { throw new Error("not reached"); },
      async branchProtection() { return { known: true, requiredStatusChecks: [], requiredApprovingReviewCount: 0, requireCodeOwnerReviews: false }; },
      async mergeSquash() {},
    },
    workers: {
      async prepareClone() {},
      async launch(input) {
        harness.launches.push(input);
        const resultPath = join(harness.workspacePath, "worker-results", input.taskId, "result.json");
        await mkdir(join(harness.workspacePath, "worker-results", input.taskId), { recursive: true });
        await writeFile(resultPath, JSON.stringify({
          task_id: input.taskId,
          status: "pass",
          summary: "Recovered change passes review.",
          reviewed_commit: commit,
          findings: [],
          verification: [{ kind: "manual", project: "example", summary: "Reviewed after restart." }],
        }));
        return {
          taskId: input.taskId,
          runtimeKind: "host",
          tmuxSession: "merro-example",
          tmuxWindow: `review-${input.taskId}`,
          paneId: "%2",
          containerId: null,
          processPid: 1,
          processStartedAt: "2026-01-01T00:00:00Z",
          clonePath: input.clonePath,
          taskFilePath: join(input.clonePath, ".merro-task.md"),
          resultPath,
          expectedCommit: input.expectedCommit,
          startedAt: "2026-01-01T00:00:00Z",
        };
      },
      async inspect() { return { alive: false, identityMatches: false, reason: "finished" }; },
      async cleanup() {},
    },
  });

  await recoveredMain.runPass();
  const state = await recoveredMain.statusSnapshot();
  assert.equal(state.tasks.find((task) => task.id === firstTaskId)?.outcome, "success");
  assert.equal(state.workItems.find((item) => item.id === workItemId)?.state, "Reviewing");
  assert.equal(harness.launches.filter((launch) => launch.role === "implement").length, 1);
  assert.equal(harness.launches.filter((launch) => launch.role === "review").length, 1);
});

test("Requires blocks a cross-Project WorkItem while independent Projects run in parallel", async (t) => {
  const { main, launches } = await createHarness(t, {
    projects: [
      { slug: "api", issueNumbers: [1] },
      { slug: "web", issueNumbers: [2] },
      { slug: "tools", issueNumbers: [3] },
    ],
    maxConcurrentTasks: 2,
  });
  const started = await main.startObjective({
    goal: "Ship the stack",
    projectSlugs: ["api", "web", "tools"],
    issues: [
      { projectSlug: "api", numbers: [1] },
      { projectSlug: "web", numbers: [2] },
      { projectSlug: "tools", numbers: [3] },
    ],
  });
  const api = started.workItems.find((item) => item.projectSlug === "api");
  const web = started.workItems.find((item) => item.projectSlug === "web");
  assert.ok(api && web);
  const relation: Relation = {
    kind: "Requires",
    from: web.id,
    to: api.id,
    confidence: "explicit",
    rationale: "The web integration needs the API contract.",
    evidence: "The issue acceptance criteria require the API endpoint.",
  };

  await main.updateRelations([relation]);
  assert.deepEqual(launches.map((launch) => launch.project.slug).sort(), ["api", "tools"]);
  assert.ok(!launches.some((launch) => launch.workItemId === web.id));
  assert.equal((await main.statusSnapshot()).tasks.filter((task) => task.status === "active").length, 2);
});

test("Requires cycles block their WorkItems without launching Tasks", async (t) => {
  const harness = await createHarness(t, {
    projects: [{ slug: "example", issueNumbers: [1, 2] }],
  });
  const started = await harness.main.startObjective({
    goal: "Ship a cyclic issue pair",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [1, 2] }],
  });
  const [first, second] = started.workItems;
  assert.ok(first && second);
  await harness.main.updateRelations([
    { kind: "Requires", from: first.id, to: second.id, confidence: "explicit", rationale: "cycle", evidence: "test" },
    { kind: "Requires", from: second.id, to: first.id, confidence: "explicit", rationale: "cycle", evidence: "test" },
  ]);

  const snapshot = await harness.main.statusSnapshot();
  assert.ok(snapshot.workItems.every((item) => item.state === "Blocked" && item.blockedReason === "cycle"));
  assert.equal(snapshot.tasks.length, 0);
  assert.equal(harness.launches.length, 0);
});

test("concurrency cap leaves unselected WorkItems Ready until a slot opens", async (t) => {
  const harness = await createHarness(t, {
    projects: [{ slug: "example", issueNumbers: [1, 2, 3] }],
    maxConcurrentTasks: 1,
  });
  await harness.main.startObjective({
    goal: "Ship three issues",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [1, 2, 3] }],
  });
  await harness.main.runPass();

  const snapshot = await harness.main.statusSnapshot();
  assert.equal(snapshot.tasks.filter((task) => task.status === "active").length, 1);
  assert.equal(snapshot.workItems.filter((item) => item.state === "Implementing").length, 1);
  assert.equal(snapshot.workItems.filter((item) => item.state === "Ready").length, 2);
});

test("task failure reports direct dependents without activating them", async (t) => {
  const harness = await createHarness(t, {
    projects: [{ slug: "example", issueNumbers: [7, 8] }],
    result(input, launchNumber, result) {
      return launchNumber === 1 ? {
        task_id: input.taskId,
        status: "failed",
        summary: "Implementation cannot proceed.",
        commit: input.expectedCommit,
        reason: "The API prerequisite is unavailable.",
        verification: [],
      } : result;
    },
  });
  const started = await harness.main.startObjective({
    goal: "Ship dependent issues",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7, 8] }],
  });
  const prerequisite = started.workItems.find((item) => item.sourceRef === "7");
  const dependent = started.workItems.find((item) => item.sourceRef === "8");
  assert.ok(prerequisite && dependent);
  await harness.main.updateRelations([{
    kind: "Requires",
    from: dependent.id,
    to: prerequisite.id,
    confidence: "explicit",
    rationale: "The dependent issue needs the prerequisite.",
    evidence: "The issue scope states this dependency.",
  }]);
  await harness.main.runPass();

  const state = await harness.main.statusSnapshot();
  assert.equal(state.workItems.find((item) => item.id === prerequisite.id)?.state, "Blocked");
  assert.equal(state.workItems.find((item) => item.id === dependent.id)?.state, "Planned");
  assert.ok(harness.notifications.some((message) => message.includes(`Direct dependents: ${dependent.id} (Planned)`)));
});

test("task failure blocks once, continue creates a fresh Task, and finalized Tasks stay unchanged", async (t) => {
  const { main } = await createHarness(t, {
    result(input, launchNumber, result) {
      if (launchNumber === 1) {
        return {
          task_id: input.taskId,
          status: "failed",
          summary: "Could not complete implementation.",
          commit: input.expectedCommit,
          reason: "A required dependency is unavailable.",
          diagnostics: "npm install failed.",
          verification: [],
        };
      }
      return result;
    },
  });
  const workItemId = await startDefaultObjective(main);
  await main.runPass();
  await main.runPass();
  const blocked = await main.statusSnapshot();
  assert.equal(blocked.workItems[0]?.state, "Blocked");
  assert.equal(blocked.workItems[0]?.blockedReason, "task_failed");
  assert.equal(blocked.tasks.length, 1);
  assert.equal(blocked.tasks[0]?.outcome, "failed");
  const originalTask = structuredClone(blocked.tasks[0]);

  await main.continueWorkItem(workItemId);
  const resumed = await main.statusSnapshot();
  assert.equal(resumed.tasks.length, 2);
  assert.deepEqual(resumed.tasks[0], originalTask);
  assert.equal(resumed.tasks[1]?.status, "active");
});

test("Main rejects stale worker results before changing WorkItem state", async (t) => {
  const { main } = await createHarness(t, {
    result(_input, _launchNumber, result) {
      return { ...result, task_id: "stale-task" };
    },
  });
  await startDefaultObjective(main);
  await main.runPass();
  await main.runPass();

  const state = await main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "Blocked");
  assert.equal(state.workItems[0]?.blockedReason, "task_failed");
  assert.equal(state.tasks[0]?.outcome, "failed");
  assert.equal(state.tasks[0]?.summary, "Task result validation failed");
  assert.equal(state.decisions.length, 0);
});

test("Main rejects review results for a different commit", async (t) => {
  const { main } = await createHarness(t, {
    result(input, _launchNumber, result) {
      return input.role === "review" ? { ...result, reviewed_commit: "stale-commit" } : result;
    },
  });
  await startDefaultObjective(main);
  await main.runPass();
  await main.runPass();
  await main.runPass();

  const state = await main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "Blocked");
  assert.equal(state.workItems[0]?.blockedReason, "task_failed");
  assert.deepEqual(state.tasks.map((task) => task.outcome), ["success", "failed"]);
  assert.equal(state.decisions.length, 0);
});

test("infrastructure failure retries once, then blocks without mutating finalized Tasks", async (t) => {
  const { main } = await createHarness(t, {
    result: () => null,
  });
  const workItemId = await startDefaultObjective(main);
  await main.runPass();
  await main.runPass();

  let state = await main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "Implementing");
  assert.equal(state.tasks.length, 2);
  assert.deepEqual(state.tasks.map((task) => task.outcome), ["failed", null]);
  const firstTask = structuredClone(state.tasks[0]);

  await main.runPass();
  state = await main.statusSnapshot();
  assert.equal(state.workItems.find((item) => item.id === workItemId)?.state, "Blocked");
  assert.equal(state.workItems[0]?.blockedReason, "task_failed");
  assert.equal(state.tasks.length, 2);
  assert.deepEqual(state.tasks[0], firstTask);
  assert.deepEqual(state.tasks.map((task) => task.outcome), ["failed", "failed"]);
});

test("review cap blocks after the configured round and continue grants a fresh round", async (t) => {
  const { main, launches } = await createHarness(t, {
    result(input, launchNumber, result) {
      if (input.role === "review" && launchNumber === 2) {
        return {
          task_id: input.taskId,
          status: "reject",
          summary: "A blocking correctness issue remains.",
          reviewed_commit: input.expectedCommit,
          findings: [{ severity: "blocking", summary: "Handle the empty response." }],
          verification: [],
        };
      }
      return result;
    },
  });
  const started = await main.startObjective({
    goal: "Ship the tracer bullet",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
    maxReviewRounds: 1,
  });
  const workItemId = started.workItems[0]?.id;
  assert.ok(workItemId);

  await main.runPass();
  await main.runPass();
  await main.runPass();
  const blocked = await main.statusSnapshot();
  assert.equal(blocked.workItems[0]?.state, "Blocked");
  assert.equal(blocked.workItems[0]?.blockedReason, "review_cap");
  assert.equal(blocked.tasks.map((task) => task.outcome).join(","), "success,reject");
  assert.equal(launches.length, 2);

  await main.continueWorkItem(workItemId);
  assert.equal(launches.length, 3);
  assert.equal(launches[2]?.role, "implement");
  assert.equal((await main.statusSnapshot()).workItems[0]?.state, "Implementing");
});

test("cross-Project Objective reconciles dependencies, rework, external checks, approvals, and merges", async (t) => {
  let apiReviewCount = 0;
  const { main, launches, pullRequests, setPullRequest } = await createHarness(t, {
    projects: [
      { slug: "api", issueNumbers: [1] },
      { slug: "web", issueNumbers: [2] },
      { slug: "tools", issueNumbers: [3] },
    ],
    maxConcurrentTasks: 2,
    requireExternalApproval: true,
    result(input, _launchNumber, result) {
      if (input.role === "review" && input.project.slug === "api" && apiReviewCount++ === 0) {
        return {
          task_id: input.taskId,
          status: "reject",
          summary: "The API response is not validated.",
          reviewed_commit: input.expectedCommit,
          findings: [{ severity: "blocking", summary: "Validate the response before returning it." }],
          verification: [],
        };
      }
      return result;
    },
  });
  const discovered = await main.discoverIssues("api");
  assert.deepEqual(discovered.map((issue) => issue.number), [1]);
  const started = await main.startObjective({
    goal: "Ship the connected Projects",
    projectSlugs: ["api", "web", "tools"],
    issues: [
      { projectSlug: "api", numbers: [1] },
      { projectSlug: "web", numbers: [2] },
      { projectSlug: "tools", numbers: [3] },
    ],
  });
  const api = started.workItems.find((item) => item.projectSlug === "api");
  const web = started.workItems.find((item) => item.projectSlug === "web");
  const tools = started.workItems.find((item) => item.projectSlug === "tools");
  assert.ok(api && web && tools);
  await main.updateRelations([{
    kind: "Requires",
    from: web.id,
    to: api.id,
    confidence: "explicit",
    rationale: "The web app requires the API contract.",
    evidence: "The selected issues describe the same feature.",
  }]);
  assert.deepEqual(launches.map((launch) => launch.project.slug).sort(), ["api", "tools"]);
  assert.ok(!launches.some((launch) => launch.project.slug === "web"));

  await main.runPass();
  await main.runPass();
  await main.runPass();
  await main.runPass();
  const beforeExternalApproval = await main.statusSnapshot();
  assert.equal(beforeExternalApproval.workItems.find((item) => item.id === api.id)?.state, "AwaitingMerge");
  assert.equal(beforeExternalApproval.workItems.find((item) => item.id === tools.id)?.state, "AwaitingMerge");
  assert.equal(beforeExternalApproval.workItems.find((item) => item.id === web.id)?.state, "Planned");
  assert.equal(beforeExternalApproval.tasks.filter((task) => task.workItemId === api.id && task.role === "implement").length, 2);
  assert.equal(beforeExternalApproval.tasks.filter((task) => task.workItemId === api.id && task.role === "review").map((task) => task.outcome).join(","), "reject,pass");
  assert.equal(beforeExternalApproval.decisions.length, 0);

  for (const [number, pullRequest] of pullRequests) {
    setPullRequest(number, {
      checks: [{ name: "CI", state: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }],
      reviews: [{ author: "maintainer", state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z", commitId: pullRequest.headRefOid }],
    });
  }
  await main.runPass();
  const approvals = (await main.statusSnapshot()).decisions;
  assert.equal(approvals.length, 2);
  const apiApproval = approvals.find((decision) => decision.subjectId === api.id);
  const toolsApproval = approvals.find((decision) => decision.subjectId === tools.id);
  assert.ok(apiApproval && toolsApproval);
  await main.resolveMergeDecision(apiApproval.id, true);
  assert.equal(launches.at(-1)?.project.slug, "web");
  await main.runPass();
  await main.runPass();
  const webReview = launches.find((launch) => launch.project.slug === "web" && launch.role === "review");
  assert.ok(webReview);
  assert.equal(webReview.dependencies?.length, 1);
  const apiCheckout = webReview.dependencies?.[0]?.checkoutPath;
  assert.ok(apiCheckout);
  assert.equal((await readFile(join(apiCheckout, "MERRO_COMMIT"), "utf8")).trim(), "e".repeat(40));
  assert.ok(webReview.taskFile.includes(`Read-only checkout: ${apiCheckout}`));

  const webPullRequest = [...pullRequests.entries()].find(([, pr]) => pr.headRefName.includes("2"));
  assert.ok(webPullRequest);
  setPullRequest(webPullRequest[0], {
    checks: [{ name: "CI", state: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }],
    reviews: [{ author: "maintainer", state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z", commitId: webPullRequest[1].headRefOid }],
  });
  await main.runPass();
  const pending = (await main.statusSnapshot()).decisions;
  const webApproval = pending.find((decision) => decision.subjectId === web.id);
  assert.ok(webApproval);
  await main.resolveMergeDecision(toolsApproval.id, true);
  await main.resolveMergeDecision(webApproval.id, true);
  const completed = await main.statusSnapshot();
  assert.ok(completed.workItems.every((item) => item.state === "Done"));
  assert.equal(completed.objectives[0]?.state, "Done");
  assert.equal(completed.tasks.filter((task) => task.status === "finalized").length, 8);
});

test("deleted local clone is restored from the reviewed remote head", async (t) => {
  const harness = await createHarness(t, { localCloneMissing: true });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();

  const state = await harness.main.statusSnapshot();
  const pullRequest = [...harness.pullRequests.values()][0];
  assert.ok(pullRequest);
  assert.deepEqual(harness.restoredClones, [{
    projectSlug: "example",
    branchName: pullRequest.headRefName,
    headCommit: pullRequest.headRefOid,
  }]);
  assert.equal(state.workItems[0]?.state, "AwaitingMerge");
  assert.equal(state.tasks.filter((task) => task.role === "review").length, 1);
  assert.equal(state.decisions.length, 1);
});

test("deleted remote branch blocks merge reconciliation without repushing", async (t) => {
  const { main, launches } = await createHarness(t, { remoteBranchExists: false });
  await startDefaultObjective(main);
  await main.runPass();
  await main.runPass();
  await main.runPass();

  const state = await main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "Blocked");
  assert.equal(state.workItems[0]?.blockedReason, "remote_branch_deleted");
  assert.equal(state.decisions.length, 0);
  assert.equal(launches.length, 2);
});

test("external PR head rewrites invalidate merge approval and trigger a fresh review", async (t) => {
  const harness = await createHarness(t);
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const beforeRewrite = await harness.main.statusSnapshot();
  const pullRequestNumber = [...harness.pullRequests.keys()][0];
  assert.ok(pullRequestNumber);
  assert.equal(beforeRewrite.decisions.length, 1);

  const rewrittenHead = createHash("sha1").update("external branch rewrite").digest("hex");
  harness.setPullRequest(pullRequestNumber, { headRefOid: rewrittenHead });
  await harness.main.runPass();

  let state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "Reviewing");
  assert.equal(state.decisions.length, 0);
  assert.equal(harness.launches.at(-1)?.role, "review");
  assert.deepEqual(harness.synchronizedHeads, [rewrittenHead]);

  await harness.main.runPass();
  state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "AwaitingMerge");
  assert.equal(state.tasks.filter((task) => task.role === "review").at(-1)?.reviewedCommit, rewrittenHead);
  assert.equal(state.decisions.length, 1);
});

test("merge approval cannot merge a PR head that changed after the Decision", async (t) => {
  const harness = await createHarness(t);
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const beforeRewrite = await harness.main.statusSnapshot();
  const decision = beforeRewrite.decisions[0];
  const pullRequestNumber = [...harness.pullRequests.keys()][0];
  assert.ok(decision && pullRequestNumber);

  const rewrittenHead = createHash("sha1").update("rewritten after approval request").digest("hex");
  harness.setPullRequest(pullRequestNumber, { headRefOid: rewrittenHead });
  await harness.main.resolveMergeDecision(decision.id, true);

  const state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "Reviewing");
  assert.equal(state.decisions.length, 0);
  assert.equal(state.tasks.filter((task) => task.role === "review").length, 2);
  assert.equal(harness.launches.at(-1)?.role, "review");
  assert.equal(harness.pullRequests.get(pullRequestNumber)?.mergedAt, null);
});

test("reconciliation adopts a PR created before Main lost the GitHub response", async (t) => {
  const { main, pullRequests } = await createHarness(t, { failAfterPullRequestCreate: true });
  await startDefaultObjective(main);
  await main.runPass();
  await main.runPass();
  await main.runPass();

  const state = await main.statusSnapshot();
  assert.equal(pullRequests.size, 1);
  assert.equal(state.workItems[0]?.state, "AwaitingMerge");
  assert.equal(state.workItems[0]?.blockedReason, null);
  assert.equal(state.decisions.length, 1);
});

test("an externally reopened pull request resumes merge reconciliation", async (t) => {
  const harness = await createHarness(t);
  const workItemId = await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();

  const beforeClose = await harness.main.statusSnapshot();
  const decision = beforeClose.decisions.find((candidate) => candidate.subjectId === workItemId);
  const [pullRequestNumber, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(decision && pullRequestNumber && pullRequest);
  harness.setPullRequest(pullRequestNumber, { state: "CLOSED" });
  await harness.main.runPass();
  const closed = await harness.main.statusSnapshot();
  assert.equal(closed.workItems.find((item) => item.id === workItemId)?.blockedReason, "pr_closed");
  assert.equal(closed.decisions.length, 0);

  harness.setPullRequest(pullRequestNumber, { state: "OPEN" });
  await harness.main.runPass();
  const reopened = await harness.main.statusSnapshot();
  assert.equal(reopened.workItems.find((item) => item.id === workItemId)?.state, "AwaitingMerge");
  assert.equal(reopened.decisions.length, 1);
  assert.notEqual(reopened.decisions[0]?.id, decision.id);
});

test("an external merge completes the WorkItem and resolves its pending merge Decision", async (t) => {
  const { main, pullRequests, setPullRequest } = await createHarness(t);
  await startDefaultObjective(main);
  await main.runPass();
  await main.runPass();
  await main.runPass();
  await main.runPass();
  const beforeMerge = await main.statusSnapshot();
  const decision = beforeMerge.decisions[0];
  const runtime = beforeMerge.workItems[0];
  assert.ok(decision && runtime);
  const pullRequestNumber = [...pullRequests.keys()][0];
  assert.ok(pullRequestNumber);

  setPullRequest(pullRequestNumber, {
    state: "CLOSED",
    mergedAt: "2026-01-03T00:00:00Z",
    mergeCommitSha: "f".repeat(40),
  });
  await main.runPass();
  const completed = await main.statusSnapshot();
  assert.equal(completed.workItems[0]?.state, "Done");
  assert.equal(completed.objectives[0]?.state, "Done");
  assert.equal(completed.decisions.length, 0);
  assert.equal(completed.tasks.filter((task) => task.status === "finalized").length, 2);
});
