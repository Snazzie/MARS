# TanStack Form Migration Implementation Plan

## Inputs

- Design: `docs/superpowers/specs/2026-08-12-tanstack-form-design.md`
- Existing form components and API modules under `apps/web/src` and `apps/control-plane/src`
- Existing Zod contracts under `packages/contracts/src`

## Phase 1: Dependency and shared form foundation

1. Add `@tanstack/react-form` to `apps/web/package.json`; install and update the lockfile.
2. Create a shared form module under `apps/web/src/forms/` using `createFormHook` and the documented field/form contexts.
3. Implement typed reusable controls: text, integer/number, select, checkbox group, field error, form error, submit button, and first-invalid focus behavior.
4. Add helpers for Standard Schema/Zod validation, server error normalization, and identity-based reset semantics.
5. Add component-level tests for blur/submit validation, dirty state, first-error focus, server errors, and pending submit state.

## Phase 2: Worker and organization settings

1. Migrate `WorkerConfigurationForm` to the shared form hook.
2. Preserve existing UI-to-transport conversion and validate safe GiB-to-byte conversion, positive integers, appliance ceilings, and concurrency capacity.
3. Keep existing TanStack Query mutation, idempotency key, `202` response, revision acknowledgement, and invalidation behavior.
4. Migrate `OrganizationSettings` to the shared form hook while preserving its API payload and cache invalidation.
5. Add focused tests for payload mapping, boundary failures, server errors, and retry behavior.

## Phase 3: Onboarding GitHub forms

1. Migrate GitHub organization selection to TanStack Form while leaving repository search/filter controls local state.
2. Migrate repository approval selection to a checkbox-group field.
3. Enforce required private/internal selection in field/form validation; preserve server rejection for public, unavailable, suspended, cross-organization, and pending records.
4. Preserve installation/repository recovery, idempotency, route redirects, and server-derived onboarding progression.
5. Add tests for empty selection, valid private selection, unavailable history, reset on organization identity change, and mutation failures.

## Phase 4: Pool and trigger-label forms

1. Migrate pool creation and trigger-label configuration to the shared form hook.
2. Reuse canonical Zod schemas for pool/resource/label validation and map UI values before API validation.
3. Preserve server-derived effective labels and `runs-on` output; do not duplicate scheduling logic.
4. Add tests for reserved/duplicate labels, invalid image digest, resource boundaries, cross-field errors, and successful payload mapping.

## Phase 5: Verification and cleanup

1. Run focused web tests for all migrated forms.
2. Run workspace typecheck and build.
3. Start the control plane and exercise each migrated form in a browser: worker resources, GitHub organization/repository approval, pool/trigger labels, and organization settings.
4. Confirm no accidental duplicate mutations, no console errors, correct first-error focus, preserved onboarding progression, and preserved API payloads.
5. Run the full test suite and record results.
6. Remove obsolete manual parsing/error-state code and update any affected component documentation.

## Acceptance criteria

- All four named form areas use the shared TanStack Form hook.
- Existing API routes and payload contracts remain unchanged.
- Blur/submit validation, first-invalid focus, dirty/reset semantics, form-level server errors, and pending state work in browser verification.
- Resource and repository safety constraints remain enforced.
- Tests, typecheck, build, and browser smoke verification pass.
