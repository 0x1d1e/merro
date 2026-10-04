import type { MerroStore } from "../store/store.js";

const REVIEWED_STATES: ReadonlySet<string> = new Set(["Reviewed", "Publishing", "AwaitingMerge", "AwaitingApproval", "AwaitingLocalMerge", "PublishBlocked", "Done"]);

/** ChangeSets whose current review can satisfy a `reviewed` gate; the scheduler and status both read this. */
export function currentlyReviewedIds(store: MerroStore): Set<string> {
  const ids = new Set<string>();
  for (const item of store.listChangeSets()) {
    const blockedAfterReview = item.state === "Blocked" && item.blockedResumeState !== null
      && REVIEWED_STATES.has(item.blockedResumeState);
    if (!REVIEWED_STATES.has(item.state) && !blockedAfterReview) continue;
    const latestReview = store.listTasks(item.id).filter((task) => task.role === "review").at(-1);
    if (latestReview?.outcome === "pass" && latestReview.reviewedCommit) ids.add(item.id);
  }
  // A passing review based on stale prerequisites cannot unlock further work.
  const relations = store.listRelations();
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of relations) {
      if (relation.kind !== "Requires" || relation.gate !== "reviewed" || !ids.has(relation.from)
        || store.getChangeSet(relation.from)?.state === "Done") continue;
      const review = store.listTasks(relation.to).filter((task) => task.role === "review").at(-1);
      if (!ids.has(relation.to) || !relation.consumedReviewedCommit || relation.consumedReviewedCommit !== review?.reviewedCommit) {
        ids.delete(relation.from);
        changed = true;
      }
    }
  }
  return ids;
}
