# Worker protocol

Read before changing Task files, result submission, launch or process identity. [Lifecycle](lifecycle.md) owns scheduling and recovery policy.

## Native Pi runtime

One Task is one fresh native Pi process in one tmux pane. Launch uses `pi --no-session --tui-mode regular` with an initial `@.merro-task.md` prompt and Merro's lifecycle/result extensions. No print-mode worker, reconstructed UI, steering API or alternate terminal backend.

Host mode inherits the user's normal HOME, Pi config, models, auth, packages and unrelated extensions. Merro does not copy or replace host configuration. Worker-specific environment sets `MERRO_RUNTIME=worker`; the installed Main extension is inert under this marker, preventing nested orchestration. Host mode is not an OS security boundary. Worker restrictions, including reviewer non-editing, are contractual.

Docker is optional. It stages normal Pi configuration into scratch, mounts only the change clone and Task/dependency scratch, and mounts the review clone read-only. It uses an interactive tty, version-matched Pi image, read-only container root and optional network isolation. Workers never receive Main's database mount. GitHub tokens are passed only when `worker_github` is enabled. Tokens and staged config are secrets removed by safe finalized cleanup.

## Paths and input

One full local clone per ChangeSet: `cwd/.wt/<semantic-slug>`. The same clone/branch serves implementation, review, rework and merge preparation. Cloning preserves the configured Git identity and repoints remotes to canonical base/push repositories; the registered source checkout is not the worker working directory.

Task scratch is `.merro/runtime/tasks/<implement-or-review>-<change>-<attempt>/`. Names and collision suffixes are semantic, never UUIDs. Exact merged dependency checkouts live under Task scratch, read-only, without a shared cache.

Main writes fresh `.merro-task.md` in the clone, excluded through Git's local exclude file. It contains change name, all issue contents/acceptance criteria, relevant Objective, guidance, repository instructions, dependencies, expected commit and role instructions. Review additionally receives full `base...HEAD` diff, implementation summary and verification, and prior findings. Task text contains no private Task/Objective/Decision/ChangeSet keys. Task history retains the input; safe finalization removes the shared file only when no successor owns it.

## Lifecycle events and observation

The lifecycle extension writes atomic `worker-state.json` beside the result:

- `agent_start`: busy
- `turn_end`: progress/activity
- `agent_settled`: idle only when `ctx.isIdle()`
- `merro_submit_result`: finished, which never regresses to busy/idle

Finished work shuts down on settling. State is event-derived, not inferred from the composer or terminal text. Main can read it after restart; humans watch the actual Pi TUI.

Pi labels the initial CLI task input interactive. Accept that first input, then block interactive intervention and direct user shell commands. Changed requirements go through Main's stop-and-restart flow.

## tmux and identity

Sessions are `merro-<project>`, windows `impl-<change>` or `rev-<change>`. One pane per window. Disable automatic rename and allow-rename; persist stable window ID and exact pane ID. Sessions are detached, never auto-attached. The last exiting window may remove its session.

Ownership is private metadata: workspace owner marker, Project, Task and ChangeSet keys, runtime kind and clone path. Keep the workspace owner marker across restarts/moves. Tmux options and Docker labels are machine metadata, not public names. Persisted legacy ownership may migrate only after exact recorded runtime/process proof; never rediscover/adopt by window name alone.

Host identity requires matching pane/window/session membership, ownership, recorded PID and OS start time, and exactly one foreground Pi process attributed to the pane's foreground process group. A Pi descendant somewhere in the tree is insufficient. Docker identity includes owned container, start time and foreground native Pi command. Launch uses `exec` so shell wrappers do not obscure the foreground process.

`capture-pane` requires verified identity and targets the exact pane. Stop targets exact recorded identity. Missing/dead, unreadable and ambiguous states are distinct: only confirmed disappearance permits recovery. Read failures and live identity mismatches fail closed without replacement.

Main inventories owned panes/containers before scheduling or merge approval and after finalization. Finalized runtime identity can deduplicate a pane/container pair, but a live Worker without an active Task remains an orphan, never adopted.

## Result submission

The Worker calls `merro_submit_result`. Model parameters do not include `task_id`: the extension injects the private key from launch environment. Success text/tool details expose no key.

`MERRO_TASK_SCRATCH` must be explicit. `.merro-result.json` is written atomically inside that scratch and outside the checkout; deriving scratch from the result path would defeat location validation. Submission validates schema and local exact HEAD, publishes finished and terminates automatic follow-up. Invalid submissions throw actionable errors without writing a result; the Worker must correct/resubmit. Main independently validates the artifact and never substitutes a commit SHA.

Persisted protocol artifacts include private `task_id` for matching, not public presentation:

- Implementation: success/failed, summary, commit, verification; optional PR title/body; failure reason/diagnostics.
- Review: pass/reject/failed, summary, reviewed commit, findings, verification; failure reason.
- Finding: blocking/non-blocking/note, summary, optional repo-relative file and line range. Blocking findings require rejection.
- Verification: exact command, Project, working directory and exit code, or manual summary. No environment secrets or full logs.

Implementation success and passing review cannot contain failed command verification. Successful implementation needs at least one passing command before review. Exact expected Task/commit must match; stale artifacts block without consuming/deleting the mismatched result. Finalized results and Task history are immutable.

## Role rules

Implementers edit, verify, fix and reverify before making one final commit directly on the expected HEAD with the configured Git identity. Hooks may require recreating an unfinalized commit; finalized commits never amend. Required checks that cannot complete mean failure. Workers never push, open PRs or merge PRs.

For approved base updates, merge the exact fetched base with `--no-ff --no-commit`, resolve and verify, then produce one final merge commit with expected HEAD and approved base as parents. If base is already an ancestor, one ordinary commit is allowed. Main checks parents/ancestry and requires fresh review.

Reviewers inspect the exact expected commit without edits or implementer conversation history. Pass when no blocking findings remain; reject with actionable findings; failed only when review cannot complete. The next implementer receives the latest complete review.

Verification follows repository guidance: nearest/root AGENTS, contributor/test docs, CI, package scripts, README. Report final relevant checks against final code. An unavailable instruction needs a recorded equivalent/fallback reason, not invented success.

## Cleanup

Submission/finalization is not process-exit proof. Main refreshes inventory before successor launch, clone mutation or cleanup. Unsafe Projects retain artifacts. Cleanup retries survive Main restart; completion is mutable runtime metadata, not a Task-history rewrite. Preserve stale mismatched results and successor-owned input. Never remove an orphan's clone automatically.
