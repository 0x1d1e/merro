# ADR-0012: Worker runtimes, issue intake and automatic merge

## Status

Accepted. Supersedes two invariants in [CONTEXT.md](../../CONTEXT.md): "PR merge needs separate per-PR approval" (now conditional on `merge.auto`) and "Merro never ... auto-creates issues" (now governed by `issues.create`). ADR-0005 (GitHub is the external authority) and ADR-0007 (Main-only writes, result tool) remain in force.

## Context

Workers were always native Pi processes with one shared model setting per role. Users need a different agent for review than for implementation, a way to turn GitHub issues into work and capture out-of-scope findings, and an opt-in path to a fully automatic factory without weakening GitHub policy.

## Decision

- `config.json` `workers.implementer` and `workers.reviewer` each choose `runtime` (`pi` or `claude`), `model` and `thinking`. Roles never inherit from each other. Legacy `worker`, `reviewer`, `worker_models` and `worker_thinking` migrate on load.
- `AgentRuntime` (`PiRuntime`, `ClaudeRuntime`) builds the launch command and recognises its process identity. tmux, Docker and cleanup remain in `WorkerRuntime`. The kind used is persisted per Task (`task_runtime.agent`), so a config change never reinterprets a running Task. The Claude runtime is host-only and exposes `merro_submit_result` through an MCP stdio server; hooks mirror the Pi lifecycle events. Both runtimes share `protocol/submit-result.ts`.
- `/merro issue create|list|show|start` is the user's direct approval for that issue operation. Workers and reviewers may add `proposed_issues` to a result; `issues.create` (`disabled`, `approval` default, `auto`) decides whether Merro drops them, holds them as `IssueProposal` Decisions, or creates them. Proposals never expand the current change's scope.
- `merge.auto` (default false) lets Merro execute the merge Decision itself once review passed on the latest diff, required checks and reviews are satisfied by GitHub policy, and CI is not pending or failed. It uses the existing head-pinned merge with `merge.method` and `merge.delete_branch`. Merro never bypasses branch protection or required reviews. A failed non-required check, unknown policy or rejected merge falls back to the human Decision or a block.

## Alternatives considered

- Separate per-runtime config sections: duplicates model and thinking fields.
- Letting workers create issues directly: bypasses user control and GitHub token scope.
- Merging with `--admin` or bypassing rulesets: violates GitHub authority.

## Consequences

Default behaviour is unchanged except that worker-proposed issues need approval. Claude coverage depends on the `claude` CLI on PATH; Docker sandbox with the Claude runtime is rejected at launch. Auto-merge makes the merge Decision a policy outcome rather than a prompt, so audit relies on the PR and Merro events.
