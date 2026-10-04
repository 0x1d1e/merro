import { changeName, issueNumbers } from "../domain/names.js";
import type { BlockReason, ChangeSet, ReviewRoundLimit, Task } from "../domain/model.js";
import type { MerroStore } from "../store/store.js";
import type { WorkerRoleSettings, WorkerSettings } from "../config.js";
import { currentlyReviewedIds } from "./reviewed.js";

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LEGACY = /\b[a-z0-9._-]+:(?:issue-\d+|(?:local|change):[^\s,)]+):g\d+\b/gi;

export type UserChangeState = "Working" | "Waiting" | "Needs you" | "Blocked" | "Done";
export const USER_STATES: readonly UserChangeState[] = ["Needs you", "Blocked", "Working", "Waiting", "Done"];

export type WaitingFor =
  | { kind: "dependency"; change: string; gate: "reviewed" | "done" }
  | { kind: "github_checks" | "github_review" | "github_availability" | "capacity" | "worker_exit" };

/** Who must act for the next transition. */
export type Owner = "merro" | "external" | "user";

export type CheckObservation = {
  source: "Local" | "GitHub";
  state: "running" | "passed" | "failed" | "waiting" | "not run" | "not reported";
  observedAt: string | null;
};

export function objectiveName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "") || "objective";
}

