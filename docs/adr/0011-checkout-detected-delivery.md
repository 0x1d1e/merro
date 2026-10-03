# ADR-0011: Checkout-detected delivery

## Status

Accepted. Supersedes ADR-0010's delivery-default decision only; its other decisions remain in force.

## Context

Projects are registered Git repositories, and a remote is optional. Requiring a user to choose a project type or delivery mode for every Objective obscures the delivery capability already present in the checkout.

## Decision

New Objectives use automatic delivery selection by default. Projects with supported base and push remotes use PR delivery; Projects without them use local delivery. An explicit Objective or `git.defaultDelivery` setting may override the automatic choice. Delivery mode remains fixed after plan approval.

Local delivery requires a separate approval after green verification and fresh review. Approval authorizes only the reviewed commit, diff, base commit, and displayed target branch. If the base moves, Merro requires fresh implementation, verification, review, and approval. Main never resolves project conflicts manually.

## Alternatives considered

- Always deliver locally: ignores the delivery capability available in Projects with supported remotes.
- Infer a special Project type during registration: duplicates information from the Git checkout and complicates registration.
- Ask for a delivery mode in every Objective: adds repetitive user input when checkout capability determines the default.

## Consequences

Remote-backed Projects use the existing PR lifecycle by default; local-only Projects use the approval-gated local merge lifecycle. Users can explicitly select either mode when they need an override. Existing approved ChangeSets retain their stored delivery mode and target branch.
