import { CommandError, systemCommandRunner, type CommandRunner } from "../runtime/commands.js";
import type { Project } from "../domain/model.js";

export interface GitHubRepository {
  nameWithOwner: string;
  url: string;
  sshUrl: string;
  defaultBranch: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: string[];
  updatedAt: string;
}

export interface GitHubReview {
  author: string;
  state: string;
  submittedAt: string | null;
  commitId: string | null;
}

export interface GitHubCheck {
  name: string;
  state: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  reviewDecision: string | null;
  reviews: GitHubReview[];
  checks: GitHubCheck[];
}

export interface BranchProtection {
  known: true;
  requiredStatusChecks: string[];
  requiredApprovingReviewCount: number;
  requireCodeOwnerReviews: boolean;
}

export interface UnknownBranchProtection {
  known: false;
  reason: string;
}

export type BranchPolicy = BranchProtection | UnknownBranchProtection;

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} returned invalid JSON`, { cause: error });
  }
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} returned an unexpected JSON value`);
  }
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, key: string, context: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`${context} is missing string field ${key}`);
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseRepository(value: unknown): GitHubRepository {
  const row = object(value, "gh repo view");
  const branch = object(row.defaultBranchRef, "gh repo view.defaultBranchRef");
  return {
    nameWithOwner: stringField(row, "nameWithOwner", "gh repo view"),
    url: stringField(row, "url", "gh repo view"),
    sshUrl: stringField(row, "sshUrl", "gh repo view"),
    defaultBranch: stringField(branch, "name", "gh repo view.defaultBranchRef"),
  };
}

function parseIssue(value: unknown): GitHubIssue {
  const row = object(value, "gh issue list item");
  const labels = Array.isArray(row.labels)
    ? row.labels.flatMap((label) => {
      if (typeof label !== "object" || label === null) return [];
      const name = (label as Record<string, unknown>).name;
      return typeof name === "string" ? [name] : [];
    })
    : [];
  return {
    number: typeof row.number === "number" ? row.number : Number.NaN,
    title: stringField(row, "title", "gh issue list item"),
    body: typeof row.body === "string" ? row.body : "",
    url: stringField(row, "url", "gh issue list item"),
    state: stringField(row, "state", "gh issue list item"),
    labels,
    updatedAt: stringField(row, "updatedAt", "gh issue list item"),
  };
}

function parseReview(value: unknown): GitHubReview {
  const row = object(value, "gh pr view review");
  const author = typeof row.author === "object" && row.author !== null
    ? nullableString((row.author as Record<string, unknown>).login)
    : null;
  return {
    author: author ?? "",
    state: typeof row.state === "string" ? row.state : "",
    submittedAt: nullableString(row.submittedAt),
    commitId: nullableString(row.commit),
  };
}

function parseCheck(value: unknown): GitHubCheck {
  const row = object(value, "gh pr view statusCheckRollup item");
  return {
    name: typeof row.name === "string" ? row.name : typeof row.context === "string" ? row.context : "",
    state: typeof row.state === "string" ? row.state : typeof row.status === "string" ? row.status : "",
    conclusion: nullableString(row.conclusion),
    detailsUrl: nullableString(row.detailsUrl),
  };
}

function parsePullRequest(value: unknown): GitHubPullRequest {
  const row = object(value, "gh pr view");
  const reviews = Array.isArray(row.reviews) ? row.reviews.map(parseReview) : [];
  const checks = Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup.map(parseCheck) : [];
  return {
    number: typeof row.number === "number" ? row.number : Number.NaN,
    title: typeof row.title === "string" ? row.title : "",
    body: typeof row.body === "string" ? row.body : "",
    url: stringField(row, "url", "gh pr view"),
    state: typeof row.state === "string" ? row.state : "",
    isDraft: row.isDraft === true,
    mergedAt: nullableString(row.mergedAt),
    mergeCommitSha: typeof row.mergeCommit === "object" && row.mergeCommit !== null
      ? nullableString((row.mergeCommit as Record<string, unknown>).oid)
      : null,
    mergeable: typeof row.mergeable === "string" ? row.mergeable : "UNKNOWN",
    headRefName: typeof row.headRefName === "string" ? row.headRefName : "",
    baseRefName: typeof row.baseRefName === "string" ? row.baseRefName : "",
    headRefOid: typeof row.headRefOid === "string" ? row.headRefOid : "",
    baseRefOid: typeof row.baseRefOid === "string" ? row.baseRefOid : "",
    reviewDecision: nullableString(row.reviewDecision),
    reviews,
    checks,
  };
}

export class GitHubClient {
  readonly #commands: CommandRunner;

  constructor(commands: CommandRunner = systemCommandRunner) {
    this.#commands = commands;
  }

