# Merro

Pi package for coordinating multiple coding workers from one Main Pi session.

Merro turns one Pi session into a controlled coding workflow:

```text
You
 ↓
Main Pi
 ↓
Merro
 ↓
isolated Pi workers
 ↓
implementation → review → PR → explicit merge approval
```

Workers run one Task at a time in isolated Docker containers and appear as tmux windows.

Merro is **not a separate coding agent or CLI**. Pi remains the agent. Merro handles orchestration, isolation, scheduling, review, reconciliation, and merge gates.

GitHub only. Linux/macOS.

---

## Quick start

### 1. Install Merro

```sh
pi install git:github.com/PrightCord/Merro
```

Restart Pi after installing.

For a pinned version:

```sh
pi install git:github.com/PrightCord/Merro@<commit-or-tag>
```

Update:

```sh
pi update git:github.com/PrightCord/Merro
```

Remove:

```sh
pi remove git:github.com/PrightCord/Merro
```

A pinned installation stays pinned. To return to `main`, rerun the unpinned install command.

### 2. Create a persistent Merro workspace

```sh
mkdir -p ~/merro-workspace
cd ~/merro-workspace
pi
```

Merro creates:

```text
~/merro-workspace/
└── .merro/
    ├── config.json
    ├── runtime/
    └── ...
```

Return to the same workspace directory when you want to resume it.

Use **one Main Pi session per workspace**.

### 3. Register a Project

Inside Pi:

```text
Register ~/Projects/kinetix as kinetix.
```

Or multiple Projects:

```text
Register ~/Projects/kinetix as kinetix and
~/Projects/kinetix-plugins as kinetix-plugins.
```

A Merro **workspace** and a Merro **Project** are different:

```text
Workspace
  └── owns .merro state

Projects
  ├── ~/Projects/kinetix
  └── ~/Projects/kinetix-plugins
```

You do not need to run Pi from a Project checkout.

Registered source repositories are not worker working directories. Merro creates separate worker clones.

### 4. Give Merro an Objective

Start small:

```text
Objective: complete issue #123 in kinetix.

Show me the proposed scope, WorkItems, and relations before starting.
Do not start until I approve them.
```

Review the proposed plan, then approve it in conversation.

Merro will handle the rest:

```text
Objective
   ↓
WorkItem
   ↓
implementation Task
   ↓
review Task
   ↓
PR
   ↓
merge approval
   ↓
Done
```

Merro asks before each squash merge.

---

## Recommended first run

Before handing Merro a milestone or large backlog, verify the complete lifecycle with:

```text
1 Project
1 issue
1 implementation Task
1 review Task
1 PR
1 merge approval
```

Then try several independent issues:

```text
Objective: complete issues #101, #102, and #103 in kinetix.

Show the proposed WorkItems and relations before starting.
```

Then move to cross-Project work:

```text
Objective: complete the selected 1.0 work across kinetix and kinetix-plugins.

Determine dependencies and conflicts between Projects.
Show the proposed WorkItems and relations before starting.
```

Once that works reliably, milestone-sized Objectives are appropriate.

---

## How Merro works

### Main

The Main Pi session:

- talks to you
- owns Merro state
- defines and approves Objectives
- schedules Tasks
- reconciles worker results
- opens PRs
- manages review cycles
- asks for merge approval
- performs merges

### Workers

Each Task gets a fresh Pi worker.

Workers:

- run in Docker by default
- use a separate local clone
- get only the context needed for their Task
- either implement or review
- cannot orchestrate other workers
- cannot push branches, open PRs, or merge

An implementation Task can edit its clone and produce one final commit.

A review Task gets a read-only checkout and returns findings without modifying the implementation.

### GitHub

GitHub remains authoritative for:

- issues
- branches
- pull requests
- required checks
- required reviews
- merge state

Merro owns orchestration state around that external state.

---

## Objectives, WorkItems, and Tasks

The main Merro concepts are:

```text
Objective
  desired outcome

WorkItem
  durable unit of work, usually associated with an issue

Task
  one worker execution attempt
```

A WorkItem may require several Tasks:

```text
WorkItem #123
   ↓
implement
   ↓
review rejects
   ↓
rework
   ↓
review passes
   ↓
PR
```

Tasks are disposable execution attempts.

WorkItems preserve the durable lifecycle.

---

## Issue scopes

Objectives may target:

- fixed issue numbers
- issues matching labels
- issues matching a milestone
- labels plus milestone
- all open issues

Example:

```text
Objective: complete all open issues labeled 1.0 in kinetix.
```

Or:

```text
Objective: complete all open issues in milestone v1.0.0 across
kinetix and kinetix-plugins.
```

Query scopes automatically include future issues that match the approved query.

An empty query means all open issues.

Merro does **not** automatically invent, split, or create issues.

---

## Relations

Merro can model relationships between WorkItems such as dependencies and conflicts.

Example:

```text
plugin capability support
        ↓ requires
core capability contract
```

A dependent WorkItem waits until its requirement is satisfied.

Ask Main to show proposed relations before starting significant work:

