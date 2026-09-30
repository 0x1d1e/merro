# ADR-0004: Per-WorkItem clones in Docker

## Status
Accepted

## Context
Workers run with the user's models and tools. Worktrees share the source repo's `.git`, so a worker can touch other branches. Reviewers must be read-only in fact, not by promise.

## Decision
Each WorkItem gets a full local clone; each Task runs in a Docker container in a tmux window mounting only that clone (ro for review). Pi config is a per-Task copy of the user's (default) or clean. Network on. Merro generic image, per-Project override. `sandbox: none` is allowed.

## Alternatives considered
- Worktrees on host: lighter, weak isolation.
- Shared source `.git` mounted rw: simpler, leaks other branches.
- Cloud or VM isolation: out of scope.

## Consequences
More disk (mitigated by `--local` hardlinks), image maintenance per toolchain, container UID/permission handling on Linux/macOS to test, process identity uses container ID + inner PID. Docker Desktop volume performance on macOS to measure.
