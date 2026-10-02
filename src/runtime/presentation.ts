import { changeName, issueNumbers } from "../domain/names.js";
import type { MerroStore } from "../store/store.js";
import type { ChangeSet, Task } from "../domain/model.js";

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LEGACY = /\b[a-z0-9._-]+:(?:issue-\d+|(?:local|change):[^\s,)]+):g\d+\b/gi;
export function publicText(text: string, names: ReadonlyMap<string, string> = new Map()): string {
  for (const [id, name] of [...names].sort((a, b) => b[0].length - a[0].length)) text = text.split(id).join(name);
  return text.replace(UUID, "worker").replace(LEGACY, "change");
}
export function workerName(item: ChangeSet, task: Pick<Task, "role">): string {
  return `${task.role === "implement" ? "impl" : "rev"}-${changeName(item)}`;
}
function localCI(tasks: Task[]): string {
  if (tasks.some((task) => task.role === "implement" && task.status === "active")) return "running";
  const last = tasks.filter((task) => task.role === "implement").at(-1);
  if (!last?.resultJson) return last?.outcome === "failed" ? "failed" : "not run";
  try {
    const result = JSON.parse(last.resultJson) as { verification?: Array<{ kind: string; exit_code?: number }> };
    const commands = result.verification?.filter((entry) => entry.kind === "command") ?? [];
    return commands.length ? commands.every((entry) => entry.exit_code === 0) ? "green" : "failed" : "not run";
  } catch { return "unknown"; }
}
/** Normal status/export excludes database keys, worker process identity, and decision payloads. */
export function presentWorkspace(store: MerroStore) {
  const names = new Map<string, string>();
  const items = store.listChangeSets();
  for (const item of items) names.set(item.id, changeName(item));
  for (const objective of store.listObjectives()) names.set(objective.id, objective.goal);
  for (const task of store.listTasks()) {
    const item = items.find((item) => item.id === task.changeSetId);
    if (item) names.set(task.id, workerName(item, task));
  }
  return {
    projects: store.listProjects().map((project) => ({ slug: project.slug })),
    objectives: store.listObjectives().map((objective) => ({ goal: publicText(objective.goal, names), state: objective.state, priority: objective.priority })),
    changes: items.map((item) => {
      const runtime = store.getChangeSetRuntime(item.id);
      const tasks = store.listTasks(item.id);
      const active = store.activeTask(item.id);
      return {
        name: changeName(item), project: item.projectSlug, issues: issueNumbers(item), state: item.state,
        branch: runtime?.branchName ? publicText(runtime.branchName, names) : null, pr: runtime?.pullRequestNumber ?? null,
        worker: active ? workerName(item, active) : null, workerState: null as string | null,
        ci: localCI(tasks), lastActivity: publicText(tasks.at(-1)?.summary ?? (active ? "Working" : "Waiting"), names),
        blocked: item.blockedReason,
      };
    }),
    decisions: store.pendingDecisions().map((decision) => {
      const payload = typeof decision.payload === "object" && decision.payload !== null ? decision.payload as Record<string, unknown> : {};
      return {
        change: names.get(decision.subjectId) ?? "change", kind: decision.kind,
        pr: typeof payload.pullRequest === "number" ? payload.pullRequest : null,
        summary: publicText(typeof payload.detail === "string" ? payload.detail : Array.isArray(payload.summary) ? payload.summary.join("\n") : "Merge approval required.", names),
      };
    }),
  };
}
export function formatStatus(snapshot: ReturnType<typeof presentWorkspace>): string {
  const status = snapshot.projects.map((project) => [project.slug, ...snapshot.changes.filter((change) => change.project === project.slug).map((change) =>
    `\n${change.name}\nIssues: ${change.issues.map((number) => `#${number}`).join(" ")}\nState: ${change.state}${change.worker ? `\nWorker: ${change.worker}${change.workerState ? ` (${change.workerState})` : ""}` : ""}\nCI: ${change.ci}\nLast activity: ${change.lastActivity}${change.pr ? `\nPR: #${change.pr}` : ""}`)].join("\n")).join("\n\n") || "Merro: no work planned.";
  return `${status}${snapshot.decisions.length ? `\n\nPending decisions:\n${snapshot.decisions.map((decision) => `${decision.change}: ${decision.summary}\n/merro-approve ${decision.change}`).join("\n")}` : ""}`;
}
