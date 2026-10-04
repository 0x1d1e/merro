import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { MainOrchestrator } from "../src/runtime/main.js";
import { MainLock } from "../src/runtime/main-lock.js";
import { initializedState } from "./fixtures.js";
import { type PiExtensionLike, registerCommands } from "../src/tools/commands.js";

type CommandConfig = Parameters<PiExtensionLike["registerCommand"]>[1];

async function tempDirectory(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "merro-commands-"));
  await initializedState(cwd);
  return cwd;
}

function commandRegistry(cwd: string, main?: MainOrchestrator): Map<string, CommandConfig> {
  const commands = new Map<string, CommandConfig>();
  registerCommands({ registerCommand(name, config) { commands.set(name, config); } }, cwd, main);
  return commands;
}

test("only /merro is registered, with or without Main", () => {
  for (const main of [undefined, {} as MainOrchestrator]) {
    assert.deepEqual([...commandRegistry("/unused", main).keys()], ["merro"]);
  }
});

test("/merro and /merro status serialize state access and show workspace status", async (t) => {
  const cwd = await tempDirectory();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const merro = commandRegistry(cwd).get("merro")!;
  for (const args of ["", "status"]) {
    const messages: string[] = [];
    await merro.handler(args, { ui: { notify: (message) => messages.push(message) } });
    assert.match(messages[0] ?? "", /No Merro work yet\./);
  }
});

test("/merro export writes status without shadowing Pi's built-in export", async (t) => {
  const cwd = await tempDirectory();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const commands = commandRegistry(cwd);
  assert.equal(commands.has("export"), false);
  const messages: string[] = [];
  await commands.get("merro")!.handler("export", { ui: { notify: (message) => messages.push(message) } });
  const snapshot = JSON.parse(await readFile(join(cwd, ".merro", "export.json"), "utf8"));
  assert.deepEqual(snapshot.projects, []);
  assert.ok(messages[0]?.includes(".merro/export.json"));
});

test("/merro unlock does not release a live Main lock", async (t) => {
  const cwd = await tempDirectory();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const lock = new MainLock(join(cwd, ".merro", "main.lock.db"));
  await lock.acquire();
  t.after(() => lock.release());
  const messages: string[] = [];
  await commandRegistry(cwd).get("merro")!.handler("unlock", { ui: { notify: (message) => messages.push(message) } });
  assert.match(messages[0] ?? "", /already holds the workspace lock/);
  assert.ok(lock.owner);
});

test("/merro config displays current effective settings and edit path without writing or taking Main's lock", async (t) => {
  const cwd = await tempDirectory();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, ".merro", "config.json");
  const notifyCommand = "notify 11111111-2222-4333-8444-555555555555";
  const original = `${JSON.stringify({ workers: { reviewer: { model: "openai/reviewer" } }, tmux: {}, notifyCommand: notifyCommand })}\n`;
  await writeFile(path, original);
  const lock = new MainLock(join(cwd, ".merro", "main.lock.db"));
  await lock.acquire();
  t.after(() => lock.release());
  const messages: string[] = [];
  const merro = commandRegistry(cwd).get("merro")!;
  await merro.handler("config", { ui: { notify: (message) => messages.push(message) } });
  assert.equal(messages[0], `Config: ${path}

Overrides

workers.reviewer
  model  openai/reviewer

notifyCommand  notify 11111111-2222-4333-8444-555555555555

Everything else uses Merro defaults.

Show all: /merro config --all`);
  assert.equal(await readFile(path, "utf8"), original);
  await writeFile(path, "{}");
  await merro.handler("config", { ui: { notify: (message) => messages.push(message) } });
  assert.match(messages[1]!, /No overrides\. Everything uses Merro defaults\./);
  await merro.handler("config --all", { ui: { notify: (message) => messages.push(message) } });
  assert.match(messages[2]!, /maxConcurrentTasks {2}3/);
  assert.match(messages[2]!, /merge\.deleteBranch|deleteBranch {2}true/);
  // Legacy snake_case names and worker_models still load as migration-only inputs.
  const legacy = '{"max_concurrent_tasks":5,"worker_github":"on","merge":{"delete_branch":false},"worker_models":{"review":"provider/review"},"worker_thinking":{"implement":"off"}}\n';
  await writeFile(path, legacy);
  await merro.handler("config", { ui: { notify: (message) => messages.push(message) } });
  assert.match(messages[3]!, /maxConcurrentTasks {2}5/);
  assert.match(messages[3]!, /workerGithub {2}true/);
  assert.match(messages[3]!, /workers\.implementer\n {2}thinking {2}off/);
  assert.match(messages[3]!, /workers\.reviewer\n {2}model +provider\/review/);
  assert.equal(await readFile(path, "utf8"), legacy);
  await merro.handler("config set sandbox docker", { ui: { notify: (message) => messages.push(message) } });
  assert.match(messages[4]!, /^Commands:/);
  assert.equal(await readFile(path, "utf8"), legacy);
});

