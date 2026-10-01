import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import { MerroStore } from "../src/store/store.js";
import type { Project, Relation } from "../src/domain/model.js";
import { GitHubMergeError, type GitHubIssue, type GitHubPullRequest } from "../src/github/client.js";
import { MainOrchestrator } from "../src/runtime/main.js";
import { registerCommands, type PiExtensionLike } from "../src/tools/commands.js";
import { registerMainTools, type MainToolAPI } from "../src/tools/main.js";
import { GitBaseMergeConflictError } from "../src/vcs/git.js";
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
  dismissStaleApprovals?: boolean;
  reviewerWritePermission?: (username: string) => boolean;
  branchPolicyAvailable?: boolean;
  failAfterPullRequestCreate?: boolean;
  remoteBranchExists?: boolean;
  baseMergeConflict?: boolean;
  mergeError?: Error;
  localCloneMissing?: boolean;
  effectiveDiffFingerprint?: (headCommit: string) => string;
  inspect?: () => Promise<WorkerPresence>;
  stop?: () => Promise<void>;
  issueFailure?: (projectSlug: string, number: number) => boolean;
  pullRequestFailure?: (number: number) => boolean;
  pullRequestContentFailure?: () => boolean;
  deleteCloneFailure?: boolean;
  result?: (input: WorkerLaunchInput, launchNumber: number, defaultResult: Record<string, unknown>) => Record<string, unknown> | null;
}

interface MainHarness {
  workspacePath: string;
  main: MainOrchestrator;
  projects: Map<string, Project>;
  issues: Map<string, GitHubIssue>;
  launches: WorkerLaunchInput[];
  pullRequests: Map<number, GitHubPullRequest>;
  reviewComments: Map<number, string>;
  notifications: string[];
  synchronizedHeads: string[];
  baseMerges: Array<{ path: string; defaultBranch: string }>;
  restoredClones: Array<{ projectSlug: string; branchName: string; headCommit: string }>;
  cloneBaseBranches: string[];
  deletedClones: string[];
  branchPolicyBranches: string[];
  setProjectState(projectSlug: string, update: Partial<Project>): void;
  setPullRequest(number: number, update: Partial<GitHubPullRequest>): void;
  setIssueState(projectSlug: string, number: number, state: string): void;
  setBaseMergeConflict(conflicts: boolean): void;
  setBranchPolicyAvailable(available: boolean): void;
  setRemoteBranchExists(exists: boolean): void;
}

