import type { IssueQuery, ObjectiveIssueScope } from "./model.js";

export function parseObjectiveIssueScopes(
  value: unknown,
  projectSlugs: readonly string[],
  options: { allowEmptyFixedSelections?: boolean } = {},
): ObjectiveIssueScope[] {
  if (!Array.isArray(value)) throw new Error("Objective issue scopes must be an array");
  const linkedProjects = new Set(projectSlugs);
  const projects = new Set<string>();
  const scopes: ObjectiveIssueScope[] = value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("invalid Objective issue scope");
    const row = entry as Record<string, unknown>;
    if (typeof row.projectSlug !== "string" || !linkedProjects.has(row.projectSlug)) throw new Error("issue scope references an unlinked Project");
    if (projects.has(row.projectSlug)) throw new Error(`duplicate issue scope for Project '${row.projectSlug}'`);
    projects.add(row.projectSlug);
    if (("numbers" in row) === ("query" in row)) throw new Error("issue scope requires either numbers or query, not both");
    if ("numbers" in row) {
      if (!Array.isArray(row.numbers) || (!options.allowEmptyFixedSelections && row.numbers.length === 0)
        || row.numbers.some((number) => !Number.isSafeInteger(number) || number < 1)) throw new Error("issue scope requires positive issue numbers");
      return { projectSlug: row.projectSlug, numbers: [...new Set(row.numbers as number[])].sort((a, b) => a - b) };
    }
    if (typeof row.query !== "object" || row.query === null || Array.isArray(row.query)) throw new Error("issue scope query must be an object");
    const query = row.query as Record<string, unknown>;
    if (Object.keys(query).some((key) => key !== "labels" && key !== "milestone")) throw new Error("unsupported issue scope query field");
    const labels = query.labels === undefined ? [] : query.labels;
    if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string" || !label.trim())) throw new Error("issue scope labels must be non-empty strings");
    if (query.milestone !== undefined && (typeof query.milestone !== "string" || !query.milestone.trim())) throw new Error("issue scope milestone must be a non-empty string");
    return {
      projectSlug: row.projectSlug,
      query: {
        labels: [...new Set(labels as string[])].sort(),
        ...(query.milestone === undefined ? {} : { milestone: query.milestone as string }),
      },
    };
  });
  for (const project of linkedProjects) {
    if (!projects.has(project)) throw new Error(`missing issue scope for Project '${project}'`);
  }
  return scopes;
}

export function matchesIssueQuery(query: IssueQuery, issue: { labels: readonly string[]; milestone?: string | null }): boolean {
  return (query.labels ?? []).every((label) => issue.labels.some((candidate) => candidate.toLowerCase() === label.toLowerCase()))
    && (query.milestone === undefined || issue.milestone === query.milestone);
}

export function matchesIssueScope(scope: ObjectiveIssueScope, issue: { number: number; labels: readonly string[]; milestone?: string | null }): boolean {
  return "numbers" in scope ? scope.numbers.includes(issue.number) : matchesIssueQuery(scope.query, issue);
}
