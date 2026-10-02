# v0.1 acceptance

Run `scripts/run-ci.sh`. Tests cross the interfaces used by Main, Pi commands/tools, Git and worker runtime; mocks replace external services, not domain rules.

## Automated gates

- Uninitialized cwd refuses with `/merro init` guidance. Startup creates nothing and ignores initialized parents.
- `/merro init` validates Pi/tmux and creates `.merro`/`.wt` in a writable directory without requiring Git, remotes or GitHub access. It registers no Projects and excludes local state when inside a Git working tree. Repeated init and startup preserve custom config, registered Projects and existing state.
- Combined #96/#97/#100 yields one ChangeSet, `.wt/plugin-lifecycle-safety`, semantic branch, sequential implementation/review flow and one PR with every closure. Internal dependencies do not become scheduling edges.
- Review requires green command verification and receives all issue contents/acceptance criteria, full diff and implementation evidence. Reject creates fresh implementation and review attempts on the same branch.
- Aggregate public plans, status, Task text, errors, PRs, review comments and notifications have no UUID-pattern matches or known private keys.
- Main restart preserves event-derived worker state and does not duplicate a healthy Task. Live ambiguous identity remains occupied and gates scheduling.
- Native TUI launch flags, exact pane/stable window identity, rename disabling, foreground process checks and fail-closed inventory are tested. Print-mode launch is absent.
- Host workers inherit existing Pi configuration; installed Merro is inert in worker mode. Docker remains optional, with read-only review mounts and owned-container rollback.
- Lifecycle events yield busy/progress/idle/finished; finished never regresses. Initial task input is accepted; subsequent interactive steering is blocked. Changed requirements cancel and replace the exact attempt.
- Existing integrity/recovery gates remain: immutable finalization, stale/mismatched results, commit validation, infrastructure retry cap, review cap, relations/concurrency, external PR/base/policy mutations, safe cleanup and merge approval.

Primary coverage: `test/workspace.test.ts`, `test/main.test.ts`, `test/worker-lifecycle.test.ts`, `test/worker-runtime.test.ts`, `test/owned-workers.test.ts`, `test/worker-isolation.test.ts`, `test/store.test.ts`, `test/main-result-validation.test.ts`.

## Native-runtime smoke check

With real Pi/provider, tmux, Git and authenticated GitHub access, use a disposable repository/workspace:

1. Load Merro before initialization: `/status` refuses and no state appears.
2. `/merro init`, register a GitHub Project by path/name, propose one combined change, approve conversationally.
3. Attach to `merro-<project> / impl-<change>`. Confirm the actual Pi TUI, repository/normal host instructions and expected config/extensions are present; no print/JSON reconstruction.
4. Observe implementation, green local verification, fresh review and one PR with all issue closures. A rejection must launch fresh Pi processes without changing branch.
5. Exit/reopen Main while a Worker runs. Same Worker remains, state/activity survive, no duplicate window.
6. Approve the semantic merge Decision; verify completion and dependent unblocking. Inspect public output for UUIDs/private keys.

Automated command fixtures cannot establish provider reachability or native terminal rendering. Record smoke-check scope separately from CI success.
