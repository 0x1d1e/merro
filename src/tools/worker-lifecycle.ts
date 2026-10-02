import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { publishWorkerState, type WorkerState } from "../protocol/worker-state.js";

interface Context {
  isIdle(): boolean;
  shutdown(): void;
  ui?: { notify(message: string, level: "warning"): void };
}
interface LifecycleAPI {
  on(event: "agent_start" | "agent_settled" | "turn_end" | "input" | "user_bash", handler: (event: { source?: string; toolResults?: Array<{ toolName?: string }> }, ctx: Context) => unknown): void;
}

export default function merroWorkerLifecycle(pi: LifecycleAPI): void {
  if (process.env.MERRO_RUNTIME !== "worker") return;
  const result = process.env.MERRO_RESULT_PATH;
  if (!result) throw new Error("Worker result path is missing.");
  const path = join(dirname(result), "worker-state.json");
  pi.on("agent_start", async () => { await publishWorkerState(path, "busy", "Working"); });
  pi.on("turn_end", async (event) => {
    const tools = event.toolResults?.map((result) => result.toolName).filter(Boolean).join(", ");
    await publishWorkerState(path, "busy", tools ? `Using ${tools}` : "Thinking");
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const state = JSON.parse(await readFile(path, "utf8")) as WorkerState;
    if (state.state === "finished") { ctx.shutdown(); return; }
    if (ctx.isIdle()) await publishWorkerState(path, "idle", "Waiting for a result");
  });
  // Pi labels its initial CLI @file prompt as interactive too.
  let taskAccepted = false;
  pi.on("input", (event, ctx) => {
    if (!taskAccepted) { taskAccepted = true; return; }
    if (event.source !== "interactive") return;
    ctx.ui?.notify("This worker has one task. Stop the attempt in Main to change requirements.", "warning");
    return { action: "handled" };
  });
  // Watching a worker is supported; direct shell intervention is not.
  pi.on("user_bash", () => { throw new Error("Worker intervention is disabled. Stop the attempt in Main instead."); });
}
