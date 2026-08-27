# Personal GitHub Account Workspaces

## Goal

Allow Mars to install its GitHub App on a personal GitHub account and manage that account's private repositories through the existing workspace, repository approval, webhook, and scheduler flows.

## Design

### Shared workspace model

Use `organizations` as the existing workspace table for both GitHub organizations and personal accounts. Add `github_account_type` with values `Organization` and `User`, defaulting existing rows to `Organization`. The existing `github_org_id` column remains the immutable GitHub account ID for compatibility; new code treats it as the account ID.

A personal workspace is created or reused transactionally from the authenticated GitHub user's immutable ID and current login. Create an owner membership for that user idempotently. Never identify the workspace by mutable login.

### Installation validation

Installation callbacks accept GitHub installation accounts of either type. For an `Organization` installation, the account ID must match the selected workspace's account ID. For a `User` installation, the account ID must match the selected personal workspace's account ID and the workspace discriminator must be `User`. Any mismatch returns `wrong_github_account` and leaves setup state and repository data unchanged.

The existing private/internal repository requirement remains. Repository synchronization, explicit approval, webhook reconciliation, scheduling, dashboard queries, and onboarding all continue to use the workspace UUID, so downstream tenant isolation is unchanged.

### API and UI

The GitHub installation request accepts a workspace UUID. Personal workspace creation/upsert happens before the installation state is created. The organization picker exposes personal workspaces using the existing workspace summary shape; no secret or installation credential is returned. Existing organization installation and management behavior remains unchanged.

### Migration

Add an idempotent `github_account_type` column and check constraint. Backfill all existing rows to `Organization`. Add composite/uniqueness safeguards so one GitHub account cannot be represented by conflicting workspaces. Update test fakes and fixtures to carry the discriminator.

### Errors and security

Use `wrong_github_account` for account-type or immutable-ID mismatch. Do not fall back to login comparison. Do not bind an installation to an arbitrary workspace based only on the callback account. Personal workspaces inherit the same membership, repository approval, webhook signature, and scheduler authorization checks as organization workspaces.

## Verification

- Schema migration backfills existing organizations.
- Personal workspace upsert is idempotent and creates owner membership.
- Matching personal installation succeeds.
- Personal account installed into an organization workspace is rejected.
- Organization account installed into a personal workspace is rejected.
- Existing organization installation succeeds.
- Private/internal repository approval and workflow webhook routing remain unchanged.
- Typecheck, full tests, and build pass.

## Scope boundary

This change does not implement the separate GitHub Actions guest-runner/JIT execution bridge. It only makes personal-account repositories valid tenants for the existing Mars control-plane flow.
