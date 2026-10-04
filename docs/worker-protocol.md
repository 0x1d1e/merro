# Worker protocol

Read before changing Task files, result submission, launch or process identity. [Lifecycle](lifecycle.md) owns scheduling and recovery policy.

## Runtimes

Each role selects a runtime in `workers.<role>.runtime` (`pi` default, `claude`). `AgentRuntime` builds the command and recognises process identity; `WorkerRuntime` owns tmux, Docker and cleanup. The agent kind is stored per Task (`task_runtime.agent`) and survives config changes. Claude Tasks run `claude --session-id <task id> --permission-mode dontAsk` with an allowlist (reviewers get no Edit/Write), a strict MCP config exposing `merro_submit_result`, and hooks that report busy/tool/stop. On Stop after a finished result, the hook ends the Claude process. Identity is the `--session-id` argument. The Claude runtime is host-only. Both runtimes validate and write results through `protocol/submit-result.ts`, so the artifact is identical. Results may include up to 5 `proposed_issues` (`title`, `body`); Main handles them per `issues.create` once, keyed by an `issues_proposed` Task event.

## Native Pi runtime

One Task is one fresh native Pi process in one tmux pane. Launch uses `pi --no-session --tui-mode regular` with an initial `@.merro-task.md` prompt and Merro's lifecycle/result extensions. No print-mode worker, reconstructed UI, steering API or alternate terminal backend.

Host mode inherits the user's normal HOME, Pi config, models, auth, packages and unrelated extensions. Merro does not copy or replace host configuration. Worker-specific environment sets `MERRO_RUNTIME=worker`; the installed Main extension is inert under this marker, preventing nested orchestration. Host mode is not an OS security boundary. Worker restrictions, including reviewer non-editing, are contractual.

Docker is optional. It stages normal Pi configuration into scratch, mounts only the change clone and Task/dependency scratch, and mounts the review clone read-only. It uses an interactive tty, version-matched Pi image, read-only container root and optional network isolation. Workers never receive Main's database mount. GitHub tokens are passed only when `worker_github` is enabled (default off). Tokens and staged config are secrets removed by safe finalized cleanup.

## Paths and input

One full local clone per ChangeSet: `<root>/.wt/<project>/<semantic-slug>`, or configured worktrees directory. The same clone/branch serves implementation, review, rework and merge preparation. Cloning preserves the configured Git identity. Local delivery points clone remotes at the canonical checkout; PR delivery points them at base/push repositories. The registered source checkout is not the worker working directory. Persisted legacy clone paths remain authoritative.

Task scratch is `.merro/runtime/tasks/<implement-or-review>-<change>-<attempt>/`. Names and collision suffixes are semantic, never UUIDs. Exact dependency checkouts live under Task scratch, read-only, without a shared cache. Reviewed-gate implementers and reviewers receive the prerequisite's exact passing-review commit, PR, review summary and checkout. Source from its ChangeSet clone when the commit is not yet merged; retain that clone while unfinished approved reviewed-gate dependents need it.

Main writes fresh `.merro-task.md` in the clone, excluded through Git's local exclude file. It contains change name, all issue contents/acceptance criteria, relevant Objective, role instructions, and role-appropriate context. Review handoffs stay compact; Main stages scoped guidance separately as Pi system-prompt context. Task text contains no private Task/Objective/Decision/ChangeSet keys. Task history retains the input; safe finalization removes the shared file only when no successor owns it.

Optional workspace Markdown is read when Main composes each fresh Task: `.merro/WORKSPACE.md`, the applicable `IMPLEMENTER.md` or `REVIEWER.md`, and `.merro/projects/<project-slug>.md`. Implementer guidance is embedded in Task input. Reviewers receive the applicable workspace, reviewer-role, Project Markdown, and persisted Project guidance through a Worker-only Pi `before_agent_start` system-prompt section, staged in Task scratch for host and Docker. Workers do not need access to Main's `.merro` or store. Role files apply only to their role, Project files only to their Project. Missing/blank files are harmless; other read errors prevent launch with an actionable message. Edits affect future Tasks, not active Workers. Guidance precedence and non-overridable safety rules are defined in [CONTEXT.md](../CONTEXT.md); repository AGENTS.md remains normal Pi guidance.

## Lifecycle events and observation

The lifecycle extension writes atomic `worker-state.json` beside the result:

- `agent_start`: busy
- `turn_end`: progress/activity
- `agent_settled`: idle only when `ctx.isIdle()`
- `merro_submit_result`: finished, which never regresses to busy/idle

Finished work shuts down on settling. State is event-derived, not inferred from the composer or terminal text. Main can read it after restart; humans watch the actual Pi TUI.

Pi labels the initial CLI task input interactive. Accept that first input, then block interactive intervention and direct user shell commands. Changed requirements go through Main's stop-and-restart flow.

## tmux and identity

