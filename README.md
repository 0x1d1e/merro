# Merro

Merro turns GitHub issues into reviewed pull requests from a Pi conversation. It shows you a plan, runs visible coding and review Workers in tmux, opens a PR, and asks before merging.

## Install

You need Node.js >=22.13.0, Pi with a configured provider and `--tui-mode regular` support, tmux, Git, and authenticated GitHub CLI (`gh auth login`). Your repository also needs working Git fetch/push authentication and a configured Git author name/email. Docker is optional.

```sh
pi install git:github.com/PrightCord/Merro
mkdir -p ~/merro-workspace
cd ~/merro-workspace
pi
```

## Initialize

Inside Pi:

```text
/merro init
```

```text
Merro initialized.

Next: Register ~/Projects/my-app as my-app
Then: Fix #42.
```

The workspace can be any writable directory. Initialization needs Pi/tmux, not a Git repository or GitHub login. It preserves existing configuration and work.

## Register a Project

Tell Pi the local path and the name you want to use:

```text
Register ~/Projects/my-app as my-app.
```

Use an existing GitHub repository checkout. You can register more Projects later; the workspace itself needs no remote.

## Give work

```text
Fix #42 in my-app.
```

Merro shows the issues, change name, branch, PR count, and implementation/review models, then asks `Approve?`. Reply:

```text
approve
```

Your first Worker starts. Use `/status` in Pi, or watch its native Pi terminal:

```sh
tmux attach -t merro-my-app
```

## Get a reviewed PR

Merro runs implementation, green local verification, then a fresh review. Blocking findings get a fresh implementer and reviewer on the same branch. Once review passes, Merro opens a PR with a summary, verification and issue closures, then asks for merge approval. Reply `approve`, or use `/merro-approve <change name>` for a pending merge. Plans and merges need separate approvals.

For several issues in one PR, say:

```text
Fix #42 and #43 together in my-app. Name the change safer-plugin-removal.
```

Selected issues form one change per Project by default. Ask for separate PRs when needed. Cross-Project work uses separate changes.

## Customize with Markdown

Create only the files you want inside the workspace:

```text
.merro/
├── config.json
├── WORKSPACE.md
├── IMPLEMENTER.md
├── REVIEWER.md
└── projects/
    ├── kinetix.md
    └── kinetix-plugins.md
```

All Markdown files are optional. Plain instructions, no schema or special syntax:

| File | Applies to |
|---|---|
| `WORKSPACE.md` | Workspace-wide instructions, coding/review conventions, delivery preferences |
| `IMPLEMENTER.md` | Additional implementer instructions |
| `REVIEWER.md` | Additional reviewer instructions |
| `projects/<slug>.md` | Instructions for that registered Project only |

For example, `.merro/WORKSPACE.md`:

```markdown
Prefer separate PRs for unrelated issues.
Run repository CI before submitting implementation.
Keep PR summaries short and include user-visible changes.
```

Guidance precedence, highest first:

```text
current user instruction
project Markdown
workspace Markdown (including the applicable role file)
Merro defaults
```

**Built-in safety invariants cannot be overridden**, even by user instructions: approval, approved scope, verification, fresh review, result validation and safe Worker ownership still apply. Existing stored Project/ChangeSet guidance remains supported. Repository `AGENTS.md` remains normal Pi/repository guidance; Merro does not replace it.

Main reads workspace and registered Project Markdown each turn, including delivery preferences when planning. Fresh Workers receive the workspace, applicable role and their Project's Markdown in their Task input, on both host and Docker. Missing/blank files are ignored; unreadable files report an error. Edits apply to future turns and Tasks, never steer a running Worker. Ask Main to restart an attempt if requirements change.

## Workspace and resume

Merro uses only the current directory's `.merro`; it does not search parents or initialize on startup. Initialization also creates `.wt` for working copies. Inside an existing Git working tree, these local directories are excluded through `.git/info/exclude`, without changing source files.

Reopen Pi in the same workspace to resume. Workers may outlive Pi; healthy Workers are reconciled, not duplicated. Use one Main Pi session per workspace. Watch Workers without typing into them; changed requirements need a fresh attempt.

## Commands

| Command | Action |
|---|---|
| `/merro init` | Initialize this directory |
| `/status` | Show changes, issues, Workers, CI and activity |
| `/merro-run` | Reconcile and schedule approved work |
| `/merro-approve [change]` | Approve a pending merge/conflict decision |
| `/merro-reject [change]` | Reject a merge or abandon conflict resolution |
| `/merro-continue <change>` | Retry a retryable blocker after fixing its cause |
| `/stop [goal or change]` | Stop new work; active Workers finish |
| `/unlock` | Clear stale ownership, never bypass live Main |
| `/merro-export` | Export status to `.merro/export.json` |

Pi's `/export` exports its conversation instead. Plans are approved conversationally, not through the merge command. Main checks current review, GitHub policy, required checks/reviews and mergeability before squash-merging. Rejecting a merge keeps the PR and branch.

## Runtime settings and safety

Instructions belong in Markdown. Runtime settings remain in `.merro/config.json`; restart Main after editing it. Defaults and validation: [`src/config.ts`](src/config.ts).

- `max_concurrent_tasks` and `max_review_rounds`: positive integers or `"unlimited"`, default 3. Each change has at most one active Worker. Explicit continuation grants another round after the review cap.
- `worker_models` and `worker_thinking`: independent `implement`/`review` choices, default `null` for Pi defaults. Models are Pi model IDs; thinking values pass through to `--thinking`.
- `sandbox`: `"none"` by default. Host Workers inherit normal HOME, Pi config, auth, models, packages and extensions. **Host mode is not a security sandbox.** Reviewer non-editing is contractual, not enforced by host filesystem permissions.
- `sandbox: "docker"`: needs Docker and a suitable image/toolchain. Review mounts are read-only. Container providers must be reachable from Docker; `localhost` means the container. `network: "off"` requires Docker.
- `worker_github`: `"on"` by default, passing a token from `gh auth token`; `"off"` withholds it. Worker push/PR/merge restrictions are contractual; repository permissions and branch protection remain the security boundary.
- `notify_command`: optional notifications for `blocked`, `merge_ready` and `objective_done`, with `MERRO_EVENT`, `MERRO_CHANGE` and `MERRO_MESSAGE`. Failures warn without aborting work.

## Develop

```sh
scripts/run-ci.sh
pi --no-extensions --extension ./src/index.ts
```

CI installs dependencies, checks boundaries/types, builds and tests. Use `--skip-install` only with current dependencies. `--no-extensions` avoids loading an installed Merro alongside the checkout.

Maintainer references, not prerequisites for using Merro:

- [CONTEXT.md](CONTEXT.md): terms and invariants
- [Lifecycle](docs/lifecycle.md): scheduling, recovery and merge contracts
- [Worker protocol](docs/worker-protocol.md): Task input/result and process identity
- [Acceptance](docs/acceptance.md): regression and native-runtime checks
