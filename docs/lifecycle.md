# Lifecycle

Read before changing ChangeSet states, relations, scheduling, PR/merge flow or reconciliation. Terms belong to [CONTEXT.md](../CONTEXT.md).

## Workspace and approval

Only `cwd/.merro` is authoritative. `/merro init` creates state explicitly in any writable directory, without requiring a Git repository, remote or GitHub access. First init writes all editable config defaults, short workspace/role Markdown templates, the Project-guidance directory, and default checkout directories. Existing `.merro` makes init a no-op, not a repair. Projects register separately: remote URLs clone into `<root>/projects/<project>`; supplied local paths register directly. No home scanning or destination adoption. Startup opens and reconciles state without replacing config or data. Missing/incomplete state refuses operations with initialization guidance.

Main proposes the user's Objective and waits for approval. One plan is pending per Main/workspace; replacement or restart expires it. Approval may be unqualified or use the semantic change name, never a database key. Changed issue scope, generation, branch, delivery mode, target branch, or relation graph requires fresh approval. A plan displays change names, issues, branches, delivery, PR count and worker counts.

Default grouping combines the selected issues within each Project into one ChangeSet. Issue-free Objectives select named changes with no GitHub scope. Delivery mode defaults to local, with PR opt-in; remote presence never implies publication. Cross-Project Objectives have separate changes. An issue already owned by another active selection cannot be silently regrouped. Separate delivery is explicit, not a second execution model: each delivery unit is still a ChangeSet.

Combined query results become fixed selections on approval so future matches cannot silently enlarge a running change. Separate delivery may retain a live query of labels and optional milestone. Newly matching issues enter approved query scope; scope expansion or new Projects require user direction. Query removal detaches ownership, obsoletes exclusive unfinished work once idle, and preserves shared work. Failed scope refresh gates scheduling and completion, never falls back to cached membership.

An Objective completes only after fresh scope verification and terminal attached work. Issue-free scopes require no GitHub calls. Externally closed issues may satisfy work. A terminal source reopened under an active Objective creates new history rather than mutating the old generation. Stopping is soft: current Tasks finish; exclusive unowned work becomes Obsolete; other owners continue.

## ChangeSet flow

```text
Planned -> Ready -> Implementing -> Reviewing -> Reviewed -> Publishing -> AwaitingMerge -> Done
                         ^             | reject                  | failure
                         +-------------+                         v
                                                        PublishBlocked -> Publishing
Reviewed -> Done (local delivery)
any non-terminal state -> Blocked -> prior flow after resolution
idle unfinished work -> Obsolete | Cancelled
```

Successful implementation requires at least one reported verification command, all with zero exit codes, before review. Main validates result and commit integrity; it does not independently rerun repository CI. Manual-only results cannot unlock review.

Review receives all issue contents and acceptance criteria, complete base-to-head diff, latest successful implementation summary/verification, prior findings, guidance and repository instructions. No implementer conversation history. Rejection is not a Task failure; its findings go to a fresh implementer on the same branch. `max_review_rounds` defaults to 3. At the cap, Blocked(review_cap); explicit continuation grants a new round.

Changed requirements require stopping the exact owned Worker, confirming exit, cancelling its Task and restoring the attempt base before launching a fresh implementer. Never send steering input to a running Worker. Finalized Task commits/history remain immutable.

## Relations and scheduling

- `Requires` waits for actual completion, normally merge. Internal references among issues in one ChangeSet are satisfied within its implementation scope.
- `Conflicts` serializes execution. A follower may run after predecessor implementation/review finishes, before merge. Rework does not interrupt a follower already running.
- Requires takes precedence; cycles block involved changes until user resolution.
- Relations need explicit or high-confidence evidence. Automatic analysis recognizes affirmative issue references; quoted, negated and speculative text is not evidence. Unresolved references gate scheduling, never expand scope.
- Automatic rebuilds preserve explicit relations and conflict occupancy held by active or orphan Workers.

A slot is one active Task, implementation or review. Default global capacity is 3; at most one Task per ChangeSet regardless of its issue count. Order: highest active-owner priority, downstream unblock count, oldest Ready, stable private tie-breaker. Ready changes without a slot remain Ready.

Main reconciles before scheduling, on startup and periodically while open. `/merro run` requests a pass. Serialized access lets status/export wait behind an active pass without competing for the writer lock.

