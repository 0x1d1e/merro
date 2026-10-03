# Runtime settings

`.merro/config.json` contains machine settings. Init writes all editable defaults without replacing existing files. `/merro config` shows the file location and effective Merro settings, filling omitted fields with defaults without rewriting the file. `null` preserves Pi inheritance rather than copying Pi settings into Merro. Restart Main after editing the JSON; the config view reads the current file, not Main's startup snapshot. Instructions, prompts, review policy, architecture guidance, and Project context belong in [Markdown](../README.md#markdown-customization).

Common overrides:

- `projectsDir`, `worktreesDir`: workspace-relative directories, default `projects` and `.wt`. They cannot overlap, traverse outside the root, contain Git/Merro metadata, or use symlink directories. Existing recorded working-copy paths remain authoritative after changes.
- `worker`, `reviewer`: optional `model` and `thinking`. Omitted or `null` inherits Pi's normal defaults. Model is a Pi model ID; thinking is a supported Pi level. Legacy `worker_models` and `worker_thinking` role maps are migration-only inputs, normalized to `worker`/`reviewer` in the effective config. Mixing either legacy map with `worker` or `reviewer` is rejected; migrate both roles together.
- `git.defaultDelivery`: `local` by default, or `pr`. Explicit plan delivery overrides it; a remote never selects publication implicitly. Existing approved changes retain their delivery mode and target branch.
- `tmux.session`: session prefix, default `merro`; a Project uses `<prefix>-<project>`. Previously recorded sessions still receive worker safety checks.

Advanced settings:

- `max_concurrent_tasks`, `max_review_rounds`: positive integers or `"unlimited"`, default 3. Each change has at most one active Worker. Explicit continuation grants another round after the review cap.
- `sandbox`: `"none"` by default. Host Workers inherit normal HOME, Pi configuration, auth, models, packages, and extensions. Host mode is not a security sandbox; reviewer non-editing is contractual.
- `sandbox: "docker"`: optional Docker isolation. Review mounts are read-only. Container providers must be reachable from Docker; `localhost` means the container. `network: "off"` requires Docker.
- `worker_github`: `"off"` by default. `"on"` passes a token from `gh auth token`. Worker push/PR/merge restrictions remain contractual; permissions and branch protection are the security boundary.
- `notify_command`: optional hook for `implementation_complete`, `review_complete`, `publication_blocked`, `blocked`, `merge_ready`, and `objective_done`. Environment includes `MERRO_EVENT`, `MERRO_CHANGE`, and `MERRO_MESSAGE`. Review completion is delivered before publication or local delivery. Hook failures warn without aborting work.

The accepted schema and defaults are defined in [`src/config.ts`](../src/config.ts).
