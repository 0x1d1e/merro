import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Project } from "../src/domain/model.js";
import { ClaudeRuntime, PiRuntime } from "../src/runtime/agent-runtime.js";
import type { CommandRunner } from "../src/runtime/commands.js";
import { WorkerRuntime } from "../src/runtime/worker-runtime.js";
import { handle } from "../src/tools/claude-result-server.js";
import { runHook } from "../src/tools/claude-hook.js";

const execFileAsync = promisify(execFile);
const TASK_ID = "4ef853a8-7018-4624-bf63-26d30307f5f1";

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  assert.ok(index >= 0, `${name} missing`);
  return args[index + 1]!;
}

const baseInput = {
  taskId: TASK_ID, runtimeRoot: "/runtime", taskFilePath: "/clone/.merro-task.md", guidance: "", guidancePath: null,
  toolEnvironment: { MERRO_TASK_ID: TASK_ID },
};

test("Claude command carries model, effort, session identity, MCP result tool and hooks", () => {
  const args = new ClaudeRuntime().command({
    ...baseInput, role: "review", settings: { runtime: "claude", model: "claude-sonnet-5", thinking: "high" }, guidance: "Scoped context.",
  });
  assert.equal(args[0], "claude");
  assert.equal(flag(args, "--model"), "claude-sonnet-5");
  assert.equal(flag(args, "--effort"), "high");
  assert.equal(flag(args, "--session-id"), TASK_ID);
  assert.equal(flag(args, "--permission-mode"), "dontAsk");
  assert.equal(flag(args, "--append-system-prompt"), "Scoped context.");
  assert.ok(args.includes("--strict-mcp-config"));
  const mcp = JSON.parse(flag(args, "--mcp-config")) as { mcpServers: { merro: { args: string[]; env: Record<string, string> } } };
  assert.deepEqual(mcp.mcpServers.merro.args, ["/runtime/tools/claude-result-server.js"]);
  assert.equal(mcp.mcpServers.merro.env.MERRO_TASK_ID, TASK_ID);
  const settings = JSON.parse(flag(args, "--settings")) as { hooks: Record<string, unknown> };
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["PreToolUse", "Stop", "UserPromptSubmit"]);
  const allowed = flag(args, "--allowedTools").split(",");
  assert.ok(allowed.includes("mcp__merro") && !allowed.includes("Edit") && !allowed.includes("Write"));
  assert.ok(flag(args, "--disallowedTools").includes("Edit"));
  assert.match(args.at(-1)!, /\/clone\/\.merro-task\.md/);
});

test("Claude implementer may edit but not publish; unset model and effort use Claude defaults", () => {
  const args = new ClaudeRuntime().command({ ...baseInput, role: "implement", settings: { runtime: "claude", model: null, thinking: null } });
  assert.ok(!args.includes("--model") && !args.includes("--effort") && !args.includes("--append-system-prompt"));
  assert.ok(flag(args, "--allowedTools").split(",").includes("Edit"));
  const denied = flag(args, "--disallowedTools");
  assert.ok(denied.includes("git push") && !denied.includes("Edit"));
});

test("Pi command keeps its extension and thinking flags", () => {
  const args = new PiRuntime().command({ ...baseInput, role: "implement", settings: { runtime: "pi", model: "m", thinking: "max" }, guidance: "x" });
  assert.deepEqual(args.slice(0, 5), ["pi", "--no-session", "--tui-mode", "regular", "--approve"]);
  assert.equal(flag(args, "--thinking"), "max");
  assert.ok(args.includes("/runtime/tools/worker-guidance.js"));
});

test("Claude process identity requires the exact Task session id", () => {
  const claude = new ClaudeRuntime();
  const row = { comm: "claude", args: `/opt/claude-code/bin/claude --session-id ${TASK_ID} --model x hi` };
  assert.equal(claude.isForegroundProcess(row, { taskId: TASK_ID, currentCommand: "claude" }), true);
  assert.equal(claude.isForegroundProcess(row, { taskId: "other", currentCommand: "claude" }), false);
  assert.equal(claude.isForegroundProcess({ comm: "pi", args: "pi --no-session" }, { taskId: TASK_ID, currentCommand: "pi" }), false);
});

