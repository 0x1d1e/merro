# Merro

Merro is a minimal **Pi + tmux + Git** project lead. One Main Pi talks to you, plans work, and runs implementers and independent reviewers visibly in tmux. GitHub is optional.

## Quick start

Install with Pi. You need Node.js >=22.13.0, Pi with a configured provider and `--tui-mode regular` support, tmux, and Git.

```sh
pi install git:github.com/PrightCord/Merro
mkdir my-workspace
cd my-workspace
pi
```

Inside Pi:

```text
/merro init
register https://github.com/<username>/<project-name> as <project-name>
```

Registration clones into `./projects/<project-name>`, then registers it. For an existing local repository, say `register /path/to/repo as <project-name>`; Merro uses that checkout directly.

Then tell Main what you want done. Project repositories need an initial commit and a configured Git author name/email. Remote cloning needs Git authentication when the repository requires it, not GitHub CLI authentication.

## Workspace model

```text
workspace/
├── .merro/
├── projects/
│   ├── kinetix/
│   └── kinetix-plugins/
└── .wt/
    ├── kinetix/<change-name>/
    └── kinetix-plugins/<change-name>/
```

- `.merro/`: activation, state, and customization.
- `projects/`: canonical checkouts for remotely registered Projects.
- `.wt/`: isolated working copies, one per ChangeSet.

A **ChangeSet** is one delivery unit in one Project; an **Objective** is your goal and may contain several changes. Working copies are independent clones, not Git worktrees sharing repository metadata.

Paths derive from the initialized workspace root containing `.merro`. Start Main there; Merro does not search parent directories. Local registrations stay at their supplied paths. Existing clone destinations are never silently adopted or overwritten.

First init creates the directories above, `.merro/config.json` containing all editable defaults, three short Markdown templates, and `.merro/projects/`. It does not register Projects, launch agents, start tmux, or contact GitHub. Repeating init reports `Merro already initialized.` without rewriting files or repairing missing directories.

## Core workflow

```text
user
  ↓
Main
  ↓
Objective / roadmap
  ↓
implementer: implement, verify, commit
  ↓
independent reviewer
  ├─ reject → fresh implementer → fresh reviewer
  └─ accept → local completion, or requested PR → approved merge
```

Main shows a named plan, including delivery mode, then asks `Approve?`. Nothing starts before approval. Review follows passing reported verification; each attempt uses a fresh Pi process.

Watch the real worker terminals:

```sh
tmux attach -t merro-kinetix
```

Main need not run inside tmux. Watch Workers without typing instructions into them. Changed requirements go through Main, which safely stops and replaces the attempt.

Reopen Pi in the same workspace to resume. Workers may outlive Main; Merro checks their identity rather than duplicating them. Use one Main per workspace.

## Commands

Merro registers one Pi command: `/merro`.

```text
/merro
/merro init
/merro status
/merro <change>
/merro approve [change]
/merro leave [change]
/merro retry [change]
/merro stop [objective]
/merro run
/merro export
/merro unlock
/merro config
```

`/merro` shows status; a change name shows details. `approve` and `leave` resolve merge Decisions, `retry` resumes eligible blocked work, and `stop` stops Objectives without interrupting active Tasks. `run` checks current work, `export` writes `.merro/export.json`, and `unlock` clears stale ownership without bypassing a live Main.

`/merro config` shows the config file location and effective Merro settings, including defaults for omitted fields. Edit that JSON file directly; `null` model/thinking values inherit normal Pi settings.

## Natural-language first

```text
register https://github.com/<username>/<project-name> as <project-name>
Fix plugin lifecycle safety issues #96, #97 and #100 in kinetix.
Add a settings screen to my local app.
Do these two objectives in parallel.
Show me current status.
Open a PR for this change instead of delivering locally.
Queue the app behind the API; let it start once the API passes review.
Use ROADMAP.md to propose the next implementation stage.
```

Issue-based work needs authenticated GitHub CLI (`gh auth login`). Plain local goals do not need GitHub issues or a remote. Main handles scheduling; normal use needs no graph language or internal identifiers. Cross-Project dependencies require plan approval, then queued work starts automatically when its approved gate opens. Worker discoveries are proposals, not permission to start companion work. Required GitHub team reviews wait and resume automatically.

