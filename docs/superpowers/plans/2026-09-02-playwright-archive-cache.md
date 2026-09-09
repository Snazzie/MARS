# Playwright Archive Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the worker-local runner cache to cache immutable Playwright browser and tool archives through the existing authenticated HTTPS CONNECT proxy.

**Architecture:** Generalize the package cache's host/key/eligibility logic from npm-only tarballs to a small allowlist of package and Playwright download hosts. Preserve the existing SQLite object store and fill lifecycle, but forward each eligible request to its original upstream host. Add the Playwright hosts to TLS interception and dispatch, then verify behavior at both the cache unit and authenticated proxy boundaries.

**Tech Stack:** Bun, TypeScript, Node HTTP/HTTPS/net, Bun SQLite, Bun test, existing worker certificate authority.

## Global Constraints

- Cache only anonymous immutable archive `GET` requests.
- Supported Playwright hosts are `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`.
- Supported Playwright paths are `/builds/.../*.zip` and `/dbazure/download/playwright/builds/.../*.zip`.
- Reject query strings, fragments, `Authorization`, `Cookie`, and `Range` headers.
- Publish only status-200 responses without `Set-Cookie`; validate `Content-Length` against captured bytes.
- Include normalized host and pathname in canonical cache keys.
- Preserve runner-cache enable/disable, TTL, size cap, purge fencing, telemetry, and Actions-cache isolation.
- Do not change unrelated CONNECT forwarding behavior.

---

### Task 1: Generalize package cache eligibility and forwarding

**Files:**
- Modify: `apps/orchestrator/src/action-cache/package-download-cache.ts`
- Test: `apps/orchestrator/src/action-cache/package-download-cache.test.ts`

**Interfaces:**
- Preserve `PackageDownloadCache` and `PackageUpstreamHandler` signatures.
- Make canonical keys and forwarding use the request's allowlisted host.

- [ ] **Step 1: Add failing unit coverage for Playwright archive requests**

Add a request helper host parameter defaulting to `registry.npmjs.org`, then add tests using `host: "cdn.playwright.dev"` and `host: "playwright.download.prss.microsoft.com"`. Each representative path must produce `MISS`, then `HIT`, with identical bytes and one upstream call. Include a fallback path under `/dbazure/download/playwright/builds/.../*.zip`.

Also add bypass cases for `/builds/.../metadata.json`, a `.zip?download=1` URL, an `Authorization` header, and a `Range` header. Assert those responses never receive `x-mars-package-cache` and reach upstream each time.

- [ ] **Step 2: Run the focused unit test and verify it fails**

Run:

```bash
bun test apps/orchestrator/src/action-cache/package-download-cache.test.ts
```

Expected: new Playwright requests bypass the cache because current host and path validation only accepts npm tarballs.

- [ ] **Step 3: Implement host-aware canonicalization**

Replace the single `PACKAGE_HOST` eligibility check with an allowlist covering npm and both Playwright hosts. Return a canonical URL containing the normalized allowlisted host and pathname. Keep npm's immutable tarball expression. Accept Playwright only when the path matches either `/builds/.../*.zip` or `/dbazure/download/playwright/builds/.../*.zip`; require a non-empty build path and a `.zip` suffix.

- [ ] **Step 4: Implement host-preserving upstream forwarding**

Change forwarding to derive the upstream hostname from the canonical/request host rather than forcing `registry.npmjs.org`. Preserve the original request path and safe forwarded headers. Keep the existing host header normalization and hop-by-hop filtering.

- [ ] **Step 5: Run the focused unit test and verify it passes**

Run:

```bash
bun test apps/orchestrator/src/action-cache/package-download-cache.test.ts
```

Expected: npm behavior remains green; all Playwright archive MISS→HIT and bypass cases pass.

- [ ] **Step 6: Commit the cache-layer change**

```bash
git add apps/orchestrator/src/action-cache/package-download-cache.ts apps/orchestrator/src/action-cache/package-download-cache.test.ts
git commit -m "feat: cache Playwright archives"
```

---

### Task 2: Intercept Playwright hosts through the worker proxy

**Files:**
- Modify: `apps/orchestrator/src/action-cache/service.ts`
- Test: `apps/orchestrator/src/action-cache/service.test.ts`

**Interfaces:**
- Preserve `startActionCacheService` and `ActionCacheService` public APIs.
- `INTERCEPTED_TLS_HOSTS` and data-server dispatch must recognize the same hosts as Task 1.

- [ ] **Step 1: Add failing authenticated CONNECT coverage**

Extend the service proxy tests with one request to each Playwright host, using representative Chrome, headless-shell, FFmpeg, and Winldd paths. Configure `forwardPackageRequest` to return deterministic bytes and record the request host/path. Assert the first request is `MISS`, the second is `HIT`, and each host/path is forwarded only once.

Add a test that a non-cacheable Playwright request still reaches the configured upstream handler without a cache header.

- [ ] **Step 2: Run the focused service test and verify it fails**

Run:

```bash
bun test apps/orchestrator/src/action-cache/service.test.ts
```

Expected: Playwright CONNECT requests are not intercepted or are rejected because the TLS host list and data-server dispatch are npm-only.

- [ ] **Step 3: Extend interception and dispatch allowlists**

Define shared service-level constants for `cdn.playwright.dev` and `playwright.download.prss.microsoft.com`. Include them in `INTERCEPTED_TLS_HOSTS`. Route either hostname to `packageDownloadCache.handle`; leave Actions hosts and unknown hosts on their existing paths.

Ensure certificate issuance receives the expanded host list at initial startup and renewal. Do not alter direct forwarding for non-intercepted targets.

- [ ] **Step 4: Run the focused service test and verify it passes**

Run:

```bash
bun test apps/orchestrator/src/action-cache/service.test.ts
```

Expected: authenticated CONNECT reaches both Playwright hosts, cache headers show MISS then HIT, and existing Actions/npm tests remain green.

- [ ] **Step 5: Commit proxy integration changes**

```bash
git add apps/orchestrator/src/action-cache/service.ts apps/orchestrator/src/action-cache/service.test.ts
git commit -m "feat: proxy Playwright download hosts"
```

---

### Task 3: Run contract verification and review the completed diff

**Files:**
- Review: `apps/orchestrator/src/action-cache/package-download-cache.ts`
- Review: `apps/orchestrator/src/action-cache/package-download-cache.test.ts`
- Review: `apps/orchestrator/src/action-cache/service.ts`
- Review: `apps/orchestrator/src/action-cache/service.test.ts`

- [ ] **Step 1: Run all focused action-cache tests**

```bash
bun test apps/orchestrator/src/action-cache/package-download-cache.test.ts apps/orchestrator/src/action-cache/service.test.ts apps/orchestrator/src/action-cache/routes.test.ts apps/orchestrator/src/action-cache/store.test.ts
```

Expected: PASS with no regressions in existing Actions cache, purge, TTL, size-cap, or telemetry behavior.

- [ ] **Step 2: Run type checking for the affected workspace**

```bash
bun run --filter '@mars/orchestrator' typecheck
```

Expected: PASS with no type errors from host-aware forwarding or certificate allowlist changes.

- [ ] **Step 3: Review the diff for scope and safety**

Confirm the diff has no generic host-wide cache fallback, no query/auth/range bypass regression, no change to Actions-cache storage, and no unrelated formatting or refactoring.

- [ ] **Step 4: Commit any final test-only corrections**

```bash
git add apps/orchestrator/src/action-cache
git commit -m "test: verify Playwright archive cache boundaries"
```
