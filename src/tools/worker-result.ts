import { Type } from "typebox";
import type { TaskRole } from "../domain/model.js";
import { RESULT_TOOL_DESCRIPTION, RESULT_TOOL_NAME, submitWorkerResult, workerEnvironment } from "../protocol/submit-result.js";

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
  proposed_issues: Type.Optional(Type.Array(Type.Object({ title: Type.String(), body: Type.String() }), { maxItems: 5 })),
  pr: Type.Optional(Type.Any()),
}, { additionalProperties: false });

export interface WorkerResultToolOptions {
  role: TaskRole;
  resultPath: string;
  checkoutPath?: string;
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
    name: RESULT_TOOL_NAME,
    label: "Submit Task result",
    description: RESULT_TOOL_DESCRIPTION,
    parameters,
    async execute(_toolCallId, args) {
      const taskId = typeof process.env.MERRO_TASK_ID === "string" ? process.env.MERRO_TASK_ID : "";
      if (!taskId) throw new Error("MERRO_TASK_ID is missing");
      const result = await submitWorkerResult(args, {
        role: options.role, taskId, resultPath: options.resultPath, checkoutPath: options.checkoutPath ?? process.cwd(),
      });
      return {
        content: [{ type: "text", text: "Result submitted. Finished." }],
        details: { role: options.role, status: result.status },
        terminate: true,
      };
    },
  });
}

export default function merroWorker(pi: WorkerResultToolAPI): void {
  const { role, resultPath } = workerEnvironment();
  registerWorkerResultTool(pi, { role, resultPath, checkoutPath: process.cwd() });
}
