# Merro domain context

## Terms

### Main
The Pi session the user talks to. Plans, schedules, reconciles, delivers reviewed changes locally, and opens requested PRs with separate merge approval.
- **Invariant:** one writer per workspace. Only Main writes orchestration state and talks to the user.
- **Avoid:** supervisor, generic harness

### Worker
Disposable Pi process executing one Task. Runs visibly in tmux, on the host by default.
- **Invariant:** never schedules, writes Main's store, pushes branches, opens PRs or merges. Receives one task; changed requirements require a fresh attempt.
- **Avoid:** subagent

### Project
Registered Git repository, identified publicly by its immutable slug. Has a canonical checkout. Optional base and push remotes may differ, for example with a fork.

### Objective
User goal with an approved Project set, optional issue scope and priority. States: Active, Done, Stopped.
- **Invariant:** multiple Objectives may share the same ChangeSet. Effective priority is the highest active owner's priority.

### ChangeSet
Delivery unit in exactly one Project. Owns optional issue SourceRefs, one working copy, one branch, and implementation/review flow. Local delivery completes in the canonical checkout; requested PR delivery owns one PR. Delivery mode and local target branch are fixed at approval.
- **Identity:** immutable semantic slug, such as `plugin-lifecycle-safety`. Issue numbers, branch and PR number provide external references; database keys are private.
- **Invariant:** an issue belongs to at most one non-terminal ChangeSet in its Project. At most one active Task per ChangeSet. Terminal records never reactivate.
- **Avoid:** WorkItem, ticket, job, issue-owned execution, task for the delivery unit

### SourceRef
Reference to an issue by Project slug and issue number. Several SourceRefs may belong to one ChangeSet; they do not own execution.

### Task
One implementation or review attempt on a ChangeSet, executed by a fresh Worker.
- **Invariant:** implement and review never overlap on the same change. Finalized Tasks are immutable.
- **Outcomes:** implementation: success, failed, cancelled. Review: pass, reject, failed, cancelled. Reject is not execution failure.

### Relation
Directed `Requires` or symmetric `Conflicts` between ChangeSets. Cross-Project dependencies use Relations, never a cross-Project ChangeSet.
- **Invariant:** only explicit or high-confidence evidence is effective. Requires takes precedence. References among issues inside one ChangeSet are internal scope, not scheduling edges.

### Decision
Pending user approval, selected publicly by change name, never by a database key. Only affected changes and their dependents wait.

### Blocked
Exceptional ChangeSet state carrying a typed reason and its prior flow state. Externally fixable causes may auto-resume after fresh reconciliation; user-owned causes need explicit continuation.

### PublishBlocked
Reviewed ChangeSet whose branch or PR publication failed. Resumes Publishing, retaining completed Tasks and any PR identity. It does not require another Worker unless the reviewed changes themselves need updating.

### Generation
Private counter preserving history when a terminal source needs new work. Never reused for the same source selection.

## Durable invariants

1. Workspace authority is exactly `cwd/.merro`. Initialization is explicit; no parent search or startup creation.
2. Public identity is semantic. Internal IDs never appear in status, plans, errors, Task text, worker/path/branch names, PRs, comments, notifications or normal exports.
3. Review follows green reported command verification and uses a fresh Worker. Rejection leads to a fresh implementer and fresh reviewer on the same change/branch.
4. Local plan approval authorizes delivery of the exact reviewed commit to its named target branch. PR merge needs separate per-PR approval unless the user merged externally or `merge.auto` is enabled (ADR-0012); GitHub policy is never bypassed. Main never force-pushes, authors merge commits, or rewrites finalized Task commits.
5. GitHub owns issue/PR/policy/merge truth; Git owns commits and working copies; tmux/process identity owns worker liveness. Merro owns orchestration metadata.
6. Requires defaults to actual completion, normally merge. An explicitly approved reviewed gate unblocks on a passing review of the exact prerequisite commit; changed prerequisites invalidate unfinished dependent work. Merro never auto-splits work. It creates issues only on user command or per `issues.create` policy (ADR-0012).
7. Guidance precedence: current user instruction, approved ChangeSet guidance, Project guidance (including Markdown), workspace Markdown, Merro defaults. Built-in safety invariants cannot be overridden. Repository AGENTS.md remains normal Pi/repository guidance.

For transitions and operational policy, read [lifecycle.md](docs/lifecycle.md). For worker contracts, read [worker-protocol.md](docs/worker-protocol.md).
