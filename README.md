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

First init creates the directories above, `.merro/config.json` containing `{}`, three short Markdown templates, and `.merro/projects/`. It does not register Projects, launch agents, start tmux, or contact GitHub. Repeating init reports `Merro already initialized.` without rewriting files or repairing missing directories.

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

## Natural-language first

```text
register https://github.com/<username>/<project-name> as <project-name>
Fix plugin lifecycle safety issues #96, #97 and #100 in kinetix.
Add a settings screen to my local app.
Do these two objectives in parallel.
Show me current status.
Open a PR for this change instead of delivering locally.
```

Issue-based work needs authenticated GitHub CLI (`gh auth login`). Plain local goals do not need GitHub issues or a remote. Main handles scheduling; normal use needs no graph language or internal identifiers.

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

Guidance precedence is current user instruction, Project instructions, workspace instructions, then Merro defaults. Approval, scope, verification, fresh review, result validation, and worker ownership remain non-overridable safety rules. Repository `AGENTS.md` still applies.

Main reads Markdown each turn; fresh Workers receive the applicable instructions. Edits affect future attempts, never steer active Workers.

Machine settings belong in the optional overrides in `config.json`, not prompts or review policy. For example:

```json
{
  "projectsDir": "projects",
  "worktreesDir": ".wt",
  "worker": { "model": "provider/model", "thinking": "high" },
  "reviewer": { "model": "provider/model", "thinking": "high" },
  "git": { "defaultDelivery": "local" },
  "tmux": { "session": "merro" }
}
```

Omit settings to use defaults: Pi's normal model/thinking settings, review enabled, local delivery. `tmux.session` is the prefix for per-Project sessions. Restart Main after changing machine settings. See [runtime settings](docs/runtime-settings.md) for advanced options.

## Local-only is first-class

```text
local repo → implement → independent review → fast-forward canonical branch → done
```

No GitHub, remote, push, or PR required. Approving the plan authorizes delivery of the reviewed commit to the displayed local target branch. The canonical checkout must be clean and on that branch. If its base diverges, Merro schedules implementation and fresh review before delivery; it never overwrites unrelated changes.

## Delivery modes

- **Local/direct-to-main** is the default: deliver the exact reviewed commit locally, without pushing.
- **Branch + PR** is requested explicitly, or configured as the default. Main publishes after review and asks separately before merging, after required GitHub checks and reviews pass.

A remote's existence never selects PR delivery. Issues in one Project combine into one change by default; ask for separate changes when needed. Cross-Project work has separate changes.

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
