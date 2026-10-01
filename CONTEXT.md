# Merro domain context

## Terms

### Main
The single Pi session the user talks to. Plans, infers relations, schedules, launches workers, reconciles, opens PRs, asks approval, merges.
- **Invariant:** one Main per workspace (lockfile + PID + start time). Only Main writes the store.
- **Avoid:** orchestrator, supervisor

### Worker
Disposable Pi process running one Task in a container. Never schedules, merges, creates Tasks, writes the store, or talks to the user.
- **Avoid:** agent, subagent

### Project
One registered repository. Identity is its immutable slug.
- **Relates to:** base_remote (canonical, PR base), push_remote (branch and PR head).

### Objective
User goal with an explicit Project set and priority (high/normal/low). States: Active, Done, Stopped.
- **Invariant:** ID is immutable once execution starts. Goal and scope may change; changes are logged.

### WorkItem
Unit of work in exactly one Project. Backed by one GitHub issue, or `local` (no issue).
- **Identity:** `<project>:issue-<n>` or `<project>:local:<slug>`, plus a generation counter. Authoritative IDs are never rewritten; filesystem namespace names are deterministic derived identities.
- **Invariant:** at most one non-terminal generation per source; terminal generations are immutable and never reactivated.
- **Avoid:** ticket, job, "task" for WorkItem

### Task
One execution attempt on a WorkItem. Role `implement` or `review`. Runs in one container.
- **Invariant:** at most one active Task per WorkItem. Implement and review never overlap. Finalized Tasks are immutable.
- **Outcomes:** implement: success, failed, cancelled. review: pass, reject, failed, cancelled. `reject` is not failure.

### Relation
Directed `Requires` or symmetric `Conflicts` between WorkItems. Cross-project work exists only through Relations.
- **Invariant:** persisted only if explicit or high-confidence. Requires beats Conflicts.

### Decision
Pending question to the user (merge approval, structural approval, blocker resolution). One per subject.
- **Invariant:** only affected WorkItems and dependents wait.

### Blocked
Exceptional state requiring user resolution or explicit "continue". Always carries a typed `BlockReason`. Reasons fixable externally (gh auth restored, network back) auto-resume after reconciliation; user-owned reasons (merge rejected, PR closed, review cap, explicit-cycle) need "continue".

### Generation
Counter for repeated work on one source. Never reused.

## WorkItem states

`Planned` waiting on relation/condition. `Ready` runnable, may wait for a slot. `Implementing` / `Reviewing` active Task. `AwaitingMerge` PR open, review valid. `Blocked`. Terminal: `Done` (merged), `Obsolete`, `Cancelled`.
There is no `Failed`: Task failed → WorkItem Blocked.

## Global invariants

1. Only Main talks to the user and writes the store.
2. Main never force-pushes. Finalized Task commits are never rewritten.
3. Merge needs explicit per-PR approval, except when the user merged externally.
4. External state wins on reconciliation: GitHub for issues/PRs/reviews/checks/policy/merge, Git for branches/commits/clones, Docker/tmux for live workers, Merro store for orchestration metadata, decisions, guidance.
5. A Task execution failure is reported once; only infra-class failure (worker died with no result) gets one automatic retry.
6. `Requires` dependents unblock only on actual completion (merge for PR-backed work).
7. Merro never auto-splits an issue and never auto-creates issues.
8. Guidance precedence: current user instruction, WorkItem guidance, Project guidance, repo instructions.
