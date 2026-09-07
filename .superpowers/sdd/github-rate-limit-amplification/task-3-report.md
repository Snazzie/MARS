# Task 3 Report — Rate-limit semantics and discovery gating

## Status
Implemented and committed as `43b9c6f` initially; follow-up deadline and response-timing fixes committed after review.

## Changes

- `github-rate-limit.ts`
  - Classifies every HTTP 429 as rate limited.
  - Retains evidence-based 403 handling: zero `x-ratelimit-remaining` or a JSON message containing `rate limit`.
  - Adds `GithubRateLimitError.kind` (`primary` or `secondary`) and preserves installation ID/reset metadata.
  - Uses the primary reset epoch only when remaining is zero, bounded to at least one second in the future; invalid/absent/overflowing reset values fall back to 60 seconds.
  - Uses only non-negative finite `Retry-After` delta-seconds for secondary cooldowns; invalid/absent/overflowing values fall back to 60 seconds.
  - Preserves successful zero-remaining cooldown behavior and installation-keyed isolation.
  - Carries cooldown kind through locally blocked requests and includes `kind` in cooldown logs.

- `job-discovery.ts`
  - Adds optional `installationBlocked` discovery dependency.
  - Queued repository discovery checks the installation gate before creating a GitHub client or invoking token/fetch dependencies.
  - Available repository discovery skips an entire cooling installation group before client/token/REST work.
  - Existing reports, retry persistence, and repository state updates remain unchanged for active/error paths.

- `index.ts`
  - Wires `githubRateLimits.isCoolingDown` into both discovery paths.

- Focused tests cover secondary `Retry-After` precedence, unconditional 429 handling, primary reset bounding/fallback, and queued/available discovery suppression before token or REST calls.

## Verification

Command:

`bun test apps/control-plane/src/github-rate-limit.test.ts apps/control-plane/src/job-discovery.test.ts`

Result: **31 pass, 0 fail, 94 expect() calls** across both focused test files, including regression coverage for unrepresentable numeric `Retry-After` and response-arrival timing.

## Concerns

- No formatter, linter, or project-wide test suite was run, per assignment.
- Unrelated pre-existing web/docs changes were left untouched.

- Follow-up review fix validates computed cooldown timestamps against JavaScript's representable Date range, falling back to 60 seconds instead of throwing for huge finite `Retry-After` values.

- Follow-up review fix samples the clock after the network response arrives, so delayed responses receive the full `Retry-After` interval from response handling time.
