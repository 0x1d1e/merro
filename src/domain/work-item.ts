import type { WorkItemState } from "./model.js";
import { TERMINAL_WORK_ITEM_STATES } from "./model.js";

const allowedTransitions: Readonly<Record<WorkItemState, ReadonlySet<WorkItemState>>> = {
  Planned: new Set(["Ready", "Blocked", "Obsolete", "Cancelled"]),
  Ready: new Set(["Implementing", "Blocked", "Obsolete", "Cancelled"]),
  Implementing: new Set(["Reviewing", "Blocked", "Obsolete"]),
  Reviewing: new Set(["Implementing", "AwaitingMerge", "Blocked", "Obsolete"]),
  AwaitingMerge: new Set(["Done", "Blocked", "Obsolete"]),
  Blocked: new Set(["Planned", "Ready", "Implementing", "Reviewing", "AwaitingMerge", "Obsolete", "Cancelled"]),
  Done: new Set(),
  Obsolete: new Set(),
  Cancelled: new Set(),
};

export class InvalidWorkItemTransitionError extends Error {
  constructor(from: WorkItemState, to: WorkItemState) {
    super(`invalid WorkItem transition: ${from} -> ${to}`);
    this.name = "InvalidWorkItemTransitionError";
  }
}

export function assertWorkItemTransition(from: WorkItemState, to: WorkItemState): void {
  if (from === to) return;
  if (TERMINAL_WORK_ITEM_STATES.has(from) || !allowedTransitions[from].has(to)) {
    throw new InvalidWorkItemTransitionError(from, to);
  }
}
