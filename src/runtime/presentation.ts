import { changeName, issueNumbers } from "../domain/names.js";
import type { BlockReason, ChangeSet, Task } from "../domain/model.js";
import type { MerroStore } from "../store/store.js";

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LEGACY = /\b[a-z0-9._-]+:(?:issue-\d+|(?:local|change):[^\s,)]+):g\d+\b/gi;

export type UserChangeState = "Working" | "Needs you" | "Ready to merge" | "Done" | "Blocked";

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

function reviewResult(tasks: Task[]): "passed" | "changes requested" | "not reviewed" | "review failed" {
  const latest = tasks.filter((task) => task.role === "review").at(-1);
  return latest?.outcome === "pass" ? "passed"
    : latest?.outcome === "reject" ? "changes requested"
      : latest?.outcome === "failed" ? "review failed" : "not reviewed";
}

function blockMessage(reason: BlockReason, detail: string, retryable: boolean | null, name: string, reviewPassed = false, localDelivery = false): { summary: string; next: string | null } {
  if (reason === "policy_unknown") {
    const rule = detail.match(/unsupported (?:merge requirement|branch rule) '([^']+)'/i)?.[1];
    if (retryable === false) return {
      summary: `Blocked by unsupported GitHub branch rule${rule ? `: ${rule}` : ""}. Merro cannot interpret this rule yet.`,
      next: "No retry needed. Merro will check again after the rule changes.",
    };
    return { summary: "Merro cannot verify GitHub's branch rules right now.", next: "Merro will check again automatically." };
  }
  if (reason === "github_unavailable" || reason === "project_unavailable") {
    if (localDelivery && reason === "project_unavailable") return { summary: "The canonical Project checkout is unavailable.", next: "Restore the checkout; Merro will retry automatically." };
    const summary = reviewPassed
      ? reason === "project_unavailable" ? "Review complete, publication blocked while this GitHub Project is unavailable."
        : "Review complete, publication blocked while GitHub is unavailable."
      : reason === "project_unavailable" ? "This GitHub Project is temporarily unavailable."
        : /current work|stop the worker|worker inspection/i.test(detail) ? "Merro could not safely verify the current work."
          : "GitHub is temporarily unavailable.";
    return { summary, next: "Merro will retry automatically when it is available." };
  }
  if (reason === "merge_rejected") return { summary: "The pull request was left open.", next: `Approve it later with /merro approve ${name}.` };
  if (reason === "pr_closed") return { summary: "The pull request was closed without merging.", next: "Reopen it on GitHub; Merro will check again automatically." };
  if (reason === "review_cap") return { summary: "Review still found blocking issues after the allowed rounds.", next: `See /merro ${name} for findings; then /merro retry ${name} after fixing them.` };
  if (reason === "cycle") return { summary: "The approved changes depend on each other in a cycle.", next: "Update the Objective's dependencies before retrying." };
  if (reason === "task_failed") {
    const diagnostic = oneLine(detail);
    const summary = /local ci is not green/i.test(diagnostic) ? diagnostic
      : diagnostic ? `The latest attempt failed: ${diagnostic}` : "Merro could not complete or verify the latest attempt.";
    return { summary, next: `See /merro ${name} for details; then /merro retry ${name} after fixing the cause.` };
  }
  if (reason === "clone_lost") return { summary: "Merro could not find the working copy for this change.", next: `Restore the working copy, then /merro retry ${name}.` };
  if (reason === "remote_branch_deleted") return { summary: "The pull request branch was deleted.", next: "Restore the branch on GitHub; Merro will check again automatically." };
  if (reason === "merge_failed") return localDelivery
    ? { summary: oneLine(detail) || "Local delivery is blocked.", next: `Check the canonical checkout, then /merro retry ${name}.` }
    : { summary: `GitHub could not merge this pull request: ${oneLine(detail)}`, next: `Check the pull request, then /merro retry ${name} if needed.` };
  if (reason === "publication_failed") return {
    summary: reviewPassed ? "Review complete, publication blocked: Merro could not open or update the pull request." : "Merro could not open or update the pull request.",
    next: `See /merro ${name} for details; then /merro retry ${name} after fixing the cause.`,
  };
  if (reason === "structural_rejected") return { summary: `GitHub rejected the change: ${oneLine(detail)}`, next: `Fix the cause, then /merro retry ${name}.` };
  return { summary: oneLine(detail) || "This change is blocked.", next: `Fix the cause, then /merro retry ${name}.` };
}

function userState(item: ChangeSet, reviewDecision: string | null, decisionAction: string | undefined): UserChangeState {
  if (item.state === "Done") return "Done";
  if (item.state === "Blocked" || item.state === "PublishBlocked") return "Blocked";
  if (decisionAction === "approve_merge") return "Ready to merge";
  if (decisionAction === "approve_fresh_attempt" || reviewDecision?.toUpperCase() === "REVIEW_REQUIRED") return "Needs you";
  return "Working";
}

