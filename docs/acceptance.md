# v0.1 acceptance

Run `scripts/run-ci.sh`. Tests cross the interfaces used by Main, Pi commands/tools, Git and worker runtime; mocks replace external services, not domain rules.

## Automated gates

- Uninitialized cwd refuses with `/merro init` guidance. Startup creates nothing and ignores initialized parents.
- `/merro init` validates Pi/tmux and creates complete editable config defaults and short Markdown templates plus `.merro`, `projects`, and `.wt` in a writable directory without requiring Git, remotes or GitHub access. It registers no Projects and excludes local state when inside a Git working tree. Repeated init is a no-op, even for incomplete state; startup preserves custom config, registered Projects, and history.
- Init reports `register <repo-or-path> as <name>`. Remote registration uses workspace-owned canonical clones; local paths register directly. No GitHub calls or destination adoption during registration.
- Real-Git tool walkthroughs approve issue-free goals, implement, review, and complete locally without any GitHub calls, including repositories with remotes. Dirty targets block without overwrites; local base divergence gets implementation and fresh review. Explicit PR plans retain publication and merge approval.
- Optional Markdown reaches Main planning and fresh Task input without new config keys. Workspace/Project/role scoping, current-turn reads, future-Task snapshots, Pi/repository guidance preservation, and non-overridable safety are covered. Repeated init preserves Markdown; absent/blank files need no setup.
- Combined #96/#97/#100 yields one ChangeSet, `.wt/kinetix/plugin-lifecycle-safety`, semantic branch, sequential implementation/review flow and one PR with every closure. Internal dependencies do not become scheduling edges.
- Review requires green command verification and receives all issue contents/acceptance criteria, full diff and implementation evidence. Reject creates fresh implementation and review attempts on the same branch.
- Aggregate public plans, status, Task text, errors, PRs, review comments and notifications have no UUID-pattern matches or known private keys.
- Main restart preserves event-derived worker state and does not duplicate a healthy Task. Live ambiguous identity remains occupied and gates scheduling.
- Native TUI launch flags, exact pane/stable window identity, rename disabling, foreground process checks and fail-closed inventory are tested. Print-mode launch is absent.
- Host workers inherit existing Pi configuration; installed Merro is inert in worker mode. Docker remains optional, with read-only review mounts and owned-container rollback.
- Lifecycle events yield busy/progress/idle/finished; finished never regresses. Initial task input is accepted; subsequent interactive steering is blocked. Changed requirements cancel and replace the exact attempt.
- Existing integrity/recovery gates remain: immutable finalization, stale/mismatched results, commit validation, infrastructure retry cap, review cap, relations/concurrency, external PR/base/policy mutations, safe cleanup and merge approval.

Primary coverage: `test/local-workflow.test.ts`, `test/workspace.test.ts`, `test/guidance.test.ts`, `test/main.test.ts`, `test/worker-lifecycle.test.ts`, `test/worker-runtime.test.ts`, `test/owned-workers.test.ts`, `test/worker-isolation.test.ts`, `test/store.test.ts`, `test/main-result-validation.test.ts`.

## Native-runtime smoke check

With real Pi/provider, tmux, and Git, use a disposable repository/workspace. GitHub authentication is needed only for the optional PR path:

1. Load Merro before initialization: `/merro status` refuses and no state appears.
2. Follow only the README quickstart: `/merro init`, register a remote or local Project, give local work, approve conversationally. Confirm the init next steps and first Worker. Optionally add workspace/role/Project Markdown and verify only applicable instructions appear in fresh Task input.
3. Attach to `merro-<project> / impl-<change>`. Confirm the actual Pi TUI, repository/normal host instructions and expected config/extensions are present; no print/JSON reconstruction.
4. Observe implementation, green local verification, fresh review, and local completion without a push or PR. A rejection must launch fresh Pi processes without changing branch.
5. Exit/reopen Main while a Worker runs. Same Worker remains, state/activity survive, no duplicate window.
6. Optionally request issue work with PR delivery using authenticated GitHub access. Confirm all issue closures and approve the semantic merge Decision separately. Verify completion and dependent unblocking. Inspect public output for UUIDs/private keys.

Automated command fixtures cannot establish provider reachability or native terminal rendering. Record smoke-check scope separately from CI success.
