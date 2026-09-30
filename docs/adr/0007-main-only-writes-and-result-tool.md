# ADR-0007: Main-only writes and validated result tool

## Status
Accepted

## Context
Workers must not corrupt orchestration state. Hand-written result JSON is fragile.

## Decision
Only Main writes the store. Workers communicate one way: the `merro_submit_result` tool validates the schema, writes `.merro-result.json` atomically, and exits Pi. Main verifies `task_id`, role schema, and commit state before consuming. Task input is a fresh `.merro-task.md`, excluded through `.git/info/exclude`.

## Alternatives considered
- Worker-written free JSON: schema drift.
- Worker writes to the store: breaks single-writer rule.

## Consequences
The tool must be present in every worker image or config copy. Stale or mismatched results are never consumed.