async function createHarness(t: test.TestContext, options: HarnessOptions = {}): Promise<MainHarness> {
  const workspacePath = await mkdtemp(join(tmpdir(), "merro-main-"));
  t.after(() => rm(workspacePath, { recursive: true, force: true }));
  const fixtures = options.projects ?? [{ slug: "example", issueNumbers: [7] }];
  const projects = new Map<string, Project>();
  const issues = new Map<string, GitHubIssue>();
  const paths = new Map<string, string>();
  const heads = new Map<string, string>();
  const cloneBranches = new Map<string, { projectSlug: string; branchName: string }>();
  const synchronizedHeads: string[] = [];
  const restoredClones: Array<{ projectSlug: string; branchName: string; headCommit: string }> = [];
  const cloneBaseBranches: string[] = [];
  const deletedClones: string[] = [];
  const branchPolicyBranches: string[] = [];
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
  let branchPolicyAvailable = options.branchPolicyAvailable ?? true;
  let remoteBranchExists = options.remoteBranchExists ?? true;
  let baseMergeConflict = options.baseMergeConflict ?? false;
  const reviewComments = new Map<number, string>();
  const baseMerges: Array<{ path: string; defaultBranch: string }> = [];
  let nextPullRequest = 13;
  const github = {
    async repositoryInDirectory(path: string) {
      const project = [...projects.values()].find((candidate) => candidate.path === path);
      if (!project) throw new Error(`unknown project path ${path}`);
      return {
        nameWithOwner: `example/${project.slug}`,
        url: `https://github.com/example/${project.slug}`,
        sshUrl: `git@github.com:example/${project.slug}.git`,
        defaultBranch: project.defaultBranch,
      };
    },
    async repository(reference: string) {
      const slug = reference.match(/(?:\/|:)([^/:]+?)(?:\.git)?$/)?.[1] ?? "example";
      const project = projects.get(slug) ?? [...projects.values()].find((candidate) => reference === candidate.baseRemote || reference === candidate.pushRemote);
      const projectSlug = project?.slug ?? slug;
      const defaultBranch = project?.defaultBranch ?? "main";
      return {
        nameWithOwner: `example/${projectSlug}`,
        url: `https://github.com/example/${projectSlug}`,
        sshUrl: `git@github.com:example/${projectSlug}.git`,
        defaultBranch,
      };
    },
    async listOpenIssues(project: Project) {
      return [...issues.values()].filter((candidate) => candidate.url.includes(`/${project.slug}/issues/`));
    },
    async issue(project: Project, number: number) {
      if (options.issueFailure?.(project.slug, number)) throw new Error(`GitHub issue ${number} unavailable`);
      const found = issues.get(`${project.slug}:${number}`);
      if (!found) throw new Error(`issue ${number} not found`);
      return found;
    },
    async createPullRequest(project: Project, branchName: string, title: string, body: string) {
      const existing = [...pullRequests.values()].find((candidate) => candidate.headRefName === branchName);
      if (existing) return existing;
      const number = nextPullRequest++;
      const clonePath = [...cloneBranches].find(([, identity]) =>
        identity.projectSlug === project.slug && identity.branchName === branchName,
      )?.[0];
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
        baseRefName: project.defaultBranch,
        headRefOid,
        baseRefOid: "base-sha",
        authorLogin: "issue-author",
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
      if (options.pullRequestFailure?.(number)) throw new Error(`GitHub pull request ${number} unavailable`);
      const pullRequest = pullRequests.get(number);
      if (!pullRequest) throw new Error(`pull request ${number} not found`);
      return pullRequest;
    },
    async syncPullRequestContent(_project: Project, pullRequest: GitHubPullRequest, body: string, notes: string) {
      if (options.pullRequestContentFailure?.()) throw new Error("GitHub PR content update unavailable");
      pullRequests.set(pullRequest.number, { ...pullRequest, body });
      reviewComments.set(pullRequest.number, notes);
    },
    async hasWritePermission(_project: Project, username: string) {
      return options.reviewerWritePermission?.(username) ?? username.toLowerCase() === "maintainer";
    },
    async branchProtection(_project: Project, branchName?: string) {
      branchPolicyBranches.push(branchName ?? _project.defaultBranch);
      if (!branchPolicyAvailable) return { known: false as const, reason: "policy visibility unavailable" };
      return {
        known: true as const,
        requiredStatusChecks: options.requireExternalApproval ? ["CI"] : [],
        requiredApprovingReviewCount: options.requireExternalApproval ? 1 : 0,
        requireCodeOwnerReviews: false,
        dismissStaleApprovals: options.dismissStaleApprovals ?? false,
      };
    },
    async mergeSquash(_project: Project, number: number, expectedHead: string) {
      if (options.mergeError) throw options.mergeError;
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
      cloneBaseBranches.push(project.defaultBranch);
      cloneBranches.set(path, { projectSlug: project.slug, branchName });
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
    async pushBranch(_project: Project, path: string, branchName: string) {
      const existing = [...pullRequests.values()].find((candidate) => candidate.headRefName === branchName);
      if (existing) {
        pullRequests.set(existing.number, {
          ...existing,
          headRefOid: heads.get(path) ?? existing.headRefOid,
          checks: [],
        });
      }
    },
    async remoteBranchCommit(_project: Project, branchName: string) {
      if (!remoteBranchExists) return null;
      return [...pullRequests.values()].find((candidate) => candidate.headRefName === branchName)?.headRefOid ?? "branch-present";
    },
    async syncBranchHead(_project: Project, path: string, _branchName: string, expectedCommit: string) {
      heads.set(path, expectedCommit);
      synchronizedHeads.push(expectedCommit);
    },
    async fetchAndMergeBase(path: string, defaultBranch: string) {
      baseMerges.push({ path, defaultBranch });
      if (baseMergeConflict) {
        throw new GitBaseMergeConflictError("d".repeat(40), ["src/conflict.ts"]);
      }
      const headCommit = "f".repeat(40);
      heads.set(path, headCommit);
      return { baseCommit: "d".repeat(40), headCommit, merged: true };
    },
    async createReadOnlyCheckout(_project: Project, path: string, commit: string) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "MERRO_COMMIT"), `${commit}\n`);
    },
    async ensureWorkItemClone(project: Project, _path: string, branchName: string, headCommit: string) {
      if (options.localCloneMissing) restoredClones.push({ projectSlug: project.slug, branchName, headCommit });
    },
    async effectiveDiffFingerprint(_project: Project, _path: string, _baseRefName: string, _baseCommit: string, headCommit: string) {
      return options.effectiveDiffFingerprint?.(headCommit) ?? headCommit;
    },
    async deleteClone(_workRoot: string, path: string) {
      if (options.deleteCloneFailure) throw new Error("clone cleanup failed");
      deletedClones.push(path);
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
    async stop() {
      await options.stop?.();
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
    reviewComments,
    notifications,
    synchronizedHeads,
    restoredClones,
    cloneBaseBranches,
    deletedClones,
    branchPolicyBranches,
    setProjectState(projectSlug, update) {
      const current = projects.get(projectSlug);
      assert.ok(current, `unknown Project ${projectSlug}`);
      projects.set(projectSlug, { ...current, ...update });
    },
    setPullRequest(number, update) {
      const current = pullRequests.get(number);
      assert.ok(current, `unknown pull request ${number}`);
      pullRequests.set(number, { ...current, ...update });
    },
    setIssueState(projectSlug, number, state) {
      const key = `${projectSlug}:${number}`;
      const current = issues.get(key);
      assert.ok(current, `unknown issue ${key}`);
      issues.set(key, { ...current, state });
    },
    setBaseMergeConflict(conflicts) {
      baseMergeConflict = conflicts;
    },
    baseMerges,
    setBranchPolicyAvailable(available) {
      branchPolicyAvailable = available;
    },
    setRemoteBranchExists(exists) {
      remoteBranchExists = exists;
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
  const harness = await createHarness(t);
  const { main } = harness;
  const workItemId = await startDefaultObjective(main);

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
  assert.equal(harness.deletedClones.length, 1);
  assert.ok(harness.notifications.some((message) => message.includes("issue #7 remains open")));

  const store = new MerroStore(join(harness.workspacePath, ".merro", "state.db"));
  try {
    const finalSummary = store.getFinalSummary(workItemId);
    assert.ok(finalSummary);
    const payload = finalSummary.payload as {
      diff: { effectiveFingerprint: string | null };
      pullRequest: { number: number; mergeCommitSha: string };
      implementerSummaries: Array<{ summary: string }>;
      reviewerOutcomes: Array<{ outcome: string }>;
    };
    assert.equal(payload.pullRequest.number, [...harness.pullRequests.keys()][0]);
    assert.match(payload.pullRequest.mergeCommitSha, /^[0-9a-f]{40}$/);
    assert.ok(payload.diff.effectiveFingerprint);
    assert.equal(payload.implementerSummaries.length, 1);
    assert.equal(payload.reviewerOutcomes.at(-1)?.outcome, "pass");
  } finally {
    store.close();
  }
});

test("merge finalization remains complete when terminal clone cleanup fails", async (t) => {
  const harness = await createHarness(t, { deleteCloneFailure: true });
  const workItemId = await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const decision = (await harness.main.statusSnapshot()).decisions[0];
  assert.ok(decision);

  await harness.main.resolveMergeDecision(decision.id, true);

  const completed = await harness.main.statusSnapshot();
  assert.equal(completed.workItems.find((item) => item.id === workItemId)?.state, "Done");
  assert.ok(harness.notifications.some((message) => message.includes("Could not clean up terminal WorkItem clone")));
  const store = new MerroStore(join(harness.workspacePath, ".merro", "state.db"));
  try {
    assert.ok(store.getFinalSummary(workItemId));
  } finally {
    store.close();
  }
});

test("runPass reconciles Project remotes and default branch before creating future work", async (t) => {
  const harness = await createHarness(t);
  const project = harness.projects.get("example");
  assert.ok(project);
  harness.setProjectState("example", {
    baseRemote: "git@github.com:example/example.git",
    pushRemote: "git@github.com:example/example.git",
    defaultBranch: "trunk",
  });

  await harness.main.runPass();
  const reconciled = (await harness.main.statusSnapshot()).projects[0];
  assert.equal(reconciled?.baseRemote, "git@github.com:example/example.git");
  assert.equal(reconciled?.pushRemote, "git@github.com:example/example.git");
  assert.equal(reconciled?.defaultBranch, "trunk");

  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  assert.deepEqual(harness.cloneBaseBranches, ["trunk"]);
  assert.equal([...harness.pullRequests.values()][0]?.baseRefName, "trunk");
  assert.ok(harness.branchPolicyBranches.includes("trunk"));
});

test("branch policy is evaluated against the pull request base branch", async (t) => {
  const harness = await createHarness(t);
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const pullRequest = [...harness.pullRequests.values()][0];
  assert.ok(pullRequest);
  harness.setPullRequest(pullRequest.number, { baseRefName: "release" });

  await harness.main.runPass();

  assert.equal(harness.branchPolicyBranches.at(-1), "release");
});

test("required approvals count only write-eligible reviewers and allow stale approvals when configured", async (t) => {
  const harness = await createHarness(t, { requireExternalApproval: true });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();

  const [number, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && pullRequest);
  harness.setPullRequest(number, {
    reviewDecision: "APPROVED",
    reviews: [{
      id: "ineligible-approval",
      author: "reviewer-without-required-permission",
      state: "APPROVED",
      submittedAt: "2026-01-01T00:00:00Z",
      commitId: pullRequest.headRefOid,
    }],
    checks: [{ name: "CI", state: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }],
  });

  await harness.main.runPass();
  assert.equal((await harness.main.statusSnapshot()).decisions.length, 0);

  harness.setPullRequest(number, {
    reviewDecision: "APPROVED",
    reviews: [{
      id: "eligible-stale-approval",
      author: "maintainer",
      state: "APPROVED",
      submittedAt: "2026-01-01T00:00:00Z",
      commitId: "a".repeat(40),
    }],
  });
  await harness.main.runPass();

  const state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "AwaitingMerge");
  assert.equal(state.decisions.length, 1);
});

