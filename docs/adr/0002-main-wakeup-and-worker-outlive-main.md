# ADR-0002: Main wake-up and worker lifetime

## Status
Accepted

## Context
Main is an LLM session, and there is no daemon. Nothing else consumes results or schedules while Main is idle or closed.

## Decision
While Main is open, an in-process timer runs the schedule loop. A headless `pi -p` pass runs one reconcile+schedule loop under the workspace lock, callable from cron or `notify_command`. Workers keep running after Main exits; the next Main reconciles before scheduling. No background daemon.

## Alternatives considered
- Daemon: another process to supervise, contradicts the Pi-package design.
- Kill workers on exit: wastes running work.

## Consequences
Autonomy while closed depends on the user wiring cron or the headless pass. Approval Decisions still wait for the user.
