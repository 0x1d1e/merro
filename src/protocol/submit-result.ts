import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { TaskRole } from "../domain/model.js";
import { parseImplementResult, parseReviewResult, type WorkerResult } from "./result.js";
import { publishWorkerState } from "./worker-state.js";

const execFileAsync = promisify(execFile);

export const RESULT_TOOL_NAME = "merro_submit_result";
export const RESULT_TOOL_DESCRIPTION =
  "Submit the final result for this Merro Task. Correct rejected submissions and retry; stop after one accepted submission.";

/** Runtime-neutral input shape; strict validation lives in the result parsers. */
export const RESULT_TOOL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "verification"],
  properties: {
    status: { enum: ["success", "failed", "pass", "reject", "cancelled"] },
    summary: { type: "string" },
    commit: { type: "string" },
    reviewed_commit: { type: "string" },
    reason: { type: "string" },
    diagnostics: { type: "string" },
    verification: { type: "array", items: {} },
    findings: { type: "array", items: {} },
    changes: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
    proposed_issues: {
      type: "array", maxItems: 5,
      items: { type: "object", required: ["title", "body"], properties: { title: { type: "string" }, body: { type: "string" } } },
    },
    dependency_suggestions: {
      type: "array", minItems: 1, maxItems: 10,
      items: {
        type: "object", additionalProperties: false, required: ["project_slug", "issue_number", "gate", "reason"],
        properties: {
          project_slug: { type: "string", maxLength: 63 }, issue_number: { type: "integer", minimum: 1 },
          gate: { enum: ["reviewed", "done"] }, reason: { type: "string", maxLength: 300 },
        },
      },
    },
    pr: {},
  },
} as const;

export interface SubmitResultOptions {
  role: TaskRole;
  taskId: string;
  resultPath: string;
  checkoutPath: string;
}

export async function validateLocalCommit(commit: string, checkoutPath: string): Promise<void> {
  const correction = "Run `git rev-parse HEAD` and submit the exact commit.";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
    throw new Error(`Submitted commit must be a full Git commit ID. ${correction}`);
  }
  let resolved: string;
  try {
    resolved = (await execFileAsync("git", ["rev-parse", "--verify", `${commit}^{commit}`], { cwd: checkoutPath })).stdout.trim();
  } catch {
    throw new Error(`Submitted commit ${commit} does not resolve locally. ${correction}`);
  }
  const head = (await execFileAsync("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: checkoutPath })).stdout.trim();
  if (resolved !== head) {
    throw new Error(`Submitted commit ${commit} does not match worker HEAD ${head}. ${correction}`);
  }
}

/** Validates and atomically publishes the one accepted Task result, whichever runtime produced it. */
export async function submitWorkerResult(args: Record<string, unknown>, options: SubmitResultOptions): Promise<WorkerResult> {
  const artifact = { ...args, task_id: options.taskId };
  const result = options.role === "implement" ? parseImplementResult(artifact) : parseReviewResult(artifact);
  // Failed implementers may report an unusable checkout; preserve that failure contract.
  if ("reviewed_commit" in result || result.status === "success") {
    await validateLocalCommit("reviewed_commit" in result ? result.reviewed_commit : result.commit, options.checkoutPath);
  }
  await mkdir(dirname(options.resultPath), { recursive: true });
  const temporaryPath = `${options.resultPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await link(temporaryPath, options.resultPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  await publishWorkerState(join(dirname(options.resultPath), "worker-state.json"), "finished", "Result submitted");
  return result;
}

export interface WorkerEnvironment { role: TaskRole; taskId: string; resultPath: string }

/** Reads and validates the Merro-controlled worker environment shared by every runtime. */
export function workerEnvironment(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): WorkerEnvironment {
  const role = env.MERRO_TASK_ROLE;
  const resultPath = env.MERRO_RESULT_PATH;
  if (role !== "implement" && role !== "review") throw new Error("MERRO_TASK_ROLE must be implement or review");
  if (env.MERRO_RUNTIME !== "worker") throw new Error("MERRO_RUNTIME must be worker");
  const scratchPath = env.MERRO_TASK_SCRATCH ?? "";
  const checkoutRelative = resultPath ? relative(cwd, resolve(resultPath)) : "";
  const outsideCheckout = checkoutRelative === ".." || checkoutRelative.startsWith(`..${sep}`) || isAbsolute(checkoutRelative);
  if (!resultPath || !isAbsolute(resultPath) || !scratchPath || !isAbsolute(scratchPath)
    || basename(resolve(resultPath)) !== ".merro-result.json"
    || resolve(resultPath) !== join(resolve(scratchPath), ".merro-result.json")
    || !outsideCheckout) {
    throw new Error("MERRO_RESULT_PATH must be the Task scratch result outside the checkout");
  }
  return { role, taskId: env.MERRO_TASK_ID ?? "", resultPath };
}
