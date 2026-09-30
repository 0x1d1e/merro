# Lifecycle

Read before changing states, relations, scheduling, PR or merge flow, reconciliation.

## Objective flow

1. User states Objective + Projects.
2. Main inspects repos and GitHub (open issues only), proposes WorkItems and relations.
3. User approves. Approval covers scope, structure, current plan.
4. New WorkItems inside approved scope are added automatically. Scope expansion, new Project, unregistered Project, splitting an issue → structural Decision.
5. Rejected structural change → affected WorkItems Blocked, wait for freeform direction.

Goal or scope change: log it, reconcile. Irrelevant untouched WorkItems → Obsolete. Active one finishes its Task, then Obsolete.
Done: refresh GitHub scope; no required matching work left. Blocked work keeps it Active. Externally closed issues count as satisfied. Reopened issue under an active Objective → new generation.
Stop is soft only: active Tasks finish, exclusive unfinished WorkItems → Obsolete, shared ones continue.
Multiple Objectives share one backlog. Shared WorkItem uses the highest active Objective priority.

## WorkItem transitions

```text
Planned -> Ready -> Implementing -> Reviewing -> AwaitingMerge -> Done
                         ^             | reject
                         +-------------+   (fresh implement Task, up to max_review_rounds)
any active state -> Blocked -> (user continue / auto-resume) -> previous flow
Planned|Ready|Blocked -> Obsolete | Cancelled
```

Review cap reached → Blocked(review_cap). "continue" grants another full round.
Dependents of a Blocked WorkItem stay Planned; they are listed in the failure report.

## Relations

- `Requires`: explicit always blocks; inferred blocks only if high confidence. Waits for completion (merge).
- `Conflicts`: high confidence only. No concurrent execution; Main orders by priority, then downstream unblock count, then repo context. Follower may start when predecessor finishes implement+review, before merge. Predecessor rework does not interrupt a running follower.
- Requires > Conflicts on order.
- Any cycle → involved WorkItems Blocked(cycle), Main asks user. No auto cycle-breaking in v0.1.
- Relation stores evidence, rationale, confidence, history of effective changes. Startup rebuilds active relations. High-confidence new relations inside approved scope apply automatically.
- Auto-combining issues is deferred past v0.1.

## Scheduling

Slot = active Task (implement or review). Default 3, user-settable, `unlimited` allowed.
Order of Ready items: priority (highest linked Objective or WorkItem level), transitive downstream unblock count (explicit + high-confidence Requires), oldest Ready, canonical ID. High may starve low. Ready never demotes to Planned for lack of a slot.
Loop: reconcile → consume terminal results → derive states → schedule up to capacity. Driven by an in-process timer while Main is open (adaptive cadence, idle when nothing runs) and by a headless `pi -p` pass (cron or notify hook) that runs one loop under the lock.

## Failure policy

- Task failed → WorkItem Blocked(task_failed). Main reports summary, reason, next action, direct dependents.
- Infra-class (container/process gone, no valid result): one automatic fresh Task. Second occurrence blocks.
- Real failure, wrong `task_id`, commit mismatch, missing verification → no retry.
- "continue" after user fix: fresh Task on same WorkItem, same clone if safe. Old Task stays immutable.
- Idle or wall-clock limit exceeded → report to user, no auto kill.
- Clone lost or corrupt during an active Task → Blocked(clone_lost). No recovery machinery in v0.1: user decides.

## Branches, clones, PRs

- Branch prefix by intent (`feat/`, `fix/`, ...), semantic kebab name, collision suffix `-<issue>`, immutable after creation. Never adopt an unrelated external branch.
- Create: fetch base_remote, branch from `base_remote/<default>`. Fetch fails → no new work for that Project.
- Base moved after start: implementer Task merges base into branch (no rebase, no force-push). Merge conflict → Decision(merge_conflict).
- External commits/rebase: compare effective diff. Unchanged → review stays valid. Changed → fresh review; reviewer verification becomes the PR verification source.
- PR only after review pass. Never draft. Head `push_owner:branch`, base `base_owner:default`, from persisted Project remotes. Existing PR reused, never duplicated.
- Body: `## Summary`, `## Verification` (final successful commands, deduped, grouped by implementer/reviewer if mixed, fallback noted), `## Issues` with `Closes #n`. Main validates structure only.
- User edits title/body → stop regenerating; Main restores only missing `Closes` and `## Verification`.
- One canonical comment marked `<!-- merro:review-notes -->`: passes, verification commands, non-blocking findings, notes. Updated on later passes, recreated if deleted, new one if update fails. Rejected findings stay internal.

## External review and CI

Change-request review or CI failure after PR → fresh implement Task → fresh review → push. No user prompt. Non-blocking external comments leave AwaitingMerge. Required checks come from GitHub policy; undeterminable → Blocked(policy_unknown). Optional check failures warn.

## Merge

Ready when: valid review covers latest diff, PR open and mergeable, required checks and reviews satisfied, policy known, no blocker. Then one Decision per PR, surfaced immediately, never batched, may wait forever.
Decision shows PR, final summary, verification, non-blocking findings, warnings.
- Approved → Main squash-merges. Squash disabled → Blocked. GitHub rejects → Blocked, fresh approval later.
- Rejected → Blocked, keep PR/branch/clone.
- Success → Done (even if issue stays open; warn if `Closes` didn't fire). Write immutable final summary (diff, PR metadata, implementer summaries, reviewer outcomes). Unblock dependents. Cleanup best-effort afterward.

## External mutations

Manual push/PR creation → adopt if identity matches. PR closed unmerged → Blocked, reopen needs explicit resume. Manual merge → Done, any method. Remote branch deleted before merge → Blocked, no silent repush; after merge → normal cleanup. Local clone or branch deleted with PR head present → rebuild from authoritative head, review stays valid only if diff unchanged. External reality wins.

## Cancel

WorkItem cancel needs confirmation showing Task, dependents, PR/branch state. Task cancelled, WorkItem Cancelled, PR left open until user separately confirms closing. Remote branch deletion always separate confirmation.

## Reconciliation

Full pass at every Main start, before scheduling: Projects, remotes, default branches, WorkItems, relations, branches, clones, containers, tmux windows, process identity, active Tasks, PR/merge state. One Project failing blocks only that Project.
Active Task with no process: valid matching result → consume; else failed (infra retry rules apply). Identity mismatch → failed. Orphan worker (live, no Task record) → report, never adopt or kill. Orphan clones never auto-deleted. Safe stale clones of terminal WorkItems removed only when Git proves it safe.
GitHub op failing after `gh` fails → Blocked(github_unavailable), auto-resume after a fresh reconcile succeeds. No blind retry of stale operations.

## Remotes and Projects

base_remote/push_remote inferred from `origin`/`upstream`, user confirms. Transport-equivalent URLs and remote renames adopted automatically; ownership transfer and fork switch need confirmation. Default-branch change applies to future WorkItems; existing PRs keep their base. Moved path: update in place after validation; different repo identity → Project Blocked until confirmed.
Project guidance persists only on clear future intent ("from now on ..."), stores current text only.
Project removal is not in v0.1.
