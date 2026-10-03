import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MainLock } from "../src/runtime/main-lock.js";
import { initializedState } from "./fixtures.js";
import { type PiExtensionLike, registerCommands } from "../src/tools/commands.js";

type CommandConfig = Parameters<PiExtensionLike["registerCommand"]>[1];

async function tempDirectory(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "merro-commands-"));
  await initializedState(cwd);
  return cwd;
}

function commandRegistry(cwd: string): Map<string, CommandConfig> {
  const commands = new Map<string, CommandConfig>();
  const pi: PiExtensionLike = {
    registerCommand(name, config) {
      commands.set(name, config);
    },
  };
  registerCommands(pi, cwd);
  return commands;
}

test("commands serialize state access and show workspace status", async (t) => {
  const cwd = await tempDirectory();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const commands = commandRegistry(cwd);
  const messages: string[] = [];
  const status = commands.get("status");
  assert.ok(status);

  await status.handler("", { ui: { notify: (message) => messages.push(message) } });

  assert.match(messages[0] ?? "", /No Merro work yet\./);
  assert.ok(commands.has("unlock"));
});

test("state export uses a namespaced command without shadowing Pi's built-in export", async (t) => {
  const cwd = await tempDirectory();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const commands = commandRegistry(cwd);
  assert.equal(commands.has("export"), false);
  const exportState = commands.get("merro-export");
  assert.ok(exportState);
  const messages: string[] = [];
  await exportState.handler("", { ui: { notify: (message) => messages.push(message) } });
  const path = join(cwd, ".merro", "export.json");
  const snapshot = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(snapshot.projects, []);
  assert.ok(messages[0]?.includes(".merro/export.json"));
});

test("unlock does not release a live Main lock", async (t) => {
  const cwd = await tempDirectory();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const lock = new MainLock(join(cwd, ".merro", "main.lock.db"));
  await lock.acquire();
  const commands = commandRegistry(cwd);
  const messages: string[] = [];
  const unlock = commands.get("unlock");
  assert.ok(unlock);

  await unlock.handler("", { ui: { notify: (message) => messages.push(message) } });

  assert.match(messages[0] ?? "", /already holds the workspace lock/);
  assert.ok(lock.owner);
  await lock.release();
});
