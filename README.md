# Merro

Pi package that coordinates multiple coding workers from one Main Pi session.
Workers run in Docker containers, one per Task, inside tmux windows. GitHub only, Linux/macOS.

## Requirements

- [Pi](https://pi.dev) installed, with a configured model/provider.
- Node.js compatible with your Pi version, at least 22.13.0 for Merro's `node:sqlite`.
- `git`, authenticated `gh`, `tmux`, and a running Docker daemon.
- Local GitHub repository checkouts, Git authentication for fetching/pushing, and a configured Git author identity.
- Permission to push branches, open PRs, and squash-merge in the target repositories.

Check GitHub authentication and Docker before starting:

```sh
gh auth status
docker info
```

## Install

```sh
pi install git:github.com/PrightCord/Merro
```

This installs from `main`. No commit hash or manual build is required; installation builds the worker files.
For a pinned version, append `@<commit-or-tag>` to the source.

Update or remove:

```sh
pi update git:github.com/PrightCord/Merro
pi remove git:github.com/PrightCord/Merro
```

A pinned installation stays pinned. To switch it to `main`, rerun the unpinned install command.
Restart Pi after installing or updating.

## Use

Start Pi in a persistent workspace directory. It can coordinate Projects outside that directory;
you do not need to run Pi from the Merro checkout.

```sh
mkdir -p ~/merro-workspace
cd ~/merro-workspace
pi
```

Merro creates `.merro/` in this workspace for configuration, SQLite state, and Task runtime files.
Return to the same directory to resume managing that workspace. Use one Main Pi session per workspace.

Talk to Main in natural language:

```text
Register ~/Projects/kinetix as kinetix and ~/Projects/kinetix-plugins as kinetix-plugins.
Objective: ship kinetix 1.0 by completing all open issues labeled 1.0 in both Projects.
Show me the proposed scope, WorkItems, and relations before starting.
```

Approve the goal, Projects, issue scopes, and proposed relations before work starts.
Scopes can be fixed issue numbers or a query matching all specified labels and an optional milestone title.
Query scopes include future matching issues automatically; an empty query covers all open issues.
Merro does not create or split issues automatically.

Main schedules implement and review Tasks, opens PRs after review passes, and asks for approval
before each squash-merge. Required GitHub checks and reviews must pass before merge approval.
Workers use separate clones; the registered source checkout is not their working directory.

Inspect a Project's live workers with:

```sh
tmux attach -t merro-kinetix
```

The default worker image builds on first use if absent. Workers can outlive Main;
reopen Pi in the same workspace to reconcile their results and resume scheduling.

### Commands

Use these inside Pi. Ask Main for full state and pending Decision IDs when needed.

| Command | Action |
|---|---|
| `/status` | Show Objective, WorkItem, and Task counts |
| `/merro-run` | Reconcile results and PRs, then schedule available work |
| `/merro-approve <Decision ID>` | Approve a merge or authorize merge-conflict resolution |
| `/merro-reject <Decision ID>` | Reject a merge or abandon merge-conflict resolution |
| `/merro-continue <WorkItem ID>` | Resume blocked work after fixing its cause |
| `/stop [Objective ID]` | Soft-stop one Objective, or all active Objectives; active Tasks are not killed |
| `/unlock` | Clear stale lock metadata only if Main is not running |
| `/merro-export` | Export SQLite state to `.merro/export.json` (Pi's `/export` exports the session) |

To adopt a moved repository, register its new path with the existing Project slug. Both remotes
must still identify the same repositories.

## Config

Merro creates `.merro/config.json` with defaults on first load. Ask Main to edit it or edit it yourself,
then restart Pi to load changes. Workspace keys and validation: [`src/config.ts`](src/config.ts).

| Key | Default |
|---|---|
| `max_concurrent_tasks` | `3` (positive integer or `unlimited`) |
| `max_review_rounds` | `3` (positive integer or `unlimited`, per-Objective override) |
| `pi_config` | `copy` (`clean` copies only `auth.json`) |
| `sandbox` | `docker` (`none` runs workers on the host without Docker isolation) |
| `network` | `on` (`off` requires Docker sandboxing) |
| `worker_github` | `on` (passes `GH_TOKEN` from `gh auth token` to workers) |
| `work_root` | `null`, meaning `<workspace>-work/` for worker clones |
| `notify_command` | `null`; runs on Blocked, merge-ready, and Objective Done |

`notify_command` runs via `bash -lc` in the workspace after releasing Main's lock. It receives
`MERRO_EVENT` (`blocked`, `merge_ready`, `objective_done`), `MERRO_SUBJECT_ID`, and `MERRO_MESSAGE`.
Command failures warn without aborting reconciliation.

## Develop locally

```sh
git clone https://github.com/PrightCord/Merro.git merro
cd merro
scripts/run-ci.sh
pi --no-extensions --extension ./src/index.ts
```

CI installs dependencies, checks boundaries and types, and builds and tests the package.
`npm run build` and `npm run typecheck` require development dependencies for type checking.
Git installation only emits JavaScript: TypeBox is supplied by Pi at runtime, not bundled with Merro
or copied into worker runtime files.
The explicit extension path loads the checkout; `--no-extensions` avoids also loading an installed copy.

## Where to read next

- Terms and invariants: [`CONTEXT.md`](CONTEXT.md)
- WorkItem states, relations, PR and merge flow, reconciliation: [`docs/lifecycle.md`](docs/lifecycle.md)
- Task files, result protocol, sandbox, tmux: [`docs/worker-protocol.md`](docs/worker-protocol.md)
- Why decisions were made: [`docs/adr/`](docs/adr/)
- Original design, historical only: [`docs/archive/SPEC-v0.1-historical.md`](docs/archive/SPEC-v0.1-historical.md)
