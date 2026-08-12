# Shared Fleet and Repository Table Design

## Goal

Make Whitesmith accurately represent workers and runner pools as control-plane-wide shared capacity, while redesigning `/repositories` as a clean, fast-scanning GitHub access table.

## Ownership model

- Workers enroll once to the control plane, not to an organization or repository.
- Runner pools are control-plane/account-scoped and can serve all connected organizations and approved repositories.
- Organizations and repositories remain GitHub tenancy/access records.
- Repository approval determines whether a repository may schedule work; pool labels determine which shared capacity can execute it.
- Worker enrollment, worker configuration, pool creation, pool mutations, worker/pool reads, and scheduler candidate selection must not require or infer an organization owner.
- Existing organization-bound worker/pool rows are migrated to shared scope. Existing pool identity conflicts are surfaced for administrator resolution; migration must not silently rename or merge pools.
- Onboarding may select a GitHub organization/repository set, but that selection must not bind the selected worker or pool to that organization.

## Repository page

`/repositories` is a GitHub access registry, not a runner-capacity page.

Use a dense responsive table with columns:

1. Repository — full name and compact organization context.
2. Visibility — private, internal, or public.
3. Access — available/unavailable from the GitHub installation.
4. Whitesmith approval — approved or pending.
5. Actions — approve/reject, manage GitHub access, and installation management where applicable.

Behavior:

- Search filters by full repository name.
- Visibility filter supports all/private/internal; public rows remain visible when returned so their rejection state is explicit.
- All-workspaces mode displays repositories across connected organizations without implying shared workers belong to any row.
- Empty, loading, and error states use the existing `QueryState` pattern.
- A compact shared-fleet context panel links to Workers and Pools and says that approved repositories use shared control-plane runner capacity.
- Destructive or unavailable actions remain disabled with accessible labels and visible status text.
- Preserve idempotency and existing GitHub access APIs.

## Backend boundaries

- Make `workers.organization_id` and `runner_pools.organization_id` nullable legacy metadata, set both to `NULL` for migrated shared resources, and stop using either field for authorization or scheduling. Keep the columns temporarily for audit/history compatibility; new enrollment and pool creation write `NULL`.
- Replace organization-scoped pool/worker APIs with control-plane-scoped equivalents or the existing `all` fleet route; do not retain parallel authorization paths.
- Remove organization predicates from runner pool and worker ownership queries. Authorization is global-admin/control-plane authorization for fleet mutations, while repository APIs retain organization membership checks.
- Pool summaries no longer expose an organization owner. Worker summaries expose nullable/no owner semantics consistently.
- Scheduling matches approved repository access and requested labels against shared pools. It must never filter candidates by repository organization.
- Audit events may retain the affected organization for repository/GitHub events, but pool and worker events use control-plane scope.
- Update onboarding/resource configuration so the worker is selected and configured globally; GitHub organization binding remains only for access setup.

## Migration

- Add a migration that makes worker/pool organization ownership nullable, records the old organization ID in the migration audit payload, and clears ownership for existing workers/pools.
- Before clearing ownership, detect duplicate pool names or trigger labels. Keep conflicting pools disabled and return their IDs/names from the fleet status endpoint for administrator resolution; do not silently rename, merge, or delete them.
- Add partial unique indexes for enabled shared pools on `name` and non-null `trigger_label`; disabled conflicts may coexist until resolved.
- Update worker/pool foreign-key and query joins so a pool’s worker is joined by `worker_id` only.
- Do not use organization IDs for shared worker/pool authorization or scheduling after migration.
- Update the approved onboarding plan and relevant contracts/tests to remove organization-owned worker/pool assumptions.

## Verification

- Contract tests reject organization ownership fields on shared worker/pool DTOs where the new contract removes them.
- Database tests prove worker/pool listings and mutations work across organizations and scheduling sees shared candidates.
- Repository UI tests prove the table renders organization context only as GitHub metadata, exposes status/action columns, and does not render runner ownership.
- Browser smoke test at `/repositories` confirms table layout, filters, shared-fleet context, and no console errors.
- Full workspace typecheck, tests, and build pass.
