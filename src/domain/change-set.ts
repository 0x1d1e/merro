import type { FlowChangeSetState, ChangeSetState, DeliveryMode } from "./model.js";
import { FLOW_CHANGE_SET_STATES, TERMINAL_CHANGE_SET_STATES } from "./model.js";

const allowedTransitions: Readonly<Record<FlowChangeSetState, ReadonlySet<ChangeSetState>>> = {
  Planned: new Set(["Ready", "Blocked", "Obsolete", "Cancelled"]),
  Ready: new Set(["Planned", "Implementing", "Blocked", "Obsolete", "Cancelled"]),
  Implementing: new Set(["Reviewing", "Blocked", "Obsolete"]),
  Reviewing: new Set(["Implementing", "Reviewed", "Blocked", "Obsolete"]),
  Reviewed: new Set(["AwaitingLocalMerge", "Publishing", "Implementing", "Reviewing", "Blocked", "Obsolete"]),
  AwaitingLocalMerge: new Set(["Done", "Implementing", "Blocked", "Obsolete"]),
  Publishing: new Set(["AwaitingMerge", "Implementing", "Reviewing", "PublishBlocked", "Blocked", "Obsolete"]),
  AwaitingMerge: new Set(["AwaitingApproval", "Implementing", "Reviewing", "Done", "Blocked", "Obsolete"]),
  AwaitingApproval: new Set(["AwaitingMerge", "Implementing", "Reviewing", "Done", "Blocked", "Obsolete"]),
};

function isFlowChangeSetState(state: ChangeSetState): state is FlowChangeSetState {
  return FLOW_CHANGE_SET_STATES.has(state as FlowChangeSetState);
}

export class InvalidChangeSetTransitionError extends Error {
  constructor(from: ChangeSetState, to: ChangeSetState) {
    super(`invalid ChangeSet transition: ${from} -> ${to}`);
    this.name = "InvalidChangeSetTransitionError";
  }
}

export function assertChangeSetTransition(
  from: ChangeSetState,
  to: ChangeSetState,
  blockedResumeState: FlowChangeSetState | null = null,
  delivery: DeliveryMode = "pr",
): void {
  if (from === to) return;
  if ((from === "Reviewed" && to === "Done")
    || (delivery === "local" && ["Publishing", "PublishBlocked", "AwaitingMerge", "AwaitingApproval"].includes(to))
    || (delivery === "pr" && to === "AwaitingLocalMerge")) {
    throw new InvalidChangeSetTransitionError(from, to);
  }
  if (TERMINAL_CHANGE_SET_STATES.has(from)) {
    throw new InvalidChangeSetTransitionError(from, to);
  }

  if (from === "Blocked" || from === "PublishBlocked") {
    if (to === "Obsolete" || to === "Cancelled") return;
    if (blockedResumeState !== null && to === blockedResumeState) return;
    throw new InvalidChangeSetTransitionError(from, to);
  }

  if (!isFlowChangeSetState(from) || !allowedTransitions[from].has(to)) {
    throw new InvalidChangeSetTransitionError(from, to);
  }
}