function oneLine(value: string, max = 180): string {
  const line = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function localChecks(tasks: Task[]): CheckObservation {
  const active = tasks.some((task) => task.role === "implement" && task.status === "active");
  const last = tasks.filter((task) => task.role === "implement").at(-1);
  if (active) return { source: "Local", state: "running", observedAt: null };
  if (!last?.resultJson) return { source: "Local", state: last?.outcome === "failed" ? "failed" : "not run", observedAt: last?.finalizedAt ?? null };
  try {
    const result = JSON.parse(last.resultJson) as { verification?: Array<{ kind: string; exit_code?: number }> };
    const commands = result.verification?.filter((entry) => entry.kind === "command") ?? [];
    return {
      source: "Local",
      state: commands.length ? commands.every((entry) => entry.exit_code === 0) ? "passed" : "failed" : "not run",
      observedAt: last.finalizedAt,
    };
  } catch {
    return { source: "Local", state: "not run", observedAt: last.finalizedAt };
  }
}

function githubChecks(value: string | null | undefined, observedAt: string | null | undefined): CheckObservation {
  const state: CheckObservation["state"] = value === "green" ? "passed"
    : value === "failed" ? "failed"
      : value === "pending" ? "waiting" : "not reported";
  return { source: "GitHub", state, observedAt: observedAt ?? null };
}

function reviewResult(tasks: Task[]): "passed" | "changes requested" | "not reviewed" | "review failed" | "running" {
  if (tasks.some((task) => task.role === "review" && task.status === "active")) return "running";
  const latest = tasks.filter((task) => task.role === "review").at(-1);
  return latest?.outcome === "pass" ? "passed"
    : latest?.outcome === "reject" ? "changes requested"
      : latest?.outcome === "failed" ? "review failed" : "not reviewed";
}

type BlockView = { summary: string; next: string | null; waitingKind?: "github_availability" | "worker_exit" };

/** Merro-owned conditions carry `waitingKind`: no `Next:` and no user command. */
/** `awaitingPublication`: review passed and the work has not reached a pull request yet. */
function blockMessage(reason: BlockReason, detail: string, retryable: boolean | null, name: string, awaitingPublication = false, localDelivery = false): BlockView {
  if (reason === "policy_unknown") {
    const rule = detail.match(/unsupported (?:merge requirement|branch rule) '([^']+)'/i)?.[1];
    if (retryable === false) return {
      summary: `Blocked by unsupported GitHub branch rule${rule ? `: ${rule}` : ""}. Merro cannot interpret this rule yet; it continues automatically after the rule changes.`,
      next: null,
    };
    return { summary: "Merro cannot verify GitHub's branch rules right now. Retrying automatically.", next: null, waitingKind: "github_availability" };
  }
  if (reason === "github_unavailable" || reason === "project_unavailable") {
    if (localDelivery && reason === "project_unavailable") return { summary: "The canonical Project checkout is unavailable.", next: "Restore the checkout; Merro continues automatically afterward." };
    const summary = awaitingPublication
      ? reason === "project_unavailable" ? "Review complete, publication blocked while this GitHub Project is unavailable."
        : "Review complete, publication blocked while GitHub is unavailable."
      : reason === "project_unavailable" ? "This GitHub Project is temporarily unavailable."
        : /current work|stop the worker|worker inspection/i.test(detail) ? "Merro could not safely verify the current work."
          : "GitHub is temporarily unavailable.";
    return { summary: `${summary} Retrying automatically.`, next: null,
      waitingKind: /current work|stop the worker|worker inspection/i.test(detail) ? "worker_exit" : "github_availability" };
  }
  if (reason === "merge_rejected") return localDelivery
    ? { summary: "Local merge was declined; no changes were applied.", next: `Request approval again with /merro retry ${name}.` }
    : { summary: "The pull request was left open.", next: `Approve it later with /merro approve ${name}.` };
  if (reason === "pr_closed") return { summary: "The pull request was closed without merging.", next: `Reopen it on GitHub, then /merro retry ${name}.` };
  if (reason === "review_cap") return { summary: "Review still found blocking issues after the allowed rounds.", next: `See /merro ${name} for findings; then /merro retry ${name} after fixing them.` };
  if (reason === "cycle") return { summary: "The approved changes depend on each other in a cycle.", next: "Update the Objective's dependencies before retrying." };
  if (reason === "task_failed") {
    const diagnostic = oneLine(detail);
    const summary = /local ci is not green/i.test(diagnostic) ? diagnostic
      : diagnostic ? `The latest attempt failed: ${diagnostic}` : "Merro could not complete or verify the latest attempt.";
    return { summary, next: `See /merro ${name} for details; then /merro retry ${name} after fixing the cause.` };
  }
  if (reason === "clone_lost") return { summary: "Merro could not find the working copy for this change.", next: `Restore the working copy, then /merro retry ${name}.` };
  if (reason === "remote_branch_deleted") return { summary: "The pull request branch was deleted.", next: `Restore the branch on GitHub, then /merro retry ${name}.` };
  if (reason === "merge_failed") return localDelivery
    ? { summary: oneLine(detail) || "Local delivery is blocked.", next: `Check the canonical checkout, then /merro retry ${name}.` }
    : { summary: `GitHub could not merge this pull request: ${oneLine(detail)}`, next: `Check the pull request, then /merro retry ${name} if needed.` };
  if (reason === "publication_failed") return {
    summary: awaitingPublication ? "Review complete, publication blocked: Merro could not open or update the pull request." : "Merro could not open or update the pull request.",
    next: `See /merro ${name} for details; then /merro retry ${name} after fixing the cause.`,
  };
  if (reason === "structural_rejected") return { summary: `GitHub rejected the change: ${oneLine(detail)}`, next: `Fix the cause, then /merro retry ${name}.` };
  return { summary: oneLine(detail) || "This change is blocked.", next: `Fix the cause, then /merro retry ${name}.` };
}

function workerRoleText(role: string, settings: WorkerRoleSettings): string {
  return `${role} ${settings.runtime}${settings.model ? ` ${settings.model}` : ""}${settings.thinking ? ` (${settings.thinking} thinking)` : ""}`;
}

export function workerSettingsText(settings: WorkerSettings): string {
  return `${workerRoleText("implementer", settings.implement)}, ${workerRoleText("reviewer", settings.review)}`;
}

export function reviewRoundsText(limit: ReviewRoundLimit): string {
  return limit === "unlimited" ? "unlimited review rounds" : `up to ${limit} review round${limit === 1 ? "" : "s"}`;
}

type PublicStatus = { status: UserChangeState; reason: string | null; owner: Owner; waitingFor: WaitingFor | null };

