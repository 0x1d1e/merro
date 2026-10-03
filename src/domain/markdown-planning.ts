import { semanticSlug } from "./names.js";

export interface MarkdownProjectMapping {
  heading: string;
  projectSlug: string;
}

export type MarkdownRoadmapStatus = "Done" | "In Progress" | "Not Started" | "Parked" | "Future";

export interface MarkdownRoadmapItem {
  workstream: string;
  projectSlug: string;
  issues: number[];
  order?: string;
  status?: MarkdownRoadmapStatus;
  changeSet?: string;
  sourceDependencies?: Array<{ workstream: string; projectSlug: string }>;
}

export interface MarkdownRoadmapPlan {
  changeSets: Array<{ name: string; projectSlug: string; issues: number[] }>;
  relations: Array<{ kind: "Requires"; from: string; to: string }>;
  planning: {
    items: MarkdownRoadmapItem[];
    unresolved: Array<{ workstream: string; projectSlug: string; statement: string }>;
  };
}

interface RoadmapRow extends MarkdownRoadmapItem {
  parallel: string;
  dependencies: RoadmapRow[];
  unresolvedStatement?: string;
  changeName: string;
}

const STOP_WORDS = new Set(["all", "and", "or", "with", "parallel", "stage", "the"]);

function headingKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function cleanCell(value: string): string {
  return value.replace(/\{:[^}]*\}/g, "").replace(/\*\*/g, "").replace(/`/g, "").trim();
}

function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  return trimmed.slice(1, -1).split("|").map(cleanCell);
}

function isSeparator(row: readonly string[]): boolean {
  return row.length > 0 && row.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function parseStatus(value: string, order: string): MarkdownRoadmapStatus | undefined {
  const status = value.trim().toLowerCase();
  const orderKey = order.trim().toLowerCase();
  if (orderKey === "parked" || status === "parked" || status.includes("parked")) return "Parked";
  if (orderKey === "future" || status === "future" || status.includes("future")) return "Future";
  if (status.includes("🟢") || status === "done" || status === "complete" || status === "completed") return "Done";
  if (status.includes("🟡") || status.includes("🔄") || status === "in progress" || status === "active") return "In Progress";
  if (status.includes("⚪") || status === "not started" || status === "todo") return "Not Started";
  if (!status) return undefined;
  throw new Error(`Unsupported roadmap status '${value}'`);
}

function projectMappings(input: readonly MarkdownProjectMapping[]) {
  if (!input.length) throw new Error("Map each roadmap heading to a registered Project slug");
  const mappings = input.map((entry) => {
    if (!entry.heading.trim() || !entry.projectSlug.trim()) throw new Error("Roadmap Project mappings need headings and slugs");
    return { heading: entry.heading.trim(), projectSlug: entry.projectSlug.trim() };
  });
  if (new Set(mappings.map((entry) => headingKey(entry.heading))).size !== mappings.length) {
    throw new Error("Roadmap Project mappings must have unique headings");
  }
  return mappings;
}

function projectForHeading(heading: string, mappings: readonly MarkdownProjectMapping[]): string | undefined {
  return mappings.find((entry) => headingKey(entry.heading) === headingKey(heading))?.projectSlug
    ?? (mappings.length === 1 ? mappings[0]!.projectSlug : undefined);
}

function parseTables(markdown: string, mappings: readonly MarkdownProjectMapping[]): RoadmapRow[] {
  const rows: RoadmapRow[] = [];
  let projectHeading: string | undefined = mappings.length === 1 ? mappings[0]!.heading : undefined;
  let projectSlug: string | undefined = mappings.length === 1 ? mappings[0]!.projectSlug : undefined;
  let headers: string[] | undefined;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      projectHeading = heading[1]!.trim();
      projectSlug = projectForHeading(projectHeading, mappings);
      headers = undefined;
      continue;
    }
    const row = cells(line);
    if (!row) {
      headers = undefined;
      continue;
    }
    const columnNames = row.map((cell) => cell.toLowerCase().replace(/[^a-z]+/g, " ").trim());
    if (columnNames.some((cell) => cell === "workstream") && columnNames.some((cell) => cell === "issues")) {
      const statusIndex = columnNames.findIndex((cell) => cell === "status");
      const orderIndex = columnNames.findIndex((cell) => cell === "order");
      const workstreamIndex = columnNames.findIndex((cell) => cell === "workstream");
      const issuesIndex = columnNames.findIndex((cell) => cell === "issues");
      const parallelIndex = columnNames.findIndex((cell) => cell === "parallel");
      if (orderIndex < 0 || parallelIndex < 0) throw new Error("Roadmap tables need Order, Workstream, Issues, and Parallel? columns");
      headers = [String(statusIndex), String(orderIndex), String(workstreamIndex), String(issuesIndex), String(parallelIndex)];
      if (!projectSlug) throw new Error(`Map roadmap heading '${projectHeading ?? "(missing)"}' to a registered Project slug`);
      continue;
    }
    if (isSeparator(row)) continue;
    if (!headers) continue;
    const [statusAt, orderAt, workstreamAt, issuesAt, parallelAt] = headers.map(Number);
    const columns = [statusAt!, orderAt!, workstreamAt!, issuesAt!, parallelAt!].filter((index) => index >= 0);
    if (row.length !== Math.max(...columns) + 1) {
      throw new Error(`Roadmap row in '${projectHeading}' does not match its table header`);
    }
    const statusCell = statusAt! < 0 ? "" : row[statusAt!]!;
    const order = row[orderAt!]!;
    const workstream = row[workstreamAt!]!;
    const issueText = row[issuesAt!]!;
    if (!workstream) throw new Error(`Roadmap row in '${projectHeading}' has no workstream name`);
    const issueMatches = [...issueText.matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
    if (issueMatches.some((number) => !Number.isSafeInteger(number) || number < 1)
      || new Set(issueMatches).size !== issueMatches.length) throw new Error(`Roadmap issues for '${workstream}' must be unique positive numbers`);
    const status = parseStatus(statusCell, order);
    rows.push({
      workstream,
      projectSlug: projectSlug!,
      issues: issueMatches,
      ...(order ? { order } : {}),
      ...(status ? { status } : {}),
      parallel: row[parallelAt!]!,
      dependencies: [],
      changeName: semanticSlug(workstream),
    });
  }
  if (!rows.length) throw new Error("No supported Markdown roadmap tables found");
  const names = new Set<string>();
  for (const row of rows) {
    if (names.has(row.changeName)) throw new Error(`Roadmap workstream names must be unique: '${row.workstream}'`);
    names.add(row.changeName);
  }
  return rows;
}

function projectAliases(mappings: readonly MarkdownProjectMapping[]): Array<{ alias: string; projectSlug: string }> {
  const aliases: Array<{ alias: string; projectSlug: string }> = [];
  for (const mapping of mappings) {
    const values = new Set([mapping.heading, mapping.projectSlug]);
    const headingParts = mapping.heading.split(/\s+/);
    if (headingParts.length > 1) values.add(headingParts.at(-1)!);
    for (const alias of values) if (alias.trim()) aliases.push({ alias: alias.toLowerCase(), projectSlug: mapping.projectSlug });
  }
  return aliases.sort((left, right) => right.alias.length - left.alias.length);
}

function projectAt(text: string, index: number, aliases: readonly { alias: string; projectSlug: string }[]): string | undefined {
  let best: { end: number; length: number; projectSlug: string } | undefined;
  for (const candidate of aliases) {
    const escaped = candidate.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(`\\b${escaped}\\b`, "ig");
    for (const match of text.matchAll(expression)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (end > index) continue;
      if (!best || end > best.end || (end === best.end && match[0].length > best.length)) {
        best = { end, length: match[0].length, projectSlug: candidate.projectSlug };
      }
    }
  }
  return best?.projectSlug;
}

function relationClause(value: string): string | undefined {
  const after = value.match(/\bafter\s+(.+)$/i);
  if (after) return after[1]!.split(/;\s*parallel\b/i)[0]!.trim().replace(/[.;,]+$/, "").trim();
  if (/\blast\b/i.test(value)) return "last";
  return undefined;
}

function resolveDependencies(row: RoadmapRow, rows: readonly RoadmapRow[], mappings: readonly MarkdownProjectMapping[]): string | undefined {
  const clause = relationClause(row.parallel);
  if (!clause) return undefined;
  if (clause.toLowerCase() === "last") {
    const previous = rows.slice(0, rows.indexOf(row)).filter((candidate) => candidate.projectSlug === row.projectSlug).at(-1);
    if (!previous) return "last (no preceding workstream in this Project)";
    row.dependencies.push(previous);
    return undefined;
  }
  if (/\ball\s+3x\s*\/\s*4x\b/i.test(clause)) {
    const barriers = rows.filter((candidate) => candidate !== row && candidate.order && /^[34][a-z0-9]*$/i.test(candidate.order));
    if (!barriers.length) return clause;
    row.dependencies.push(...barriers);
    return undefined;
  }

  const issueMatches = [...clause.matchAll(/#(\d+)/g)];
  const orderMatches = [...clause.matchAll(/\b(\d+[A-Z])\b/gi)];
  const resolved = new Set<RoadmapRow>();
  for (const match of issueMatches) {
    const number = Number(match[1]);
    const hintedProject = projectAt(clause, match.index ?? 0, projectAliases(mappings));
    let candidates = rows.filter((candidate) => candidate.issues.includes(number)
      && (!hintedProject || candidate.projectSlug === hintedProject));
    if (!hintedProject) {
      const sameProject = candidates.filter((candidate) => candidate.projectSlug === row.projectSlug);
      if (sameProject.length) candidates = sameProject;
    }
    if (candidates.length !== 1) return `${clause} (issue #${number} does not identify one roadmap workstream)`;
    resolved.add(candidates[0]!);
  }
  for (const match of orderMatches) {
    const order = match[1]!.toLowerCase();
    const candidates = rows.filter((candidate) => candidate.projectSlug === row.projectSlug && candidate.order?.toLowerCase() === order);
    if (candidates.length !== 1) return `${clause} (order ${match[1]} does not identify one workstream in ${row.projectSlug})`;
    resolved.add(candidates[0]!);
  }

  let remainder = clause.replace(/#\d+/g, " ").replace(/\b\d+[A-Z]\b/gi, " ");
  for (const alias of projectAliases(mappings)) {
    const escaped = alias.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    remainder = remainder.replace(new RegExp(`\\b${escaped}\\b`, "ig"), " ");
  }
  const words = remainder.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((word) => word && !STOP_WORDS.has(word));
  if (words.length) {
    const candidates = rows.filter((candidate) => candidate !== row && candidate.projectSlug === row.projectSlug
      && words.every((word) => candidate.workstream.toLowerCase().split(/[^a-z0-9]+/).includes(word)));
    if (candidates.length !== 1) return clause;
    resolved.add(candidates[0]!);
  }
  if (!resolved.size) return clause;
  for (const dependency of resolved) {
    if (dependency === row) return `${clause} (workstream cannot depend on itself)`;
    row.dependencies.push(dependency);
  }
  return undefined;
}

function blockerFor(row: RoadmapRow, visiting = new Set<RoadmapRow>()): string[] {
  if (row.unresolvedStatement) return [row.unresolvedStatement];
  if (visiting.has(row)) return [];
  const nextVisiting = new Set(visiting).add(row);
  const blocked: string[] = [];
  for (const dependency of row.dependencies) {
    if (dependency.status === "Done") continue;
    if (dependency.status === "Parked" || dependency.status === "Future") {
      blocked.push(`${dependency.workstream} is ${dependency.status}`);
      continue;
    }
    blocked.push(...blockerFor(dependency, nextVisiting).map((reason) => `${dependency.workstream}: ${reason}`));
  }
  return [...new Set(blocked)];
}

/** Convert structured Markdown roadmap tables into proposal-only typed planning data. */
export function interpretMarkdownRoadmap(markdown: string, projectMapInput: readonly MarkdownProjectMapping[]): MarkdownRoadmapPlan {
  const mappings = projectMappings(projectMapInput);
  const rows = parseTables(markdown, mappings);
  for (const row of rows) {
    const unresolved = resolveDependencies(row, rows, mappings);
    if (unresolved) row.unresolvedStatement = unresolved.startsWith("after ") || unresolved === "last" ? unresolved : `after ${unresolved}`;
  }

  const selected = new Map<string, RoadmapRow>();
  const unresolved: MarkdownRoadmapPlan["planning"]["unresolved"] = [];
  const planningItems: MarkdownRoadmapItem[] = [];
  for (const row of rows) {
    const contextOnly = row.status === "Done" || row.status === "Parked" || row.status === "Future";
    const blockers = contextOnly ? [] : blockerFor(row);
    const canExecute = !contextOnly && blockers.length === 0;
    const item: MarkdownRoadmapItem = {
      workstream: row.workstream,
      projectSlug: row.projectSlug,
      issues: [...row.issues],
      ...(row.order ? { order: row.order } : {}),
      ...(row.status ? { status: row.status } : {}),
      ...(canExecute ? { changeSet: row.changeName } : {}),
      ...(row.dependencies.length ? { sourceDependencies: row.dependencies.map((dependency) => ({ workstream: dependency.workstream, projectSlug: dependency.projectSlug })) } : {}),
    };
    planningItems.push(item);
    if (canExecute) selected.set(row.changeName, row);
    else if (!contextOnly) unresolved.push({
      workstream: row.workstream,
      projectSlug: row.projectSlug,
      statement: row.unresolvedStatement ?? `Blocked by unresolved prerequisite(s): ${blockers.join("; ")}`,
    });
  }

  const relations: MarkdownRoadmapPlan["relations"] = [];
  for (const [name, row] of selected) {
    for (const dependency of row.dependencies) {
      if (dependency.status === "Done") continue;
      if (!selected.has(dependency.changeName)) continue;
      relations.push({ kind: "Requires", from: name, to: dependency.changeName });
    }
  }
  return {
    changeSets: [...selected].map(([name, row]) => ({ name, projectSlug: row.projectSlug, issues: [...row.issues] })),
    relations,
    planning: { items: planningItems, unresolved },
  };
}
