# ADR-0012: Approved reviewed dependencies

## Status

Accepted. Extends the completion-only Requires policy; omitted gates still mean `done`.

## Context

Cross-Project implementation can need a reviewed contract before its PR is merged. Waiting for merge unnecessarily serializes that work, but consuming a moving branch silently invalidates downstream review. A Worker can discover the prerequisite without authority to expand approved scope.

## Decision

Main proposes separate companion ChangeSets and Requires Relations for user approval, reusing existing approved work. A Worker suggestion never starts work or replaces an unrelated pending plan.

An explicitly approved `reviewed` gate permits downstream work after independent review passes. Both Task roles receive an exact read-only prerequisite snapshot with PR and summary. Main records the consumed commit without rewriting finalized Tasks.

A changed or no-longer-reviewed prerequisite expires unfinished downstream merge approvals and gates transitive dependents. Wait for live Workers to exit, then run fresh implementation and review against the next passing snapshot. The original approval authorizes this revalidation, not merging a stale result. Terminal ChangeSets remain immutable.

## Alternatives considered

- Require merge for every dependency: retain as the default, but prevents explicitly approved early integration.
- Consume the prerequisite branch head: not stable enough to establish which reviewed input the downstream Task used.
- Let Workers create companion work: bypasses Main ownership and user scope approval.

## Consequences

Reviewed-gate dependents may have PRs open before their prerequisites merge. Required GitHub team reviews remain GitHub-owned gates, not unsupported policy. Exact pre-merge commits may require retaining prerequisite clones while approved dependents remain unfinished. Host read-only access remains contractual; Docker mounts enforce it.
