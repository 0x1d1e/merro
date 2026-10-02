# Worker protocol

Read before changing Task files, the result tool, container/tmux launch, process identity, or verification rules.

## Isolation

- Each WorkItem gets a full local clone at `<work_root>/<project>/<derived-name>/` (`git clone --local` from the source repo, then remotes re-pointed to the real base/push URLs). New clone names are bounded readable slugs with a stable hash of the authoritative WorkItem ID; persisted clone paths remain unchanged. The source repo is never mounted or modified. Same clone serves implement, rework, review, PR, merge.
- Clone creation runs the Project's setup command (deps, env files) inside the image.
- Review of a dependency Project uses a throwaway read-only checkout at the exact merged commit. No cache in v0.1.
- Task = one Docker container running Pi as a foreground process in one tmux window. Attach with `tmux attach -t merro-<project>`, then the window.
- Mounts: clone (rw for implement, ro for review), per-Task scratch dir, copied Pi config dir (`pi_config: copy`, never the real one) or empty (`clean`). Model auth via env passthrough or copied auth file. Docker bind mounts use CSV-escaped `--mount` fields, never colon-delimited host-path parsing, including setup and dependency checkouts.
- `worker_github: on` passes `GH_TOKEN` derived from the user's `gh` auth. Push, PR, and merge remain Main-only by contract. Branch protection is the real guard. `off` removes the token.
- Network on by default. `sandbox: none` runs the same Task on the host in the clone.
- Image: generic Merro (Node, git, common build tools) is tagged with the host Pi version so Workers have the same model/provider registry; overridable per Project by image name or Dockerfile.

## Pi runtime boundary

Main Pi loads Merro's orchestration extension. Every Docker and host Worker Pi runs with `MERRO_RUNTIME=worker`; Merro's normal package entrypoint is intentionally inert in that runtime. It creates no Main state, lock, commands, tools, timers, or nested workers. The dedicated `merro_submit_result` extension remains active.

`pi_config: copy` preserves installed packages, unrelated extensions, settings, auth, and model/provider configuration in Task scratch without changing the host config. Package filtering is not required: the explicit runtime marker protects Merro even when it is loaded from another configuration location. The marker belongs to the worker launch environment only, never Main's environment or persisted Pi settings. Docker workers mount only the clone and Task scratch, not Main's store; `sandbox: none` is not an OS security boundary.

`/status` and `/merro-export` use the live Main's serialized state access when available, waiting for an active reconciliation operation to release ownership. Export is a coherent detached snapshot, not mutable store access. Standalone commands still acquire the workspace lock; `/unlock` never bypasses live ownership.

## tmux

- Session `merro-<project>` created when a Project's first Task starts, detached, no Main window. Never auto-attached.
- Window per Task (`impl-188`, `rev-188`), named by issue number or local WorkItem slug rather than Task UUID; one pane, Workers may not open more.
- Session env `MERRO_PROJECT`, `MERRO_OWNER=workspace:<uuid>`, mirrored by `@merro_project` and `@merro_owner` session options. The owner is atomically persisted in `.merro/runtime/workspace-owner`, independent of Project paths; retain it across workspace moves and while workers live. Invalid identity fails inventory closed.
- Task window options `@merro_task_id`, `@merro_work_item_id`, `@merro_clone_path`, `@merro_runtime_kind` identify owned live panes for reconciliation. Docker labels `merro.task_id`, `merro.project`, `merro.owner`, `merro.work_item_id`, `merro.clone_path` identify containers even if tmux is gone. Containers with old path-hash owners or no owner require an exact workspace Task scratch mount or stored matching Task/container identity as ownership proof, not the current Project path.
- Legacy path-hash tmux markers migrate only after a stored runtime matches the pane, session, window, and live process identity. Host proof requires PID and start time; Docker proof requires container identity. This changes namespace metadata, not Task status or processes. Otherwise, mismatched session markers block that Project and are reported without adoption.
- Last window exits, session may vanish. No supervisor hook.

## Process identity

Runtime record per active Task: Task ID, WorkItem, role, Project, tmux session/window, container ID, Pi PID inside container, start time, clone path.
Host identity uses the pane ID, PID, and OS process start time (`ps`), not the unsupported tmux `pane_start_time` format. Window existence alone is not proof. Gone process + no valid result → failed. Identity mismatch → failed. No rediscovery or adoption. Owned-worker inventory may use finalized runtime identity to deduplicate a legacy Docker pane and container and recover their WorkItem; the worker remains an orphan, never an active Task. Match pane, session, and window together to avoid reusing another Task's pane ID; fall back to session/window only when the stored pane ID is absent.
Pi exited but valid matching result exists → consume it.

## Task input: `.merro-task.md`

