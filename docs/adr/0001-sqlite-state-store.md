# ADR-0001: SQLite state store

## Status
Accepted. Supersedes the JSON-file-per-entity design in the archived spec.

## Context
Correctness and recovery are the priorities. Orchestration state spans WorkItems, Tasks, Relations, Decisions. Per-file atomic writes cannot make multi-entity changes atomic, forcing startup repair, hashed filenames, and path-length handling.

## Decision
One SQLite database (`node:sqlite`) in `.merro/`, single writer (Main, guarded by the workspace lock). Triggers reject updates to finalized Tasks and terminal WorkItem core fields. Backup on clean exit, keep last 5. `export` command dumps JSON. Config stays JSON.

## Alternatives considered
- Files per entity: hand-editable, but needs repair logic and filename schemes.
- Fewer, larger JSON files: less repair, still no transactions.

## Consequences
Positive: transactions, indexed queries, enforced immutability, less code.
Negative: not hand-editable (mitigated by `export` and a state-edit tool), schema migrations, depends on Pi's Node version supporting `node:sqlite`.
