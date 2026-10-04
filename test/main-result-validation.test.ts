import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import { initializedState } from "./fixtures.js";
import { MainOrchestrator, type MainOptions } from "../src/runtime/main.js";
import { systemCommandRunner } from "../src/runtime/commands.js";
import { WorkerRuntime } from "../src/runtime/worker-runtime.js";

for (const forged of ["implement", "review", "task_id", "schema"] as const) {
  test(`Main independently rejects a forged ${forged} artifact against a real Git clone`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "merro-forged-result-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "source");
    const workspace = join(root, "main");
    await mkdir(source);
    await initializedState(workspace);
    const git = async (cwd: string, ...args: string[]) => (await systemCommandRunner.run("git", args, { cwd })).stdout.trim();
    await git(source, "init", "--initial-branch=main");
    await git(source, "config", "user.name", "Test");
    await git(source, "config", "user.email", "test@example.test");
    await git(source, "commit", "--allow-empty", "-m", "base");
    await git(source, "remote", "add", "origin", source);
    const base = await git(source, "rev-parse", "HEAD");
    const repository = { nameWithOwner: "test/p", url: "https://github.com/test/p", sshUrl: "git@github.com:test/p.git", defaultBranch: "main" };
    const issue = { number: 1, title: "Implement", body: "Scope", url: "https://github.com/test/p/issues/1", state: "OPEN", labels: [], updatedAt: "2026-01-01" };
    const unexpected = async (): Promise<never> => { throw new Error("unexpected GitHub mutation"); };
    const github: NonNullable<MainOptions["github"]> = {
      repository: async () => repository, repositoryInDirectory: async () => repository,
      listOpenIssues: async () => [issue], issue: async () => issue, issues: async (_project, numbers) => numbers.map(() => issue),
      createIssue: unexpected, createPullRequest: unexpected, pullRequest: unexpected, branchProtection: unexpected,
      hasWritePermission: unexpected, merge: unexpected, syncPullRequestContent: unexpected,
    };
    const runtime = new WorkerRuntime({ workspacePath: join(workspace, ".merro/runtime"), config: DEFAULT_CONFIG });
    const main = new MainOrchestrator({ workspacePath: workspace, config: DEFAULT_CONFIG, github, notify() {}, workers: {
      prepareClone: async () => {}, plan: (input) => runtime.plan(input),
      async launch(input, plan = runtime.plan(input)) {
        await mkdir(join(input.clonePath, ".git/info"), { recursive: true });
        await writeFile(join(input.clonePath, ".git/info/exclude"), "/.merro-task.md\n");
        await writeFile(plan.taskFilePath, input.taskFile);
        if (input.role === "implement") {
          await writeFile(join(input.clonePath, "implementation.txt"), "done\n");
          await git(input.clonePath, "add", "implementation.txt");
          await git(input.clonePath, "commit", "-m", "implementation");
        }
        const head = await git(input.clonePath, "rev-parse", "HEAD");
        const result = input.role === "implement"
          ? { task_id: forged === "task_id" ? "forged-task" : input.taskId, status: "success", summary: "done",
            commit: forged === "implement" ? base : head, verification: forged === "schema" ? "invalid" : [{ kind: "command", project: "p", cwd: input.clonePath, command: "git status --short", exit_code: 0 }] }
          : { task_id: input.taskId, status: "pass", summary: "reviewed", reviewed_commit: base, findings: [], verification: [] };
        await mkdir(dirname(plan.resultPath), { recursive: true });
        await writeFile(plan.resultPath, JSON.stringify(result));
        return plan;
      },
      inspect: async () => ({ alive: false, identityMatches: true, reason: null }),
      cleanup: async () => {}, listOwnedWorkers: async () => [],
    } });
    await main.addProject(source, "p");
    const input = { goal: "test", projectSlugs: ["p"], issues: [{ projectSlug: "p", numbers: [1] }] };
    const proposal = await main.proposeObjective(input);
    await main.startObjective(input, proposal.id);
    await main.runPass();
    await main.runPass();
    if (forged === "review") {
      assert.equal((await main.statusSnapshot()).changeSets[0]?.state, "Reviewing");
      await main.runPass();
    }
    const snapshot = await main.statusSnapshot();
    assert.equal(snapshot.changeSets[0]?.state, "Blocked");
    assert.equal(snapshot.tasks.at(-1)?.outcome, "failed");
    assert.equal(snapshot.tasks.filter((task) => task.role === "review").length, forged === "review" ? 1 : 0);
  });
}
