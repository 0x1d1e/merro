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
  id: string | null;
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
  authorLogin: string | null;
  reviewDecision: string | null;
  reviews: GitHubReview[];
  checks: GitHubCheck[];
}

export interface BranchProtection {
  known: true;
  requiredStatusChecks: string[];
  requiredApprovingReviewCount: number;
  requireCodeOwnerReviews: boolean;
  dismissStaleApprovals: boolean;
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

function statusCheckNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const checks = value as Record<string, unknown>;
  return [
    ...stringArray(checks.contexts),
    ...(Array.isArray(checks.checks)
      ? checks.checks.flatMap((check) => {
        if (typeof check !== "object" || check === null) return [];
        const row = check as Record<string, unknown>;
        const name = typeof row.context === "string" ? row.context : row.name;
        return typeof name === "string" ? [name] : [];
      })
      : []),
  ];
}

function isNotFound(error: unknown): boolean {
  const text = error instanceof CommandError ? `${error.message} ${error.stderr}` : String(error);
  return /\b404\b/i.test(text);
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
  const commitId = typeof row.commit === "object" && row.commit !== null
    ? nullableString((row.commit as Record<string, unknown>).oid)
    : nullableString(row.commit);
  return {
    id: typeof row.id === "string" || typeof row.id === "number" ? String(row.id) : null,
    author: author ?? "",
    state: typeof row.state === "string" ? row.state : "",
    submittedAt: nullableString(row.submittedAt),
    commitId,
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
    authorLogin: typeof row.author === "object" && row.author !== null
      ? nullableString((row.author as Record<string, unknown>).login)
      : null,
    reviewDecision: nullableString(row.reviewDecision),
    reviews,
    checks,
  };
}

export class GitHubMergeError extends Error {
  constructor(readonly kind: "unavailable" | "rejected", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubMergeError";
  }
}

function isGitHubAvailabilityFailure(error: unknown): boolean {
  const message = error instanceof CommandError
    ? `${error.message} ${error.stderr} ${error.causeCode ?? ""}`
    : error instanceof Error ? error.message : String(error);
  return /\b(?:ENOENT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN)\b|\b(?:401|429|502|503|504)\b|rate limit|timed? ?out|network|connection (?:reset|refused|closed)|could not resolve|failed to connect|not logged in|authentication token/i.test(message);
}

