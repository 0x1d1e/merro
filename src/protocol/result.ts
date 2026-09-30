export type Verification =
  | { kind: "command"; project: string; cwd: string; command: string; exit_code: number }
  | { kind: "manual"; project: string; summary: string };

export interface ReviewFinding {
  severity: "blocking" | "non-blocking" | "note";
  summary: string;
  file?: string;
  line_start?: number;
  line_end?: number;
}

export interface ImplementSuccessResult {
  task_id: string;
  status: "success";
  summary: string;
  commit: string;
  verification: Verification[];
  pr?: { title: string; body: string };
}

export interface ImplementFailedResult {
  task_id: string;
  status: "failed";
  summary: string;
  reason: string;
  diagnostics?: string;
  verification: Verification[];
}

export interface ReviewResult {
  task_id: string;
  status: "pass" | "reject";
  summary: string;
  reviewed_commit: string;
  findings: ReviewFinding[];
  verification: Verification[];
}

export interface ReviewFailedResult {
  task_id: string;
  status: "failed";
  summary: string;
  reason: string;
  reviewed_commit: string;
  findings: ReviewFinding[];
  verification: Verification[];
}

export type WorkerResult = ImplementSuccessResult | ImplementFailedResult | ReviewResult | ReviewFailedResult;

export class ResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResultValidationError";
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResultValidationError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ResultValidationError(`${name} must be a non-empty string`);
  }
  return value;
}

function verificationList(value: unknown): Verification[] {
  if (!Array.isArray(value)) throw new ResultValidationError("verification must be an array");
  return value.map((entry, index) => {
    const row = object(entry, `verification[${index}]`);
    if (row.kind === "command") {
      if (typeof row.exit_code !== "number" || !Number.isInteger(row.exit_code)) {
        throw new ResultValidationError(`verification[${index}].exit_code must be an integer`);
      }
      return {
        kind: "command",
        project: text(row.project, `verification[${index}].project`),
        cwd: text(row.cwd, `verification[${index}].cwd`),
        command: text(row.command, `verification[${index}].command`),
        exit_code: row.exit_code,
      };
    }
    if (row.kind === "manual") {
      return {
        kind: "manual",
        project: text(row.project, `verification[${index}].project`),
        summary: text(row.summary, `verification[${index}].summary`),
      };
    }
    throw new ResultValidationError(`verification[${index}].kind is invalid`);
  });
}

function assertSuccessfulVerification(verification: readonly Verification[], status: "success" | "pass"): void {
  const failed = verification.find((entry) => entry.kind === "command" && entry.exit_code !== 0);
  if (failed && failed.kind === "command") {
    throw new ResultValidationError(`${status} result contains failing verification: ${failed.command} exited ${failed.exit_code}`);
  }
}

function findings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) throw new ResultValidationError("findings must be an array");
  return value.map((entry, index) => {
    const row = object(entry, `findings[${index}]`);
    if (row.severity !== "blocking" && row.severity !== "non-blocking" && row.severity !== "note") {
      throw new ResultValidationError(`findings[${index}].severity is invalid`);
    }
    const finding: ReviewFinding = {
      severity: row.severity,
      summary: text(row.summary, `findings[${index}].summary`),
    };
    if (row.file !== undefined) finding.file = text(row.file, `findings[${index}].file`);
    if (row.line_start !== undefined) {
      if (!Number.isInteger(row.line_start) || Number(row.line_start) < 1) {
        throw new ResultValidationError(`findings[${index}].line_start must be a positive integer`);
      }
      finding.line_start = Number(row.line_start);
    }
    if (row.line_end !== undefined) {
      if (!Number.isInteger(row.line_end) || Number(row.line_end) < 1) {
        throw new ResultValidationError(`findings[${index}].line_end must be a positive integer`);
      }
      finding.line_end = Number(row.line_end);
    }
    if (finding.line_start !== undefined && finding.line_end !== undefined && finding.line_end < finding.line_start) {
      throw new ResultValidationError(`findings[${index}] line range is reversed`);
    }
    return finding;
  });
}

export function parseImplementResult(value: unknown): ImplementSuccessResult | ImplementFailedResult {
  const row = object(value, "result");
  const task_id = text(row.task_id, "task_id");
  const summary = text(row.summary, "summary");
  const verification = verificationList(row.verification);

  if (row.status === "success") {
    assertSuccessfulVerification(verification, "success");
    const result: ImplementSuccessResult = {
      task_id,
      status: "success",
      summary,
      commit: text(row.commit, "commit"),
      verification,
    };
    if (row.pr !== undefined) {
      const pr = object(row.pr, "pr");
      result.pr = { title: text(pr.title, "pr.title"), body: text(pr.body, "pr.body") };
    }
    return result;
  }

  if (row.status === "failed") {
    const result: ImplementFailedResult = {
      task_id,
      status: "failed",
      summary,
      reason: text(row.reason, "reason"),
      verification,
    };
    if (row.diagnostics !== undefined) result.diagnostics = text(row.diagnostics, "diagnostics");
    return result;
  }

  throw new ResultValidationError("implement result status must be success or failed");
}

export function parseReviewResult(value: unknown): ReviewResult | ReviewFailedResult {
  const row = object(value, "result");
  const task_id = text(row.task_id, "task_id");
  const summary = text(row.summary, "summary");
  const parsedFindings = findings(row.findings);
  const verification = verificationList(row.verification);
  const reviewed_commit = text(row.reviewed_commit, "reviewed_commit");

  if (row.status === "failed") {
    return {
      task_id,
      status: "failed",
      summary,
      reason: text(row.reason, "reason"),
      reviewed_commit,
      findings: parsedFindings,
      verification,
    };
  }

  if (row.status !== "pass" && row.status !== "reject") {
    throw new ResultValidationError("review result status must be pass, reject, or failed");
  }

  const hasBlocking = parsedFindings.some((finding) => finding.severity === "blocking");
  if (row.status === "pass" && hasBlocking) {
    throw new ResultValidationError("review pass cannot contain a blocking finding");
  }
  if (row.status === "reject" && !hasBlocking) {
    throw new ResultValidationError("review reject requires at least one blocking finding");
  }
  if (row.status === "pass") {
    assertSuccessfulVerification(verification, "pass");
  }

  return {
    task_id,
    status: row.status,
    summary,
    reviewed_commit,
    findings: parsedFindings,
    verification,
  };
}

export function assertResultMatchesTask(input: {
  expectedTaskId: string;
  expectedCommit?: string;
  result: WorkerResult;
}): void {
  if (input.result.task_id !== input.expectedTaskId) {
    throw new ResultValidationError(`task_id mismatch: expected ${input.expectedTaskId}, found ${input.result.task_id}`);
  }
  if (input.expectedCommit && "reviewed_commit" in input.result && input.result.reviewed_commit !== input.expectedCommit) {
    throw new ResultValidationError(`reviewed_commit mismatch: expected ${input.expectedCommit}, found ${input.result.reviewed_commit}`);
  }
  if (input.expectedCommit && "commit" in input.result && input.result.commit !== input.expectedCommit) {
    throw new ResultValidationError(`commit mismatch: expected ${input.expectedCommit}, found ${input.result.commit}`);
  }
}