  async repository(reference: string): Promise<GitHubRepository> {
    const result = await this.#commands.run("gh", [
      "repo", "view", reference,
      "--json", "nameWithOwner,url,sshUrl,defaultBranchRef",
    ]);
    return parseRepository(parseJson(result.stdout, "gh repo view"));
  }

  async repositoryInDirectory(path: string): Promise<GitHubRepository> {
    const result = await this.#commands.run("gh", [
      "repo", "view", "--json", "nameWithOwner,url,sshUrl,defaultBranchRef",
    ], { cwd: path });
    return parseRepository(parseJson(result.stdout, "gh repo view"));
  }

  async listOpenIssues(project: Project, labels: readonly string[] = [], limit = 100): Promise<GitHubIssue[]> {
    const repository = await this.repository(project.baseRemote);
    const args = [
      "issue", "list", "--repo", repository.nameWithOwner,
      "--state", "open", "--limit", String(limit),
      "--json", "number,title,body,url,state,labels,updatedAt",
    ];
    for (const label of labels) args.push("--label", label);
    const result = await this.#commands.run("gh", args, { cwd: project.path });
    const value = parseJson(result.stdout, "gh issue list");
    if (!Array.isArray(value)) throw new Error("gh issue list returned a non-array value");
    return value.map(parseIssue).filter((issue) => Number.isSafeInteger(issue.number) && issue.number > 0);
  }

  async issue(project: Project, number: number): Promise<GitHubIssue> {
    const repository = await this.repository(project.baseRemote);
    const result = await this.#commands.run("gh", [
      "issue", "view", String(number), "--repo", repository.nameWithOwner,
      "--json", "number,title,body,url,state,labels,updatedAt",
    ], { cwd: project.path });
    return parseIssue(parseJson(result.stdout, "gh issue view"));
  }

  async findPullRequest(project: Project, branchName: string): Promise<GitHubPullRequest | null> {
    const base = await this.repository(project.baseRemote);
    const head = await this.repository(project.pushRemote);
    const owner = head.nameWithOwner.split("/")[0];
    if (!owner) throw new Error(`cannot determine GitHub head owner for ${head.nameWithOwner}`);
    const result = await this.#commands.run("gh", [
      "pr", "list", "--repo", base.nameWithOwner, "--state", "all",
      "--head", `${owner}:${branchName}`,
      "--json", "number,title,body,url,state,isDraft,mergedAt,mergeCommit,mergeable,headRefName,baseRefName,headRefOid,baseRefOid,reviewDecision,reviews,statusCheckRollup",
      "--limit", "100",
    ], { cwd: project.path });
    const value = parseJson(result.stdout, "gh pr list");
    if (!Array.isArray(value)) throw new Error("gh pr list returned a non-array value");
    const pullRequest = value.map(parsePullRequest).find((candidate) => candidate.headRefName === branchName);
    return pullRequest ?? null;
  }

  async pullRequest(project: Project, number: number): Promise<GitHubPullRequest> {
    const repository = await this.repository(project.baseRemote);
    const result = await this.#commands.run("gh", [
      "pr", "view", String(number), "--repo", repository.nameWithOwner,
      "--json", "number,title,body,url,state,isDraft,mergedAt,mergeCommit,mergeable,headRefName,baseRefName,headRefOid,baseRefOid,reviewDecision,reviews,statusCheckRollup",
    ], { cwd: project.path });
    return parsePullRequest(parseJson(result.stdout, "gh pr view"));
  }

  async createPullRequest(
    project: Project,
    branchName: string,
    title: string,
    body: string,
  ): Promise<GitHubPullRequest> {
    const existing = await this.findPullRequest(project, branchName);
    if (existing) return existing;

    const [base, head] = await Promise.all([
      this.repository(project.baseRemote),
      this.repository(project.pushRemote),
    ]);
    const owner = head.nameWithOwner.split("/")[0];
    if (!owner) throw new Error(`cannot determine GitHub head owner for ${head.nameWithOwner}`);
    const headRef = base.nameWithOwner === head.nameWithOwner ? branchName : `${owner}:${branchName}`;
    const result = await this.#commands.run("gh", [
      "pr", "create", "--repo", base.nameWithOwner,
      "--head", headRef, "--base", project.defaultBranch,
      "--title", title, "--body", body,
    ], { cwd: project.path });
    const url = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    const number = url ? Number(url.match(/\/pull\/(\d+)/)?.[1]) : Number.NaN;
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(`gh pr create returned no pull request URL: ${result.stdout.trim()}`);
    return this.pullRequest(project, number);
  }

  async branchProtection(project: Project): Promise<BranchPolicy> {
    const repository = await this.repository(project.baseRemote);
    const path = `repos/${repository.nameWithOwner}/branches/${encodeURIComponent(project.defaultBranch)}/protection`;
    try {
      const result = await this.#commands.run("gh", ["api", path], { cwd: project.path });
      const row = object(parseJson(result.stdout, "gh api branch protection"), "gh api branch protection");
      const statusChecks = row.required_status_checks;
      const statusCheckObject = typeof statusChecks === "object" && statusChecks !== null
        ? statusChecks as Record<string, unknown>
        : {};
      const requiredStatusChecks = [
        ...stringArray(statusCheckObject.contexts),
        ...(Array.isArray(statusCheckObject.checks)
          ? statusCheckObject.checks.flatMap((check) => {
            if (typeof check !== "object" || check === null) return [];
            const name = (check as Record<string, unknown>).context;
            return typeof name === "string" ? [name] : [];
          })
          : []),
      ];
      const pullRequestReview = typeof row.required_pull_request_reviews === "object" && row.required_pull_request_reviews !== null
        ? row.required_pull_request_reviews as Record<string, unknown>
        : {};
      return {
        known: true,
        requiredStatusChecks: [...new Set(requiredStatusChecks)],
        requiredApprovingReviewCount: typeof pullRequestReview.required_approving_review_count === "number"
          ? pullRequestReview.required_approving_review_count
          : 0,
        requireCodeOwnerReviews: pullRequestReview.require_code_owner_reviews === true,
      };
    } catch (error) {
      const reason = error instanceof CommandError ? error.message : String(error);
      return { known: false, reason };
    }
  }

  async mergeSquash(project: Project, number: number, expectedHeadCommit: string): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/i.test(expectedHeadCommit)) {
      throw new Error(`invalid expected pull request head SHA: ${expectedHeadCommit}`);
    }
    const repository = await this.repository(project.baseRemote);
    await this.#commands.run("gh", [
      "pr", "merge", String(number), "--repo", repository.nameWithOwner,
      "--squash", "--match-head-commit", expectedHeadCommit,
    ], { cwd: project.path });
  }
}
