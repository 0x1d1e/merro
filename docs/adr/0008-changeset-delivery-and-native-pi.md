# ADR-0008: ChangeSet delivery and native host Pi

## Status

Accepted. Supersedes [ADR-0004](0004-per-workitem-clones-in-docker.md) and [ADR-0006](0006-workitem-identity-and-generations.md). Those files record historical decisions, not the current contract.

## Context

Issue-owned execution creates multiple branches, implementations and PRs when the user wants several issues delivered together. Docker-default execution and copied host configuration diverge from ordinary Pi, complicating provider access and hiding the UI the user expects. Public database identifiers make plans and recovery harder to understand.

## Decision

The product boundary is Pi, tmux, Git and GitHub, not interchangeable harnesses/backends. A workspace exists only at explicit `cwd/.merro`; `/merro init` records repository identity without source edits. Working copies live in `cwd/.wt`.

An Objective owns ChangeSets. Each ChangeSet is within one Project and owns its issue SourceRefs, working copy, branch, sequential implementation/review Tasks and one PR. Selected issues combine by default; separate delivery is explicit. Combined query selections freeze at approval. Active issue ownership cannot overlap. Terminal generations and finalized Tasks remain immutable.

Public identity is Project/change slug, issue number, branch and PR number. Database keys remain private. Names and collisions use readable slugs and numeric suffixes; plans and Decisions are approved conversationally/by name.

Host Pi is the default, inheriting the user's normal Pi configuration and adding only worker lifecycle/result extensions. Run fresh native TUI processes in exact tmux panes/windows, with rename disabled and verified foreground identity. Live ambiguity pauses scheduling rather than creating duplicate Workers. No steering: changed requirements stop and replace an attempt.

Green reported local command verification precedes a fresh reviewer with complete diff, issue scope and implementation evidence. Rejection starts a fresh implementer/reviewer cycle on the same change and branch. Docker remains an optional execution mode, not the architecture's organizing abstraction.

## Alternatives considered

- Keep per-issue delivery: fails combined-PR requests and duplicates review context.
- Add a generic execution framework: introduces variation outside the product boundary.
- Keep Docker/copy-config as default: preserves stronger isolation but departs from normal host Pi behavior.
- Use worktrees instead of clones: shares source Git metadata; retain independent clones for now.
- Expose durable UUIDs: simple internal lookup, poor public language; keep keys private instead.

## Consequences

Combined delivery has one owner and one review flow, not per-issue scheduling. Native Pi is directly observable and inherits user configuration. Host mode sacrifices OS-enforced reviewer isolation; restrictions are contractual, with Docker available when needed. Pi lifecycle events provide machine state; process identity, not terminal heuristics, controls recovery.

## Persisted-state migration

Existing SQLite keys and source columns remain storage details. Migration assigns semantic slugs with numeric collisions and adds stable window identity without rewriting immutable history. Existing working-copy paths/runtime ownership stay authoritative while recorded Workers may still be alive. Deprecated `work_root` and `pi_config` inputs are discarded on config parsing; no dual public model or compatibility worker architecture remains.