test("Claude trust dialog is accepted only by moving off the default No", async () => {
  const keys: string[][] = [];
  const screens = ["loading", " Do you trust this folder?\n ❯ 1. No, exit\n   2. Yes, I trust this folder"];
  const commands: CommandRunner = {
    async run(file, args) {
      assert.equal(file, "tmux");
      if (args[0] === "capture-pane") return { stdout: screens.length > 1 ? screens.shift()! : screens[0]!, stderr: "" };
      keys.push([...args]);
      return { stdout: "", stderr: "" };
    },
  };
  await new ClaudeRuntime().afterLaunch("%1", commands);
  assert.deepEqual(keys.map((key) => key.at(-1)), ["Down", "Enter"]);
});

test("Claude launch is host-only, records its agent and pins identity to the Task session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-claude-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clonePath = join(root, "clone");
  const workspacePath = join(root, "runtime");
  await mkdir(clonePath);
  const project: Project = { slug: "p", path: root, baseRemote: "https://github.com/e/p.git", pushRemote: "https://github.com/e/p.git", defaultBranch: "main" };
  let script = "";
  let sessionExists = false;
  const commands: CommandRunner = {
    async run(file, args) {
      if (file === "tmux") {
        if (args[0] === "has-session") { if (!sessionExists) throw new Error("no such session"); return { stdout: "", stderr: "" }; }
        if (args[0] === "show-option") {
          return { stdout: args.at(-1) === "@merro_task_id" ? TASK_ID : args.at(-1) === "@merro_project" ? "p\n" : await readFile(join(workspacePath, "workspace-owner"), "utf8"), stderr: "" };
        }
        if (args[0] === "new-session" || args[0] === "new-window") {
          sessionExists = true;
          script = String(args[args.indexOf("-c") + 2]).slice(6, -1);
          return { stdout: "%3\n", stderr: "" };
        }
        if (args[0] === "capture-pane") return { stdout: "? for shortcuts", stderr: "" };
        if (args[0] === "display-message") {
          return { stdout: args.at(-1) === "#{window_id}" ? "@3" : args.at(-1) === "#{pane_pid}" ? "321\n" : "%3\t321\t0\tclaude\tmerro-p\trev-x\t@3\t1\t\t\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }
      if (file === "ps") {
        if (args.at(-1) === "tpgid=") return { stdout: "321", stderr: "" };
        if (args[0] === "-eo") return { stdout: `321 321 claude /opt/claude-code/bin/claude --session-id ${TASK_ID} hi`, stderr: "" };
        return { stdout: "Thu Jan 1 00:00:00 2026\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    },
  };
  const claudeConfig = {
    ...DEFAULT_CONFIG,
    workers: {
      implementer: { runtime: "pi", model: "gpt-6-luna", thinking: "max" },
      reviewer: { runtime: "claude", model: "claude-sonnet-5", thinking: "high" },
    },
  } as const;
  const runtime = new WorkerRuntime({ workspacePath, config: { ...claudeConfig }, commands });
  const input = {
    taskId: TASK_ID, changeSetId: "c1", changeSlug: "x", taskName: "review-x", role: "review", project, clonePath,
    taskFile: "Review.", expectedCommit: "a".repeat(40), projectSettings: null,
  } as const;
  const record = await runtime.launch(input);
  assert.equal(record.agent, "claude");
  const body = await readFile(script, "utf8");
  assert.ok(body.includes("'--session-id' '" + TASK_ID + "'") || body.includes(`'--session-id' '${TASK_ID}'`));
  assert.ok(body.includes(`export MERRO_CHECKOUT_PATH='${clonePath}'`));
  assert.ok(!body.includes("'pi'"));
  assert.equal((await runtime.inspect(record, TASK_ID)).identityMatches, true);
  assert.equal((await runtime.inspect({ ...record, agent: "pi" }, TASK_ID)).identityMatches, false);

  const implementer = await runtime.launch({ ...input, taskId: "pi-task", role: "implement", taskName: "implement-x" }).catch((error: unknown) => error);
  assert.equal((implementer as { agent?: string }).agent ?? "launch-failed", "pi");

  const docker = new WorkerRuntime({ workspacePath, config: { ...claudeConfig, sandbox: "docker" }, commands });
  assert.throws(() => docker.plan(input), /runtime=claude does not support sandbox=docker/);
});

test("result MCP server lists and submits through the shared result contract", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clone = join(root, "clone");
  const scratch = join(root, "scratch");
  await mkdir(clone);
  await mkdir(scratch);
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: clone });
  await execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: clone });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: clone })).stdout.trim();
  const env = {
    MERRO_RUNTIME: "worker", MERRO_TASK_ID: TASK_ID, MERRO_TASK_ROLE: "implement", MERRO_CHECKOUT_PATH: clone,
    MERRO_RESULT_PATH: join(scratch, ".merro-result.json"), MERRO_TASK_SCRATCH: scratch,
  };

  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, env);
  assert.equal((init?.result as { protocolVersion: string }).protocolVersion, "2025-03-26");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, env), null);
  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, env);
  assert.equal((list?.result as { tools: Array<{ name: string }> }).tools[0]?.name, "merro_submit_result");

  const bad = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "merro_submit_result", arguments: { status: "success", summary: "s", verification: [] } } }, env);
  assert.equal((bad?.result as { isError?: boolean }).isError, true);
  await assert.rejects(readFile(env.MERRO_RESULT_PATH), { code: "ENOENT" });

  const ok = await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "merro_submit_result", arguments: {
    status: "success", summary: "done", commit: head, changes: ["Did it."],
    verification: [{ kind: "command", project: "p", cwd: ".", command: "npm test", exit_code: 0 }],
    proposed_issues: [{ title: "Follow up", body: "Later." }],
  } } }, env);
  assert.equal((ok?.result as { isError?: boolean }).isError, undefined, JSON.stringify(ok));
  const stored = JSON.parse(await readFile(env.MERRO_RESULT_PATH, "utf8")) as { task_id: string; proposed_issues: unknown[] };
  assert.equal(stored.task_id, TASK_ID);
  assert.equal(stored.proposed_issues.length, 1);
  assert.equal((await handle({ jsonrpc: "2.0", id: 5, method: "nope" }, env))?.error !== undefined, true);
});

