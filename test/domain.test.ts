import test from "node:test";
import assert from "node:assert/strict";
import type { Relation, ChangeSet } from "../src/domain/model.js";
import { parseObjectiveIssueScopes } from "../src/domain/objective.js";
import { analyzeIssueRelations, findRequiresCycle, normalizeRelation } from "../src/domain/relations.js";
import { schedule } from "../src/domain/scheduler.js";
import { assertChangeSetTransition } from "../src/domain/change-set.js";

function item(id: string, state: ChangeSet["state"], priority: ChangeSet["priority"] = "normal", readySince = "2026-01-01T00:00:00Z"): ChangeSet {
  return {
    id,
    projectSlug: "p",
    slug: id,
    issues: [],
    generation: 1,
    state,
    priority,
    readySince: state === "Ready" ? readySince : null,
    blockedReason: null,
    blockedResumeState: null,
  };
}

function requires(from: string, to: string): Relation {
  return { kind: "Requires", from, to, confidence: "explicit", rationale: "test", evidence: "test" };
}

function conflicts(left: string, right: string): Relation {
  return { kind: "Conflicts", from: left, to: right, confidence: "high", rationale: "test", evidence: "test" };
}

test("Objective issue scopes cover exactly the normalized linked Project set", () => {
  const scopes = [{ projectSlug: "web", numbers: [8, 8] }, { projectSlug: "api", query: {} }];
  assert.deepEqual(parseObjectiveIssueScopes(scopes, ["api", "web", "api"]), [
    { projectSlug: "web", numbers: [8] }, { projectSlug: "api", query: { labels: [] } },
  ]);
  assert.throws(() => parseObjectiveIssueScopes(scopes, ["api", "web", "infra"]), /missing issue scope for Project 'infra'/);
  assert.throws(() => parseObjectiveIssueScopes([], ["api"]), /missing issue scope for Project 'api'/);
  assert.throws(() => parseObjectiveIssueScopes(scopes, ["api"]), /unlinked Project/);
  assert.throws(() => parseObjectiveIssueScopes([...scopes, { projectSlug: "api", numbers: [7] }], ["api", "web"]), /duplicate issue scope/);
  assert.throws(() => parseObjectiveIssueScopes([{ projectSlug: "api", numbers: [] }], ["api"]), /positive issue numbers/);
  assert.deepEqual(parseObjectiveIssueScopes([{ projectSlug: "api", numbers: [] }], ["api"], { allowEmptyFixedSelections: true }), [{ projectSlug: "api", numbers: [] }]);
});

test("terminal ChangeSets cannot reactivate", () => {
  assert.throws(() => assertChangeSetTransition("Done", "Ready"), /invalid ChangeSet transition/);
  assert.doesNotThrow(() => assertChangeSetTransition("Reviewing", "Implementing"));
  assert.doesNotThrow(() => assertChangeSetTransition("AwaitingMerge", "Done"));
});

test("unfinished ChangeSets can become Obsolete when no Objective owns them", () => {
  assert.doesNotThrow(() => assertChangeSetTransition("Implementing", "Obsolete"));
  assert.doesNotThrow(() => assertChangeSetTransition("Reviewing", "Obsolete"));
  assert.doesNotThrow(() => assertChangeSetTransition("AwaitingMerge", "Obsolete"));
  assert.doesNotThrow(() => assertChangeSetTransition("Blocked", "Obsolete"));
  assert.doesNotThrow(() => assertChangeSetTransition("AwaitingMerge", "Implementing"));
});