function publicStatus(
  item: ChangeSet, blocked: BlockView | null, reviewDecision: string | null, decisionAction: string | undefined,
  checks: CheckObservation, dependency: WaitingFor | null,
): PublicStatus {
  const waiting = (waitingFor: WaitingFor, owner: Owner): PublicStatus => ({ status: "Waiting", reason: null, owner, waitingFor });
  if (item.state === "Done") return { status: "Done", reason: null, owner: "merro", waitingFor: null };
  if (item.state === "Blocked" || item.state === "PublishBlocked") {
    if (blocked?.waitingKind) return waiting({ kind: blocked.waitingKind }, "merro");
    return { status: "Blocked", reason: null, owner: "user", waitingFor: null };
  }
  if (decisionAction === "approve_merge" || decisionAction === "approve_local_merge") return { status: "Needs you", reason: "ready to merge", owner: "user", waitingFor: null };
  if (decisionAction === "approve_fresh_attempt") return { status: "Needs you", reason: "merge conflicts", owner: "user", waitingFor: null };
  if (decisionAction === "approve_worker_settings") return { status: "Needs you", reason: "worker settings", owner: "user", waitingFor: null };
  if (item.state === "AwaitingApproval" || reviewDecision?.toUpperCase() === "REVIEW_REQUIRED") return waiting({ kind: "github_review" }, "external");
  if (item.state === "AwaitingMerge" && checks.state !== "passed") return waiting({ kind: "github_checks" }, "external");
  if (dependency && (item.state === "Ready" || item.state === "Planned" || dependency.kind === "capacity")) return waiting(dependency, "merro");
  return { status: "Working", reason: null, owner: "merro", waitingFor: null };
}

export function waitingText(waitingFor: WaitingFor, pr: number | null = null): string {
  const target = pr ? `PR #${pr}` : "The change";
  if (waitingFor.kind === "dependency") return waitingFor.gate === "reviewed" ? `waiting for ${waitingFor.change} review` : `waiting for ${waitingFor.change} to finish`;
  if (waitingFor.kind === "github_checks") return `${target} · waiting for GitHub checks`;
  if (waitingFor.kind === "github_review") return `${target} needs the required GitHub team review`;
  if (waitingFor.kind === "github_availability") return "GitHub unavailable · retrying automatically";
  if (waitingFor.kind === "worker_exit") return "verifying current work · retrying automatically";
  return "waiting for a free worker slot";
}

function activityOf(item: ChangeSet, active: Task | null | undefined, latestReview: Task | undefined): string {
  if (active?.role === "implement") return latestReview?.outcome === "reject" ? "fixing review findings" : "implementing";
  if (active?.role === "review") return "reviewing";
  if (item.state === "Publishing") return "opening PR";
  if (item.state === "Reviewed") return "preparing merge approval";
  return "starting";
}

export function publicText(text: string, names: ReadonlyMap<string, string> = new Map()): string {
  for (const [id, name] of [...names].sort((a, b) => b[0].length - a[0].length)) text = text.split(id).join(name);
  return text.replace(UUID, "worker").replace(LEGACY, "change");
}

export function workerName(item: ChangeSet, task: Pick<Task, "role">): string {
  return `${task.role === "implement" ? "impl" : "rev"}-${changeName(item)}`;
}

/** Default status contains only user-level state, decisions, and one-line context. */
export interface PresentationOptions {
  /** Scheduler capacity; without it, capacity holds are not reported. */
  maxConcurrentTasks?: number | "unlimited";
  /** Unverified live workers; like the scheduler, status counts them against capacity. */
  orphanedTaskCount?: number;
}

