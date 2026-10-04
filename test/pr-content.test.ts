import test from "node:test";
import assert from "node:assert/strict";
import { normalizedVerification, renderPullRequestContent } from "../src/runtime/pr-content.js";
import type { ChangeSet } from "../src/domain/model.js";
import type { Verification } from "../src/protocol/result.js";

const change: ChangeSet = { id: "private", slug: "permission-revocation", projectSlug: "kinetix", issues: [96, 97, 100].map((number) => ({ projectSlug: "kinetix", number })), generation: 1, state: "Reviewed", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null };
const command = (command: string, exit_code = 0): Verification => ({ kind: "command", project: "kinetix", cwd: "/tmp/.wt/permission-revocation", command, exit_code });

test("PR rendering filters internal structured bullets and never uses activity or legacy PR suggestions", () => {
  const internal = ["Commit 42bf123 is directly on 75f0123.", "Worktree /tmp/.wt/change.", "No PR created per task instructions.", "Merro publication is Publishing.", "Reviewed commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa."];
  const result = renderPullRequestContent({ change, intent: "Make bound-plugin permission revocation atomic", branch: "fix/permission-revocation",
    implementation: { task_id: "implementation", status: "success", commit: "a".repeat(40), summary: internal.join(" "), changes: [...internal, "Preserve existing bindings.", "Preserve existing bindings."], verification: [command("cargo test")], pr: { title: "Bad narrative", body: "Bad narrative" } },
    review: { task_id: "review", status: "pass", summary: internal.join(" "), reviewed_commit: "a".repeat(40), findings: [], verification: [command("cargo test"), command("cargo fmt --all -- --check")] },
  });
  assert.equal(result.title, "fix: make bound-plugin permission revocation atomic");
  assert.equal(result.body, "## Summary\n\n- Preserve existing bindings.\n\n## Verification\n\n- `cargo test`\n- `cargo fmt --all -- --check`\n\n## Issues\n\nCloses #96\nCloses #97\nCloses #100");
});

test("normalized verification retains exact passing commands once, excluding directories and narrative", () => {
  assert.equal(normalizedVerification([command("cargo test"), command("cargo test"), command('printf "a  b"'), command("failed", 1), command("cd /tmp/.wt/permission-revocation && cargo test"), command("echo No PR created per task instructions"), { kind: "manual", project: "kinetix", summary: "Unstructured narrative" }]), '- `cargo test`\n- `printf "a  b"`');
});

test("legacy results without changes use intent and generated titles stay conventional and bounded", () => {
  const result = renderPullRequestContent({ change, intent: "Fix permission revocation " + "without changing bindings ".repeat(10), branch: "fix/permission-revocation", implementation: null,
    review: { task_id: "review", status: "pass", summary: "Do not use this activity", reviewed_commit: "a".repeat(40), findings: [], verification: [command("cargo test")] },
  });
  assert.match(result.title, /^fix: /);
  assert.ok(result.title.length <= 72);
  assert.match(result.body, /^## Summary\n\n- Fix permission revocation/);
  assert.doesNotMatch(result.body, /Do not use this activity/);
});

test("related pull requests section is generated, replaced in place and removed when empty", async () => {
  const { withRelatedPullRequests } = await import("../src/runtime/pr-content.js");
  const base = "## Summary\n\n- Did it\n\n## Issues\n\nCloses #1";
  const first = withRelatedPullRequests(base, [{ name: "api", relation: "Requires", url: "https://github.com/o/lib/pull/4" }]);
  assert.match(first, /## Related pull requests\n\n- Requires `api`: https:\/\/github.com\/o\/lib\/pull\/4$/);
  const second = withRelatedPullRequests(first, [
    { name: "api", relation: "Requires", url: "https://github.com/o/lib/pull/4" },
    { name: "ui", relation: "Required by", url: "https://github.com/o/app/pull/9" },
  ]);
  assert.equal(second.match(/## Related pull requests/g)?.length, 1);
  assert.match(second, /Required by `ui`: https:\/\/github.com\/o\/app\/pull\/9/);
  assert.equal(withRelatedPullRequests(second, []), base);
});
