import { join } from "node:path";
import type { WorkerRoleSettings, WorkerRuntimeKind } from "../config.js";
import type { TaskRole } from "../domain/model.js";
import type { CommandRunner } from "./commands.js";

export type Sandbox = "docker" | "none";

export interface AgentCommandInput {
  role: TaskRole;
  taskId: string;
  settings: WorkerRoleSettings;
  /** Directory holding the staged `tools/` and `protocol/` runtime files, as the agent sees it. */
  runtimeRoot: string;
  /** Task file path as the agent sees it. */
  taskFilePath: string;
  /** Worker-only guidance text, or empty. */
  guidance: string;
  /** Guidance file path as the agent sees it, or null when there is no guidance. */
  guidancePath: string | null;
  /** Environment the agent's result tool needs, passed explicitly to child processes. */
  toolEnvironment: Record<string, string>;
}

/**
 * Agent-specific part of a worker: how the CLI is started and recognized.
 * Lifecycle (tmux, Docker, identity pinning, cleanup) stays in WorkerRuntime so every
 * agent follows launch -> observe -> stop -> collect result identically.
 */
export interface AgentRuntime {
  readonly kind: WorkerRuntimeKind;
  readonly sandboxes: readonly Sandbox[];
  command(input: AgentCommandInput): string[];
  /** True when exactly the expected agent process owns the pane's foreground process group. */
  isForegroundProcess(row: { comm: string; args: string }, input: { taskId: string; currentCommand: string }): boolean;
  /** True when a container's PID 1 command line is this agent. */
  isContainerProcess(commandLine: string): boolean;
  /** Clears one-time interactive prompts after the pane exists. */
  afterLaunch(paneId: string, commands: CommandRunner): Promise<void>;
}

function executable(comm: string): string {
  return comm.split("/").at(-1) ?? comm;
}

export class PiRuntime implements AgentRuntime {
  readonly kind = "pi";
  readonly sandboxes = ["docker", "none"] as const;

  command(input: AgentCommandInput): string[] {
    const { settings, runtimeRoot } = input;
    return [
      "pi", "--no-session", "--tui-mode", "regular", "--approve",
      ...(settings.model ? ["--model", settings.model] : []),
      ...(settings.thinking ? ["--thinking", settings.thinking] : []),
      "--extension", join(runtimeRoot, "tools", "worker-result.js"),
      "--extension", join(runtimeRoot, "tools", "worker-lifecycle.js"),
      ...(input.guidance ? ["--extension", join(runtimeRoot, "tools", "worker-guidance.js")] : []),
      "--", `@${input.taskFilePath}`,
    ];
  }

  isForegroundProcess(row: { comm: string; args: string }, input: { currentCommand: string }): boolean {
    if (!["pi", "node"].includes(input.currentCommand)) return false;
    const argv = row.args.trim().split(/\s+/);
    const name = executable(row.comm);
    return name === "pi" || name === "node" && Boolean(argv[1]
      && (/\/(?:pi|pi\.js)$/.test(argv[1]) || /\/pi-coding-agent\/dist\/cli\.js$/.test(argv[1])));
  }

  isContainerProcess(commandLine: string): boolean {
    return /\b(?:pi|cli\.js)\b/.test(commandLine) && commandLine.includes("--tui-mode regular");
  }

  async afterLaunch(): Promise<void> {}
}

const CLAUDE_EFFORT: Record<string, string> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
const REVIEWER_DENIED = [
  "Edit", "Write", "NotebookEdit",
  ...["add", "commit", "push", "reset", "checkout", "switch", "merge", "rebase", "cherry-pick", "restore", "clean"].map((verb) => `Bash(git ${verb} *)`),
  "Bash(gh pr merge *)", "Bash(gh pr create *)",
];
const IMPLEMENTER_DENIED = ["Bash(git push *)", "Bash(gh pr create *)", "Bash(gh pr merge *)"];

export class ClaudeRuntime implements AgentRuntime {
  readonly kind = "claude";
  // The Claude CLI needs host credentials and the host tmux pane; Docker images only ship Pi.
  readonly sandboxes = ["none"] as const;

  command(input: AgentCommandInput): string[] {
    const { settings, runtimeRoot, role } = input;
    const node = process.execPath;
    const hook = (event: string) => `${shellWord(node)} ${shellWord(join(runtimeRoot, "tools", "claude-hook.js"))} ${event}`;
    const hooks = (command: string, matcher?: string) =>
      [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] }];
    const settingsJson = {
      hooks: {
        UserPromptSubmit: hooks(hook("busy")),
        PreToolUse: hooks(hook("tool"), "*"),
        Stop: hooks(hook("stop")),
      },
    };
    const mcp = {
      mcpServers: {
        merro: { command: node, args: [join(runtimeRoot, "tools", "claude-result-server.js")], env: input.toolEnvironment },
      },
    };
    const allowed = role === "review"
      ? ["Bash", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "mcp__merro"]
      : ["Bash", "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "mcp__merro"];
    const effort = settings.thinking ? CLAUDE_EFFORT[settings.thinking] : undefined;
    return [
      "claude", "--session-id", input.taskId, "--name", `merro-${role === "review" ? "rev" : "impl"}`,
      // dontAsk denies anything outside the allowlist without prompting an unattended worker.
      "--permission-mode", "dontAsk",
      "--allowedTools", allowed.join(","),
      "--disallowedTools", (role === "review" ? REVIEWER_DENIED : IMPLEMENTER_DENIED).join(","),
      "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp),
      "--settings", JSON.stringify(settingsJson),
      ...(settings.model ? ["--model", settings.model] : []),
      ...(effort ? ["--effort", effort] : []),
      ...(input.guidance ? ["--append-system-prompt", input.guidance] : []),
      `Your Merro Task is the file ${input.taskFilePath}. Read it fully, then carry it out exactly. Submit the result with the merro_submit_result tool.`,
    ];
  }

  isForegroundProcess(row: { comm: string; args: string }, input: { taskId: string; currentCommand: string }): boolean {
    const marker = `--session-id ${input.taskId}`;
    const index = row.args.indexOf(marker);
    if (index < 0) return false;
    return /(?:^|[\\/\s])claude(?:\.js|\.exe)?(?:\s|$)/.test(row.args.slice(0, index)) || executable(row.comm) === "claude";
  }

  isContainerProcess(): boolean {
    return false;
  }

  /** Fresh clones raise Claude's folder-trust dialog; the clone is Merro-created, so accept it. */
  async afterLaunch(paneId: string, commands: CommandRunner): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const screen = (await commands.run("tmux", ["capture-pane", "-p", "-t", paneId])).stdout;
      if (/trust this folder|Accessing workspace/i.test(screen)) {
        // The cursor starts on "No, exit"; move only when it is not already on "Yes".
        if (!/❯\s*(?:\d\.\s*)?Yes/.test(screen)) await commands.run("tmux", ["send-keys", "-t", paneId, "Down"]);
        await commands.run("tmux", ["send-keys", "-t", paneId, "Enter"]);
        return;
      }
      // Once the conversation UI appears no dialog is coming.
      if (/\? for shortcuts|esc to interrupt|❯\s*$/m.test(screen) && !/trust/i.test(screen)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function agentRuntime(kind: WorkerRuntimeKind): AgentRuntime {
  return kind === "claude" ? new ClaudeRuntime() : new PiRuntime();
}


