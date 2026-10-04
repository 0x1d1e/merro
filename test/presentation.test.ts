import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeSet } from "../src/domain/model.js";
import { schedule } from "../src/domain/scheduler.js";
import { presentWorkspace } from "../src/runtime/presentation.js";
import { currentlyReviewedIds } from "../src/runtime/reviewed.js";
import { MerroStore } from "../src/store/store.js";

test("status reports a review built on a stale prerequisite as not satisfying a reviewed gate, like the scheduler", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "merro-presentation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MerroStore(join(directory, "state.db"));
  t.after(() => store.close());
  store.createProject({ slug: "p", path: directory, baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" });
  const change = (slug: string, number: number, state: ChangeSet["state"]): ChangeSet => {
    const item: ChangeSet = { id: slug, projectSlug: "p", slug, issues: [{ projectSlug: "p", number }], generation: 1, state,
      priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null };
    store.createChangeSet(item);
    return item;
  };
  const passReview = (item: ChangeSet, commit: string) => {
    const id = `${item.id}-review-${commit}`;
    store.createTask({ id, changeSetId: item.id, role: "review", attempt: 1 });
    store.finalizeTask({ id, outcome: "pass", summary: "ok", resultJson: "{}", reviewedCommit: commit });
  };
  const api = change("api", 1, "AwaitingMerge");
  const app = change("app", 2, "AwaitingMerge");
  const web = change("web", 3, "Ready");
  passReview(api, "a".repeat(40));
  passReview(app, "b".repeat(40));
  // app was reviewed against an api commit that a later api review replaced.
  passReview(api, "c".repeat(40));
  const requires = (from: ChangeSet, to: ChangeSet, consumed: string | null) => ({ kind: "Requires" as const, from: from.id, to: to.id,
    confidence: "explicit" as const, rationale: "needs it", evidence: "approved", gate: "reviewed" as const, consumedReviewedCommit: consumed });
  store.replaceRelations([requires(app, api, "a".repeat(40)), requires(web, app, null)]);

  const reviewed = currentlyReviewedIds(store);
  const scheduled = schedule({ changeSets: store.listChangeSets(), relations: store.listRelations(), reviewedChangeSetIds: [...reviewed],
    activeTaskCount: 0, activeChangeSetIds: [], maxConcurrentTasks: "unlimited" });
  assert.equal(scheduled.selected.some((item) => item.id === web.id), false);
  const status = presentWorkspace(store).changes.find((entry) => entry.name === "web");
  assert.equal(status?.status, "Waiting");
  assert.deepEqual(status?.waitingFor, { kind: "dependency", change: "app", gate: "reviewed" });
});
