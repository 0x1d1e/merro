# ADR-0003: Failure and review-cap policy

## Status
Accepted

## Context
Blind retries hide real problems and burn cost. But every infra blip blocking on the user defeats autonomy. An unbounded reject loop can run away.

## Decision
A real Task failure is reported once and blocks the WorkItem. Infra-class failure (worker gone, no valid result) gets one automatic fresh Task. Reject loop runs up to `max_review_rounds` (default 3, configurable to `unlimited`), then Blocked(review_cap); "continue" grants another round. Finalized Task records are immutable.

## Alternatives considered
- No auto retry at all: too many manual interventions.
- Retry budget: adds state and tuning with little benefit.
- Unlimited default loop: no cost brake.

## Consequences
Review cap is a config outcome, not a Task failure. Cost is visible in `status` but not enforced.
