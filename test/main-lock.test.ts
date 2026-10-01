import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MainAlreadyRunningError, MainLock } from "../src/runtime/main-lock.js";

async function tempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "merro-main-lock-"));
}

test("Main lock rejects another owner and can be reacquired after release", async (t) => {
  const dir = await tempDirectory();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "main.lock.db");
  const first = new MainLock(path);
  const second = new MainLock(path);

  await first.acquire();
  await assert.rejects(second.acquire(), (error: unknown) => {
    assert.ok(error instanceof MainAlreadyRunningError);
    assert.equal(error.owner?.pid, process.pid);
    return true;
  });

  await first.release();
  await second.acquire();
  assert.equal(second.owner?.pid, process.pid);
  await second.release();
});

test("Main lock is released by process death and stale owner metadata is replaced", async (t) => {
  const dir = await tempDirectory();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "main.lock.db");
  const moduleUrl = new URL("../src/runtime/main-lock.js", import.meta.url).href;
  const script = [
    `import { MainLock } from ${JSON.stringify(moduleUrl)};`,
    `const lock = new MainLock(${JSON.stringify(path)});`,
    "await lock.acquire();",
    "console.log('READY');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  });

  let output = "";
  await new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("READY\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock child exited before ready (${code}): ${output}`)));
  });

  const main = new MainLock(path);
  await assert.rejects(main.acquire(), (error: unknown) => {
    assert.ok(error instanceof MainAlreadyRunningError);
    assert.equal(error.owner?.pid, child.pid);
    return true;
  });

  child.kill("SIGKILL");
  await once(child, "exit");
  await main.acquire();
  assert.equal(main.owner?.pid, process.pid);
  await main.release();
});