test("passing review and publication have distinct resumable states", () => {
  assert.doesNotThrow(() => assertChangeSetTransition("Reviewing", "Reviewed"));
  assert.throws(() => assertChangeSetTransition("Reviewing", "AwaitingMerge"), /invalid/);
  assert.doesNotThrow(() => assertChangeSetTransition("Reviewed", "Publishing"));
  assert.throws(() => assertChangeSetTransition("Reviewed", "Done"), /invalid/);
  assert.throws(() => assertChangeSetTransition("Reviewed", "Done", null, "local"), /invalid/);
  assert.doesNotThrow(() => assertChangeSetTransition("Reviewed", "AwaitingLocalMerge", null, "local"));
  assert.throws(() => assertChangeSetTransition("Reviewed", "AwaitingLocalMerge"), /invalid/);
  assert.doesNotThrow(() => assertChangeSetTransition("AwaitingLocalMerge", "Done", null, "local"));
  assert.doesNotThrow(() => assertChangeSetTransition("AwaitingLocalMerge", "Implementing", null, "local"));
  assert.throws(() => assertChangeSetTransition("Reviewed", "Publishing", null, "local"), /invalid/);
  assert.throws(() => assertChangeSetTransition("Reviewed", "AwaitingMerge"), /invalid/);
  assert.doesNotThrow(() => assertChangeSetTransition("Publishing", "AwaitingMerge"));
  assert.doesNotThrow(() => assertChangeSetTransition("Publishing", "PublishBlocked"));
  assert.doesNotThrow(() => assertChangeSetTransition("PublishBlocked", "Publishing", "Publishing"));
  for (const state of ["Implementing", "Reviewing", "AwaitingMerge"] as const) {
    assert.throws(() => assertChangeSetTransition("PublishBlocked", state, "Publishing"), /invalid/);
  }
});

test("Blocked ChangeSets resume only to their persisted previous flow state", () => {
  assert.doesNotThrow(() => assertChangeSetTransition("Blocked", "Ready", "Ready"));
  assert.throws(() => assertChangeSetTransition("Blocked", "Reviewing", "Ready"), /invalid ChangeSet transition/);
  assert.throws(() => assertChangeSetTransition("Blocked", "Planned", null), /invalid ChangeSet transition/);
  assert.doesNotThrow(() => assertChangeSetTransition("Blocked", "Cancelled", "Ready"));
});

test("Conflicts are canonicalized symmetrically", () => {
  const relation = normalizeRelation({ kind: "Conflicts", from: "z", to: "a", confidence: "high", rationale: "x", evidence: "x" });
  assert.equal(relation.from, "a");
  assert.equal(relation.to, "z");
});

test("issue relation analysis accepts affirmative references and rejects speculative or quoted evidence", () => {
  const source = { ...item("source", "Planned"), issues: [{ projectSlug: "p", number: 8 }] };
  const target = { ...item("target", "Ready"), issues: [{ projectSlug: "p", number: 7 }] };
  for (const body of ["Requires #7", "Depends on: #7", "Blocked by #7", "#8 requires #7"]) {
    assert.equal(analyzeIssueRelations(source, { title: "Work", body }, [source, target]).relations[0]?.to, target.id);
  }
  for (const body of ["Does not require #7", "Does not depend on #7", "Never requires #7", "If this requires #7", "Requires #7?", "Example: requires #7", "Requires #7 or #99",
    "`Requires #7`", "> Requires #7", "```\nRequires #7\n```", 'Example: "requires #7"']) {
    assert.deepEqual(analyzeIssueRelations(source, { title: "Work", body }, [source, target]).relations, []);
  }
  const newer = { ...target, id: "newer", generation: 2 };
  assert.equal(analyzeIssueRelations(source, { title: "Work", body: "Requires #7" }, [source, target, newer]).relations[0]?.to, "newer");
  assert.deepEqual(analyzeIssueRelations(source, { title: "Work", body: "Requires #99 and #8" }, [source, target]).unresolved, ["#99"]);
  const crossProject = { ...target, projectSlug: "q" };
  assert.equal(analyzeIssueRelations(source, { title: "Work", body: "Requires q#7" }, [source, crossProject]).relations[0]?.to, target.id);
});

