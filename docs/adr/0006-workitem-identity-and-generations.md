# ADR-0006: WorkItem identity and generations

## Status
Accepted

## Context
Issues get reopened, work gets cancelled and redone, and terminal records must stay immutable and traceable.

## Decision
Identity is `<project>:issue-<n>` or `<project>:local:<slug>` plus a generation counter that is never reused. One non-terminal generation per source. Terminal generations (Done, Obsolete, Cancelled) are never reactivated; equivalent later work is a new generation. No auto-splitting of issues, no auto-created issues. Auto-combining issues is deferred past v0.1. Cross-project work is Relations between WorkItems, never one WorkItem across Projects.

## Alternatives considered
- Mutable WorkItems reopened in place: loses history.
- Auto-combine in v0.1: adds combined identities and obsolescence rules for unproven value.

## Consequences
Reopened issue under an active Objective yields a new generation and fresh relation inference.