test("dismiss-stale branch policy requires a current-head approval", async (t) => {
  const harness = await createHarness(t, { requireExternalApproval: true, dismissStaleApprovals: true });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && pullRequest);
  harness.setPullRequest(number, {
    reviewDecision: "APPROVED",
    reviews: [{
      id: "stale-approval",
      author: "maintainer",
      state: "APPROVED",
      submittedAt: "2026-01-01T00:00:00Z",
      commitId: "a".repeat(40),
    }],
    checks: [{ name: "CI", state: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }],
  });
  await harness.main.runPass();
  assert.equal((await harness.main.statusSnapshot()).decisions.length, 0);

  harness.setPullRequest(number, {
    reviews: [{
      id: "current-approval",
      author: "maintainer",
      state: "APPROVED",
      submittedAt: "2026-01-02T00:00:00Z",
      commitId: pullRequest.headRefOid,
    }],
  });
  await harness.main.runPass();
  assert.equal((await harness.main.statusSnapshot()).decisions.length, 1);
});

test("SKIPPED and NEUTRAL satisfy required status checks", async (t) => {
  for (const conclusion of ["SKIPPED", "NEUTRAL"]) {
    const harness = await createHarness(t, { requireExternalApproval: true });
    await startDefaultObjective(harness.main);
    await harness.main.runPass();
    await harness.main.runPass();
    await harness.main.runPass();
    const [number, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
    assert.ok(number && pullRequest);
    harness.setPullRequest(number, {
      reviewDecision: "APPROVED",
      reviews: [{
        id: `approval-${conclusion}`,
        author: "maintainer",
        state: "APPROVED",
        submittedAt: "2026-01-02T00:00:00Z",
        commitId: pullRequest.headRefOid,
      }],
      checks: [{ name: "CI", state: "COMPLETED", conclusion, detailsUrl: null }],
    });
    await harness.main.runPass();
    assert.equal((await harness.main.statusSnapshot()).decisions.length, 1, `${conclusion} should satisfy CI`);
  }
});

test("reopened issue generations use distinct branches and pull requests", async (t) => {
  const harness = await createHarness(t);
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const firstDecision = (await harness.main.statusSnapshot()).decisions[0];
  const firstPullRequest = [...harness.pullRequests.values()][0];
  assert.ok(firstDecision && firstPullRequest);
  await harness.main.resolveMergeDecision(firstDecision.id, true);

  const second = await harness.main.startObjective({
    goal: "Reopened issue generation",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
  });
  assert.equal(second.workItems[0]?.generation, 2);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();

  const generationPullRequests = [...harness.pullRequests.values()];
  assert.equal(generationPullRequests.length, 2);
  const nextPullRequest = generationPullRequests.find((pr) => pr.number !== firstPullRequest.number);
  assert.ok(nextPullRequest);
  assert.notEqual(nextPullRequest.headRefName, firstPullRequest.headRefName);
  assert.equal(harness.pullRequests.get(firstPullRequest.number)?.state, "CLOSED");
  assert.equal(nextPullRequest.state, "OPEN");
  assert.equal(nextPullRequest.mergedAt, null);
  assert.equal((await harness.main.statusSnapshot()).workItems.find((item) => item.generation === 2)?.state, "AwaitingMerge");
});

const reworkScenarios: Array<{ name: string; update: Partial<GitHubPullRequest> }> = [
  { name: "failed required CI", update: { checks: [{ name: "CI", state: "COMPLETED", conclusion: "FAILURE", detailsUrl: null }] } },
];

for (const scenario of reworkScenarios) {
  test(`${scenario.name} starts a fresh implementation and review cycle`, async (t) => {
    const harness = await createHarness(t, { requireExternalApproval: true });
    await startDefaultObjective(harness.main);
    await harness.main.runPass();
    await harness.main.runPass();
    await harness.main.runPass();
    const [number, original] = [...harness.pullRequests.entries()][0] ?? [];
    assert.ok(number && original);
    harness.setPullRequest(number, scenario.update);

    await harness.main.runPass();
    assert.deepEqual(harness.launches.map((launch) => launch.role), ["implement", "review", "implement"]);
    assert.equal((await harness.main.statusSnapshot()).workItems[0]?.state, "Implementing");
    assert.equal((await harness.main.statusSnapshot()).decisions.length, 0);

    await harness.main.runPass();
    await harness.main.runPass();
    const afterRework = await harness.main.statusSnapshot();
    assert.deepEqual(harness.launches.map((launch) => launch.role), ["implement", "review", "implement", "review"]);
    assert.equal(afterRework.workItems[0]?.state, "AwaitingMerge");
    assert.equal(afterRework.decisions.length, 0);
    assert.notEqual(harness.pullRequests.get(number)?.headRefOid, original.headRefOid);
    assert.equal(harness.pullRequests.get(number)?.reviewDecision, null);
  });
}

test("persistent CHANGES_REQUESTED reworks only once for the same review and reviewed head", async (t) => {
  const harness = await createHarness(t, { requireExternalApproval: true });
  const workItemId = await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number, original] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && original);
  harness.setPullRequest(number, {
    reviewDecision: "CHANGES_REQUESTED",
    reviews: [{
      id: "changes-request-1",
      author: "maintainer",
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-01-02T00:00:00Z",
      commitId: original.headRefOid,
    }],
  });

  await harness.main.runPass();
  assert.deepEqual(harness.launches.map((launch) => launch.role), ["implement", "review", "implement"]);
  const store = new MerroStore(join(harness.workspacePath, ".merro", "state.db"));
  try {
    const trigger = store.getWorkItemRuntime(workItemId)?.lastReworkTrigger;
    assert.ok(trigger?.includes("changes-request-1"));
    assert.ok(trigger?.includes(original.headRefOid));
  } finally {
    store.close();
  }

  await harness.main.runPass();
  await harness.main.runPass();
  let state = await harness.main.statusSnapshot();
  assert.deepEqual(harness.launches.map((launch) => launch.role), ["implement", "review", "implement", "review"]);
  assert.equal(state.workItems[0]?.state, "AwaitingMerge");
  assert.equal(state.decisions.length, 0);
  assert.equal(harness.pullRequests.get(number)?.reviewDecision, "CHANGES_REQUESTED");
  assert.notEqual(harness.pullRequests.get(number)?.headRefOid, original.headRefOid);

  await harness.main.runPass();
  state = await harness.main.statusSnapshot();
  assert.equal(harness.launches.length, 4);
  assert.equal(state.workItems[0]?.state, "AwaitingMerge");
  assert.equal(state.decisions.length, 0);
});

