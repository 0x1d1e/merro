# ADR-0013: Attention-first presentation

## Status

Accepted. Adds to ADR-0003 and ADR-0012; does not change lifecycle states.

## Context

Merro reported its own orchestration: internal states, retry hints for Merro-owned work, and permanent notifications for transient conditions. Users had to decide which messages mattered.

## Decision

Public states are Working, Waiting, Needs you, Blocked and Done, derived from lifecycle state, dependencies and Decisions. Waiting carries a structured `waitingFor` (dependency, github_checks, github_review, github_availability, capacity, worker_exit) so ownership is explicit. Merro-owned conditions never show `Next:` or retry.

Permanent notifications are reserved for conditions that need the user. Automatic recovery and waiting goes to the transient status line; permanent notifications are deduped per subject and re-arm when progress is reported for that subject. Diagnostics stay in `/merro <change>`; history is opt-in via `--history`.

Approval is deterministic: the extension captures the raw user message from Pi's `input` event (ignoring extension-sourced input), and the approval tools read that, never a model-authored argument. Only exactly `approve` approves, and one reply authorizes one approval. Other input gets `Unknown choice` with the valid choices. `/merro approve` remains the escape hatch.

Worker settings (model, thinking, runtime) are captured at plan proposal and the review-round limit is materialized at approval; both are persisted per Objective, so config hot reload affects only future plans. Concurrency, merge, notify and similar operational settings stay live.

Worker-proposed issues carry a persisted, monotonic number so `/merro issue approve N` never shifts after a dismissal.

## Consequences

Approval tools gain no new parameters; `registerMainTools` requires a user-approval source. Schema version 22 adds `objective_settings.worker_settings_json`.
