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
      stdout: JSON.stringify([[{
        number: 17,
        title: "Fix widget",
        body: "Details",
        html_url: "https://github.com/acme/widget/issues/17",
        state: "open",
        labels: [{ name: "v0.1" }, { name: "bug" }],
        milestone: { title: "v1" },
        updated_at: "2026-01-01T00:00:00Z",
      }]]),
      stderr: "",
    },
  ]);
  const gh = new GitHubClient(commands);

  const issues = await gh.listOpenIssues(project, { labels: ["v0.1", "bug"], milestone: "v1" });

  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0]?.labels, ["v0.1", "bug"]);
  assert.equal(issues[0]?.milestone, "v1");
  assert.deepEqual(commands.calls[1]?.args, ["api", "--paginate", "--slurp", "repos/acme/widget/issues?state=open&per_page=100"]);
  assert.equal(commands.calls[1]?.options?.cwd, project.path);
});

test("scope discovery consumes every page, excludes PRs, and filters all approved labels and milestone", async () => {
  const issue = (number: number, labels = ["feature"], milestone = "v1") => ({
    number, title: `Issue ${number}`, body: "scope", html_url: `https://github.com/acme/widget/issues/${number}`,
    state: "open", labels: labels.map((name) => ({ name })), milestone: { title: milestone }, updated_at: "2026-01-01T00:00:00Z",
  });
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    { stdout: JSON.stringify([
      Array.from({ length: 100 }, (_, index) => issue(index + 1, ["bug"])),
      [issue(101, ["feature", "release"]), { ...issue(102, ["feature", "release"]), pull_request: {} }, issue(103, ["feature", "release"], "v2"), issue(104)],
    ]), stderr: "" },
  ]);
  const issues = await new GitHubClient(commands).listOpenIssues(project, { labels: ["FEATURE", "release"], milestone: "v1" });
  assert.deepEqual(issues.map((candidate) => candidate.number), [101]);
  assert.ok(commands.calls[1]?.args.includes("--paginate"));
});

test("scope discovery rejects incomplete or malformed responses instead of reporting no work", async () => {
  for (const value of [[], [{}], [[{ number: 1, labels: [{}] }]]]) {
    const commands = new FakeCommands([
      { stdout: repository("acme/widget"), stderr: "" },
      { stdout: JSON.stringify(value), stderr: "" },
    ]);
    await assert.rejects(new GitHubClient(commands).listOpenIssues(project));
  }
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
        author: { login: "issue-author" },
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
  assert.equal(pullRequest.authorLogin, "issue-author");
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

test("reviewer write permissions are parsed and cached per repository and account", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    { stdout: JSON.stringify({ permission: "write" }), stderr: "" },
  ]);
  const github = new GitHubClient(commands);

  assert.equal(await github.hasWritePermission(project, "Maintainer"), true);
  assert.equal(await github.hasWritePermission(project, "maintainer"), true);
  assert.equal(commands.calls.length, 2);
  assert.deepEqual(commands.calls[1]?.args, [
    "api", "repos/acme/widget/collaborators/Maintainer/permission",
  ]);
});

test("maintain permission also qualifies for required approvals", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    { stdout: JSON.stringify({ permission: "maintain" }), stderr: "" },
  ]);
  const github = new GitHubClient(commands);

  assert.equal(await github.hasWritePermission(project, "release-manager"), true);
});

test("missing or read-only collaborators cannot satisfy required approvals", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    { stdout: JSON.stringify({ permission: "read" }), stderr: "" },
    { stdout: repository("acme/widget"), stderr: "" },
    new Error("HTTP 404: Not Found"),
  ]);
  const github = new GitHubClient(commands);

  assert.equal(await github.hasWritePermission(project, "reader"), false);
  assert.equal(await github.hasWritePermission(project, "stranger"), false);
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
          dismiss_stale_reviews: true,
        },
      }),
      stderr: "",
    },
    {
      stdout: JSON.stringify([
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "ruleset-ci" }] },
        },
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 3,
            require_code_owner_review: false,
            dismiss_stale_reviews_on_push: true,
          },
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
    dismissStaleApprovals: true,
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
    dismissStaleApprovals: false,
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
    dismissStaleApprovals: false,
  });
});

test("branch policy is unknown when classic merge requirements are not modeled", async (t) => {
  const requirements = [
    { name: "last-push approval", protection: { required_pull_request_reviews: { require_last_push_approval: true } } },
    { name: "review-thread resolution", protection: { required_conversation_resolution: { enabled: true } } },
    { name: "check app identity", protection: { required_status_checks: { checks: [{ context: "CI", app_id: 42 }] } } },
  ];
  for (const requirement of requirements) {
    await t.test(requirement.name, async () => {
      const commands = new FakeCommands([
        { stdout: repository("acme/widget"), stderr: "" },
        { stdout: JSON.stringify(requirement.protection), stderr: "" },
        { stdout: "[]", stderr: "" },
      ]);
      const policy = await new GitHubClient(commands).branchProtection(project);
      assert.equal(policy.known, false, "unsupported active merge requirement must fail closed");
    });
  }
});

test("branch policy is unknown for unsupported active ruleset requirements", async (t) => {
  for (const rule of [
    { type: "required_reviewers", parameters: { required_reviewers: [{ reviewer: { id: 123 } }] } },
    { type: "pull_request", parameters: { required_review_thread_resolution: true } },
    { type: "pull_request", parameters: { required_reviewers: [{ reviewer: { id: 123 } }] } },
    { type: "required_review_thread_resolution", parameters: {} },
    { type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI", integration_id: 42 }] } },
  ]) {
    await t.test(rule.type, async () => {
      const commands = new FakeCommands([
        { stdout: repository("acme/widget"), stderr: "" },
        new Error("HTTP 404: Branch not protected"),
        { stdout: JSON.stringify([rule]), stderr: "" },
      ]);
      const policy = await new GitHubClient(commands).branchProtection(project);
      assert.equal(policy.known, false, "unsupported active merge requirement must fail closed");
    });
  }
});

test("branch protection queries the supplied PR base branch", async () => {
  const commands = new FakeCommands([
    { stdout: repository("acme/widget"), stderr: "" },
    new Error("HTTP 404: Branch not protected"),
    { stdout: "[]", stderr: "" },
  ]);

  await new GitHubClient(commands).branchProtection(project, "release/stable");

  assert.equal(commands.calls[1]?.args[1], "repos/acme/widget/branches/release%2Fstable/protection");
  assert.equal(commands.calls[2]?.args[1], "repos/acme/widget/rules/branches/release%2Fstable");
});