test("base movement merges the base into the PR branch and schedules a fresh review", async (t) => {
  const harness = await createHarness(t);
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && pullRequest);

  harness.setPullRequest(number, { baseRefOid: "d".repeat(40) });
  await harness.main.runPass();

  assert.deepEqual(harness.baseMerges, [{ path: join(harness.workspacePath, "workers", "example", "example:issue-7:g1"), defaultBranch: "main" }]);
  assert.deepEqual(harness.launches.map((launch) => launch.role), ["implement", "review", "review"]);
  assert.equal((await harness.main.statusSnapshot()).workItems[0]?.state, "Reviewing");
  assert.equal((await harness.main.statusSnapshot()).decisions.length, 0);
});

test("base merge conflicts create one merge_conflict Decision", async (t) => {
  const harness = await createHarness(t, { baseMergeConflict: true });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && pullRequest);

  harness.setPullRequest(number, { baseRefOid: "d".repeat(40) });
  await harness.main.runPass();
  let state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "AwaitingMerge");
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0]?.kind, "merge_conflict");

  await harness.main.runPass();
  state = await harness.main.statusSnapshot();
  assert.equal(harness.baseMerges.length, 1);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.decisions[0]?.kind, "merge_conflict");
});

test("approve command resolves a merge_conflict Decision and schedules fresh review", async (t) => {
  const harness = await createHarness(t, { baseMergeConflict: true });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && pullRequest);
  harness.setPullRequest(number, { baseRefOid: "d".repeat(40) });
  await harness.main.runPass();
  const decision = (await harness.main.statusSnapshot()).decisions[0];
  assert.ok(decision);
  assert.equal(decision.kind, "merge_conflict");

  const commands = new Map<string, Parameters<PiExtensionLike["registerCommand"]>[1]>();
  registerCommands({ registerCommand(name, config) { commands.set(name, config); } }, harness.workspacePath, harness.main);
  const approve = commands.get("merro-approve");
  assert.ok(approve);
  harness.setBaseMergeConflict(false);
  await approve.handler(decision.id, { ui: { notify() {} } });

  const state = await harness.main.statusSnapshot();
  assert.equal(state.decisions.length, 0);
  assert.equal(state.workItems[0]?.state, "Reviewing");
  assert.deepEqual(harness.launches.map((launch) => launch.role), ["implement", "review", "review"]);
});

test("reject command abandons a merge_conflict Decision without wedging the WorkItem", async (t) => {
  const harness = await createHarness(t, { baseMergeConflict: true });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && pullRequest);
  harness.setPullRequest(number, { baseRefOid: "d".repeat(40) });
  await harness.main.runPass();
  const decision = (await harness.main.statusSnapshot()).decisions[0];
  assert.ok(decision);

  const commands = new Map<string, Parameters<PiExtensionLike["registerCommand"]>[1]>();
  registerCommands({ registerCommand(name, config) { commands.set(name, config); } }, harness.workspacePath, harness.main);
  const reject = commands.get("merro-reject");
  assert.ok(reject);
  await reject.handler(decision.id, { ui: { notify() {} } });

  const state = await harness.main.statusSnapshot();
  assert.equal(state.decisions.length, 0);
  assert.equal(state.workItems[0]?.state, "Blocked");
  assert.equal(state.workItems[0]?.blockedReason, "merge_rejected");
});

