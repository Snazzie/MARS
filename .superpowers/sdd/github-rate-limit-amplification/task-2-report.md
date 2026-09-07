# Task 2 — Installation token reuse

## Status

Implemented and committed as part of Task 2.

## Files changed

- `apps/control-plane/src/github-app.ts`
  - Added a private memory-only token cache keyed by installation ID.
  - Added a private per-installation in-flight promise map for single-flight access-token acquisition.
  - `getInstallationToken(installationId: number): Promise<string>` retains its public signature.
  - Reuses cached tokens only when the parsed `expires_at` is more than five minutes in the future.
  - Refreshes near-expiry tokens, requires a non-empty token and valid future `expires_at`, and stores the parsed expiry.
  - Clears the in-flight promise in `finally`; failed requests are not cached and can be retried.
  - Keeps credentials isolated between installation IDs and does not log token values.

- `apps/control-plane/src/github-app.test.ts`
  - Added focused coverage for sequential cache reuse, concurrent single-flight acquisition, five-minute refresh behavior, failed-acquisition retry, installation isolation, and invalid token metadata.
  - Updated existing access-token fixtures to include GitHub's required future `expires_at` field.

## Verification

Command:

```text
bun test apps/control-plane/src/github-app.test.ts
```

Output:

```text
bun test v1.4.0 (34cbb9a40)

 40 pass
 0 fail
 124 expect() calls
Ran 40 tests across 1 file. [101.00ms]
```

## Concerns

- The cache is intentionally process-local and memory-only; tokens are reacquired after process restart.
- Per the Task 2 scope, only the focused `github-app.test.ts` suite was run; formatters, linters, typechecks, and project-wide suites were not run.
