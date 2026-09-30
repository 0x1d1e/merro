# v0.1 acceptance

0. Tracer bullet first: one Project, one issue, implement, review pass, PR, approval, squash merge, Done.
1. Primary e2e: two Projects, one Objective, issue discovery, cross-project Requires, parallel independent Tasks, implement, verify, review reject, rework, pass, PR, external CI/review reconciliation, merge approval, squash, dependent unblock, second Project done, Objective done.
2. Crash recovery: Main dies, container survives, new Main takes lock, reconciles, does not restart the healthy Task, consumes result, resumes scheduling.
3. Failure: Task fails, WorkItem Blocked, report with dependents, user fixes, "continue", fresh Task, old Task unchanged. Infra-class failure retries once.
4. Review cap: reject loop stops at `max_review_rounds`, Blocked(review_cap), "continue" grants another round.
5. External mutation: manual commit, branch rewrite, push, PR create/edit/close/reopen/merge, remote branch delete, local clone delete. Reconcile without inventing state.
6. Relations/scheduling: Requires blocking, cycle → Blocked, conflict ordering, shared WorkItem across Objectives, priority order, concurrency cap with Ready under no slot.
7. Result integrity: stale result, task_id mismatch, commit mismatch (both roles), valid result after worker exit, missing worker with no result, immutable finalized Tasks (enforced by store triggers).
8. Sandbox: worker cannot see source repo or host config; reviewer mount is read-only; `pi_config` copy vs clean; `sandbox: none` path.