test("Main tool exposes merge_conflict resolution", async (t) => {
  const harness = await createHarness(t, { baseMergeConflict: true });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && pullRequest);
  harness.setPullRequest(number, { baseRefOid: "d".repeat(40) });
  await harness.main.runPass();
  const decision = (await harness.main.statusSnapshot()).decisions[0];
  assert.ok(decision);

  const tools = new Map<string, Parameters<MainToolAPI["registerTool"]>[0]>();
  registerMainTools({ registerTool(tool) { tools.set(tool.name, tool); } }, harness.main);
  const resolve = tools.get("merro_resolve_merge_conflict");
  assert.ok(resolve);
  const result = await resolve.execute("call", { decision_id: decision.id, resolution: "abandon" });
  assert.match(result.content[0]?.text ?? "", /abandon/);
  const state = await harness.main.statusSnapshot();
  assert.equal(state.decisions.length, 0);
  assert.equal(state.workItems[0]?.state, "Blocked");
  assert.equal(state.workItems[0]?.blockedReason, "merge_rejected");
});

test("stopping an Objective resolves its pending merge_conflict Decision", async (t) => {
  const harness = await createHarness(t, { baseMergeConflict: true });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && pullRequest);
  harness.setPullRequest(number, { baseRefOid: "d".repeat(40) });
  await harness.main.runPass();
  let state = await harness.main.statusSnapshot();
  assert.equal(state.decisions[0]?.kind, "merge_conflict");
  const objective = state.objectives[0];
  assert.ok(objective);

  await harness.main.stopObjectives(objective.id);
  state = await harness.main.statusSnapshot();
  assert.equal(state.decisions.length, 0);
  assert.equal(state.workItems[0]?.state, "Obsolete");
});

test("external issue closure prevents launch and cancels active work", async (t) => {
  const beforeLaunch = await createHarness(t);
  const unstartedId = await startDefaultObjective(beforeLaunch.main);
  beforeLaunch.setIssueState("example", 7, "CLOSED");
  await beforeLaunch.main.runPass();
  let state = await beforeLaunch.main.statusSnapshot();
  assert.equal(state.workItems.find((item) => item.id === unstartedId)?.state, "Done");
  assert.equal(state.tasks.length, 0);
  assert.equal(beforeLaunch.launches.length, 0);

  const active = await createHarness(t);
  const activeId = await startDefaultObjective(active.main);
  await active.main.runPass();
  assert.equal(active.launches.length, 1);
  active.setIssueState("example", 7, "CLOSED");
  await active.main.runPass();
  state = await active.main.statusSnapshot();
  assert.equal(state.workItems.find((item) => item.id === activeId)?.state, "Done");
  assert.equal(state.tasks[0]?.outcome, "cancelled");
});

test("reopening an issue under an active Objective creates a new generation", async (t) => {
  const harness = await createHarness(t, { projects: [{ slug: "example", issueNumbers: [7, 8] }] });
  await harness.main.startObjective({
    goal: "Complete both tracked issues",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7, 8] }],
  });
  await harness.main.runPass();
  harness.setIssueState("example", 7, "CLOSED");
  await harness.main.runPass();
  let state = await harness.main.statusSnapshot();
  assert.ok(state.objectives.some((objective) => objective.state === "Active"));
  assert.ok(state.workItems.some((item) => item.sourceRef === "7" && item.generation === 1 && item.state === "Done"));

  harness.setIssueState("example", 7, "OPEN");
  await harness.main.runPass();
  state = await harness.main.statusSnapshot();
  const reopened = state.workItems.find((item) => item.sourceRef === "7" && item.generation === 2);
  assert.ok(reopened);
  assert.ok(state.objectives.some((objective) => objective.state === "Active"));
  assert.ok(harness.launches.some((launch) => launch.workItemId === reopened.id));
});

test("PR reconciliation repairs required body sections and canonical review notes", async (t) => {
  const harness = await createHarness(t);
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && pullRequest);
  assert.ok(harness.reviewComments.get(number)?.includes("<!-- merro:review-notes -->"));

  harness.setPullRequest(number, {
    body: "## Summary\n\nKeep this user-written summary.\n\n## Verification\n\nKeep this user-written verification.",
  });
  harness.reviewComments.delete(number);
  await harness.main.runPass();

  const repaired = harness.pullRequests.get(number);
  assert.ok(repaired);
  assert.match(repaired.body, /Keep this user-written summary\./);
  assert.match(repaired.body, /Keep this user-written verification\./);
  assert.doesNotMatch(repaired.body, /Checked the change/);
  assert.match(repaired.body, /Closes #7/);
  assert.ok(harness.reviewComments.get(number)?.includes("<!-- merro:review-notes -->"));
});

test("failed PR-content repair blocks merge readiness and clears stale Decisions", async (t) => {
  let failContentSync = false;
  const harness = await createHarness(t, { pullRequestContentFailure: () => failContentSync });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number);
  assert.equal((await harness.main.statusSnapshot()).decisions.length, 1);

  harness.setPullRequest(number, { body: "## Summary\n\nUser edited this body." });
  failContentSync = true;
  await harness.main.runPass();

  const state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "Blocked");
  assert.equal(state.workItems[0]?.blockedReason, "github_unavailable");
  assert.equal(state.decisions.length, 0);
});

test("title edits stop regenerating the PR verification section", async (t) => {
  const harness = await createHarness(t, {
    requireExternalApproval: true,
    result(input, launchNumber, result) {
      if (input.role === "implement" && launchNumber === 3) {
        return { ...result, verification: [{ kind: "manual", project: input.project.slug, summary: "New implementation verification." }] };
      }
      return result;
    },
  });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number, initial] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && initial);
  harness.setPullRequest(number, { title: "User-maintained title" });
  harness.setPullRequest(number, { checks: [{ name: "CI", state: "COMPLETED", conclusion: "FAILURE", detailsUrl: null }] });

  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();

  const updated = harness.pullRequests.get(number);
  assert.ok(updated);
  assert.equal(updated.title, "User-maintained title");
  assert.match(updated.body, /Checked the change/);
  assert.doesNotMatch(updated.body, /New implementation verification/);
});