Sessions are `<tmux.session>-<project>` (default `merro-<project>`), windows `impl-<change>` or `rev-<change>`. One pane per window. Disable automatic rename and allow-rename; persist stable window ID and exact pane ID. Sessions are detached, never auto-attached. Semantic lookup must be exact: sibling Project/session or change/window prefixes never prove existence or ownership. Verify each tmux command's target semantics rather than assuming `=` works identically everywhere. Host workers enable `remain-on-exit`: an unexpected Pi exit leaves the exact dead pane, tmux exit status/signal and scrollback available to reconciliation. Main writes a bounded plain-text pane capture to `.merro/runtime/diagnostics/<task-attempt>.log` before finalizing the infrastructure failure; the log survives Task scratch cleanup. A missing pane remains distinct evidence of external tmux/session removal.

Ownership is private metadata: workspace owner marker, Project, Task and ChangeSet keys, runtime kind and clone path. Keep the workspace owner marker across restarts/moves. Tmux options and Docker labels are machine metadata, not public names. Persisted legacy ownership may migrate only after exact recorded runtime/process proof; never rediscover/adopt by window name alone.

Host identity requires matching pane/window/session membership, ownership, recorded PID and OS start time, and exactly one foreground Pi process attributed to the pane's foreground process group. A Pi descendant somewhere in the tree is insufficient. Docker identity includes owned container, start time and foreground native Pi command. Launch uses `exec` so shell wrappers do not obscure the foreground process.

`capture-pane` requires verified identity and targets the exact pane. Stop targets exact recorded identity. Missing/dead, unreadable and ambiguous states are distinct: only confirmed disappearance permits recovery. Read failures and live identity mismatches fail closed without replacement.

Main inventories owned panes/containers before scheduling or merge approval and after finalization. Finalized runtime identity can deduplicate a pane/container pair, but a live Worker without an active Task remains an orphan, never adopted.

## Result submission

The Worker calls `merro_submit_result`. Model parameters do not include `task_id`: the extension injects the private key from launch environment. Success text/tool details expose no key.

`MERRO_TASK_SCRATCH` must be explicit. `.merro-result.json` is written atomically inside that scratch and outside the checkout; deriving scratch from the result path would defeat location validation. Submission validates schema and local exact HEAD, publishes finished and terminates automatic follow-up. Invalid submissions throw actionable errors without writing a result; the Worker must correct/resubmit. Main independently validates the artifact and never substitutes a commit SHA.

Persisted protocol artifacts include private `task_id` for matching, not public presentation:

- Implementation: success/failed, activity summary, commit, verification; optional `changes` with 1-20 single-line product-facing bullets, at most 300 characters each; failure reason/diagnostics; optional `dependency_suggestions` on success or failure name existing issues in other registered Projects, a reviewed/done gate and a concise reason. Main alone proposes scope/Relations for approval. Legacy PR title/body remain accepted for historical compatibility but are never used to publish PR content.
- Review: pass/reject/failed, summary, reviewed commit, findings, verification; failure reason.
- Finding: blocking/non-blocking/note, summary, optional repo-relative file and line range. Blocking findings require rejection.
- Verification: exact command, Project, working directory and exit code, or manual summary. No environment secrets or full logs.

Implementation success and passing review cannot contain failed command verification. Successful implementation needs at least one passing command before review. Exact expected Task/commit must match; stale artifacts block without consuming/deleting the mismatched result. Finalized results and Task history are immutable.

## Role rules

Implementers edit, verify, fix and reverify before making one final commit directly on the expected HEAD with the configured Git identity. Hooks may require recreating an unfinalized commit; finalized commits never amend. Required checks that cannot complete mean failure. Workers never push, open PRs or merge PRs.

For approved base updates, merge the exact fetched base with `--no-ff --no-commit`, resolve and verify, then produce one final merge commit with expected HEAD and approved base as parents. If base is already an ancestor, one ordinary commit is allowed. Main checks parents/ancestry and requires fresh review.

Reviewers inspect the exact expected commit and the implementation's structured changes without edits or implementer conversation history. Check that product-facing bullets describe the reviewed diff, with no ancestry, working paths or publication commentary. Pass when no blocking findings remain; reject with actionable findings; failed only when review cannot complete. The next implementer receives the latest complete review.

Verification follows repository guidance: nearest/root AGENTS, contributor/test docs, CI, package scripts, README. Report final relevant checks against final code. An unavailable instruction needs a recorded equivalent/fallback reason, not invented success.

## Cleanup

Submission/finalization is not process-exit proof. Main refreshes inventory before successor launch, clone mutation or cleanup. Unsafe Projects retain artifacts. Cleanup retries survive Main restart; completion is mutable runtime metadata, not a Task-history rewrite. Retained host panes are removed only after exact Task/window identity is rechecked and the pane is confirmed dead. Failure diagnostics are bounded, private runtime artifacts; launch secrets and staged Pi configuration are still removed. Preserve stale mismatched results and successor-owned input. Never remove an orphan's clone automatically.