test("/merro config reports invalid config and missing workspace without creating files", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "merro-config-command-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const messages: string[] = [];
  const merro = commandRegistry(cwd).get("merro")!;
  const ctx = { ui: { notify: (message: string) => messages.push(message) } };
  await merro.handler("config", ctx);
  assert.match(messages[0]!, /Run \/merro init/);
  await assert.rejects(readFile(join(cwd, ".merro", "config.json")), { code: "ENOENT" });
  await initializedState(cwd);
  await writeFile(join(cwd, ".merro", "config.json"), '{"worker":{},"worker_models":{}}');
  await merro.handler("config", ctx);
  assert.match(messages[1]!, /Cannot combine/);
});

test("/merro routes change details and management actions using semantic targets", async () => {
  const calls: unknown[][] = [];
  const main = {
    async changeDetails(name: string) { calls.push(["details", name]); return null; },
    async resolveDecisionForChange(name: string | undefined, approved: boolean) { calls.push(["decision", name, approved]); return "Resolved."; },
    async retryChangeSet(name: string | undefined) { calls.push(["retry", name]); return "Retried."; },
    async stopObjectives(name: string | undefined) { calls.push(["stop", name]); return 1; },
    async runPass() { calls.push(["run"]); },
  } as unknown as MainOrchestrator;
  const merro = commandRegistry("/unused", main).get("merro")!;
  const messages: string[] = [];
  for (const args of ["safety", "approve", "approve safety", "leave", "leave safety", "retry", "retry safety", "stop", "stop goal", "run"]) {
    await merro.handler(args, { ui: { notify: (message) => messages.push(message) } });
  }
  assert.deepEqual(calls, [["details", "safety"], ["decision", undefined, true], ["decision", "safety", true], ["decision", undefined, false], ["decision", "safety", false], ["retry", undefined], ["retry", "safety"], ["stop", undefined], ["stop", "goal"], ["run"]]);
  assert.ok(messages.includes("Stopped 1 Objective. Active changes will finish; no new work will start."));
});

test("/merro issue routes create, list, show, start, approve and dismiss", async () => {
  const calls: unknown[][] = [];
  const issue = (number: number, title = `Issue ${number}`) => ({ number, title, body: "", url: `https://x/${number}`, state: "OPEN", labels: ["bug"], projectSlug: "app" });
  const main = {
    async createIssue(project: string | undefined, title: string, body: string) { calls.push(["create", project, title, body]); return issue(9, title); },
    async listIssues(project?: string) { calls.push(["list", project]); return { projectSlug: "app", issues: [issue(1)] }; },
    async showIssue(project: string | undefined, number: number) { calls.push(["show", project, number]); return issue(number); },
    async startIssue(project: string | undefined, number: number) { calls.push(["start", project, number]); return { issue: issue(number), objective: {}, changeSets: [{ slug: "issue-slug" }] }; },
    async issueProposals() { return [{ position: 1, projectSlug: "app", title: "Cleanup", body: "", change: "safety" }]; },
    async resolveIssueProposal(position: number, approved: boolean) { calls.push(["resolve", position, approved]); return "Done."; },
  } as unknown as MainOrchestrator;
  const merro = commandRegistry("/unused", main).get("merro")!;
  const messages: string[] = [];
  const run = (args: string) => merro.handler(args, { ui: { notify: (message) => messages.push(message) } });
  await run("issue create Fix the thing --project app --body Longer   explanation");
  await run("issue list");
  await run("issue show #4 --project app");
  await run("issue start 12");
  await run("issue approve");
  await run("issue dismiss 1");
  assert.deepEqual(calls, [
    ["create", "app", "Fix the thing", "Longer explanation"],
    ["list", undefined], ["show", "app", 4], ["start", undefined, 12], ["resolve", 1, true], ["resolve", 1, false],
  ]);
  assert.match(messages[0]!, /Created app #9: Fix the thing/);
  assert.match(messages[1]!, /#1 Issue 1 \[bug\][\s\S]*1\. Cleanup \(app, from safety\)/);
  assert.match(messages[3]!, /Started #12: Issue 12\nChanges: issue-slug/);

  await run("issue show nope");
  await run("issue");
  assert.match(messages.at(-1)!, /Usage: \/merro issue/);
});

test("/merro issue asks to open Main when none is attached", async () => {
  const merro = commandRegistry("/unused").get("merro")!;
  const messages: string[] = [];
  await merro.handler("issue list", { ui: { notify: (message) => messages.push(message) } });
  assert.match(messages[0]!, /Open Main/);
});