test("one issue lookup failure blocks only its WorkItem and does not abort other Projects", async (t) => {
  const harness = await createHarness(t, {
    projects: [{ slug: "unavailable", issueNumbers: [7] }, { slug: "healthy", issueNumbers: [8] }],
    issueFailure: (projectSlug) => projectSlug === "unavailable",
  });
  const started = await harness.main.startObjective({
    goal: "Continue independent Project work",
    projectSlugs: ["unavailable", "healthy"],
    issues: [{ projectSlug: "unavailable", numbers: [7] }, { projectSlug: "healthy", numbers: [8] }],
  });

  await harness.main.runPass();
  const state = await harness.main.statusSnapshot();
  const unavailable = started.workItems.find((item) => item.projectSlug === "unavailable");
  const healthy = started.workItems.find((item) => item.projectSlug === "healthy");
  assert.ok(unavailable && healthy);
  assert.equal(state.workItems.find((item) => item.id === unavailable.id)?.blockedReason, "github_unavailable");
  assert.equal(state.workItems.find((item) => item.id === healthy.id)?.state, "Implementing");
  assert.deepEqual(harness.launches.map((launch) => launch.workItemId), [healthy.id]);
});

test("worker stop failure for a closed issue does not prevent other Project reconciliation", async (t) => {
  let inspectCalls = 0;
  const harness = await createHarness(t, {
    projects: [{ slug: "closing", issueNumbers: [7] }, { slug: "healthy", issueNumbers: [8] }],
    inspect: async () => ({ alive: ++inspectCalls === 1, identityMatches: true, reason: null }),
    stop: async () => { throw new Error("tmux stop unavailable"); },
  });
  const started = await harness.main.startObjective({
    goal: "Continue independent Project work",
    projectSlugs: ["closing", "healthy"],
    issues: [{ projectSlug: "closing", numbers: [7] }, { projectSlug: "healthy", numbers: [8] }],
  });
  await harness.main.runPass();
  harness.setIssueState("closing", 7, "CLOSED");

  await harness.main.runPass();

  const state = await harness.main.statusSnapshot();
  const closing = started.workItems.find((item) => item.projectSlug === "closing");
  const healthy = started.workItems.find((item) => item.projectSlug === "healthy");
  assert.ok(closing && healthy);
  assert.equal(state.workItems.find((item) => item.id === closing.id)?.blockedReason, "github_unavailable");
  assert.equal(state.workItems.find((item) => item.id === healthy.id)?.state, "Reviewing");
});

test("active worker inspection failure does not abort reconciliation of other Tasks", async (t) => {
  let inspectCalls = 0;
  const harness = await createHarness(t, {
    projects: [{ slug: "first", issueNumbers: [7] }, { slug: "second", issueNumbers: [8] }],
    inspect: async () => {
      inspectCalls += 1;
      if (inspectCalls === 1) throw new Error("tmux unavailable");
      return { alive: true, identityMatches: true, reason: null };
    },
  });
  await harness.main.startObjective({
    goal: "Continue independent Project work",
    projectSlugs: ["first", "second"],
    issues: [{ projectSlug: "first", numbers: [7] }, { projectSlug: "second", numbers: [8] }],
  });
  await harness.main.runPass();
  assert.equal(harness.launches.length, 2);
  for (const launch of harness.launches) {
    await rm(join(harness.workspacePath, "worker-results", launch.taskId, "result.json"), { force: true });
  }

  await assert.doesNotReject(harness.main.runPass());
  assert.equal(inspectCalls, 2);
  const state = await harness.main.statusSnapshot();
  assert.equal(state.workItems.filter((item) => item.blockedReason === "github_unavailable").length, 1);
  assert.ok(harness.notifications.some((message) => message.includes("Could not inspect active Task")));
});

test("closed-issue PR lookup failure is isolated and clears its merge Decision", async (t) => {
  let unavailablePullRequest: number | null = null;
  const harness = await createHarness(t, {
    projects: [{ slug: "closing", issueNumbers: [7] }, { slug: "healthy", issueNumbers: [8] }],
    pullRequestFailure: (number) => number === unavailablePullRequest,
  });
  const started = await harness.main.startObjective({
    goal: "Continue independent Project work",
    projectSlugs: ["closing", "healthy"],
    issues: [{ projectSlug: "closing", numbers: [7] }, { projectSlug: "healthy", numbers: [8] }],
  });
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const closingPr = [...harness.pullRequests.values()].find((pr) => pr.headRefName.includes("issue-7-for-closing"));
  const closing = started.workItems.find((item) => item.projectSlug === "closing");
  const healthy = started.workItems.find((item) => item.projectSlug === "healthy");
  assert.ok(closingPr && closing && healthy);
  harness.setIssueState("closing", 7, "CLOSED");
  unavailablePullRequest = closingPr.number;

  await harness.main.runPass();

  const state = await harness.main.statusSnapshot();
  assert.equal(state.workItems.find((item) => item.id === closing.id)?.blockedReason, "github_unavailable");
  assert.equal(state.workItems.find((item) => item.id === healthy.id)?.state, "AwaitingMerge");
  assert.deepEqual(state.decisions.map((decision) => decision.subjectId), [healthy.id]);
});

test("unchanged effective diff survives an external PR head rewrite", async (t) => {
  const harness = await createHarness(t, { effectiveDiffFingerprint: () => "same-effective-diff" });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const [number, pullRequest] = [...harness.pullRequests.entries()][0] ?? [];
  assert.ok(number && pullRequest);
  const reviewCount = harness.launches.filter((launch) => launch.role === "review").length;

  harness.setPullRequest(number, { headRefOid: "a".repeat(40) });
  await harness.main.runPass();

  const state = await harness.main.statusSnapshot();
  assert.equal(harness.launches.filter((launch) => launch.role === "review").length, reviewCount);
  assert.equal(state.workItems[0]?.state, "AwaitingMerge");
  assert.equal(state.decisions.length, 1);
  const payload = state.decisions[0]?.payload as Record<string, unknown>;
  assert.equal(payload.headRefOid, "a".repeat(40));
  assert.equal(payload.diffHash, "same-effective-diff");
});

