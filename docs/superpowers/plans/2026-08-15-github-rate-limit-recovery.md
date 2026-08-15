# GitHub Rate-Limit Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop GitHub discovery and JIT reconciliation from exhausting installation API quotas, then resume queued Windows Actions automatically after GitHub's reset time.

**Architecture:** A process-wide `GithubRateLimitGate` wraps every installation-scoped GitHub Jobs fetch and records cooldowns from response headers. Discovery executes repositories sequentially within each installation, while reconciliation attempts at most one admissible job per installation per tick.

**Tech Stack:** Bun 1.3, TypeScript, Bun test, GitHub REST API, PostgreSQL

## Global Constraints

- Rate-limit state is keyed by GitHub installation ID.
- Tokens, JIT configuration, and GitHub response bodies must never be logged or persisted.
- A rate-limit `403` must remain distinct from a permission `403`.
- Separate installations must continue independently.
- Existing non-rate-limit error behavior remains unchanged.
- Work directly on `main`; push completed changes to `main`.

---

### Task 1: Add the installation rate-limit gate

**Files:**
- Create: `apps/control-plane/src/github-rate-limit.ts`
- Create: `apps/control-plane/src/github-rate-limit.test.ts`

**Interfaces:**
- Produces: `GithubRateLimitError` with `code = "github_rate_limited"`, `installationId`, and `resetAt`.
- Produces: `isGithubRateLimitError(value: unknown): value is GithubRateLimitError`.
- Produces: `GithubRateLimitGate.scopedFetch(installationId: number, fetcher?: typeof fetch): typeof fetch`.

- [ ] **Step 1: Write failing gate tests**

Cover these observable cases with a fake clock and counting fetcher:

```ts
const gate = new GithubRateLimitGate({ now: () => now });
const fetcher = gate.scopedFetch(42, async () => new Response(
  JSON.stringify({ message: "API rate limit exceeded" }),
  { status: 403, headers: { "content-type": "application/json", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1776223272" } },
));
await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ code: "github_rate_limited", installationId: 42 });
await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ code: "github_rate_limited" });
expect(networkCalls).toBe(1);
```

Also assert that installation 43 still calls the network, a successful zero-remaining response opens cooldown only after returning that response, permission `403` without rate-limit evidence remains a normal response, and advancing `now` to `resetAt` permits a probe.

- [ ] **Step 2: Run the gate test and verify failure**

Run: `bun test apps/control-plane/src/github-rate-limit.test.ts`
Expected: FAIL because `github-rate-limit.ts` does not exist.

- [ ] **Step 3: Implement the gate**

Implement a map of `installationId -> resetAtMs`. Before a request, throw the stored error when `now() < resetAtMs`; delete expired cooldowns before probing. After each response, parse finite non-negative `x-ratelimit-remaining` and `x-ratelimit-reset` values. For a `403` or `429`, classify rate limiting when remaining is zero or a cloned JSON response has a string `message` containing `rate limit` case-insensitively. Store `Math.max(parsedReset, now() + 1_000)` and throw `GithubRateLimitError`. For a successful response with remaining zero, store the reset but return the response. Log only installation ID and ISO reset time on cooldown entry and recovery.

- [ ] **Step 4: Run focused tests**

Run: `bun test apps/control-plane/src/github-rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/github-rate-limit.ts apps/control-plane/src/github-rate-limit.test.ts
git commit -m "feat: gate GitHub installation rate limits"
```

---

### Task 2: Bound reconciliation by installation

**Files:**
- Modify: `apps/control-plane/src/reconcile.ts`
- Modify: `apps/control-plane/src/reconcile.test.ts`
- Modify: `apps/control-plane/src/job-reconciler.ts`
- Modify: `apps/control-plane/src/runs.test.ts`

**Interfaces:**
- Changes `ReconcileDeps.jit` input to include `installationId: number`.
- Changes `JobReconciliationDeps` to consume `githubFetchForInstallation: (installationId: number) => Fetcher`.

