# AGENTS.md

- Domain terms: read `CONTEXT.md` before naming anything. Use canonical terms; avoid the listed synonyms.
- Before changing WorkItem states, relations, scheduling, PR or merge flow, read `docs/lifecycle.md`.
- Before changing Task files, the result tool, Docker/tmux launch, or process identity, read `docs/worker-protocol.md`.
- Before reversing a decision, read the matching ADR in `docs/adr/` and supersede it, don't edit it.
- `domain/` must not import git, github, docker, tmux, or sqlite modules.
- Tests cross the same interface callers use. Bug fixes get a regression test that fails on the old behavior.
- Verify with `scripts/run-ci.sh`. Use `--skip-install` only when dependencies are already current.
- `docs/archive/` is historical. Do not update it.

## Module ownership

`domain` (pure rules: states, relations, scheduling order, review-round cap), `store` (SQLite, migrations, immutability triggers), `runtime` (Docker, tmux, process identity), `vcs` (clones, branches), `github` (`gh --json`, deterministic; gh-axi only for Main's own reading), `reconcile`, `tools` (Pi tool surface, notify, escape commands).
