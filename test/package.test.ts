import assert from "node:assert/strict";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { systemCommandRunner } from "../src/runtime/commands.js";

test("clean Git checkout installs with Pi's production-only dependency flags", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "merro-install-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  for (const path of ["package.json", "package-lock.json", "tsconfig.json", "src", "test"]) {
    await cp(path, join(checkout, path), { recursive: true });
  }

  await systemCommandRunner.run("npm", ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"], {
    cwd: checkout,
    env: { npm_config_ignore_scripts: "false" },
  });
  for (const path of ["dist/src/index.js", "dist/src/tools/worker-result.js", "dist/src/protocol/result.js"]) {
    assert.ok((await stat(join(checkout, path))).isFile(), `install missing ${path}`);
  }
  await systemCommandRunner.run(process.execPath, ["--input-type=module", "-e", "await import('./dist/src/index.js'); await import('./dist/src/tools/worker-result.js');"], {
    cwd: checkout,
  });
});

test("published package contains the compiled worker protocol and Docker build context", async () => {
  const output = await systemCommandRunner.run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const packages = Object.values(JSON.parse(output.stdout)) as Array<{ files: Array<{ path: string }> }>;
  const files = new Set(packages[0]?.files.map((file) => file.path));
  for (const path of ["src/index.ts", "dist/src/tools/worker-result.js", "dist/src/protocol/result.js", "docker/worker.Dockerfile"]) {
    assert.ok(files.has(path), `package missing ${path}`);
  }
});
