# ADR-0005: GitHub via gh, external authority

## Status
Accepted

## Context
Issues, PRs, checks, reviews, and merge state change outside Merro. gh-axi is built for LLM readability (TOON output), not for deterministic parsing.

## Decision
Deterministic code calls `gh` with `--json`. Main may use gh-axi when reading for itself. GitHub is authoritative for issues, PRs, reviews, checks, policy, merge; Git for branches and commits; Docker/tmux for live workers; the store for orchestration metadata. Reconciliation lets external state win. GitHub operation failure → Blocked(github_unavailable), auto-resume after a successful fresh reconcile. No per-capability freshness machine. Workers may receive `GH_TOKEN` (`worker_github`, default on).

## Alternatives considered
- gh-axi everywhere: token-efficient, unstable output for code.
- Capability freshness tracking: state machine without a proven need.

## Consequences
Worker token can push despite the Main-only contract; branch protection is the real guard. GitHub only in v0.1, no forge abstraction.
