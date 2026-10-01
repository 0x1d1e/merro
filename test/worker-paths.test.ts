import assert from "node:assert/strict";
import test from "node:test";
import { dockerBindMount } from "../src/runtime/docker-mount.js";
import { workItemPathName } from "../src/runtime/filesystem-identity.js";

test("WorkItem path names are deterministic, bounded, readable and collision-resistant", () => {
  const id = "merro-acceptance:issue-1:g1";
  assert.match(workItemPathName(id), /^merro-acceptance-issue-1-g1-[0-9a-f]{16}$/);
  for (const value of [id, "project:issue-1:g1", "project/issue-1/g1", "project\\issue-1\\g1", "..", ".", "", "你好", "A".repeat(500)]) {
    const name = workItemPathName(value);
    assert.equal(name, workItemPathName(value));
    assert.ok(name.length <= 65);
    assert.match(name, /^[a-z0-9-]+$/);
    assert.ok(!/[/:\\]/.test(name));
  }
  for (const [a, b] of [
    ["project:issue-1:g1", "project/issue-1/g1"],
    ["project:issue-1:g1", "PROJECT:ISSUE-1:G1"],
    [`${"long".repeat(100)}:g1`, `${"long".repeat(100)}:g2`],
  ] as const) {
    assert.equal(workItemPathName(a).slice(0, -17), workItemPathName(b).slice(0, -17));
    assert.notEqual(workItemPathName(a), workItemPathName(b));
  }
});

test("Docker bind mounts preserve colons, spaces and platform-specific paths as one CLI argument", () => {
  for (const source of ["/tmp/merro:test/work item", "/Users/test/merro:work item", String.raw`C:\Users\test\work item`, String.raw`\\server\share\work item`]) {
    assert.deepEqual(dockerBindMount(source, "/work"), ["--mount", `type=bind,src=${source},dst=/work`]);
    assert.deepEqual(dockerBindMount(source, "/work", { readOnly: true }), ["--mount", `type=bind,src=${source},dst=/work,readonly`]);
  }
});

test("Docker bind mount CSV escaping quotes whole fields and doubles embedded quotes", () => {
  assert.deepEqual(dockerBindMount('/work:space/a,b="quoted"', '/target,with"quotes', { readOnly: true }), [
    "--mount", 'type=bind,"src=/work:space/a,b=""quoted""","dst=/target,with""quotes",readonly',
  ]);
  assert.deepEqual(dockerBindMount("/source\nline\rbreak", "/work"), ["--mount", 'type=bind,"src=/source\nline\rbreak",dst=/work']);
  assert.deepEqual(dockerBindMount("/source/'single quote'", "/work"), ["--mount", "type=bind,src=/source/'single quote',dst=/work"]);
});