### Plan from Markdown

Ask Main to use a roadmap file or paste a Markdown table:

```markdown
| Order | Workstream | Issues | Depends on |
|---|---|---|---|
| 1A | Provider primitives | #159 + #160 | |
| 1B | Admin API | #105 | |
| 2A | CLI contract | #101 + #103 | 1A |
```

Main presents a proposal with issue groups, order, statuses, dependencies, parallel work and any unresolved wording. Ambiguous text is not turned into a dependency. Done, parked and future work remain context, not executable work. Nothing starts before approval.

After approval, Merro's durable ChangeSets and Relations control execution. Editing the roadmap has no effect; explicitly ask Main to update or re-plan before a changed roadmap can be used.

## Markdown customization

```text
.merro/
├── config.json
├── WORKSPACE.md
├── IMPLEMENTER.md
├── REVIEWER.md
└── projects/
    └── kinetix.md
```

Edit the generated templates. `WORKSPACE.md` holds goals, constraints, conventions, and Project relationships. Role files guide implementation or review. `projects/<name>.md` holds Project-specific context.

Guidance precedence is current user instruction and approved ChangeSet requirements, Project Markdown, workspace Markdown, then Merro defaults. Role Markdown adds workspace-level instructions for that role. Approval, scope, verification, fresh review, result validation, and worker ownership remain non-overridable safety rules. Repository `AGENTS.md` still applies.

Main reads customization Markdown each turn; fresh Workers receive the applicable instructions. Edits affect future attempts, never steer active Workers.

Machine settings belong in `config.json`, not prompts or review policy. Init writes every setting; edit the fields you need. For example:

```json
{
  "projectsDir": "projects",
  "worktreesDir": ".wt",
  "worker": { "model": "provider/model", "thinking": "high" },
  "reviewer": { "model": "provider/model", "thinking": "high" },
  "git": { "defaultDelivery": "auto" },
  "tmux": { "session": "merro" }
}
```

Omitted settings still use defaults; `null` model/thinking inherits Pi's normal settings. Review is always enabled; delivery follows each Project checkout by default: PR for supported remotes, local otherwise. `tmux.session` is the prefix for per-Project sessions. Restart Main after changing machine settings. See [runtime settings](docs/runtime-settings.md) for advanced options.

## Local-only is first-class

```text
local repo → implement → independent review → fast-forward canonical branch → done
```

No GitHub, remote, push, or PR required. After implementation, green verification, and fresh review, Main asks separately before applying the reviewed commit to the displayed local branch. The canonical checkout must be clean and on that branch. If its base moves, Merro schedules fresh implementation, verification, and review, then requests approval again. Main never resolves conflicts or overwrites unrelated changes.

## Delivery modes

- **Local/direct-to-main** is selected when the Project has no supported remote, or when explicitly requested. Main asks for separate local merge approval after green verification and fresh review.
- **Branch + PR** is selected when the Project has supported remotes, or when explicitly requested. Main publishes after review and asks separately before merging, after required GitHub checks and reviews pass.

Issue presence does not change delivery selection. Issues in one Project combine into one change by default; ask for separate changes when needed. Cross-Project work has separate changes.

## What Merro deliberately does not do

- No generic agent framework, daemon, dashboard, or fleet abstraction.
- No Docker default or hidden worker daemon.
- No user-visible UUIDs or required DAG/DSL.
- No arbitrary home-directory repository scanning.
- No direct worker steering.
- No requirement for Main to run inside tmux.

Host Workers use your normal Pi configuration and permissions. Host mode is not a security sandbox; reviewer non-editing is contractual. Docker remains an optional isolation mode.

## Maintainer references

Run `scripts/run-ci.sh` to verify the checkout. See [acceptance checks](docs/acceptance.md), [domain terms](CONTEXT.md), [lifecycle](docs/lifecycle.md), and [worker protocol](docs/worker-protocol.md) before changing execution or recovery contracts.
