import test from "node:test";
import assert from "node:assert/strict";
import type { CommandOptions, CommandOutput, CommandRunner } from "../src/runtime/commands.js";
import { GitHubClient, GitHubMergeError } from "../src/github/client.js";

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

test("pull request parsing reads review commit OIDs from gh's object shape", async () => {
  const head = "b".repeat(40);
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    {
      stdout: JSON.stringify({
        number: 22,
        title: "Approval shape",
        body: "",
        url: "https://github.com/acme/widget/pull/22",
        state: "OPEN",
        isDraft: false,
        mergedAt: null,
        mergeCommit: null,
        mergeable: "MERGEABLE",
        headRefName: "feature",
        baseRefName: "main",
        headRefOid: head,
        baseRefOid: "c".repeat(40),
        reviewDecision: "APPROVED",
        reviews: [{
          author: { login: "maintainer" },
          state: "APPROVED",
          submittedAt: "2026-01-01T00:00:00Z",
          commit: { oid: head },
        }],
        statusCheckRollup: [],
      }),
      stderr: "",
    },
  ]);

  const pullRequest = await new GitHubClient(commands).pullRequest(project, 22);
  assert.equal(pullRequest.reviews[0]?.commitId, head);
  assert.equal(pullRequest.reviews[0]?.author, "maintainer");
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

test("squash merge classifies permanent rejection separately from availability failure", async () => {
  const expectedHead = "a".repeat(40);
  const rejected = new GitHubClient(new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    new Error("Squash merging is disabled for this repository"),
  ]));
  await assert.rejects(
    rejected.mergeSquash(project, 23, expectedHead),
    (error: unknown) => error instanceof GitHubMergeError && error.kind === "rejected",
  );

  const unavailable = new GitHubClient(new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    new Error("gh pr merge failed (ETIMEDOUT): network timeout"),
  ]));
  await assert.rejects(
    unavailable.mergeSquash(project, 23, expectedHead),
    (error: unknown) => error instanceof GitHubMergeError && error.kind === "unavailable",
  );
});

test("branch protection combines classic settings with active rulesets", async () => {
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
    {
      stdout: JSON.stringify([
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ruleset-ci", integration_id: 1 }] },
        },
        {
          type: "pull_request",
          parameters: { required_approving_review_count: 3, require_code_owner_review: false },
        },
      ]),
      stderr: "",
    },
  ]);
  const policy = await new GitHubClient(commands).branchProtection(project);
  assert.deepEqual(policy, {
    known: true,
    requiredStatusChecks: ["ci", "lint", "ruleset-ci"],
    requiredApprovingReviewCount: 3,
    requireCodeOwnerReviews: true,
  });
});

test("an unprotected branch is known when classic protection returns 404 and no ruleset applies", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    new Error("HTTP 404: Branch not protected"),
    { stdout: "[]", stderr: "" },
  ]);

  const policy = await new GitHubClient(commands).branchProtection(project);

  assert.deepEqual(policy, {
    known: true,
    requiredStatusChecks: [],
    requiredApprovingReviewCount: 0,
    requireCodeOwnerReviews: false,
  });
  assert.equal(commands.calls[2]?.args[1], "repos/acme/widget/rules/branches/main");
});

test("branch rulesets remain authoritative when classic protection returns 404", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    new Error("HTTP 404: Branch not protected"),
    {
      stdout: JSON.stringify([{
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ruleset-ci" }] },
      }]),
      stderr: "",
    },
  ]);

  const policy = await new GitHubClient(commands).branchProtection(project);

  assert.deepEqual(policy, {
    known: true,
    requiredStatusChecks: ["ruleset-ci"],
    requiredApprovingReviewCount: 0,
    requireCodeOwnerReviews: false,
  });
});