export function presentWorkspace(store: MerroStore, options: PresentationOptions = {}) {
  const items = store.listChangeSets().filter((item) => item.state !== "Obsolete");
  const decisionRows = store.pendingDecisions().filter((decision) => decision.subjectType === "ChangeSet").map((decision) => {
    const payload = typeof decision.payload === "object" && decision.payload !== null ? decision.payload as Record<string, unknown> : {};
    const item = store.getChangeSet(decision.subjectId);
    const runtime = item && store.getChangeSetRuntime(item.id);
    const pr = typeof payload.pullRequest === "number" ? payload.pullRequest : runtime?.pullRequestNumber ?? null;
    const action = decision.kind === "merge_conflict" ? "approve_fresh_attempt"
      : decision.kind === "worker_settings" ? "approve_worker_settings"
      : decision.kind === "local_merge" ? "approve_local_merge" : "approve_merge";
    const settings = action === "approve_worker_settings"
      ? `${workerSettingsText(payload.settings as WorkerSettings)}${payload.maxReviewRounds ? `, ${reviewRoundsText(payload.maxReviewRounds as ReviewRoundLimit)}` : ""}` : null;
    const summary = action === "approve_fresh_attempt" ? "Approve a fresh attempt to resolve merge conflicts?"
      : settings ? `${String(payload.objective)} was approved before Merro recorded its worker settings. Start with ${settings}?`
      : action === "approve_local_merge" ? "Approve local merge?" : "Approve merge?";
    const objective = typeof payload.objective === "string" ? payload.objective : null;
    return { change: item ? changeName(item) : "change", action, pr, summary, objective };
  });
  const decisionByChange = new Map(decisionRows.map((decision) => [decision.change, decision]));
  const byId = new Map(items.map((item) => [item.id, item]));
  const requires = store.listRelations().filter((relation) => relation.kind === "Requires");
  // Same gate semantics as the scheduler: a reviewed gate needs a current passing review, a done gate needs Done.
  const reviewed = currentlyReviewedIds(store);
  const gateSatisfied = (required: ChangeSet, gate: "reviewed" | "done"): boolean =>
    gate === "done" ? required.state === "Done" : reviewed.has(required.id);
  const unfinished = (item: ChangeSet) => requires
    .filter((relation) => relation.from === item.id)
    .flatMap((relation) => {
      const required = byId.get(relation.to);
      const gate = relation.gate ?? "done" as const;
      return required && !gateSatisfied(required, gate) ? [{ required, gate }] : [];
    });
  const activeTaskCount = store.listTasks().filter((task) => task.status === "active").length + (options.orphanedTaskCount ?? 0);
  const atCapacity = options.maxConcurrentTasks !== undefined && options.maxConcurrentTasks !== "unlimited" && activeTaskCount >= options.maxConcurrentTasks;
  const waitingOn = (item: ChangeSet): string[] => unfinished(item)
    .map(({ required }) => required.projectSlug === item.projectSlug ? changeName(required) : `${changeName(required)} (${required.projectSlug})`);

  return {
    projects: store.listProjects().map((project) => ({ slug: project.slug })),
    objectives: store.listObjectives().filter((objective) => objective.state !== "Stopped").map((objective) => ({
      name: objectiveName(objective.goal), status: objective.state === "Done" ? "Done" as const : "Working" as const, priority: objective.priority,
    })),
    changes: items.map((item) => {
      const runtime = store.getChangeSetRuntime(item.id);
      const tasks = store.listTasks(item.id);
      const active = store.activeTask(item.id);
      const decision = decisionByChange.get(changeName(item));
      const checks = runtime?.pullRequestNumber
        ? githubChecks(runtime.githubChecks, runtime.githubChecksAt)
        : localChecks(tasks);
      const review = reviewResult(tasks);
      const latestReview = tasks.filter((task) => task.role === "review").at(-1);
      const latestBlock = store.latestBlock(item.id);
      const blocked = item.blockedReason
        ? blockMessage(item.blockedReason, latestBlock?.detail ?? "", latestBlock?.retryable ?? null, changeName(item), review === "passed" && !runtime?.pullRequestNumber, item.delivery === "local")
        : null;
      const waiting = waitingOn(item);
      const firstDependency = unfinished(item)[0];
      const dependency: WaitingFor | null = firstDependency
        ? { kind: "dependency", change: changeName(firstDependency.required), gate: firstDependency.gate } : null;
      const capacityHeld = atCapacity && !active && !dependency && (item.state === "Ready" || item.state === "Implementing");
      const { status: state, reason, owner, waitingFor } = publicStatus(item, blocked, runtime?.githubReviewDecision ?? null, decision?.action, checks,
        dependency ?? (capacityHeld ? { kind: "capacity" } : null));
      let summary: string;
      if (state === "Done") summary = item.delivery === "local" ? `Completed locally on ${item.targetBranch}` : runtime?.pullRequestNumber ? `PR #${runtime.pullRequestNumber} merged` : "Completed";
      else if (runtime?.pullRequestState?.toUpperCase() === "MERGED" && !runtime.mergedCommitSha) summary = `GitHub marked PR #${runtime.pullRequestNumber} merged; Merro is verifying completion`;
      else if (reason === "ready to merge") summary = decision?.action === "approve_local_merge" ? `Ready to apply locally to ${item.targetBranch}` : "Ready for merge approval";
      else if (reason === "worker settings") summary = decision!.summary;
      else if (state === "Needs you") summary = runtime?.pullRequestNumber
        ? `PR #${runtime.pullRequestNumber} · Merge conflicts need a resolution`
        : "A decision is needed";
      else if (state === "Blocked" || blocked?.waitingKind) summary = blocked?.summary ?? "This change is blocked.";
      else if (waitingFor?.kind === "dependency" && waiting.length > 1) summary = `waiting for ${waiting.join(", ")}`;
      else if (waitingFor) summary = waitingText(waitingFor, runtime?.pullRequestNumber ?? null);
      else if (active?.role === "implement" && latestReview?.outcome === "reject") summary = `Fixing review findings · attempt ${Math.max(2, (runtime?.reviewRound ?? 1) + 1)}`;
      else if (item.state === "Reviewed" && item.delivery === "local") summary = "Review passed; preparing local merge approval";
      else if (item.state === "Publishing") summary = "Opening PR...";
      else if (active?.role === "review") summary = "Checking the latest changes";
      else if (active) summary = "Working on the change";
      else if (item.state === "AwaitingApproval") summary = `PR #${runtime?.pullRequestNumber} · Awaiting required team review`;
      else if (item.state === "AwaitingMerge" && checks.state === "waiting") summary = `PR #${runtime?.pullRequestNumber} · GitHub checks running`;
      else if (item.state === "AwaitingMerge") summary = `PR #${runtime?.pullRequestNumber} · Waiting for GitHub review and checks`;
      else if (item.state === "Ready" || item.state === "Planned") summary = waiting.length ? `Approved · waiting for ${waiting.join(", ")}` : "Approved · ready to start";
      else summary = "Working on the change";
      return {
        name: changeName(item), project: item.projectSlug, issues: issueNumbers(item), status: state, reason, owner, waitingFor,
        activity: activityOf(item, active, latestReview), worker: active ? workerName(item, active) : null, summary,
        pr: runtime?.pullRequestNumber ?? null,
        prState: item.delivery === "local" ? "not requested" : runtime?.mergedCommitSha ? "MERGED" : runtime?.pullRequestState?.toUpperCase() === "MERGED" ? "verifying merge" : runtime?.pullRequestState?.toUpperCase() ?? "not opened",
        checks, review, decision: decision ?? null, waitingOn: item.state === "Ready" || item.state === "Planned" ? waiting : [],
        blocked: blocked ? { message: blocked.summary, next: blocked.next } : null,
      };
    }),
    decisions: decisionRows,
  };
}

