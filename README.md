# Merro

A Pi package coordinating coding work through **Pi + tmux + Git + GitHub**.

Talk to Main in Pi. Main proposes a plan, launches visible native Pi workers, reconciles their results, opens PRs and asks before merging. Host Pi is the default; Docker is optional. Merro is not a generic agent harness or a separate CLI.

## Install and initialize

Workspace requirements: Node.js >=22.13.0, Pi supporting `--tui-mode regular` with a configured provider, and tmux. Project registration and delivery also require Git, authenticated `gh`, working Git fetch/push authentication and a configured Git author identity.

```sh
pi install git:github.com/PrightCord/Merro
mkdir -p ~/merro-workspace
cd ~/merro-workspace
pi
```

Inside Pi:

```text
/merro init
```

Initialization works in any writable directory, without a Git repository, remote URL or GitHub login. It validates Pi/tmux and creates:

```text
merro-workspace/
├── .merro/
│   ├── config.json
│   ├── state.db
│   └── runtime/
└── .wt/
```

Inside an existing Git working tree, local state and working copies are excluded through `.git/info/exclude`, without changing project source. Otherwise no Git files are created. Initialization is idempotent: existing config, Projects and state remain intact.

Merro only uses **cwd/.merro**. It neither initializes on startup nor searches parent directories. Elsewhere tools say:

```text
Merro is not initialized here. Run /merro init.
```

Return to the same directory to resume. Use one Main per workspace. Initialization does not register Projects automatically. Before planning work, ask Main to register a GitHub repository by local path and semantic Project name:

```text
Register ~/Projects/kinetix as kinetix.
```

The workspace itself needs no remote; registered Projects still require GitHub repositories.

## Plan and approve

```text
Do #96, #97 and #100 together in one PR.
Name the change plugin-lifecycle-safety.
```

Main presents:

```text
Plan

kinetix: #96 #97 #100
Change: plugin-lifecycle-safety
Branch: chore/plugin-lifecycle-safety
Delivery: one change per Project
PRs: 1
Implementation: one worker per change
Review: one fresh worker per change

Approve?
```

Reply `approve`, or select the pending plan by name. No identifier is required. A replacement plan or changed authoritative scope requires fresh approval.

All selected issues in each Project form one **ChangeSet** by default: one `.wt/plugin-lifecycle-safety` clone, branch and PR. Ask for separate delivery when issues should ship independently. Combined query selections are frozen at approval; separate delivery can retain a live label/milestone query. Cross-Project work uses separate changes and dependency relations.

```text
implementation -> green local verification -> fresh review -> PR -> merge approval
                         ^                      |
                         +-- fresh implementer -+ reject
```

A reviewer receives issue contents, acceptance criteria, full `base...HEAD` diff, implementation summary, verification results and repository instructions. Rework keeps the same working copy and branch, but uses new Pi processes. PRs contain Summary, Verification and Issues sections with every `Closes #n`.

## Watch and resume

```sh
tmux attach -t merro-kinetix
```

Windows use semantic names such as `impl-plugin-lifecycle-safety` and `rev-plugin-lifecycle-safety`. They show the actual Pi TUI, not reconstructed output. Watch without steering; ask Main to stop and restart the attempt if requirements change.

Workers may outlive Main. Reopen Pi in the workspace to reconcile existing workers without duplicating healthy Tasks. Ambiguous identity pauses scheduling rather than guessing ownership or launching a replacement.

## Commands

| Command | Action |
|---|---|
| `/merro init` | Explicitly initialize this directory, Git optional |
| `/status` | Show changes, issues, state, worker, CI and activity |
| `/merro-run` | Reconcile and schedule approved work |
| `/merro-approve [change]` | Approve a pending merge/conflict decision |
| `/merro-reject [change]` | Reject a merge or abandon conflict resolution |
| `/merro-continue <change>` | Retry a retryable blocker after fixing its cause |
| `/stop [goal or change]` | Soft-stop Objectives; active Tasks finish |
| `/unlock` | Clear stale ownership, never bypass live Main |
| `/merro-export` | Export normal semantic status to `.merro/export.json` |

Pi's `/export` exports its conversation instead. Plans are approved conversationally, not through the merge command.

Merge approval is per PR. Main checks current review, GitHub policy, required checks/reviews and mergeability before squash-merging. Rejection keeps the PR and branch. External merges are reconciled as completion.

## Configuration and safety

Edit `.merro/config.json`, then restart Main. Initial configuration is:

```json
{
  "max_concurrent_tasks": 3,
  "max_review_rounds": 3,
  "worker_models": { "implement": null, "review": null },
  "worker_thinking": { "implement": null, "review": null }
}
```

Both limits accept a positive integer or `"unlimited"`. Set `worker_models` and `worker_thinking` independently for `implement` and `review`; `null` uses Pi's default. Model values are Pi model IDs, and thinking values pass through to Pi's `--thinking` option. Different changes may implement/review concurrently, but each ChangeSet has at most one active Worker. Hitting the review cap blocks the change; explicit continuation grants another round.

Host workers inherit normal HOME, Pi config, auth, models, packages and extensions. Merro adds its lifecycle/result extensions and disables nested Main orchestration in workers. **Host mode is not a security sandbox.** Reviewers must not edit, but host filesystem permissions do not enforce that promise.

Optional `"sandbox": "docker"` requires Docker and a suitable image/toolchain. Docker stages Pi config into Task scratch and mounts the reviewer clone read-only. Container providers must be reachable from inside Docker; `localhost` points to the container, not the host. `"network": "off"` requires Docker.

`"worker_github": "on"` is the default and passes a token obtained from `gh auth token`. `"off"` withholds GitHub tokens. Worker push/PR/merge restrictions are contractual; repository permissions and branch protection remain the security boundary.

Optional `notify_command` runs for `blocked`, `merge_ready` and `objective_done`. It receives `MERRO_EVENT`, semantic `MERRO_CHANGE` and `MERRO_MESSAGE`. Failures warn without aborting reconciliation. All supported defaults and validation live in [`src/config.ts`](src/config.ts).

## Develop

```sh
scripts/run-ci.sh
pi --no-extensions --extension ./src/index.ts
```

The CI script installs dependencies, checks boundaries/types, builds and tests. Use `--skip-install` only with current dependencies. `--no-extensions` avoids loading an installed Merro alongside the local checkout.

- [CONTEXT.md](CONTEXT.md): canonical terms and invariants
- [Lifecycle](docs/lifecycle.md): scheduling, recovery and merge contracts
- [Worker protocol](docs/worker-protocol.md): Task input/result and process identity
- [Acceptance](docs/acceptance.md): regression and native-runtime checks
- [ADR-0008](docs/adr/0008-changeset-delivery-and-native-pi.md): delivery/runtime decision, superseding ADR-0004 and ADR-0006
- [ADR-0009](docs/adr/0009-repository-independent-workspace-init.md): repository-independent initialization