```text
Show all proposed WorkItems, dependencies, and conflicts before execution.
```

---

## Inspect workers

Each Project gets a tmux session when its first Task starts.

For example:

```sh
tmux attach -t merro-kinetix
```

Typical windows:

```text
impl-188
rev-188
```

Each window corresponds to one worker Task.

Workers may continue running if Main exits.

Reopen Pi from the same Merro workspace:

```sh
cd ~/merro-workspace
pi
```

Merro will reconcile worker state and continue from persisted state.

---

## Commands

Use these inside the Main Pi session.

| Command | Action |
|---|---|
| `/status` | Show Objective, WorkItem, and Task counts |
| `/merro-run` | Reconcile worker results and PR state, then schedule available work |
| `/merro-approve <Decision ID>` | Approve a merge or authorize merge-conflict resolution |
| `/merro-reject <Decision ID>` | Reject a merge or abandon merge-conflict resolution |
| `/merro-continue <WorkItem ID>` | Resume blocked work after its cause has been fixed |
| `/stop [Objective ID]` | Soft-stop one Objective, or all active Objectives |
| `/unlock` | Clear stale lock metadata only when Main is not running |
| `/merro-export` | Export Merro SQLite state to `.merro/export.json` |

Pi's normal `/export` exports the Pi session instead.

Ask Main for current pending Decision IDs when needed.

`/stop` does not kill already running Tasks. It prevents further scheduling.

---

## Merge approval

Merro never silently merges completed work.

After implementation, review, PR creation, and required GitHub checks are satisfied, Main asks for approval.

Approve:

```text
/merro-approve <Decision ID>
```

Reject:

```text
/merro-reject <Decision ID>
```

Non-blocking review findings and notes are shown again before merge.

---

## Blocked work

A WorkItem may become blocked when Merro cannot safely continue.

Examples:

- missing external dependency
- repository unavailable
- worker runtime problem
- conflicting external state
- merge conflict requiring authorization
- invalid worker result

Fix the underlying problem, then resume:

```text
/merro-continue <WorkItem ID>
```

Do not use `/unlock` for ordinary blocked work.

`/unlock` is only for stale Main lock metadata when no Main process is actually running.

---

## Docker and provider networking

Workers run in Docker by default.

This matters if Pi uses a model/provider endpoint running on your host.

For example, this configuration may work from host Pi:

```text
http://localhost:PORT
```

but fail inside a worker container.

Inside Docker:

```text
localhost
```

refers to the container itself, not the host.

If you use a local gateway such as Kinetix, make sure workers can reach the configured endpoint from Docker.

Before debugging Merro itself, verify the same provider configuration works from a container-accessible address.

You can temporarily use host workers for diagnosis:

```json
{
  "sandbox": "none"
}
```

Host mode does not provide Docker isolation.

---

## Requirements