export function presentChangeDetails(store: MerroStore, name: string, options: PresentationOptions = {}) {
  const item = store.listChangeSets().find((candidate) => changeName(candidate) === name);
  if (!item) return null;
  const runtime = store.getChangeSetRuntime(item.id);
  const tasks = store.listTasks(item.id);
  const current = presentWorkspace(store, options).changes.find((change) => change.name === name)!;
  const latestBlock = store.latestBlock(item.id);
  const block = item.blockedReason
    ? blockMessage(item.blockedReason, latestBlock?.detail ?? "", latestBlock?.retryable ?? null, name, current.review === "passed" && !runtime?.pullRequestNumber, item.delivery === "local")
    : null;
  const blocked = block ? {
    message: block.summary, next: block.next,
    diagnostic: latestBlock?.detail && oneLine(latestBlock.detail) !== block.summary ? oneLine(publicText(latestBlock.detail)) : null,
  } : null;
  return {
    ...current,
    branch: runtime?.branchName ? publicText(runtime.branchName) : null,
    blocked,
    history: tasks.map((task) => {
      let note = task.summary ?? task.outcome ?? "In progress";
      let blocking: string[] = [];
      if (task.role === "review" && task.resultJson) {
        try {
          const result = JSON.parse(task.resultJson) as { findings?: Array<{ severity?: string; summary?: string }> };
          const findings = result.findings?.filter((finding) => finding.severity === "blocking").map((finding) => finding.summary).filter((value): value is string => !!value) ?? [];
          if (findings.length) note = `${note} · ${findings.length} blocking finding${findings.length === 1 ? "" : "s"}: ${findings.map((finding) => oneLine(finding, 100)).join("; ")}`;
          blocking = findings.map((finding) => oneLine(publicText(finding), 160));
        } catch { /* Keep the finalized Task summary when a historical result is malformed. */ }
      }
      return {
        role: task.role === "implement" ? "Implementation" : "Review",
        attempt: task.attempt,
        outcome: task.outcome ?? "in progress",
        startedAt: task.startedAt,
        finalizedAt: task.finalizedAt,
        summary: oneLine(publicText(note)),
        findings: blocking,
      };
    }),
  };
}