export function publicText(text: string, names: ReadonlyMap<string, string> = new Map()): string {
  for (const [id, name] of [...names].sort((a, b) => b[0].length - a[0].length)) text = text.split(id).join(name);
  return text.replace(UUID, "worker").replace(LEGACY, "change");
}

export function workerName(item: ChangeSet, task: Pick<Task, "role">): string {
  return `${task.role === "implement" ? "impl" : "rev"}-${changeName(item)}`;
}

/** Default status contains only user-level state, decisions, and one-line context. */
export function presentWorkspace(store: MerroStore) {
  const items = store.listChangeSets().filter((item) => item.state !== "Obsolete");
  const decisionRows = store.pendingDecisions().map((decision) => {
    const payload = typeof decision.payload === "object" && decision.payload !== null ? decision.payload as Record<string, unknown> : {};
    const item = store.getChangeSet(decision.subjectId);
    const runtime = item && store.getChangeSetRuntime(item.id);
    const pr = typeof payload.pullRequest === "number" ? payload.pullRequest : runtime?.pullRequestNumber ?? null;
    const action = decision.kind === "merge_conflict" ? "approve_fresh_attempt" : "approve_merge";
    const summary = action === "approve_fresh_attempt"
      ? "Approve a fresh attempt to resolve merge conflicts?"
      : "Approve merge?";
    return { change: item ? changeName(item) : "change", action, pr, summary };
  });
  const decisionByChange = new Map(decisionRows.map((decision) => [decision.change, decision]));

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
      const state = userState(item, runtime?.githubReviewDecision ?? null, decision?.action);
      const checks = runtime?.pullRequestNumber
        ? githubChecks(runtime.githubChecks, runtime.githubChecksAt)
        : localChecks(tasks);
      const review = reviewResult(tasks);
      const latestReview = tasks.filter((task) => task.role === "review").at(-1);
      const latestBlock = store.latestBlock(item.id);
      const blocked = item.blockedReason
        ? blockMessage(item.blockedReason, latestBlock?.detail ?? "", latestBlock?.retryable ?? null, changeName(item), review === "passed", item.delivery === "local")
        : null;
      let summary: string;
      if (state === "Done") summary = item.delivery === "local" ? `Completed locally on ${item.targetBranch}` : runtime?.pullRequestNumber ? `PR #${runtime.pullRequestNumber} merged` : "Completed";
      else if (runtime?.pullRequestState?.toUpperCase() === "MERGED" && !runtime.mergedCommitSha) summary = `GitHub marked PR #${runtime.pullRequestNumber} merged; Merro is verifying completion`;
      else if (state === "Ready to merge") summary = "Ready for merge approval";
      else if (state === "Needs you") summary = runtime?.pullRequestNumber
        ? `PR #${runtime.pullRequestNumber} · ${decision?.action === "approve_fresh_attempt" ? "Merge conflicts need a resolution" : "GitHub requires reviewer approval"}`
        : "A decision is needed";
      else if (state === "Blocked") summary = blocked?.summary ?? "This change is blocked.";
      else if (active?.role === "implement" && latestReview?.outcome === "reject") summary = `Fixing review findings · attempt ${Math.max(2, (runtime?.reviewRound ?? 1) + 1)}`;
      else if (item.state === "Reviewed" && item.delivery === "local") summary = "Review passed; completing locally";
      else if (item.state === "Publishing") summary = "Opening PR...";
      else if (active?.role === "review") summary = "Checking the latest changes";
      else if (active) summary = "Working on the change";
      else if (item.state === "AwaitingMerge" && checks.state === "waiting") summary = `PR #${runtime?.pullRequestNumber} · GitHub checks running`;
      else if (item.state === "AwaitingMerge") summary = `PR #${runtime?.pullRequestNumber} · Waiting for GitHub review and checks`;
      else if (item.state === "Ready" || item.state === "Planned") summary = "Waiting to start";
      else summary = "Working on the change";
      return {
        name: changeName(item), project: item.projectSlug, issues: issueNumbers(item), status: state, summary,
        pr: runtime?.pullRequestNumber ?? null,
        prState: item.delivery === "local" ? "not requested" : runtime?.mergedCommitSha ? "MERGED" : runtime?.pullRequestState?.toUpperCase() === "MERGED" ? "verifying merge" : runtime?.pullRequestState?.toUpperCase() ?? "not opened",
        checks, review, decision: decision ?? null,
        blocked: blocked ? { message: blocked.summary, next: blocked.next } : null,
      };
    }),
    decisions: decisionRows,
  };
}