test("permanent squash-merge rejection blocks without an automatic retry", async (t) => {
  const harness = await createHarness(t, {
    mergeError: new GitHubMergeError("rejected", "Squash merging is disabled"),
  });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const decision = (await harness.main.statusSnapshot()).decisions[0];
  assert.ok(decision);

  await harness.main.resolveMergeDecision(decision.id, true);
  let state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "Blocked");
  assert.equal(state.workItems[0]?.blockedReason, "merge_failed");
  assert.equal(state.decisions.length, 0);
  const taskCount = state.tasks.length;

  await harness.main.runPass();
  state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.blockedReason, "merge_failed");
  assert.equal(state.decisions.length, 0);
  assert.equal(state.tasks.length, taskCount);
});

test("manual merge completes a blocked PR-backed WorkItem with a different resume state", async (t) => {
  const harness = await createHarness(t);
  const workItemId = await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();
  const pullRequestNumber = [...harness.pullRequests.keys()][0];
  assert.ok(pullRequestNumber);

  const store = new MerroStore(join(harness.workspacePath, ".merro", "state.db"));
  try {
    store.transitionWorkItem(workItemId, "Implementing");
    store.transitionWorkItem(workItemId, "Blocked", "task_failed");
  } finally {
    store.close();
  }
  harness.setPullRequest(pullRequestNumber, {
    state: "CLOSED",
    mergedAt: "2026-01-03T00:00:00Z",
    mergeCommitSha: "f".repeat(40),
  });

  await harness.main.runPass();
  const state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "Done");
  assert.equal(state.objectives[0]?.state, "Done");
  assert.equal(state.decisions.length, 0);
});

test("stopping a high-priority Objective recomputes shared WorkItem priority", async (t) => {
  const harness = await createHarness(t);
  const normal = await harness.main.startObjective({
    goal: "Normal priority owner",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
    priority: "normal",
  });
  const high = await harness.main.startObjective({
    goal: "High priority owner",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
    priority: "high",
  });
  assert.equal(high.workItems[0]?.priority, "high");

  await harness.main.stopObjectives(high.objective.id);

  const state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.id, normal.workItems[0]?.id);
  assert.equal(state.workItems[0]?.priority, "normal");
  assert.equal(state.objectives.find((objective) => objective.id === high.objective.id)?.state, "Stopped");
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

test("Main obsoletes ownerless planned WorkItems instead of marking them Ready", async (t) => {
  const harness = await createHarness(t);
  const store = new MerroStore(join(harness.workspacePath, ".merro", "state.db"));
  try {
    store.createWorkItem({
      id: "ownerless",
      projectSlug: "example",
      sourceType: "issue",
      sourceRef: "99",
      generation: 1,
      state: "Planned",
      priority: "normal",
      readySince: null,
      blockedReason: null,
      blockedResumeState: null,
    });
  } finally {
    store.close();
  }

  await harness.main.runPass();
  const state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "Obsolete");
  assert.equal(harness.launches.length, 0);
});

test("/stop obsoletes exclusive work and leaves shared work for an active Objective", async (t) => {
  const exclusive = await createHarness(t);
  const only = await exclusive.main.startObjective({
    goal: "Only owner",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
  });
  assert.equal(await exclusive.main.stopObjectives(only.objective.id), 1);
  assert.equal((await exclusive.main.statusSnapshot()).workItems[0]?.state, "Obsolete");
  assert.equal(exclusive.launches.length, 0);

  const shared = await createHarness(t);
  const first = await shared.main.startObjective({
    goal: "First owner",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
  });
  await shared.main.startObjective({
    goal: "Second owner",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
  });
  assert.equal(await shared.main.stopObjectives(first.objective.id), 1);
  const continued = await shared.main.statusSnapshot();
  assert.equal(continued.workItems[0]?.state, "Implementing");
  assert.equal(continued.objectives.find((objective) => objective.id === first.objective.id)?.state, "Stopped");
  assert.equal(continued.objectives.find((objective) => objective.id !== first.objective.id)?.state, "Active");
  assert.equal(shared.launches.length, 1);
});

