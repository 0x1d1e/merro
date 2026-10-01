# Merro

Pi package that coordinates multiple coding workers from one Main Pi session.
Workers run in Docker containers, one per Task, inside tmux windows. GitHub only, Linux/macOS.

## Use

```sh
git clone https://github.com/PrightCord/Merro && cd merro && pi
```

Talk to Main in natural language:

```text
Work on ~/Projects/kinetix and ~/Projects/kinetix-plugins.
Objective: ship kinetix 1.0, all open issues labeled 1.0.
```

Main proposes WorkItems and relations, you approve, then it schedules implement and review Tasks,
opens PRs, asks per-PR merge approval, squash-merges, and replans until the Objective is done.

Escape hatches (commands): `status`, `stop`, `unlock`, `export` (SQLite to JSON).

## Requirements

`git`, `gh` (authenticated), `docker`, `tmux`, Node.js >=22.13.0 for unflagged `node:sqlite` (verify against Pi's runtime).

## Config

`.merro/config.json`, versioned, edited by Main from natural language. Defaults work unedited.

| Key | Default |
|---|---|
| `max_concurrent_tasks` | `3` (number or `unlimited`) |
| `max_review_rounds` | `3` (number or `unlimited`, per-Objective override) |
| `pi_config` | `copy` (`clean` = empty config, auth only) |
| `sandbox` | `docker` (`none` = host run) |
| `network` | `on` |
| `worker_github` | `on` (passes `GH_TOKEN` to workers) |
| `image` | Merro generic; per-Project override |
| `work_root` | `<checkout>-work/`, outside the Merro checkout |
| `notify_command` | unset; runs on Blocked, merge-ready, Objective Done |
| model / thinking effort | Pi defaults unless set |

`notify_command` runs via `bash -lc` in the workspace after releasing Main's lock. It receives
`MERRO_EVENT` (`blocked`, `merge_ready`, `objective_done`), `MERRO_SUBJECT_ID`, and `MERRO_MESSAGE`.
Command failures warn without aborting reconciliation.

To adopt a moved repository, register its new path with the existing Project slug. Both remotes
must still identify the same repositories.

## Where to read next

- Terms and invariants: `CONTEXT.md`
- WorkItem states, relations, PR and merge flow, reconciliation: `docs/lifecycle.md`
- Task files, result protocol, sandbox, tmux: `docs/worker-protocol.md`
- Why decisions were made: `docs/adr/`
- Original design, historical only: `docs/archive/SPEC-v0.1-historical.md`