- [Pi](https://pi.dev) installed with a configured model/provider
- Node.js compatible with your Pi version
- Node.js `>=22.13.0` for Merro's `node:sqlite`
- `git`
- authenticated `gh`
- `tmux`
- running Docker daemon
- local GitHub repository checkouts
- working Git authentication for fetch/push
- configured Git author identity
- permission to push branches, create PRs, and squash-merge target repositories

Verify the important external dependencies:

```sh
gh auth status
docker info
git config user.name
git config user.email
```

---

## Configuration

Merro creates:

```text
.merro/config.json
```

on first load.

Edit it directly or ask Main to change it, then restart Pi.

Current workspace options:

| Key | Default | Meaning |
|---|---|---|
| `max_concurrent_tasks` | `3` | Maximum active worker Tasks |
| `max_review_rounds` | `3` | Maximum review cycles per Objective |
| `pi_config` | `copy` | Worker Pi configuration mode |
| `sandbox` | `docker` | Worker isolation mode |
| `network` | `on` | Worker network access |
| `worker_github` | `on` | Pass GitHub authentication to workers |
| `work_root` | `null` | Worker clone root |
| `notify_command` | `null` | Optional event notification command |

Example:

```json
{
  "max_concurrent_tasks": 3,
  "max_review_rounds": 3,
  "pi_config": "copy",
  "sandbox": "docker",
  "network": "on",
  "worker_github": "on",
  "work_root": null,
  "notify_command": null
}
```

### `max_concurrent_tasks`

Positive integer or:

```json
"unlimited"
```

Start with `3`.

Higher concurrency increases resource usage and makes early debugging harder.

### `max_review_rounds`

Positive integer or:

```json
"unlimited"
```

Controls repeated implement → review cycles.

### `pi_config`

`copy`:

- copies your Pi configuration for each Task
- preserves installed packages
- preserves unrelated extensions
- preserves model/provider configuration
- preserves authentication
- does not mutate your real Pi configuration

`clean`:

- copies only `auth.json`
- provides a much smaller worker Pi environment

### `sandbox`

Default:

```json
"docker"
```

Workers run in isolated containers.

Alternative:

```json
"none"
```

Workers run directly on the host inside their clone.

Host mode is not an OS security boundary.

### `network`

Default:

```json
"on"
```

`off` requires Docker sandboxing.

### `worker_github`

Default:

```json
"on"
```

Merro derives `GH_TOKEN` from:

```sh
gh auth token
```

and passes it to workers.

Workers still may not push branches, open PRs, or merge by Merro contract.

Main owns those operations.

### `work_root`

Default:

```json
null
```

which uses:

```text
<workspace>-work/
```

for worker clones.

### `notify_command`

Optional shell command executed when Merro emits:

- `blocked`
- `merge_ready`
- `objective_done`

Available environment variables:

```text
MERRO_EVENT
MERRO_SUBJECT_ID
MERRO_MESSAGE
```

Example:

```json
{
  "notify_command": "notify-send 'Merro' \"$MERRO_MESSAGE\""
}
```

Notification command failures produce warnings but do not abort reconciliation.

---

## Worker isolation

Each WorkItem gets its own local clone under the configured work root.

The registered source checkout is never mounted into the worker and is never modified.

Typical layout:

```text
~/merro-workspace/
~/merro-workspace-work/
    └── kinetix/
        └── issue-188-.../
```

The same WorkItem clone is reused across implementation, review, rework, PR, and merge preparation.

Implementation workers receive the clone read-write.

Review workers receive it read-only.

---

## Pi configuration inside workers

With:

```json
{
  "pi_config": "copy"
}
```

Merro copies the Main Pi configuration into Task scratch space.

This allows workers to reuse your existing:

- providers
- models
- Pi packages
- extensions
- authentication
- settings

Merro itself does not recursively activate inside workers.

Workers run with:

```text
MERRO_RUNTIME=worker
```

which disables Main orchestration behavior in worker Pi processes.

---

## Review model

Implementation and review are intentionally separate Tasks.

```text
implementer
    ↓
final commit
    ↓
fresh reviewer
    ↓
pass / reject
```

Reviewers:

- do not inherit implementer conversation history
- see the complete relevant diff
- get acceptance criteria
- get implementation summary
- get verification results
- receive relevant dependency context
- cannot modify the implementation checkout

A blocking finding causes rejection.

The next implementation Task receives the full latest review result.

---

## Verification

Workers determine the appropriate checks from the Project itself.

Instruction precedence:

1. nearest `AGENTS.md`
2. root `AGENTS.md`
3. contributor/test documentation
4. CI configuration
5. package scripts
6. README

Relevant checks must run against the final implementation state.

If an expected check cannot safely complete, the Task fails rather than pretending verification succeeded.

---

## Repository moves

If a registered source checkout moves, register its new path using the existing Project slug.

Example:

```text
Register ~/src/kinetix as kinetix.
```

Merro can adopt the moved checkout when its repository identity still matches the registered Project.

---

## What Merro does not do

Merro deliberately does **not**:

- replace Pi
- replace GitHub
- create or split issues automatically
- let workers launch other workers
- let workers manage orchestration state
- let workers push branches
- let workers open PRs
- let workers merge
- silently merge approved work
- modify registered source checkouts
- provide a generic autonomous multi-agent hierarchy
- act as a general workflow/DAG engine

The intended boundary is:

```text
Pi
  reasoning + coding

Merro
  orchestration + isolation + lifecycle

GitHub
  issues + PRs + checks + merge truth
```

---

## Suggested usage pattern

Merro works best when GitHub issues already describe coherent units of work.

Prefer:

```text
Objective:
complete this approved set of issues
```

over:

```text
Build the entire product and decide everything yourself.
```

For significant Objectives, ask Main to show:

- scope
- WorkItems
- dependencies
- conflicts
- Project assignments

before execution.

Example:

```text
Objective: finish milestone v1.0.0 across kinetix and kinetix-plugins.

Show me:
- included issues
- proposed WorkItems
- dependencies
- conflicts
- execution order

Do not start until I approve the plan.
```

---

## Develop locally

Clone Merro:

```sh
git clone https://github.com/PrightCord/Merro.git merro
cd merro
```

Run CI:

```sh
scripts/run-ci.sh
```

Load the local checkout directly into Pi:

```sh
pi --no-extensions --extension ./src/index.ts
```

`--no-extensions` avoids simultaneously loading an installed Merro package.

Useful commands:

```sh
npm run build
npm run typecheck
npm run lint
npm test
```

CI installs dependencies, checks architectural boundaries and types, builds the package, and runs tests.

Git installation emits JavaScript.

TypeBox is supplied by Pi at runtime and is not bundled with Merro or copied into worker runtime files.

---

## Architecture documentation

Read these before changing Merro internals:

- [`CONTEXT.md`](CONTEXT.md) — terms, ownership boundaries, invariants
- [`docs/lifecycle.md`](docs/lifecycle.md) — WorkItem states, relations, PR/merge flow, reconciliation
- [`docs/worker-protocol.md`](docs/worker-protocol.md) — Task files, worker runtime, result protocol, Docker, tmux
- [`docs/adr/`](docs/adr/) — architectural decisions