test("Claude hooks mirror lifecycle into worker state and end a finished session", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "merro-hook-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const env = { MERRO_RUNTIME: "worker", MERRO_RESULT_PATH: join(scratch, ".merro-result.json") };
  const state = async () => JSON.parse(await readFile(join(scratch, "worker-state.json"), "utf8")) as { state: string; lastActivity: string };
  await runHook("busy", "", env);
  assert.equal((await state()).state, "busy");
  await runHook("tool", JSON.stringify({ tool_name: "Bash" }), env);
  assert.equal((await state()).lastActivity, "Using Bash");
  await runHook("stop", "", env, 0);
  assert.equal((await state()).state, "idle");
  await writeFile(join(scratch, "worker-state.json"), JSON.stringify({ state: "finished", lastActivity: "Result submitted", updatedAt: "x" }));
  const killed: Array<[number, string]> = [];
  const original = process.kill;
  process.kill = ((pid: number, signal: string) => { killed.push([pid, signal]); return true; }) as typeof process.kill;
  try { await runHook("stop", "", env, 4242); } finally { process.kill = original; }
  assert.deepEqual(killed, [[4242, "SIGTERM"]]);
  await runHook("busy", "", { ...env, MERRO_RUNTIME: "main" });
  assert.equal((await state()).state, "finished");
});