- [ ] **Step 1: Write failing reconciliation tests**

Add a test with two admissible jobs for installation 42 and one for installation 43. Assert one JIT call for 42, one for 43, and that the second job for 42 is counted as skipped. Add a rate-limit case where installation 42 throws `GithubRateLimitError`; assert its later job is not reserved and installation 43 still runs.

- [ ] **Step 2: Run the reconciliation tests and verify failure**

Run: `bun test apps/control-plane/src/reconcile.test.ts apps/control-plane/src/runs.test.ts`
Expected: FAIL because reconciliation currently attempts every queued job.

- [ ] **Step 3: Implement bounded reconciliation**

In `reconcileQueuedJobs`, maintain `attemptedInstallations: Set<number>`. Skip an installation after its first admissible reservation/JIT attempt in the current invocation. Pass `queued.installationId` into `deps.jit`. In `job-reconciler.ts`, construct `GithubJobsClient` with `deps.githubFetchForInstallation(installationId)` and migrate all test callsites.

- [ ] **Step 4: Run focused tests**

Run: `bun test apps/control-plane/src/reconcile.test.ts apps/control-plane/src/runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/reconcile.ts apps/control-plane/src/reconcile.test.ts apps/control-plane/src/job-reconciler.ts apps/control-plane/src/runs.test.ts
git commit -m "fix: bound JIT attempts per installation"
```

---

### Task 3: Share the gate with discovery and startup

**Files:**
- Modify: `apps/control-plane/src/job-discovery.ts`
- Modify: `apps/control-plane/src/job-discovery.test.ts`
- Modify: `apps/control-plane/src/index.ts`

**Interfaces:**
- Changes `DiscoveryDeps` to consume `githubFetchForInstallation: (installationId: number) => Fetcher`.
- Consumes `GithubRateLimitGate.scopedFetch` from Task 1.

- [ ] **Step 1: Write failing discovery tests**

Use two repositories on installation 42 and one on installation 43. Make installation 42's first request throw `GithubRateLimitError`. Assert its second repository performs no request, receives no `discovery_error='github_403'` update, and installation 43 still completes. Preserve the existing test proving a permission `403` receives the 24-hour repository retry.

- [ ] **Step 2: Run discovery tests and verify failure**

Run: `bun test apps/control-plane/src/job-discovery.test.ts`
Expected: FAIL because repository workers do not coordinate per installation.

- [ ] **Step 3: Implement installation-grouped discovery**

Group selected repository rows by numeric installation ID. Process repositories sequentially inside each group and process at most four installation groups concurrently. Break only the affected group on `GithubRateLimitError`; increment `failed` for the interrupted repository without persisting a permission cooldown. Use `githubFetchForInstallation(installationId)` for each group's `GithubJobsClient`.

Create one `GithubRateLimitGate` in `index.ts`. Pass `installationId => gate.scopedFetch(installationId)` to both `discoverAvailableRepositoryJobs` and `runQueuedJobReconciliation`. Remove the obsolete unscoped fetch plumbing and migrate tests.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun test apps/control-plane/src/github-rate-limit.test.ts apps/control-plane/src/github-jobs.test.ts apps/control-plane/src/reconcile.test.ts apps/control-plane/src/runs.test.ts apps/control-plane/src/job-discovery.test.ts && bun run --filter @whitesmith/control-plane typecheck`
Expected: PASS.

- [ ] **Step 5: Run the live recovery scenario**

Restart `whitesmith-bun-dev`. Confirm logs show one JIT attempt per installation per tick, no repeated network calls during an active cooldown, and automatic recovery after GitHub's reset time. Confirm the `whitesmith-windows-x64` workflow leaves GitHub's queued state or produces a single actionable non-rate-limit failure.

- [ ] **Step 6: Commit and push**

```bash
git add apps/control-plane/src/job-discovery.ts apps/control-plane/src/job-discovery.test.ts apps/control-plane/src/index.ts
git commit -m "fix: coordinate GitHub rate-limit recovery"
git push origin main
```
