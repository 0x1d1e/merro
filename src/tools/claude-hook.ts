import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { publishWorkerState, type WorkerState } from "../protocol/worker-state.js";

/**
 * Claude Code hook that mirrors Pi's lifecycle events into worker-state.json.
 * Usage: claude-hook.js busy|tool|stop. Claude runs hooks as direct children, so process.ppid is Claude.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(event: string, input: string, env: NodeJS.ProcessEnv = process.env, parent = process.ppid): Promise<void> {
  if (env.MERRO_RUNTIME !== "worker" || !env.MERRO_RESULT_PATH) return;
  const path = join(dirname(env.MERRO_RESULT_PATH), "worker-state.json");
  if (event === "busy") {
    await publishWorkerState(path, "busy", "Working");
  } else if (event === "tool") {
    let tool = "";
    try { tool = String((JSON.parse(input) as { tool_name?: unknown }).tool_name ?? ""); } catch { /* unreadable payload only loses the label */ }
    await publishWorkerState(path, "busy", tool ? `Using ${tool.replace(/^mcp__merro__/, "")}` : "Thinking");
  } else if (event === "stop") {
    const state = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as Partial<WorkerState>;
    if (state.state === "finished") {
      // A finished worker has one task; end the session as Pi's lifecycle extension does.
      process.kill(parent, "SIGTERM");
      return;
    }
    await publishWorkerState(path, "idle", "Waiting for a result");
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const event = process.argv[2] ?? "";
  runHook(event, event === "tool" ? await readStdin() : "").catch((error: unknown) => {
    console.error(`merro hook failed: ${String(error)}`);
    process.exitCode = 0; // never block the agent on telemetry
  });
}
