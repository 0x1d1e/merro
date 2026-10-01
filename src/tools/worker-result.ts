import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";
import { parseImplementResult, parseReviewResult } from "../protocol/result.js";
import type { TaskRole } from "../domain/model.js";

const verificationSchema = Type.Array(Type.Any());
const parameters = Type.Object({
  task_id: Type.String(),
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
  pr: Type.Optional(Type.Any()),
}, { additionalProperties: false });

export interface WorkerResultToolOptions {
  role: TaskRole;
  resultPath: string;
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
    description: "Submit the final validated result for this Merro Task. Call exactly once after completing or failing the Task.",
    parameters,
    async execute(_toolCallId, args) {
      const taskId = typeof process.env.MERRO_TASK_ID === "string" ? process.env.MERRO_TASK_ID : "";
      if (!taskId) throw new Error("MERRO_TASK_ID is missing");
      const result = options.role === "implement" ? parseImplementResult(args) : parseReviewResult(args);
      if (result.task_id !== taskId) {
        throw new Error(`task_id mismatch: worker Task is ${taskId}, submitted result is for ${result.task_id}`);
      }
      await mkdir(dirname(options.resultPath), { recursive: true });
      const temporaryPath = `${options.resultPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await link(temporaryPath, options.resultPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
      return {
        content: [{ type: "text", text: `Result submitted for Task ${result.task_id}. Stop now.` }],
        details: { taskId: result.task_id, role: options.role },
        terminate: true,
      };
    },
  });
}

export default function merroWorker(pi: WorkerResultToolAPI): void {
  const role = process.env.MERRO_TASK_ROLE;
  const resultPath = process.env.MERRO_RESULT_PATH;
  if (role !== "implement" && role !== "review") throw new Error("MERRO_TASK_ROLE must be implement or review");
  if (!resultPath) throw new Error("MERRO_RESULT_PATH is missing");
  registerWorkerResultTool(pi, { role, resultPath });
}
