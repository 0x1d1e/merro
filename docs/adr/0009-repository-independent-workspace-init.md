# ADR-0009: Repository-independent workspace initialization

## Status

Accepted. Supersedes only the repository-registration requirement of `/merro init` in [ADR-0008](0008-changeset-delivery-and-native-pi.md). Its delivery and worker decisions remain in effect.

## Context

A workspace may coordinate several Projects from a new directory that is not a Git repository. Requiring a remote and GitHub authentication during initialization prevents this use and couples workspace creation to Project registration.

## Decision

`/merro init` creates workspace state in any writable cwd after validating Pi and tmux. It requires no Git repository, remote URL or GitHub access, and creates no repository or remote. When Git is available and cwd is inside a working tree, exclude local workspace files through `.git/info/exclude`.

Register Projects explicitly using the existing path/slug tool. Projects remain GitHub repositories with base/push remotes; this decision does not add local-only delivery or remove PR/merge requirements.

## Consequences

New workspaces begin with no Projects, even inside an existing repository. Users register a Project before proposing work. Reinitialization preserves existing configuration, registered Projects and history. Startup and workspace authority remain cwd-only.

Conditional automatic registration was rejected: initialization would still depend on incidental remotes and GitHub availability. Implicit `git init` was rejected because workspace setup should not change repository intent.
