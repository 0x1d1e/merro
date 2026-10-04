# ADR-0013: Attention-first presentation

## Status

Accepted. Adds to ADR-0003 and ADR-0012; does not change lifecycle states.

## Context

Merro reported its own orchestration: internal states, retry hints for Merro-owned work, and permanent notifications for transient conditions. Users had to decide which messages mattered.

## Decision

Public states are Working, Waiting, Needs you, Blocked and Done, derived from lifecycle state, dependencies and Decisions. Waiting carries a structured `waitingFor` (dependency, github_checks, github_review, github_availability, capacity, worker_exit) so ownership is explicit. Merro-owned conditions never show `Next:` or retry.

Permanent notifications are reserved for conditions that need the user. Automatic recovery and waiting goes to the transient status line; permanent notifications are deduped per subject and re-arm when progress is reported for that subject. Diagnostics stay in `/merro <change>`; history is opt-in via `--history`.

Approval is deterministic: tools require the user's literal `reply`, and only exactly `approve` approves. Other input gets `Unknown choice` with the valid choices.

Worker settings (model, thinking, runtime) are snapshotted per Objective at plan approval and used at launch; config hot reload affects only future plans. `maxReviewRounds` still reads live config.

Worker-proposed issues carry a persisted, monotonic number so `/merro issue approve N` never shifts after a dismissal.

## Consequences

`merro_start_objective` and approving `merro_resolve_decision` require `reply`. Schema version 22 adds `objective_settings.worker_settings_json`.