function displayTime(value: string | null): string {
  if (!value) return "time not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time not recorded" : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatChecks(checks: CheckObservation, mergeReady = false): string {
  const state = checks.state === "passed" ? "passed" : checks.state === "failed" ? "failed"
    : checks.state === "running" || checks.state === "waiting" ? "running" : checks.state;
  const qualification = mergeReady && checks.source === "GitHub" && checks.state === "failed" ? " (required checks pass)" : "";
  return `${checks.source} checks ${state}${qualification}${checks.observedAt ? ` · checked ${displayTime(checks.observedAt)}` : ""}`;
}

type Snapshot = ReturnType<typeof presentWorkspace>;
type ChangeView = Snapshot["changes"][number];

function counts(changes: readonly ChangeView[]): string {
  return USER_STATES.map((state) => `${state.padEnd(10)} ${changes.filter((change) => change.status === state).length}`).join("\n");
}

function checksWord(checks: CheckObservation): string {
  return checks.state === "waiting" ? "running" : checks.state;
}

/** Commands the user can run, only for changes the user owns. */
function userActions(change: ChangeView): string[] {
  if (change.decision?.action === "approve_local_merge") return [`Approve local merge: /merro approve ${change.name}`, `Leave unchanged: /merro leave ${change.name}`];
  if (change.decision?.action === "approve_worker_settings") return [`Approve worker settings: /merro approve ${change.name}`, `Skip: /merro stop ${change.decision.objective}`];
  if (change.decision?.action === "approve_fresh_attempt") return [`Approve fresh attempt: /merro approve ${change.name}`, `Leave unchanged: /merro leave ${change.name}`];
  if (change.decision) return [`Approve merge: /merro approve ${change.name}`, `Leave open: /merro leave ${change.name}`];
  return [];
}

function attentionDetail(change: ChangeView, full = false): string[] {
  if (change.reason === "ready to merge" && full) return [`${formatChecks(change.checks, true)} · Merro review ${change.review}`, ...userActions(change)];
  if (change.reason === "ready to merge") {
    const facts = [change.pr ? `PR #${change.pr}` : null, `review ${change.review}`, `checks ${checksWord(change.checks)}`].filter(Boolean);
    return [facts.join(" · "), ...userActions(change)];
  }
  if (change.status === "Needs you") return [change.summary, ...userActions(change)];
  if (change.status === "Blocked") return [change.blocked?.message ?? change.summary, ...(change.blocked?.next ? [change.blocked.next] : [])];
  return [change.summary];
}

/** Attention-first overview: counts, then only what needs the user, what is blocked, running and waiting. */
export function formatOverview(snapshot: Snapshot): string {
  if (!snapshot.changes.length) return "No Merro work yet.";
  const sections = (["Needs you", "Blocked", "Working", "Waiting"] as const).flatMap((state) => {
    const rows = snapshot.changes.filter((change) => change.status === state);
    if (!rows.length) return [];
    const lines = rows.map((change) => state === "Working" ? `  ${change.name} · ${change.project} · ${change.activity}`
      : `  ${change.name} · ${change.project}\n${attentionDetail(change).map((line) => `    ${line}`).join("\n")}`);
    return [`${state}\n${lines.join("\n\n")}`];
  });
  const done = snapshot.changes.filter((change) => change.status === "Done").length;
  return ["Merro", counts(snapshot.changes), ...sections, ...(done ? [`${done} done · all changes: /merro status`] : [])].join("\n\n");
}

/** Complete roadmap: counts plus every change grouped by Project. */
export function formatStatus(snapshot: Snapshot): string {
  const groups = snapshot.projects.map((project) => {
    const changes = snapshot.changes.filter((change) => change.project === project.slug);
    if (!changes.length) return "";
    return `${project.slug}\n${changes.map((change) => {
      const pr = change.pr ? ` · PR #${change.pr}${change.prState === "MERGED" ? " merged" : ""}` : "";
      const row = `  ${change.name}   ${change.status}${change.reason ? ` · ${change.reason}` : ""}${pr}`;
      if (change.status === "Done") return row;
      const checks = change.status !== "Needs you" && change.checks.state !== "not run" ? [formatChecks(change.checks)] : [];
      return [row, ...[...attentionDetail(change, true), ...checks].map((line) => `    ${line}`)].join("\n");
    }).join("\n")}`;
  }).filter(Boolean);
  if (!groups.length) return "No Merro work yet.";
  return `Roadmap\n\n${counts(snapshot.changes)}\n\n${groups.join("\n\n")}`;
}

const outcomeWord = (outcome: string) => outcome === "success" || outcome === "pass" ? "passed" : outcome === "reject" ? "changes requested" : outcome;

const NEXT_BY_OWNER: Record<Owner, string> = {
  merro: "Merro continues automatically.",
  external: "Merro continues automatically afterward.",
  user: "",
};

export function formatChangeDetails(change: ReturnType<typeof presentChangeDetails>, options: { history?: boolean } = {}): string {
  if (!change) return "Change not found.";
  if (options.history) {
    const rows = change.history.map((task) => `${`${task.role} ${task.attempt}`.padEnd(18)}${outcomeWord(task.outcome)}${task.findings.length ? `\n  ${task.findings.join("\n  ")}` : ""}`);
    return `${change.name} · history\n\n${rows.join("\n") || "No attempts yet."}`;
  }
  const state = change.status === "Working" ? `Working · ${change.activity}`
    : change.reason ? `${change.status} · ${change.reason}` : change.status;
  const lines = [
    change.name, "", state,
    `Project: ${change.project}`,
    `Issues: ${change.issues.map((number) => `#${number}`).join(" ") || "none"}`,
  ];
  if (change.pr) lines.push(`PR: #${change.pr}${change.prState === "MERGED" ? " merged" : ""}`);
  if (change.checks.state !== "not run") lines.push(`Checks: ${change.checks.source} ${checksWord(change.checks)}${change.reason === "ready to merge" && change.checks.source === "GitHub" && change.checks.state === "failed" ? " (required checks pass)" : ""}`);
  lines.push(`Review: ${change.review}`);
  if (change.branch) lines.push(`Branch: ${change.branch}`);
  if (change.status === "Waiting" || change.status === "Blocked" || change.status === "Done") {
    lines.push("", change.blocked?.message ?? change.summary);
    if (change.blocked?.diagnostic) lines.push(`Details: ${change.blocked.diagnostic}`);
  }
  if (change.worker) lines.push("", `Worker: ${change.worker}`);
  const actions = userActions(change);
  const next = change.blocked?.next ?? (actions.length ? null : change.status === "Blocked" || change.status === "Done" ? null : NEXT_BY_OWNER[change.owner]);
  if (actions.length) lines.push("", ...actions);
  else if (next) lines.push(change.worker ? "" : "", `Next: ${next}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
