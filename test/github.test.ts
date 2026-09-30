import test from "node:test";
import assert from "node:assert/strict";
import type { CommandOptions, CommandOutput, CommandRunner } from "../src/runtime/commands.js";
import { GitHubClient } from "../src/github/client.js";

class FakeCommands implements CommandRunner {
  readonly calls: Array<{ file: string; args: readonly string[]; options?: CommandOptions }> = [];
  readonly outputs: Array<CommandOutput | Error>;

  constructor(outputs: Array<CommandOutput | Error>) {
    this.outputs = outputs;
  }

  async run(file: string, args: readonly string[], options?: CommandOptions): Promise<CommandOutput> {
    this.calls.push(options ? { file, args, options } : { file, args });
    const output = this.outputs.shift();
    if (!output) throw new Error(`no fake output for ${file} ${args.join(" ")}`);
    if (output instanceof Error) throw output;
    return output;
  }
}

const project = {
  slug: "widget",
  path: "/repos/widget",
  baseRemote: "https://github.com/acme/widget.git",
  pushRemote: "git@github.com:contributor/widget.git",
  defaultBranch: "main",
};

const repository = (nameWithOwner: string) => JSON.stringify({
  nameWithOwner,
  url: `https://github.com/${nameWithOwner}`,
  sshUrl: `git@github.com:${nameWithOwner}.git`,
  defaultBranchRef: { name: "main" },
});

test("GitHub issue discovery uses gh JSON and parses issue labels", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    {
      stdout: JSON.stringify([{
        number: 17,
        title: "Fix widget",
        body: "Details",
        url: "https://github.com/acme/widget/issues/17",
        state: "OPEN",
        labels: [{ name: "v0.1" }, { name: "bug" }],
        updatedAt: "2026-01-01T00:00:00Z",
      }]),
      stderr: "",
    },
  ]);
  const gh = new GitHubClient(commands);

  const issues = await gh.listOpenIssues(project, ["v0.1", "bug"]);

  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0]?.labels, ["v0.1", "bug"]);
  assert.deepEqual(commands.calls[1]?.args.slice(-4), ["--label", "v0.1", "--label", "bug"]);
  assert.equal(commands.calls[1]?.options?.cwd, project.path);
});

test("branch protection is unknown on GitHub API failure", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    new Error("permission denied"),
  ]);
  const policy = await new GitHubClient(commands).branchProtection(project);
  assert.equal(policy.known, false);
  if (!policy.known) assert.match(policy.reason, /permission denied/);
});

test("pull request parsing includes the exact merged commit SHA", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    {
      stdout: JSON.stringify({
        number: 23,
        title: "Merged dependency",
        body: "",
        url: "https://github.com/acme/widget/pull/23",
        state: "CLOSED",
        isDraft: false,
        mergedAt: "2026-01-01T00:00:00Z",
        mergeCommit: { oid: "a".repeat(40) },
        mergeable: "UNKNOWN",
        headRefName: "feature",
        baseRefName: "main",
        headRefOid: "b".repeat(40),
        baseRefOid: "c".repeat(40),
        reviewDecision: null,
        reviews: [],
        statusCheckRollup: [],
      }),
      stderr: "",
    },
  ]);
  const pullRequest = await new GitHubClient(commands).pullRequest(project, 23);

  assert.equal(pullRequest.mergeCommitSha, "a".repeat(40));
  assert.ok(commands.calls[1]?.args.some((argument) => argument.split(",").includes("mergeCommit")));
});

test("pull request parsing preserves legacy status-context names for required checks", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    {
      stdout: JSON.stringify({
        number: 24,
        title: "Status context check",
        body: "",
        url: "https://github.com/acme/widget/pull/24",
        state: "OPEN",
        isDraft: false,
        mergedAt: null,
        mergeCommit: null,
        mergeable: "MERGEABLE",
        headRefName: "feature",
        baseRefName: "main",
        headRefOid: "b".repeat(40),
        baseRefOid: "c".repeat(40),
        reviewDecision: null,
        reviews: [],
        statusCheckRollup: [{ context: "legacy-ci", state: "SUCCESS", targetUrl: "https://checks.example.test" }],
      }),
      stderr: "",
    },
  ]);

  const pullRequest = await new GitHubClient(commands).pullRequest(project, 24);
  assert.deepEqual(pullRequest.checks, [{
    name: "legacy-ci",
    state: "SUCCESS",
    conclusion: null,
    detailsUrl: null,
  }]);
});

test("squash merge requires the approved pull request head commit", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    { stdout: "", stderr: "" },
  ]);
  const expectedHead = "a".repeat(40);
  await new GitHubClient(commands).mergeSquash(project, 23, expectedHead);

  assert.deepEqual(commands.calls[1]?.args, [
    "pr", "merge", "23", "--repo", "acme/widget", "--squash",
    "--match-head-commit", expectedHead,
  ]);
  await assert.rejects(new GitHubClient(new FakeCommands([])).mergeSquash(project, 23, "bad-sha"), /invalid expected/);
});

test("branch protection reports exact required checks and review count", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    {
      stdout: JSON.stringify({
        required_status_checks: { contexts: ["ci"], checks: [{ context: "lint" }] },
        required_pull_request_reviews: {
          required_approving_review_count: 2,
          require_code_owner_reviews: true,
        },
      }),
      stderr: "",
    },
  ]);
  const policy = await new GitHubClient(commands).branchProtection(project);
  assert.deepEqual(policy, {
    known: true,
    requiredStatusChecks: ["ci", "lint"],
    requiredApprovingReviewCount: 2,
    requireCodeOwnerReviews: true,
  });
});
