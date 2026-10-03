# ADR-0010: Local-first workspace and delivery

## Status

Accepted. Supersedes the GitHub-only Project/delivery boundary in [ADR-0008](0008-changeset-delivery-and-native-pi.md) and [ADR-0009](0009-repository-independent-workspace-init.md), and the default worker GitHub-token access in [ADR-0005](0005-github-via-gh-external-authority.md). Their other decisions remain in effect.

## Context

Workspace initialization should establish a boundary, not a GitHub workflow. Registering a remote should produce a workspace-owned checkout rather than depending on a repository elsewhere in the home directory. Local goals need the same implementation and independent review without issues, publication, or GitHub credentials.

## Decision

The product boundary is Pi, tmux, and Git. GitHub supplies optional issues and requested PR delivery. Projects are Git repositories; a remote is optional. New changes default to local delivery, regardless of remote presence. PR delivery must be requested or configured explicitly. Worker GitHub-token access defaults off.

Init creates minimal state, short editable Markdown templates, and workspace directories. Repeating init is a no-op whenever `.merro` exists, not a repair operation. Workspace authority remains explicit `cwd/.merro`, with no parent or home-directory discovery.

Remote registration clones into `<root>/projects/<project>`. Local registration uses the supplied path directly. Each ChangeSet owns an independent clone at `<root>/.wt/<project>/<change>`. Configured paths remain workspace-relative; existing destinations cannot be silently adopted or overwritten.

Local plan approval authorizes fast-forwarding the exact independently reviewed commit to the displayed canonical target branch. Both checkouts must be clean, the target branch checked out, and worker exit verified. Main does not author commits or push. Divergence schedules an implementer to merge the exact local base, verify, and commit, followed by fresh review. Unsafe or dirty checkouts block delivery. PR delivery retains separate merge approval and GitHub policy checks.

Behavior and context belong in Markdown; paths, models/thinking, delivery, and runtime settings belong in JSON. Built-in approval, review, verification, scope, and ownership invariants remain non-overridable.

## Alternatives considered

- Discover existing home-directory clones: ambiguous ownership and non-reproducible paths.
- Publish whenever a remote exists: unexpected remote effects and GitHub dependency for local goals.
- Author local merge commits in Main: bypasses implementation verification and independent review of the final commit.
- Switch to Git worktrees: shares repository metadata; retain the existing independent-clone isolation decision.

## Compatibility and consequences

Persisted changes migrate as PR delivery, preserving earlier approved intent. Existing clone paths and worker identities remain authoritative; no relocation of live working copies. Delivery mode and local target branch are immutable after approval.

Local completion is Git-authoritative and needs no GitHub checks. Users must keep the canonical target clean and checked out. Main still needs to remain open for reconciliation; there is no worker daemon.
