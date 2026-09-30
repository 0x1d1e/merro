import type { FlowWorkItemState, WorkItemState } from "./model.js";
import { FLOW_WORK_ITEM_STATES, TERMINAL_WORK_ITEM_STATES } from "./model.js";

const allowedTransitions: Readonly<Record<FlowWorkItemState, ReadonlySet<WorkItemState>>> = {
  Planned: new Set(["Ready", "Blocked", "Obsolete", "Cancelled"]),
  Ready: new Set(["Implementing", "Blocked", "Obsolete", "Cancelled"]),
  Implementing: new Set(["Reviewing", "Blocked"]),
  Reviewing: new Set(["Implementing", "AwaitingMerge", "Blocked"]),
  AwaitingMerge: new Set(["Done", "Blocked"]),
};

export class InvalidWorkItemTransitionError extends Error {
  constructor(from: WorkItemState, to: WorkItemState) {
    super(`invalid WorkItem transition: ${from} -> ${to}`);
    this.name = "InvalidWorkItemTransitionError";
  }
}

export function assertWorkItemTransition(
  from: WorkItemState,
  to: WorkItemState,
  blockedResumeState: FlowWorkItemState | null = null,
): void {
  if (from === to) return;
  if (TERMINAL_WORK_ITEM_STATES.has(from)) {
    throw new InvalidWorkItemTransitionError(from, to);
  }

  if (from === "Blocked") {
    if (to === "Obsolete" || to === "Cancelled") return;
    if (blockedResumeState !== null && to === blockedResumeState) return;
    throw new InvalidWorkItemTransitionError(from, to);
  }

  if (!FLOW_WORK_ITEM_STATES.has(from) || !allowedTransitions[from as FlowWorkItemState].has(to)) {
    throw new InvalidWorkItemTransitionError(from, to);
  }
}
