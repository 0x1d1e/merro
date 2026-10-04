import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadMarkdownGuidance, renderMarkdownGuidance } from "../src/runtime/guidance.js";
import { renderTaskFile } from "../src/runtime/task-file.js";

async function workspace(t: test.TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "merro-markdown-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".merro", "projects"), { recursive: true });
  return cwd;
}

test("Markdown guidance is optional and blank files add no Task content", async (t) => {
  const cwd = await workspace(t);
  assert.deepEqual(await loadMarkdownGuidance(cwd, ["kinetix"], "implement"), []);
  for (const path of ["WORKSPACE.md", "IMPLEMENTER.md", "REVIEWER.md", "projects/kinetix.md"]) {
    await writeFile(join(cwd, ".merro", path), " \n\t\n");
  }
  for (const role of ["implement", "review"] as const) {
    const guidance = await loadMarkdownGuidance(cwd, ["kinetix"], role);
    assert.deepEqual(guidance, []);
    assert.equal(renderMarkdownGuidance(guidance), "");
  }
});

test("implement Tasks embed scoped guidance while review handoffs rely on Pi guidance", async (t) => {
  const cwd = await workspace(t);
  for (const [path, text] of [
    ["WORKSPACE.md", "Use separate delivery; run CI."],
    ["IMPLEMENTER.md", "Implementer convention."],
    ["REVIEWER.md", "Reviewer convention."],
    ["projects/kinetix.md", "Kinetix convention."],
    ["projects/kinetix-plugins.md", "Plugins convention."],
  ] as const) await writeFile(join(cwd, ".merro", path), text);
  for (const role of ["implement", "review"] as const) {
    const guidance = await loadMarkdownGuidance(cwd, ["kinetix"], role);
    assert.deepEqual(guidance.map((file) => file.path), [".merro/WORKSPACE.md", role === "implement" ? ".merro/IMPLEMENTER.md" : ".merro/REVIEWER.md", ".merro/projects/kinetix.md"]);
    const task = renderTaskFile({ role, change: "fix-42", projectSlug: "kinetix", issues: [42], title: "Fix #42", scope: "Approved scope", objective: "Fix #42", userGuidance: "Current requirements", projectGuidance: "Existing Project guidance", markdownGuidance: guidance, repositoryInstructions: [{ path: "AGENTS.md", text: "Repository convention" }], dependencies: [], latestReview: null, expectedCommit: "a".repeat(40), baseCommit: "b".repeat(40) });
    assert.match(task, /Current requirements/);
    assert.match(task, /## Task instructions/);
    if (role === "review") {
      for (const text of ["Existing Project guidance", "Repository convention", "Use separate delivery; run CI.", "Kinetix convention.", "Reviewer convention."]) assert.ok(!task.includes(text), text);
      assert.match(task, /the agent's normal mechanisms/);
      assert.match(task, /Do not modify files/);
      assert.match(task, /Base commit: b{40}/);
    } else {
      for (const text of ["Existing Project guidance", "Repository convention", "Use separate delivery; run CI.", "Kinetix convention.", "Implementer convention."]) assert.ok(task.includes(text), text);
      assert.ok(!task.includes("Reviewer convention."));
      assert.ok(!task.includes("Plugins convention."));
      assert.match(task, /current user instruction and approved ChangeSet requirements, Project Markdown, workspace Markdown, Merro defaults/);
      assert.match(task, /built-in safety invariants cannot be overridden/);
      assert.match(task, /Repository AGENTS\.md remains normal Pi\/repository guidance/);
      assert.match(task, /Do not push branches/);
    }
  }
});

test("Markdown reads are fresh and invalid paths/read errors fail visibly", async (t) => {
  const cwd = await workspace(t);
  const path = join(cwd, ".merro", "WORKSPACE.md");
  await writeFile(path, "First convention");
  const first = await loadMarkdownGuidance(cwd, []);
  await writeFile(path, "Updated convention");
  assert.equal((await loadMarkdownGuidance(cwd, []))[0]?.text, "Updated convention");
  assert.equal(first[0]?.text, "First convention");
  await assert.rejects(loadMarkdownGuidance(cwd, ["../../elsewhere"]), /invalid Project slug/);
  await rm(path);
  await mkdir(path);
  await assert.rejects(loadMarkdownGuidance(cwd, []), /Could not read \.merro\/WORKSPACE\.md/);
});
