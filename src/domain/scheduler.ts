import type { Relation, SchedulingInput, WorkItem } from "./model.js";
import { priorityRank } from "./model.js";
import { effectiveRelations, findRequiresCycle } from "./relations.js";

export interface ScheduleResult {
  selected: WorkItem[];
  cycle: string[] | null;
}

function transitiveDownstreamCount(id: string, relations: readonly Relation[]): number {
  const reverse = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.kind !== "Requires") continue;
    const dependents = reverse.get(relation.to) ?? [];
    dependents.push(relation.from);
    reverse.set(relation.to, dependents);
  }

  const seen = new Set<string>();
  const queue = [...(reverse.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    queue.push(...(reverse.get(next) ?? []));
  }
  return seen.size;
}

function requirementsSatisfied(item: WorkItem, byId: ReadonlyMap<string, WorkItem>, relations: readonly Relation[]): boolean {
  for (const relation of relations) {
    if (relation.kind !== "Requires" || relation.from !== item.id) continue;
    if (byId.get(relation.to)?.state !== "Done") return false;
  }
  return true;
}

function conflictsWithAny(itemId: string, peerIds: ReadonlySet<string>, relations: readonly Relation[]): boolean {
  for (const relation of relations) {
    if (relation.kind !== "Conflicts") continue;
    const peer = relation.from === itemId ? relation.to : relation.to === itemId ? relation.from : null;
    if (peer && peerIds.has(peer)) return true;
  }
  return false;
}

export function schedule(input: SchedulingInput): ScheduleResult {
  const relations = effectiveRelations(input.relations);
  const cycle = findRequiresCycle(relations);
  const byId = new Map(input.workItems.map((item) => [item.id, item]));
  const available = input.maxConcurrentTasks === "unlimited"
    ? Number.POSITIVE_INFINITY
    : Math.max(0, input.maxConcurrentTasks - input.activeTaskCount);

  const activeIds = new Set(
    input.workItems
      .filter((item) => item.state === "Implementing" || item.state === "Reviewing")
      .map((item) => item.id),
  );

  const candidates = input.workItems
    .filter((item) => item.state === "Ready")
    .filter((item) => requirementsSatisfied(item, byId, relations))
    .filter((item) => !conflictsWithAny(item.id, activeIds, relations))
    .sort((left, right) => {
      const priority = priorityRank(left.priority) - priorityRank(right.priority);
      if (priority !== 0) return priority;
      const downstream = transitiveDownstreamCount(right.id, relations) - transitiveDownstreamCount(left.id, relations);
      if (downstream !== 0) return downstream;
      const leftReady = left.readySince ?? "9999";
      const rightReady = right.readySince ?? "9999";
      const ready = leftReady.localeCompare(rightReady);
      if (ready !== 0) return ready;
      return left.id.localeCompare(right.id);
    });

  const selected: WorkItem[] = [];
  const selectedIds = new Set<string>();
  for (const candidate of candidates) {
    if (selected.length >= available) break;
    if (conflictsWithAny(candidate.id, selectedIds, relations)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
  }

  return { selected, cycle };
}