test("/stop lets an active Task finish, then obsoletes its unowned WorkItem", async (t) => {
  let alive = true;
  const harness = await createHarness(t, {
    inspect: async () => ({ alive, identityMatches: true, reason: null }),
    result: () => null,
  });
  const workItemId = await startDefaultObjective(harness.main);
  await harness.main.runPass();
  const initial = await harness.main.statusSnapshot();
  const taskId = initial.tasks[0]?.id;
  assert.ok(taskId);
  assert.equal(initial.tasks[0]?.status, "active");

  await harness.main.stopObjectives();
  const stopped = await harness.main.statusSnapshot();
  assert.equal(stopped.workItems.find((item) => item.id === workItemId)?.state, "Implementing");
  assert.equal(stopped.tasks.find((task) => task.id === taskId)?.status, "active");
  assert.equal(harness.launches.length, 1);

  const commit = createHash("sha1").update(taskId).digest("hex");
  await writeFile(join(harness.workspacePath, "worker-results", taskId, "result.json"), JSON.stringify({
    task_id: taskId,
    status: "success",
    summary: "Completed after stop.",
    commit,
    verification: [{ kind: "manual", project: "example", summary: "Finished the active Task." }],
  }));
  alive = false;
  await harness.main.runPass();
  const finished = await harness.main.statusSnapshot();
  assert.equal(finished.tasks.find((task) => task.id === taskId)?.outcome, "success");
  assert.equal(finished.workItems.find((item) => item.id === workItemId)?.state, "Obsolete");
  assert.equal(harness.launches.length, 1);
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
      async syncBranchHead() {},
      async effectiveDiffFingerprint(_project, _path, _baseRefName, _baseCommit, headCommit) { return headCommit; },
      async fetchAndMergeBase() { return { baseCommit: "base-sha", headCommit: "base-sha", merged: false }; },
    },
    github: {
      async repository() {
        return { nameWithOwner: "example/repo", url: "https://github.com/example/repo", sshUrl: "git@github.com:example/repo.git", defaultBranch: "main" };
      },
      async repositoryInDirectory(path) {
        const project = [...harness.projects.values()].find((candidate) => candidate.path === path);
        assert.ok(project);
        return { nameWithOwner: `example/${project.slug}`, url: "https://github.com/example/repo", sshUrl: "git@github.com:example/repo.git", defaultBranch: "main" };
      },
      async listOpenIssues() { return [harness.issues.get("example:7")!]; },
      async issue() { return harness.issues.get("example:7")!; },
      async createPullRequest() { throw new Error("not reached"); },
      async pullRequest() { throw new Error("not reached"); },
      async syncPullRequestContent() {},
      async branchProtection() { return { known: true, requiredStatusChecks: [], requiredApprovingReviewCount: 0, requireCodeOwnerReviews: false, dismissStaleApprovals: false }; },
      async hasWritePermission() { return false; },
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

test("review cap ignores stopped Objective owners and uses the strictest active owner limit", async (t) => {
  const harness = await createHarness(t, {
    result(input, launchNumber, result) {
      if (input.role === "review" && launchNumber === 2) {
        return {
          task_id: input.taskId,
          status: "reject",
          summary: "A blocking issue remains.",
          reviewed_commit: input.expectedCommit,
          findings: [{ severity: "blocking", summary: "Fix it." }],
          verification: [],
        };
      }
      return result;
    },
  });
  const stoppedOwner = await harness.main.startObjective({
    goal: "Strict but stopped owner",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
    maxReviewRounds: 1,
  });
  const activeOwner = await harness.main.startObjective({
    goal: "Active unlimited owner",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
    maxReviewRounds: "unlimited",
  });
  assert.equal(activeOwner.workItems[0]?.id, stoppedOwner.workItems[0]?.id);
  await harness.main.stopObjectives(stoppedOwner.objective.id);
  await harness.main.runPass();
  await harness.main.runPass();
  const state = await harness.main.statusSnapshot();
  assert.equal(state.workItems[0]?.state, "Implementing");
  assert.equal(state.workItems[0]?.blockedReason, null);
  assert.equal(harness.launches.map((launch) => launch.role).join(","), "implement,review,implement");

  const capped = await createHarness(t, {
    result(input, launchNumber, result) {
      if (input.role === "review" && launchNumber === 2) {
        return {
          task_id: input.taskId,
          status: "reject",
          summary: "A blocking issue remains.",
          reviewed_commit: input.expectedCommit,
          findings: [{ severity: "blocking", summary: "Fix it." }],
          verification: [],
        };
      }
      return result;
    },
  });
  await capped.main.startObjective({
    goal: "Permissive active owner",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
    maxReviewRounds: 3,
  });
  await capped.main.startObjective({
    goal: "Strict active owner",
    projectSlugs: ["example"],
    issues: [{ projectSlug: "example", numbers: [7] }],
    maxReviewRounds: 1,
  });
  await capped.main.runPass();
  await capped.main.runPass();
  await capped.main.runPass();
  assert.equal((await capped.main.statusSnapshot()).workItems[0]?.blockedReason, "review_cap");
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
      reviewDecision: "APPROVED",
      checks: [{ name: "CI", state: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }],
      reviews: [{ id: `approval-${number}`, author: "maintainer", state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z", commitId: pullRequest.headRefOid }],
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
    reviewDecision: "APPROVED",
    checks: [{ name: "CI", state: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }],
    reviews: [{ id: `approval-${webPullRequest[0]}`, author: "maintainer", state: "APPROVED", submittedAt: "2026-01-02T00:00:00Z", commitId: webPullRequest[1].headRefOid }],
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

test("an externally reopened pull request stays blocked until explicit continuation", async (t) => {
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
  assert.equal(reopened.workItems.find((item) => item.id === workItemId)?.state, "Blocked");
  assert.equal(reopened.workItems.find((item) => item.id === workItemId)?.blockedReason, "pr_closed");
  assert.equal(reopened.decisions.length, 0);

  await harness.main.continueWorkItem(workItemId);
  const continued = await harness.main.statusSnapshot();
  assert.equal(continued.workItems.find((item) => item.id === workItemId)?.state, "AwaitingMerge");
  assert.equal(continued.decisions.length, 1);
  assert.notEqual(continued.decisions[0]?.id, decision.id);
});

test("a policy_unknown WorkItem automatically resumes when policy visibility returns", async (t) => {
  const harness = await createHarness(t, { branchPolicyAvailable: false });
  await startDefaultObjective(harness.main);
  await harness.main.runPass();
  await harness.main.runPass();
  await harness.main.runPass();

  const blocked = await harness.main.statusSnapshot();
  assert.equal(blocked.workItems[0]?.state, "Blocked");
  assert.equal(blocked.workItems[0]?.blockedReason, "policy_unknown");
  assert.equal(blocked.decisions.length, 0);

  harness.setBranchPolicyAvailable(true);
  await harness.main.runPass();
  const resumed = await harness.main.statusSnapshot();
  assert.equal(resumed.workItems[0]?.state, "AwaitingMerge");
  assert.equal(resumed.workItems[0]?.blockedReason, null);
  assert.equal(resumed.decisions.length, 1);
});

test("an external merge completes the WorkItem and resolves its pending merge Decision", async (t) => {
  const { main, workspacePath, deletedClones, pullRequests, setPullRequest, setIssueState } = await createHarness(t);
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
  setIssueState("example", 7, "CLOSED");
  await main.runPass();
  const completed = await main.statusSnapshot();
  assert.equal(completed.workItems[0]?.state, "Done");
  assert.equal(completed.objectives[0]?.state, "Done");
  assert.equal(completed.decisions.length, 0);
  assert.equal(completed.tasks.filter((task) => task.status === "finalized").length, 2);
  assert.equal(deletedClones.length, 1);
  const store = new MerroStore(join(workspacePath, ".merro", "state.db"));
  try {
    assert.ok(store.getFinalSummary(runtime.id));
  } finally {
    store.close();
  }
});
