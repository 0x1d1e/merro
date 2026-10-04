# Runtime settings

`.merro/config.json` contains machine settings. Init writes all editable defaults without replacing existing files. `/merro config` shows the file location and effective Merro settings, filling omitted fields with defaults without rewriting the file. `null` preserves Pi inheritance rather than copying Pi settings into Merro. Restart Main after editing the JSON; the config view reads the current file, not Main's startup snapshot. Instructions, prompts, review policy, architecture guidance, and Project context belong in [Markdown](../README.md#markdown-customization).

Common overrides:

- `projectsDir`, `worktreesDir`: workspace-relative directories, default `projects` and `.wt`. They cannot overlap, traverse outside the root, contain Git/Merro metadata, or use symlink directories. Existing recorded working-copy paths remain authoritative after changes.
- `workers.implementer`, `workers.reviewer`: `runtime` (`pi` default, or `claude`), `model` and `thinking`. Roles are independent; the reviewer never inherits the implementer's runtime or model. Omitted or `null` model/thinking inherits the runtime's normal defaults. The `claude` runtime needs the `claude` CLI on PATH, runs on the host only (`sandbox: "docker"` is rejected), and accepts thinking `low`..`max`. Legacy `worker`, `reviewer`, `worker_models` and `worker_thinking` are migration-only inputs normalized to `workers`; mixing legacy keys with `workers` is rejected.
- `issues.create`: `disabled`, `approval` (default) or `auto`. Governs issues that workers or reviewers propose; `/merro issue create|start` are direct user actions.
- `merge.auto` (default `false`), `merge.method` (`squash` default, `merge`, `rebase`), `merge.delete_branch` (default `true`). With `auto`, Merro merges once review passed on the latest diff, GitHub required checks and reviews are satisfied and CI is not pending or failed. GitHub rules stay authoritative; Merro never bypasses them.
- `git.defaultDelivery`: `auto` by default, `local`, or `pr`. Auto selects PR delivery when the Project has supported remotes and local delivery otherwise. Explicit plan delivery overrides it. Existing approved changes retain their delivery mode and target branch.
- `tmux.session`: session prefix, default `merro`; a Project uses `<prefix>-<project>`. Previously recorded sessions still receive worker safety checks.

Advanced settings:

- `max_concurrent_tasks`, `max_review_rounds`: positive integers or `"unlimited"`, default 3. Each change has at most one active Worker. Explicit continuation grants another round after the review cap.
- `sandbox`: `"none"` by default. Host Workers inherit normal HOME, Pi configuration, auth, models, packages, and extensions. Host mode is not a security sandbox; reviewer non-editing is contractual.
- `sandbox: "docker"`: optional Docker isolation. Review mounts are read-only. Container providers must be reachable from Docker; `localhost` means the container. `network: "off"` requires Docker.
- `worker_github`: `"off"` by default. `"on"` passes a token from `gh auth token`. Worker push/PR/merge restrictions remain contractual; permissions and branch protection are the security boundary.
- `notify_command`: optional hook for `implementation_complete`, `review_complete`, `publication_blocked`, `blocked`, `merge_ready`, and `objective_done`. Environment includes `MERRO_EVENT`, `MERRO_CHANGE`, and `MERRO_MESSAGE`. Review completion is delivered before publication or local delivery. Hook failures warn without aborting work.

The accepted schema and defaults are defined in [`src/config.ts`](../src/config.ts).
