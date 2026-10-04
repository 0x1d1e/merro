import { createInterface } from "node:readline";
import {
  RESULT_TOOL_DESCRIPTION, RESULT_TOOL_JSON_SCHEMA, RESULT_TOOL_NAME, submitWorkerResult, workerEnvironment,
} from "../protocol/submit-result.js";

/**
 * Minimal MCP stdio server exposing the Task result tool to Claude workers.
 * It shares submitWorkerResult with the Pi extension so both runtimes enforce one result contract.
 */
interface Request { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> }

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

export async function handle(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown> | null> {
  if (request.id === undefined) return null; // notifications need no reply
  const id = request.id;
  const checkoutPath = env.MERRO_CHECKOUT_PATH ?? process.cwd();
  switch (request.method) {
    case "initialize":
      return {
        id,
        result: {
          protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "merro", version: "1" },
        },
      };
    case "ping":
      return { id, result: {} };
    case "tools/list":
      return { id, result: { tools: [{ name: RESULT_TOOL_NAME, description: RESULT_TOOL_DESCRIPTION, inputSchema: RESULT_TOOL_JSON_SCHEMA }] } };
    case "tools/call": {
      if (request.params?.name !== RESULT_TOOL_NAME) return { id, error: { code: -32602, message: "Unknown tool" } };
      try {
        const worker = workerEnvironment(env, checkoutPath);
        if (!worker.taskId) throw new Error("MERRO_TASK_ID is missing");
        const args = request.params.arguments;
        if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("Result arguments must be an object");
        await submitWorkerResult(args as Record<string, unknown>, { ...worker, checkoutPath });
        return { id, result: { content: [{ type: "text", text: "Result submitted. Finished." }] } };
      } catch (error) {
        // Rejected submissions are returned to the model so it can correct and retry.
        return { id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } };
      }
    }
    default:
      return { id, error: { code: -32601, message: `Method not found: ${request.method}` } };
  }
}

export function serve(): void {
  const lines = createInterface({ input: process.stdin });
  let queue: Promise<void> = Promise.resolve();
  lines.on("line", (line) => {
    queue = queue.then(async () => {
      if (!line.trim()) return;
      let request: Request;
      try {
        request = JSON.parse(line) as Request;
      } catch {
        send({ id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      const response = await handle(request);
      if (response) send(response);
    });
  });
  lines.on("close", () => { void queue.then(() => process.exit(0)); });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) serve();