Written fresh by Main per Task into the clone (excluded via `.git/info/exclude`, never the repo's `.gitignore`). Contains only: WorkItem scope, relevant Objective context, latest review result, user and Project guidance, repo instructions, direct dependency context (WorkItem ID, Project, merged PR, commit, final summary), role instructions, verification expectations, and any exact updated-base commit to merge. Never the full backlog. Copied to Task history, deleted at finalization.

## Task output: `merro_submit_result`

Worker ends by calling the `merro_submit_result` tool, which validates the schema and local commit, writes `.merro-result.json` atomically in Task scratch, and terminates Pi's automatic follow-up. The result path must be beside the scratch `pi-config` directory, outside the checkout. Implementer success and all review results require a full Git commit ID that resolves locally to HEAD. Invalid submissions throw an actionable error without writing a result or terminating; the worker must explicitly correct and resubmit, never receive an automatically substituted SHA. Failed implementers retain the ability to report an unusable checkout without an exact-HEAD check. Main independently validates every artifact; worker prevalidation is not a trust boundary. Controlled `.merro-task.md` remains excluded, not globally ignored. Main validates: `task_id` equals the active Task, schema matches role, commit state matches, result is not stale. Then copies to Task history and deletes the file.
Wrong `task_id`: don't consume, don't delete, WorkItem Blocked, report expected vs found.

Main retries pending finalized Task artifact cleanup every reconciliation pass, including after restart and when a Project is unavailable. Successful cleanup records `cleanup_completed_at` in mutable Task runtime metadata, not immutable Task history; completed cleanups leave the retry queue. Older runtimes without this marker enter the queue once. Result submission and Task finalization do not prove process exit. Refresh worker inventory after finalization before scheduling successors or cleaning artifacts, including on exceptional reconciliation exits. Defer cleanup while a Project has unowned live workers or an incomplete worker inventory. Remove Task scratch and launch credentials; preserve mismatched results and shared input owned by an active successor Task.

Implement result: `task_id`, `status: success|failed`, `summary`, `commit`, `verification[]`, optional `pr{title,body}`; failed adds `reason`, optional `diagnostics`.
Review result: `task_id`, `status: pass|reject|failed`, `summary`, `reviewed_commit`, `findings[]`, `verification[]`; failed adds `reason`.
Finding: `severity: blocking|non-blocking|note`, `summary`, optional repo-relative `file`, `line_start`, `line_end` (lines refer to reviewed commit). Any blocking finding means reject. `reviewed_commit` mismatch → failed, Main never substitutes current HEAD.
Verification entry: `kind: command` (`project`, `cwd`, exact `command`, `exit_code`) or `kind: manual` (`project`, `summary`). Persist only the final successful set, or the final failing check for a verification-caused reject. No env vars, no full logs.

## Implementer rules

Fresh Pi. Edits, verifies, fixes, re-verifies, makes exactly one final commit with the user's Git identity, writes the result. Verification failures stay inside the Task. Pre-commit hook failure: fix, re-verify, retry; hook-modified files: recreate the unfinalized commit. Merro validates the SHA exists, equals HEAD, and is the one new commit. Never amend a finalized commit. Cannot proceed safely → failed.
For a base update, Main fetches and persists the exact base commit. The implementer merges that commit with `--no-ff --no-commit`, resolves conflicts, verifies the merged tree, and creates one final merge commit: first parent is the Task's expected HEAD, second parent is the approved base. Main validates both parents and base ancestry. If the base is already an ancestor, one ordinary commit is allowed instead. No rebase, branch push, or PR operations by workers. A fresh reviewer follows every successful base-update Task.
Next implementer after a reject gets the full latest review: blocking, non-blocking, notes, verification. Blocking must be fixed.

## Reviewer rules

Fresh Pi, no implementer history. Gets scope, acceptance criteria, full `base...HEAD` diff, latest implementer summary, verification, prior findings, guidance, dependency context. Read-only mount enforces this. May inspect dependency Projects and run safe verification there. Dependency check failure rejects only if materially relevant to compatibility.
Nearby out-of-scope issues may be reported; same-Project expanded work stays in the current WorkItem. Blocking work in another registered Project inside an approved Objective becomes or reuses a WorkItem there plus a Requires. After that dependency merges, a fresh review runs if the branch is unchanged.
Non-blocking findings and notes: shown in the review-notes comment and again at merge approval. No follow-up WorkItems.

## Verification

Workers choose checks from repo context. Precedence: nearest AGENTS.md, root AGENTS.md, contributor/test docs, CI config, package scripts, README. Stale or impossible instruction → closest equivalent plus a recorded fallback reason (also noted in PR). Guidance fix may ride in the same commit. Final relevant checks run against the final code. A required check that cannot complete → failed. No interactive commands. No fixed timeout; idle/wall-clock limit reports to the user.

## Cost visibility

Record per-Task duration and tokens/cost when Pi exposes them. `status` shows totals per Objective. No enforcement in v0.1.
