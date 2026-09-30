import type { Relation } from "./model.js";

export function normalizeRelation(relation: Relation): Relation {
  if (relation.from === relation.to) {
    throw new Error("relation cannot target itself");
  }
  if (relation.kind !== "Conflicts" || relation.from < relation.to) return relation;
  return { ...relation, from: relation.to, to: relation.from };
}

export function effectiveRelations(relations: readonly Relation[]): Relation[] {
  const normalized = relations.map(normalizeRelation);
  const requires = new Set(
    normalized
      .filter((relation) => relation.kind === "Requires")
      .map((relation) => `${relation.from}\u0000${relation.to}`),
  );

  return normalized.filter((relation) => {
    if (relation.kind !== "Conflicts") return true;
    return !requires.has(`${relation.from}\u0000${relation.to}`)
      && !requires.has(`${relation.to}\u0000${relation.from}`);
  });
}

export function findRequiresCycle(relations: readonly Relation[]): string[] | null {
  const edges = new Map<string, string[]>();
  for (const relation of effectiveRelations(relations)) {
    if (relation.kind !== "Requires") continue;
    const list = edges.get(relation.from) ?? [];
    list.push(relation.to);
    edges.set(relation.from, list);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(node: string): string[] | null {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
    }
    if (visited.has(node)) return null;

    visiting.add(node);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }

  for (const node of edges.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}
