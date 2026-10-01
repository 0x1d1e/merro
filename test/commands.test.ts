import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainLock } from "../src/runtime/main-lock.js";
import { registerCommands, type PiExtensionLike } from "../src/tools/commands.js";

type CommandConfig = Parameters<PiExtensionLike["registerCommand"]>[1];

async function tempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "merro-commands-"));
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

  assert.match(messages[0] ?? "", /0 active objective/);
  assert.ok(commands.has("unlock"));
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