test("relation inference distinguishes conditional clauses, quotations, and apostrophes", () => {
  const source = { ...item("source", "Planned"), issues: [{ projectSlug: "p", number: 8 }] };
  const target = { ...item("target", "Ready"), issues: [{ projectSlug: "p", number: 7 }] };
  for (const body of ["Requires #7 if optional mode is enabled", "Depends on #7 unless compatibility mode is disabled",
    "Requires #99 if optional mode is enabled", '"Requires #99"', "'Requires #99'", '"Requires #99 because it\'s shared"',
    "'Requires #99 because it's shared'", 'Requires "#99"', "Requires '#99'", "If enabled, requires #99.",
    "“Requires #99”", "‘Requires #99 because it’s shared’"]) {
    assert.deepEqual(analyzeIssueRelations(source, { title: "Work", body }, [source, target]), { relations: [], unresolved: [] }, body);
  }
  for (const body of ["Requires #7 because it's shared", "Depends on #7 because the team's API is shared",
    'Requires #7 because the "common" API is shared', "Requires #7 because the teams' API is shared",
    "Requires #7 because it’s shared",
    '"Unrelated quotation"; Requires #7', "'Unrelated quotation'; Requires #7",
    "Requires #7. If enabled, requires #99.", "If enabled, requires #99; requires #7."]) {
    const result = analyzeIssueRelations(source, { title: "Work", body }, [source, target]);
    assert.equal(result.relations.length, 1, body);
    assert.equal(result.relations[0]?.to, target.id, body);
    assert.deepEqual(result.unresolved, [], body);
  }
  for (const projectSlug of ["example", "may", "if"]) {
    assert.equal(analyzeIssueRelations(source, { title: "Work", body: `Requires ${projectSlug}#7` },
      [source, { ...target, projectSlug }]).relations[0]?.to, target.id);
  }
});

test("Requires cycles are detected", () => {
  assert.deepEqual(findRequiresCycle([requires("a", "b"), requires("b", "c"), requires("c", "a")]), ["a", "b", "c", "a"]);
});

test("reviewed gates require full review evidence while done gates still require completion", () => {
  const input = { changeSets: [item("dependent", "Ready"), item("base", "AwaitingApproval")],
    relations: [{ ...requires("dependent", "base"), gate: "reviewed" as const }], activeTaskCount: 0, maxConcurrentTasks: 3 };
  assert.deepEqual(schedule(input).selected, []);
  assert.deepEqual(schedule({ ...input, reviewedChangeSetIds: ["base"] }).selected.map((entry) => entry.id), ["dependent"]);
  assert.deepEqual(schedule({ ...input, relations: [{ ...requires("dependent", "base"), gate: "done" }], reviewedChangeSetIds: ["base"] }).selected, []);
  assert.throws(() => normalizeRelation({ ...conflicts("a", "b"), gate: "reviewed" }), /Only Requires/);
});

test("scheduler blocks dependents until prerequisite is Done", () => {
  const result = schedule({
    changeSets: [item("dependent", "Ready"), item("base", "AwaitingMerge")],
    relations: [requires("dependent", "base")],
    activeTaskCount: 0,
    maxConcurrentTasks: 3,
  });
  assert.deepEqual(result.selected.map((entry) => entry.id), []);
});

test("scheduler orders priority, downstream unblock count, age, then ID", () => {
  const items = [
    item("low", "Ready", "low", "2026-01-01T00:00:00Z"),
    item("high-leaf", "Ready", "high", "2026-01-01T00:00:00Z"),
    item("high-root", "Ready", "high", "2026-01-02T00:00:00Z"),
    item("child", "Planned"),
  ];
  const result = schedule({
    changeSets: items,
    relations: [requires("child", "high-root")],
    activeTaskCount: 0,
    maxConcurrentTasks: 2,
  });
  assert.deepEqual(result.selected.map((entry) => entry.id), ["high-root", "high-leaf"]);
});

test("scheduler never selects conflicting Ready ChangeSets together", () => {
  const result = schedule({
    changeSets: [
      item("first", "Ready", "high", "2026-01-01T00:00:00Z"),
      item("second", "Ready", "high", "2026-01-02T00:00:00Z"),
    ],
    relations: [conflicts("first", "second")],
    activeTaskCount: 0,
    maxConcurrentTasks: 2,
  });
  assert.deepEqual(result.selected.map((entry) => entry.id), ["first"]);
});

test("scheduler blocks a conflict against an already active ChangeSet", () => {
  const result = schedule({
    changeSets: [item("ready", "Ready"), item("active", "Implementing")],
    relations: [conflicts("ready", "active")],
    activeTaskCount: 1,
    maxConcurrentTasks: 2,
  });
  assert.deepEqual(result.selected, []);
});

test("Requires cycle does not stall unrelated Ready work", () => {
  const result = schedule({
    changeSets: [item("a", "Ready"), item("b", "Ready"), item("unrelated", "Ready")],
    relations: [requires("a", "b"), requires("b", "a")],
    activeTaskCount: 0,
    maxConcurrentTasks: 3,
  });
  assert.deepEqual(result.selected.map((entry) => entry.id), ["unrelated"]);
  assert.ok(result.cycle);
});