## Failures and recovery

A real failure blocks once with a semantic change name, reason and retry guidance. A missing/dead Worker with no valid result gets one infrastructure retry; the next disappearance blocks. Invalid/stale results, commit mismatch and missing verification are not infrastructure retries.

`/merro retry <change>` resumes the blocked phase after its cause is fixed. Task failures receive a fresh Task; PublishBlocked resumes publication/reconciliation without repeating completed implementation or review. Known transient `gh` connection failures receive bounded backoff before blocking. Externally fixable causes such as GitHub unavailability auto-resume only after fresh reconciliation. User-owned causes such as rejected merge, closed PR, explicit cycle and review cap need continuation. Idle/wall limits warn without automatically killing work.

A live unreadable or mismatched identity remains occupied and pauses scheduling. Orphans are reported, never adopted or automatically killed. Unknown ownership gates the workspace; known orphan ownership gates its Project. Inventory failures gate the affected Project. Healthy independent Projects continue.

Valid result after exit is consumed. Result submission alone does not prove exit: refresh inventory before successors, clone mutation or cleanup. Defer finalized artifact cleanup while ownership is unsafe; retry it across Main restarts, without changing immutable Task history or deleting a successor's input.

## Git and PRs

Each change uses `.wt/<project>/<slug>` and an intent-prefixed branch (`feat/`, `fix/`, `chore/`). Names are immutable; collisions use numeric semantic suffixes. Existing persisted paths remain authoritative during migration, particularly while workers live. Never adopt an unrelated branch or expose private keys in public names/text.

Local changes start from the approved target branch in the canonical checkout; their clone remotes point there. PR changes start from the canonical base remote's current default branch. Base movement schedules an implementer to merge the exact fetched commit, verify and commit, followed by fresh review. No rebase, force-push or Main-authored merge commit. Merge conflicts require a Decision authorizing implementation, not direct merge by Main.

Passing review persists Reviewed and reports completion before delivery, including completion hooks. Local delivery requires verified worker exit, the exact reviewed HEAD, clean working copies, and the approved branch checked out in the canonical Project. Main fast-forwards without authoring a commit or pushing. Diverged local base schedules implementation and fresh review; dirty/mismatched targets block with retry guidance. Completion is persisted only after verifying the canonical HEAD.

For PR delivery, Publishing fetches the push remote branch first and publishes the exact reviewed commit with an ordinary push. Absent/equal/remote-behind branches are safe; remote-ahead/diverged branches block with reconciliation and fresh-review guidance. A concurrent remote update cannot be overwritten. PublishBlocked retains review and any PR identity; restart/continuation reuses the single PR. AwaitingMerge begins only after publication and metadata synchronization succeed.

Main generates a concise conventional title from task intent and branch kind. Summary uses reviewed product-facing changes, Verification uses deduplicated passing commands, and Issues includes every `Closes #n`. Activity summaries and legacy worker PR suggestions remain history, never PR content. Generated title/body omit internal ancestry, working paths and lifecycle commentary. User edits stop wholesale body regeneration; required verification/closures are repaired. One canonical `<!-- merro:review-notes -->` comment holds passing review, verification and non-blocking findings. Private IDs are removed from titles, bodies, comments, notifications and merge prompts.

External requested changes or required-check failure schedule fresh implementation and review. Optional failures warn. Unknown GitHub policy blocks rather than assuming no requirements. Effective diff changes invalidate review; unchanged rewrites may preserve it.

## Merge and external authority

Main asks per PR only when review covers the latest diff, the PR is open/mergeable, policy is known and required checks/reviews pass. Approval rechecks external state and worker safety before squash merge. Rejection keeps the PR/branch/clone and blocks. GitHub merge rejection needs fresh approval, not blind retry. An external merge completes the change regardless of merge method.

Completion writes immutable final history and unblocks dependents. Cleanup is best-effort afterward. PR closed unmerged or branch deleted before merge blocks; a lost clone may be restored from the authoritative reviewed remote head. Unsafe live-worker occupancy prohibits restoration/deletion.

Project repository identity changes require confirmation. Transport-equivalent URLs, remote renames and validated checkout moves may be adopted. New default branches apply to future changes; existing local target branches and PR bases remain intact. Project removal is outside v0.1.
