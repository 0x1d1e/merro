# ADR-0013: Attention-first presentation

## Status

Accepted. Adds to ADR-0003 and ADR-0012; does not change lifecycle states.

## Context

Merro reported its own orchestration: internal states, retry hints for Merro-owned work, and permanent notifications for transient conditions. Users had to decide which messages mattered.

## Decision

Public states are Working, Waiting, Needs you, Blocked and Done, derived from lifecycle state, dependencies and Decisions. Waiting carries a structured `waitingFor` (dependency, github_checks, github_review, github_availability, capacity, worker_exit) so ownership is explicit. Merro-owned conditions never show `Next:` or retry.

Permanent notifications are reserved for conditions that need the user. Automatic recovery and waiting goes to the transient status line; permanent notifications are deduped per subject and re-arm when progress is reported for that subject or a new block occurs. Diagnostics stay in `/merro <change>`; history is opt-in via `--history`.

Approval is deterministic: the extension captures the raw user message from Pi's `input` event (ignoring extension-sourced input), and the approval tools read that, never a model-authored argument. Only exactly `approve` approves, and one reply authorizes one approval. The reply must arrive after the plan or Decision it approves was shown; it is cleared on extension input and once the turn settles (Pi's `agent_settled`, after automatic retries and compaction continuations). Other input gets `Unknown choice` with the valid choices. `/merro approve` is the escape hatch: the typed command is itself the approval, so it approves the pending plan, or a merge Decision; when both wait it asks for a name.

Worker settings (model, thinking, runtime) and the review-round limit are snapshotted at plan approval. Worker settings are persisted per ChangeSet and the first approval wins, so a ChangeSet shared by Objectives never switches settings when ownership changes. The Objective keeps its own snapshot so ChangeSets it gains later (issues entering a live query scope) use it; a reopened issue generation inherits the settings of the generation it continues. Config hot reload affects only future plans. Concurrency, merge, notify and similar operational settings stay live.

Worker-proposed issues carry a persisted, monotonic number so `/merro issue approve N` never shifts after a dismissal.

## Consequences

Approval tools gain no new parameters; `registerMainTools` requires a user-approval source. Schema version 22 adds `objective_settings.worker_settings_json`; version 23 adds `change_set_worker_settings`, backfilled from the oldest approving Objective, and repairs databases from development builds whose version 22 had either layout.
