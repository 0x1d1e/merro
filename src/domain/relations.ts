import type { Relation, WorkItem } from "./model.js";

function maskQuotedSpans(line: string): string {
  const characters = [...line];
  const closingQuotes: Record<string, string> = { '"': '"', "'": "'", "“": "”", "‘": "’" };
  let quote: string | null = null;
  let start = 0;
  let escaped = false;
  for (let index = 0; index < characters.length; index++) {
    const character = characters[index] ?? "";
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    const followsWord = /[\p{L}\p{N}]/u.test(characters[index - 1] ?? "");
    // Apostrophes within words, including contractions, are not quotation marks.
    if ((character === "'" || character === "’") && followsWord
      && /[\p{L}\p{N}]/u.test(characters[index + 1] ?? "")) continue;
    const closingQuote = closingQuotes[character];
    if (quote === character) {
      characters.fill(" ", start, index + 1);
      quote = null;
    } else if (quote === null && closingQuote && (character !== "'" || !followsWord)) {
      quote = closingQuote;
      start = index;
    }
  }
  return characters.join("");
}

/** Conservative inference from affirmative issue-reference statements, never general prose overlap. */
export function analyzeIssueRelations(
  item: WorkItem,
  issue: { title: string; body: string },
  approvedItems: readonly WorkItem[],
): { relations: Relation[]; unresolved: string[] } {
  const relations: Relation[] = [];
  const unresolved: string[] = [];
  let fenced = false;
  for (const raw of `${issue.title}\n${issue.body}`.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; continue; }
    if (fenced || /^\s*>/.test(raw)) continue;
    const line = maskQuotedSpans(raw.replace(/`[^`]*`/g, " "));
    const statements = /\b(requires|depends on|blocked by|conflicts with)\s*:?\s+((?:(?:[A-Za-z0-9._/-]+)?#[1-9][0-9]*)(?:(?:\s*,\s*|\s+and\s+)(?:[A-Za-z0-9._/-]+)?#[1-9][0-9]*)*)/gi;
    for (const match of line.matchAll(statements)) {
      // Evaluate both sides of this statement, not unrelated sentences on the same line.
      const prefix = line.slice(0, match.index).split(/[.;](?:\s+|$)/).at(-1) ?? "";
      const suffix = line.slice(match.index + match[0].length).split(/[.;](?:\s+|$)/)[0] ?? "";
      const context = `${prefix} ${suffix}`;
      if (/\b(not|never|no)\b/i.test(prefix)
        || /\b(if|unless|whether|might|may|could|should|example|or)\b|\?/i.test(context)) continue;
      const kind = match[1]!.toLowerCase() === "conflicts with" ? "Conflicts" : "Requires";
      for (const reference of match[2]!.matchAll(/([A-Za-z0-9._/-]+)?#([1-9][0-9]*)/g)) {
        const projectSlug = reference[1] ?? item.projectSlug;
        const number = reference[2]!;
        const target = approvedItems.filter((candidate) => candidate.projectSlug === projectSlug
          && candidate.sourceType === "issue" && candidate.sourceRef === number)
          .sort((left, right) => right.generation - left.generation)[0];
        if (!target || target.state === "Obsolete" || target.state === "Cancelled") {
          unresolved.push(reference[0]);
          continue;
        }
        if (target.id === item.id) { unresolved.push(reference[0]); continue; }
        relations.push({ kind, from: item.id, to: target.id, confidence: "high",
          rationale: "Affirmative issue-reference statement inside approved scope.", evidence: raw.trim() });
      }
    }
  }
  return { relations: effectiveRelations(relations), unresolved: [...new Set(unresolved)] };
}

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