export class GitHubClient {
  readonly #commands: CommandRunner;
  readonly #reviewerPermissionCache = new Map<string, { expiresAt: number; result: Promise<boolean> }>();

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
      "--json", "number,title,body,url,state,isDraft,mergedAt,mergeCommit,mergeable,headRefName,baseRefName,headRefOid,baseRefOid,author,reviewDecision,reviews,statusCheckRollup",
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
      "--json", "number,title,body,url,state,isDraft,mergedAt,mergeCommit,mergeable,headRefName,baseRefName,headRefOid,baseRefOid,author,reviewDecision,reviews,statusCheckRollup",
    ], { cwd: project.path });
    return parsePullRequest(parseJson(result.stdout, "gh pr view"));
  }

  async syncPullRequestContent(
    project: Project,
    pullRequest: GitHubPullRequest,
    body: string,
    reviewNotes: string,
  ): Promise<void> {
    const repository = await this.repository(project.baseRemote);
    if (pullRequest.body !== body) {
      await this.#commands.run("gh", [
        "pr", "edit", String(pullRequest.number), "--repo", repository.nameWithOwner, "--body", body,
      ], { cwd: project.path });
    }

    const endpoint = `repos/${repository.nameWithOwner}/issues/${pullRequest.number}/comments`;
    const listed = await this.#commands.run("gh", [
      "api", endpoint, "--paginate", "--jq", ".[] | {id, body, created_at}",
    ], { cwd: project.path });
    const comments = listed.stdout.trim()
      ? listed.stdout.trim().split(/\r?\n/).map((line) => object(parseJson(line, "gh api pull request comments"), "gh api pull request comment"))
        .flatMap((row) => typeof row.body === "string" && (typeof row.id === "number" || typeof row.id === "string")
          ? [{ id: String(row.id), body: row.body, createdAt: typeof row.created_at === "string" ? row.created_at : "" }]
          : [])
      : [];
    const canonical = comments.filter((comment) => comment.body.includes("<!-- merro:review-notes -->"))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
    if (!canonical) {
      await this.#commands.run("gh", [
        "pr", "comment", String(pullRequest.number), "--repo", repository.nameWithOwner, "--body", reviewNotes,
      ], { cwd: project.path });
      return;
    }
    if (canonical.body === reviewNotes) return;
    try {
      await this.#commands.run("gh", [
        "api", "--method", "PATCH", `repos/${repository.nameWithOwner}/issues/comments/${canonical.id}`,
        "--field", `body=${reviewNotes}`,
      ], { cwd: project.path });
    } catch {
      await this.#commands.run("gh", [
        "pr", "comment", String(pullRequest.number), "--repo", repository.nameWithOwner, "--body", reviewNotes,
      ], { cwd: project.path });
    }
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

  async hasWritePermission(project: Project, username: string): Promise<boolean> {
    const normalizedUsername = username.trim().toLowerCase();
    if (!normalizedUsername) return false;
    const key = `${project.baseRemote.toLowerCase()}\0${normalizedUsername}`;
    const cached = this.#reviewerPermissionCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const result = (async () => {
      const repository = await this.repository(project.baseRemote);
      const path = `repos/${repository.nameWithOwner}/collaborators/${encodeURIComponent(username)}/permission`;
      try {
        const response = await this.#commands.run("gh", ["api", path], { cwd: project.path });
        const row = object(parseJson(response.stdout, "gh api collaborator permission"), "gh api collaborator permission");
        const permission = typeof row.permission === "string" ? row.permission.toLowerCase() : "none";
        return permission === "write" || permission === "maintain" || permission === "admin";
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    })();
    this.#reviewerPermissionCache.set(key, { expiresAt: Date.now() + 30_000, result });
    try {
      return await result;
    } catch (error) {
      if (this.#reviewerPermissionCache.get(key)?.result === result) this.#reviewerPermissionCache.delete(key);
      throw error;
    }
  }

  async branchProtection(project: Project): Promise<BranchPolicy> {
    const repository = await this.repository(project.baseRemote);
    const branch = encodeURIComponent(project.defaultBranch);
    const classicPath = `repos/${repository.nameWithOwner}/branches/${branch}/protection`;
    const rulesPath = `repos/${repository.nameWithOwner}/rules/branches/${branch}`;
    let classicChecks: string[] = [];
    let classicApprovals = 0;
    let classicCodeOwners = false;
    let dismissStaleApprovals = false;

    try {
      const result = await this.#commands.run("gh", ["api", classicPath], { cwd: project.path });
      const row = object(parseJson(result.stdout, "gh api branch protection"), "gh api branch protection");
      classicChecks = statusCheckNames(row.required_status_checks);
      const reviews = typeof row.required_pull_request_reviews === "object" && row.required_pull_request_reviews !== null
        ? row.required_pull_request_reviews as Record<string, unknown>
        : {};
      classicApprovals = typeof reviews.required_approving_review_count === "number"
        ? reviews.required_approving_review_count
        : 0;
      classicCodeOwners = reviews.require_code_owner_reviews === true;
      dismissStaleApprovals = reviews.dismiss_stale_reviews === true;
    } catch (error) {
      if (!isNotFound(error)) return { known: false, reason: error instanceof Error ? error.message : String(error) };
    }

    try {
      const result = await this.#commands.run("gh", ["api", rulesPath], { cwd: project.path });
      const rules = parseJson(result.stdout, "gh api branch rules");
      if (!Array.isArray(rules)) throw new Error("gh api branch rules returned a non-array value");
      const requiredStatusChecks = [...classicChecks];
      let requiredApprovingReviewCount = classicApprovals;
      let requireCodeOwnerReviews = classicCodeOwners;
      let dismissStale = dismissStaleApprovals;
      for (const value of rules) {
        const rule = object(value, "gh api branch rule");
        const parameters = typeof rule.parameters === "object" && rule.parameters !== null
          ? rule.parameters as Record<string, unknown>
          : {};
        if (rule.type === "required_status_checks") {
          requiredStatusChecks.push(...statusCheckNames({ checks: parameters.required_status_checks }));
        } else if (rule.type === "pull_request") {
          if (typeof parameters.required_approving_review_count === "number") {
            requiredApprovingReviewCount = Math.max(requiredApprovingReviewCount, parameters.required_approving_review_count);
          }
          requireCodeOwnerReviews ||= parameters.require_code_owner_review === true
            || parameters.require_code_owner_reviews === true;
          dismissStale ||= parameters.dismiss_stale_reviews_on_push === true;
        }
      }
      return {
        known: true,
        requiredStatusChecks: [...new Set(requiredStatusChecks)],
        requiredApprovingReviewCount,
        requireCodeOwnerReviews,
        dismissStaleApprovals: dismissStale,
      };
    } catch (error) {
      return { known: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async mergeSquash(project: Project, number: number, expectedHeadCommit: string): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/i.test(expectedHeadCommit)) {
      throw new Error(`invalid expected pull request head SHA: ${expectedHeadCommit}`);
    }
    try {
      const repository = await this.repository(project.baseRemote);
      await this.#commands.run("gh", [
        "pr", "merge", String(number), "--repo", repository.nameWithOwner,
        "--squash", "--match-head-commit", expectedHeadCommit,
      ], { cwd: project.path });
    } catch (error) {
      throw new GitHubMergeError(
        isGitHubAvailabilityFailure(error) ? "unavailable" : "rejected",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }
}
