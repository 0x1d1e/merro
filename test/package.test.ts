import test from "node:test";
import assert from "node:assert/strict";
import { systemCommandRunner } from "../src/runtime/commands.js";

test("published package contains the compiled worker protocol and Docker build context", async () => {
  const output = await systemCommandRunner.run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  const packages = Object.values(JSON.parse(output.stdout)) as Array<{ files: Array<{ path: string }> }>;
  const files = new Set(packages[0]?.files.map((file) => file.path));
  for (const path of ["src/index.ts", "dist/src/tools/worker-result.js", "dist/src/protocol/result.js", "docker/worker.Dockerfile"]) {
    assert.ok(files.has(path), `package missing ${path}`);
  }
});
