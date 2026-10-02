import assert from "node:assert/strict";
import test from "node:test";
import { dockerBindMount } from "../src/runtime/docker-mount.js";
import { changeSetPathName } from "../src/runtime/filesystem-identity.js";

test("ChangeSet path names are deterministic, bounded and semantic", () => {
  const id = "plugin-lifecycle-safety";
  assert.equal(changeSetPathName(id), id);
  for (const value of [id, "project:issue-1:g1", "project/issue-1/g1", "project\\issue-1\\g1", "A".repeat(500)]) {
    const name = changeSetPathName(value);
    assert.equal(name, changeSetPathName(value));
    assert.ok(name.length <= 65);
    assert.match(name, /^[a-z0-9-]+$/);
    assert.ok(!/[/:\\]/.test(name));
  }
  assert.equal(changeSetPathName("Plugin lifecycle safety"), id);
  for (const invalid of ["..", ".", "", "你好"]) assert.throws(() => changeSetPathName(invalid), /descriptive/);
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
