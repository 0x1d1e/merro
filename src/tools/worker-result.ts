import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { parseImplementResult, parseReviewResult } from "../protocol/result.js";
import type { TaskRole } from "../domain/model.js";
import { publishWorkerState } from "../protocol/worker-state.js";

const verificationSchema = Type.Array(Type.Any());
const parameters = Type.Object({
  status: Type.Union([
    Type.Literal("success"), Type.Literal("failed"),
    Type.Literal("pass"), Type.Literal("reject"), Type.Literal("cancelled"),
  ]),
  summary: Type.String(),
  commit: Type.Optional(Type.String()),
  reviewed_commit: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  diagnostics: Type.Optional(Type.String()),
  verification: verificationSchema,
  findings: Type.Optional(Type.Array(Type.Any())),
  changes: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 20 })),
  dependency_suggestions: Type.Optional(Type.Array(Type.Object({
    project_slug: Type.String({ maxLength: 63 }),
    issue_number: Type.Integer({ minimum: 1 }),
    gate: Type.Union([Type.Literal("reviewed"), Type.Literal("done")]),
    reason: Type.String({ maxLength: 300 }),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 10 })),
  pr: Type.Optional(Type.Any()),
}, { additionalProperties: false });

export interface WorkerResultToolOptions {
  role: TaskRole;
  resultPath: string;
  checkoutPath?: string;
}

const execFileAsync = promisify(execFile);

async function validateLocalCommit(commit: string, checkoutPath: string): Promise<void> {
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

export interface WorkerResultToolAPI {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: typeof parameters;
    execute: (
      toolCallId: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (update: unknown) => void,
      context?: unknown,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; terminate: true }>;
  }): void;
}

export function registerWorkerResultTool(pi: WorkerResultToolAPI, options: WorkerResultToolOptions): void {
  pi.registerTool({
    name: "merro_submit_result",
    label: "Submit Task result",
    description: "Submit the final result for this Merro Task. Correct rejected submissions and retry; stop after one accepted submission.",
    parameters,
    async execute(_toolCallId, args) {
      const taskId = typeof process.env.MERRO_TASK_ID === "string" ? process.env.MERRO_TASK_ID : "";
      if (!taskId) throw new Error("MERRO_TASK_ID is missing");
      const artifact = { ...args, task_id: taskId };
      const result = options.role === "implement" ? parseImplementResult(artifact) : parseReviewResult(artifact);
      // Failed implementers may report an unusable checkout; preserve that failure contract.
      if ("reviewed_commit" in result || result.status === "success") {
        await validateLocalCommit("reviewed_commit" in result ? result.reviewed_commit : result.commit,
          options.checkoutPath ?? process.cwd());
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
      return {
        content: [{ type: "text", text: "Result submitted. Finished." }],
        details: { role: options.role, status: result.status },
        terminate: true,
      };
    },
  });
}

export default function merroWorker(pi: WorkerResultToolAPI): void {
  const role = process.env.MERRO_TASK_ROLE;
  const resultPath = process.env.MERRO_RESULT_PATH;
  if (role !== "implement" && role !== "review") throw new Error("MERRO_TASK_ROLE must be implement or review");
  if (process.env.MERRO_RUNTIME !== "worker") throw new Error("MERRO_RUNTIME must be worker");
  const scratchPath = process.env.MERRO_TASK_SCRATCH ?? "";
  const checkoutRelative = resultPath ? relative(process.cwd(), resolve(resultPath)) : "";
  const outsideCheckout = checkoutRelative === ".." || checkoutRelative.startsWith(`..${sep}`) || isAbsolute(checkoutRelative);
  if (!resultPath || !isAbsolute(resultPath) || !scratchPath || !isAbsolute(scratchPath)
    || basename(resolve(resultPath)) !== ".merro-result.json"
    || resolve(resultPath) !== join(resolve(scratchPath), ".merro-result.json")
    || !outsideCheckout) {
    throw new Error("MERRO_RESULT_PATH must be the Task scratch result outside the checkout");
  }
  registerWorkerResultTool(pi, { role, resultPath, checkoutPath: process.cwd() });
}