export function presentChangeDetails(store: MerroStore, name: string) {
  const item = store.listChangeSets().find((candidate) => changeName(candidate) === name);
  if (!item) return null;
  const runtime = store.getChangeSetRuntime(item.id);
  const tasks = store.listTasks(item.id);
  const current = presentWorkspace(store).changes.find((change) => change.name === name)!;
  const latestBlock = store.latestBlock(item.id);
  const block = item.blockedReason
    ? blockMessage(item.blockedReason, latestBlock?.detail ?? "", latestBlock?.retryable ?? null, name, current.review === "passed", item.delivery === "local")
    : null;
  const blocked = block ? {
    ...block,
    diagnostic: latestBlock?.detail && oneLine(latestBlock.detail) !== block.summary ? oneLine(publicText(latestBlock.detail)) : null,
  } : null;
  return {
    ...current,
    branch: runtime?.branchName ? publicText(runtime.branchName) : null,
    blocked,
    history: tasks.map((task) => {
      let note = task.summary ?? task.outcome ?? "In progress";
      if (task.role === "review" && task.resultJson) {
        try {
          const result = JSON.parse(task.resultJson) as { findings?: Array<{ severity?: string; summary?: string }> };
          const findings = result.findings?.filter((finding) => finding.severity === "blocking").map((finding) => finding.summary).filter((value): value is string => !!value) ?? [];
          if (findings.length) note = `${note} · ${findings.length} blocking finding${findings.length === 1 ? "" : "s"}: ${findings.map((finding) => oneLine(finding, 100)).join("; ")}`;
        } catch { /* Keep the finalized Task summary when a historical result is malformed. */ }
      }
      return {
        role: task.role === "implement" ? "Implementation" : "Review",
        attempt: task.attempt,
        outcome: task.outcome ?? "in progress",
        startedAt: task.startedAt,
        finalizedAt: task.finalizedAt,
        summary: oneLine(publicText(note)),
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

export function formatStatus(snapshot: ReturnType<typeof presentWorkspace>): string {
  const groups = snapshot.projects.map((project) => {
    const changes = snapshot.changes.filter((change) => change.project === project.slug);
    if (!changes.length) return "";
    return `${project.slug}\n${changes.map((change) => {
      const pr = change.pr ? ` · PR #${change.pr}${change.prState === "MERGED" ? " merged" : ""}` : "";
      const row = `  ${change.name}   ${change.status}${pr}`;
      if (change.status === "Done") return row;
      if (change.status === "Ready to merge") {
        return `${row}\n    ${formatChecks(change.checks, true)} · Merro review ${change.review}\n    Approve merge? /merro approve ${change.name} · Leave open: /merro leave ${change.name}`;
      }
      if (change.status === "Needs you" && change.decision?.action === "approve_fresh_attempt") {
        return `${row}\n    ${change.summary}\n    Approve a fresh attempt? /merro approve ${change.name} · Leave unchanged: /merro leave ${change.name}`;
      }
      const next = change.status === "Needs you" && !change.decision
        ? "\n    Next: Request an eligible reviewer on GitHub; Merro will recheck automatically."
        : change.status === "Blocked" && change.blocked?.next
          ? `\n    Next: ${change.blocked.next}`
          : "";
      const checks = change.checks.state === "not run" ? "" : `\n    ${formatChecks(change.checks)}`;
      return `${row}${change.summary ? `\n    ${change.summary}` : ""}${next}${checks}`;
    }).join("\n")}`;
  }).filter(Boolean);
  return groups.join("\n\n") || "No Merro work yet.";
}

export function formatChangeDetails(change: ReturnType<typeof presentChangeDetails>): string {
  if (!change) return "Change not found.";
  const pr = change.pr ? `PR #${change.pr}${change.prState === "MERGED" ? " merged" : ` (${change.prState.toLowerCase()})`}` : "No pull request yet";
  const lines = [
    change.name,
    `${change.status} · ${pr}`,
    `Project: ${change.project} · Issues: ${change.issues.map((number) => `#${number}`).join(" ") || "none"}`,
    `Current: ${change.summary}`,
    `Checks: ${formatChecks(change.checks, change.status === "Ready to merge")}`,
    `Review: ${change.review}`,
  ];
  if (change.branch) lines.push(`Branch: ${change.branch}`);
  if (change.blocked) lines.push(`\n${change.blocked.summary}${change.blocked.diagnostic ? `\nDetails: ${change.blocked.diagnostic}` : ""}${change.blocked.next ? `\nNext: ${change.blocked.next}` : ""}`);
  if (change.decision) lines.push(`\n${change.decision.summary}`);
  if (change.history.length) {
    lines.push("\nHistory:");
    for (const task of change.history) lines.push(`  ${task.role} ${task.attempt} · ${task.outcome} · ${task.summary}`);
  }
  return lines.join("\n");
}
