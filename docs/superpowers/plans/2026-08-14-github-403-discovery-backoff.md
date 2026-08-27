# GitHub 403 Discovery Backoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a 24-hour per-repository cooldown after GitHub job discovery receives HTTP 403 and let global administrators queue one repository for an earlier retry from the repository registry.

**Architecture:** Store the last discovery error and next eligible time on `dashboard_repositories`. The scheduler filters future deadlines, records 403 outcomes, and clears state after a successful repository scan. A transactional database operation queues a retry without calling GitHub; the dashboard API exposes that operation and the repository UI renders active, paused, and queued states.

**Tech Stack:** Bun, TypeScript, PostgreSQL through `postgres`, Hono, Zod, React, TanStack Query, Bun Test.

## Global Constraints

- Automatic suppression after `github_403` is exactly 24 hours.
- Force recheck is per repository; there is no workspace-wide bulk action.
- Only global administrators may force a recheck.
- The force-recheck HTTP request returns HTTP 202 and never calls GitHub directly.
- The existing discovery scheduler performs queued work on its next cycle, normally within 30 seconds.
- `github_404` continues to mark a repository unavailable; non-403 failures retain normal-cycle retry behavior.
- Persisted cooldown state survives process restarts; do not add an in-memory cooldown or lock.
- Work directly on `main`, commit each completed task, and push completed changes to `origin/main`.

---

### Task 1: Persist and expose repository discovery state

**Files:**
- Modify: `packages/db/src/schema.ts:58-65`
- Modify: `packages/db/src/schema.test.ts`
- Modify: `packages/contracts/src/dashboard.ts:30`
- Modify: `tests/dashboard-contracts.test.ts:10-18`
- Modify: `packages/db/src/dashboard.ts:54,79`
- Modify: `packages/db/src/dashboard.test.ts`

**Interfaces:**
- Consumes: existing `dashboard_repositories` rows and `RepositorySummary` list endpoints.
- Produces: `RepositorySummary.discoveryState: "active" | "paused" | "queued"` and `RepositorySummary.discoveryRetryAt: string | null` on both organization-scoped and all-workspace repository listings.
- Produces persisted columns `dashboard_repositories.discovery_error text` and `dashboard_repositories.discovery_retry_at timestamptz` for Tasks 2–4.

- [ ] **Step 1: Add failing schema and contract tests**

In `packages/db/src/schema.test.ts`, add:

```ts
test("repository discovery cooldown is durable and nullable for existing rows", () => {
  expect(schemaSql).toContain("ALTER TABLE dashboard_repositories ADD COLUMN IF NOT EXISTS discovery_error text;");
  expect(schemaSql).toContain("ALTER TABLE dashboard_repositories ADD COLUMN IF NOT EXISTS discovery_retry_at timestamptz;");
  expect(schemaSql).not.toContain("discovery_retry_at timestamptz NOT NULL");
});
```

Update the repository fixture in `tests/dashboard-contracts.test.ts` so the valid value contains:

```ts
const repository = {
  id: "repo-1",
  organizationId: "org-1",
  name: "app",
  fullName: "acme/app",
  visibility: "private",
  available: true,
  installationId: "inst-1",
  discoveryState: "active" as const,
  discoveryRetryAt: null,
};
```

Add assertions that `paused` with an ISO timestamp and `queued` parse, while an unknown state does not:

```ts
expect(RepositorySummary.safeParse({
  ...repository,
  discoveryState: "paused",
  discoveryRetryAt: "2026-08-15T12:00:00.000Z",
}).success).toBe(true);
expect(RepositorySummary.safeParse({ ...repository, discoveryState: "queued" }).success).toBe(true);
expect(RepositorySummary.safeParse({ ...repository, discoveryState: "blocked" }).success).toBe(false);
```

- [ ] **Step 2: Run schema and contract tests to verify RED**

Run:

```bash
bun test packages/db/src/schema.test.ts tests/dashboard-contracts.test.ts
```

Expected: FAIL because the migration columns and `RepositorySummary` fields do not exist.

- [ ] **Step 3: Add a failing repository-list normalization test**

In `packages/db/src/dashboard.test.ts`, import `RepositorySummary` and add a table-driven test using a fake SQL function that returns three rows. Use valid UUIDs for DTO IDs.

```ts
test("repository listings derive active paused and queued discovery states", async () => {
  const future = new Date("2026-08-15T12:00:00.000Z");
  const past = new Date("2026-08-14T12:00:00.000Z");
  const rows = [
    { id: crypto.randomUUID(), organizationId: crypto.randomUUID(), name: "active", fullName: "acme/active", visibility: "public", available: true, installationId: crypto.randomUUID(), discoveryState: "active", discoveryRetryAt: null },
    { id: crypto.randomUUID(), organizationId: crypto.randomUUID(), name: "paused", fullName: "acme/paused", visibility: "private", available: true, installationId: crypto.randomUUID(), discoveryState: "paused", discoveryRetryAt: future },
    { id: crypto.randomUUID(), organizationId: crypto.randomUUID(), name: "queued", fullName: "acme/queued", visibility: "internal", available: true, installationId: crypto.randomUUID(), discoveryState: "queued", discoveryRetryAt: past },
  ];
  const db = (async () => rows) as never;

  const scoped = await listRepositories(db, rows[0].organizationId);
  const all = await listAllRepositories(db, "user-1");

  expect(scoped.items.map((item) => RepositorySummary.parse(item).discoveryState)).toEqual(["active", "paused", "queued"]);
  expect(all.items[1]?.discoveryRetryAt).toBe(future.toISOString());
});
```

- [ ] **Step 4: Run the repository-list test to verify RED**

Run:

```bash
bun test packages/db/src/dashboard.test.ts --test-name-pattern "repository listings derive"
```

Expected: FAIL because list results do not normalize the new timestamp and current SQL does not select the fields.

- [ ] **Step 5: Implement the migration and DTO**

Append after the existing repository column migrations in `packages/db/src/schema.ts`:

```sql
ALTER TABLE dashboard_repositories ADD COLUMN IF NOT EXISTS discovery_error text;
ALTER TABLE dashboard_repositories ADD COLUMN IF NOT EXISTS discovery_retry_at timestamptz;
```

Extend `RepositorySummary` in `packages/contracts/src/dashboard.ts`:

```ts
export const RepositorySummary = dto(strict({
  id,
  organizationId,
  name: z.string().min(1),
  fullName: z.string().min(1),
  visibility: z.enum(["private", "internal", "public"]),
  available: z.boolean(),
  installationId: id,
  discoveryState: z.enum(["active", "paused", "queued"]),
  discoveryRetryAt: timestamp.nullable(),
}));
```

- [ ] **Step 6: Select and normalize discovery state in both repository listings**

In `packages/db/src/dashboard.ts`, add:

```ts
function normalizeRepository(row: Record<string, unknown>): RepositorySummary {
  return {
    ...row,
    discoveryRetryAt: normalizeTimestamp(row.discoveryRetryAt),
  } as RepositorySummary;
}
```

Change both repository queries to select:

```sql
CASE
  WHEN r.discovery_error='github_403' AND r.discovery_retry_at>now() THEN 'paused'
  WHEN r.discovery_error='github_403' AND r.discovery_retry_at<=now() THEN 'queued'
  ELSE 'active'
END AS "discoveryState",
r.discovery_retry_at AS "discoveryRetryAt"
```

Use `db<Record<string, unknown>[]>`, map `rows.slice(0, limit)` through `normalizeRepository`, and derive `nextCursor` from the normalized items. Apply the same shape to `listRepositories()` and `listAllRepositories()`; do not create a second normalization path.

Update every existing `RepositorySummary` fixture reported by typecheck so it explicitly supplies `discoveryState: "active"` and `discoveryRetryAt: null`.

- [ ] **Step 7: Run Task 1 tests and typecheck**

Run:

```bash
bun test packages/db/src/schema.test.ts packages/db/src/dashboard.test.ts tests/dashboard-contracts.test.ts
bun run --filter @mars/contracts typecheck
bun run --filter @mars/db typecheck
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit and push Task 1**

```bash
git add packages/db/src/schema.ts packages/db/src/schema.test.ts packages/contracts/src/dashboard.ts tests/dashboard-contracts.test.ts packages/db/src/dashboard.ts packages/db/src/dashboard.test.ts
git commit -m "feat: expose repository discovery state"
git push origin main
```

---

### Task 2: Apply durable 403 cooldowns in discovery

**Files:**
- Modify: `apps/control-plane/src/job-discovery.ts:81-90`
- Modify: `apps/control-plane/src/job-discovery.test.ts:56-112`

**Interfaces:**
- Consumes: `dashboard_repositories.discovery_error` and `discovery_retry_at` from Task 1.
- Produces: automatic selection predicate `(repo.discovery_retry_at IS NULL OR repo.discovery_retry_at<=now())`.
- Produces outcome transitions: 403 → future 24-hour deadline; success → cleared cooldown; 404 and other failures unchanged.

- [ ] **Step 1: Strengthen the selection test**

Extend `"discovers every available repository on an active installation"` in `job-discovery.test.ts`:

```ts
expect(selection).toContain("repo.discovery_retry_at IS NULL OR repo.discovery_retry_at<=now()");
```

Keep the existing availability and approved-installation assertions.

- [ ] **Step 2: Add a failing 403 persistence test**

```ts
test("pauses a repository for 24 hours after GitHub 403", async () => {
  let selected = false;
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    queries.push(query);
    if (!selected && query.includes("FROM dashboard_repositories repo")) {
      selected = true;
      return [{ ...repository, discoveryError: null, discoveryRetryAt: null }];
    }
    return [];
  }) as never;

  const report = await discoverAvailableRepositoryJobs({
    db,
    installationToken: async () => "token",
    githubFetch: async () => new Response(null, { status: 403 }),
  });

  expect(report).toMatchObject({ repositories: 1, failed: 1 });
  expect(queries.some((query) =>
    query.includes("discovery_error='github_403'") && query.includes("interval '24 hours'")
  )).toBe(true);
});
```

- [ ] **Step 3: Add failing success-clears-state and non-403 tests**

Create a successful queued-repository test. Return empty GitHub pages with the payload shape expected by `GithubJobsClient`:

```ts
const emptyGithub = async (input: RequestInfo | URL) =>
  String(input).includes("/jobs")
    ? Response.json({ total_count: 0, jobs: [] })
    : Response.json({ total_count: 0, workflow_runs: [] });
```

The fake repository row must contain `discoveryError: "github_403"` and a past `discoveryRetryAt`. Assert a query clears both columns:

```ts
expect(queries.some((query) =>
  query.includes("SET discovery_error=NULL,discovery_retry_at=NULL")
)).toBe(true);
```

Split the existing `[403, 429, 500]` table: retain one table for `429` and `500`, and assert those statuses neither retire the repository nor update `discovery_error`. The dedicated 403 test owns cooldown behavior.

- [ ] **Step 4: Run discovery tests to verify RED**

Run:

```bash
bun test apps/control-plane/src/job-discovery.test.ts
```

Expected: the new selection, cooldown, and clear-state assertions fail.

- [ ] **Step 5: Implement selection and state transitions**

Add `repo.discovery_error AS "discoveryError"` and `repo.discovery_retry_at AS "discoveryRetryAt"` to both discovery SELECT lists. Add this predicate to both the filtered and unfiltered queries:

```sql
AND (repo.discovery_retry_at IS NULL OR repo.discovery_retry_at<=now())
```

Expand the worker loop rather than retaining it as one line. After `discoverRepository()` succeeds, clear state only if the selected row carried prior state:

```ts
const row = rows[index] as Record<string, unknown>;
try {
  const value = await discoverRepository(deps, row);
  report.discovered += value.discovered;
  report.updated += value.updated;
  if (row.discoveryError != null || row.discoveryRetryAt != null) {
    await deps.db`
      UPDATE dashboard_repositories
      SET discovery_error=NULL,discovery_retry_at=NULL
      WHERE id=${String(row.repositoryId)}
        AND (discovery_error IS NOT NULL OR discovery_retry_at IS NOT NULL)
    `;
  }
} catch (error) {
  const code = error instanceof Error ? error.message : "unknown";
  if (code === "github_404") {
    await deps.db`UPDATE dashboard_repositories SET available=false WHERE id=${String(row.repositoryId)}`;
    continue;
  }
  if (code === "github_403") {
    await deps.db`
      UPDATE dashboard_repositories
      SET discovery_error='github_403',discovery_retry_at=now()+interval '24 hours'
      WHERE id=${String(row.repositoryId)}
    `;
  }
  report.failed += 1;
  console.error(`GitHub job discovery failed for ${String(row.fullName)}: ${code}`);
}
```

Do not write cooldown state for 429, 500, malformed payloads, or installation-token failures.

- [ ] **Step 6: Run discovery tests and control-plane typecheck**

Run:

```bash
bun test apps/control-plane/src/job-discovery.test.ts apps/control-plane/src/discovery-health.test.ts
bun run --filter @mars/control-plane typecheck
```

Expected: all commands exit 0. Existing discovery health semantics remain green because future-deadline rows are absent from the report.

- [ ] **Step 7: Commit and push Task 2**

```bash
git add apps/control-plane/src/job-discovery.ts apps/control-plane/src/job-discovery.test.ts
git commit -m "feat: back off GitHub 403 discovery"
git push origin main
```

---

### Task 3: Add the transactional force-recheck API

**Files:**
- Modify: `packages/db/src/dashboard.ts`
- Modify: `packages/db/src/dashboard.test.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts:1-45`
- Modify: `apps/control-plane/src/dashboard-api.test.ts`

**Interfaces:**
- Produces: `queueRepositoryDiscoveryRecheck(db, organizationId, repositoryId, idempotencyKey): Promise<"queued" | "not_found" | "not_paused">` from `@mars/db`.
- Produces: `POST /api/organizations/:organizationId/repositories/:repositoryId/discovery/recheck` → HTTP 202 `{ queued: true }`.
- Consumes: approved, available repository rows with `discovery_error='github_403'` and `discovery_retry_at>now()`.

- [ ] **Step 1: Add failing transactional database tests**

In `packages/db/src/dashboard.test.ts`, import `queueRepositoryDiscoveryRecheck`. Build a stateful fake SQL object whose `begin` calls the callback with the same function. Track `paused`, mutation keys, and update count.

Cover these observable cases:

```ts
test("queues one paused repository and converges an idempotent replay", async () => {
  const state = makeDiscoveryRecheckDb({ paused: true });
  expect(await queueRepositoryDiscoveryRecheck(state.db, ORG_ID, REPO_ID, "retry-1")).toBe("queued");
  expect(await queueRepositoryDiscoveryRecheck(state.db, ORG_ID, REPO_ID, "retry-1")).toBe("queued");
  expect(state.updates).toBe(1);
  expect(state.keys).toEqual(new Set([`repository-discovery-recheck:${REPO_ID}:retry-1`]));
});

test("rejects active and missing repositories without consuming the key", async () => {
  const active = makeDiscoveryRecheckDb({ paused: false });
  expect(await queueRepositoryDiscoveryRecheck(active.db, ORG_ID, REPO_ID, "retry-active")).toBe("not_paused");
  expect(active.keys.size).toBe(0);

  const missing = makeDiscoveryRecheckDb({ missing: true });
  expect(await queueRepositoryDiscoveryRecheck(missing.db, ORG_ID, REPO_ID, "retry-missing")).toBe("not_found");
  expect(missing.keys.size).toBe(0);
});
```

The fake must return a prior mutation only for `SELECT ... FROM dashboard_mutations`, return `{ paused: true|false }` for the repository `SELECT ... FOR UPDATE`, record the insert key, and increment `updates` for `SET discovery_retry_at=now()`.

- [ ] **Step 2: Run the database test to verify RED**

Run:

```bash
bun test packages/db/src/dashboard.test.ts --test-name-pattern "repository|paused"
```

Expected: FAIL because `queueRepositoryDiscoveryRecheck` is not exported.

- [ ] **Step 3: Implement the transactional queue operation**

Add to `packages/db/src/dashboard.ts`:

```ts
export type QueueRepositoryDiscoveryRecheckResult = "queued" | "not_found" | "not_paused";

export async function queueRepositoryDiscoveryRecheck(
  db: DashboardDb,
  organizationId: string,
  repositoryId: string,
  idempotencyKey: string,
): Promise<QueueRepositoryDiscoveryRecheckResult> {
  const mutationKey = `repository-discovery-recheck:${repositoryId}:${idempotencyKey}`;
  return db.begin(async (tx) => {
    const [prior] = await tx`
      SELECT 1 FROM dashboard_mutations
      WHERE organization_id=${organizationId} AND idempotency_key=${mutationKey}
    `;
    if (prior) return "queued";

    const [repository] = await tx`
      SELECT r.discovery_error='github_403' AND r.discovery_retry_at>now() AS paused
      FROM dashboard_repositories r
      JOIN dashboard_installations i
        ON i.id=r.installation_id AND i.organization_id=r.organization_id
      WHERE r.organization_id=${organizationId} AND r.id=${repositoryId}
        AND r.available=true AND i.state='approved'
      FOR UPDATE OF r
    `;
    if (!repository) return "not_found";
    if (repository.paused !== true) return "not_paused";

    const inserted = await tx`
      INSERT INTO dashboard_mutations (organization_id,idempotency_key)
      VALUES (${organizationId},${mutationKey})
      ON CONFLICT DO NOTHING RETURNING idempotency_key
    `;
    if (!inserted.length) return "queued";

    await tx`
      UPDATE dashboard_repositories SET discovery_retry_at=now()
      WHERE organization_id=${organizationId} AND id=${repositoryId}
    `;
    return "queued";
  });
}
```

If the PostgreSQL client returns the boolean under a different representation in tests, normalize only that driver representation; do not accept truthy strings such as `"false"`.

- [ ] **Step 4: Add failing HTTP authorization and status tests**

In `apps/control-plane/src/dashboard-api.test.ts`, add a `discoveryRecheckDb()` fake with a working `begin` method and test:

```ts
const path = `/api/organizations/${ORG_ID}/repositories/${REPO_ID}/discovery/recheck`;
const headers = { ...sessionHeaders, "Idempotency-Key": "recheck-1" };

expect((await appFor(member, db).request(path, { method: "POST", headers })).status).toBe(403);
expect((await appFor(admin, db).request(path, { method: "POST", headers: sessionHeaders })).status).toBe(400);

const accepted = await appFor(admin, db).request(path, { method: "POST", headers });
expect(accepted.status).toBe(202);
expect(await accepted.json()).toEqual({ queued: true });
```

Add separate fakes/assertions for `not_found` → 404 and `not_paused` → 409. Assert that the accepted path writes `discovery_retry_at=now()` and never invokes a GitHub service dependency.

- [ ] **Step 5: Run HTTP tests to verify RED**

Run:

```bash
bun test apps/control-plane/src/dashboard-api.test.ts --test-name-pattern "discovery recheck"
```

Expected: FAIL with 404 because the route is not registered.

- [ ] **Step 6: Register the route**

Import `queueRepositoryDiscoveryRecheck` in `dashboard-routes.ts` and add the route before the generic repository workflow routes:

```ts
app.post("/api/organizations/:organizationId/repositories/:repositoryId/discovery/recheck", safe(async (c) => {
  const org = c.req.param("organizationId");
  const denied = await guard(c, deps, org);
  if (denied) return denied;
  if (!c.get("user").isGlobalAdmin) {
    return error(c, 403, "forbidden", "Global administrator authorization required");
  }
  const idem = requireMutation(c);
  if (idem) return idem;

  const result = await queueRepositoryDiscoveryRecheck(
    deps.db,
    org,
    c.req.param("repositoryId"),
    c.req.header("idempotency-key")!.trim(),
  );
  if (result === "not_found") return error(c, 404, "not_found", "Resource not found");
  if (result === "not_paused") {
    return error(c, 409, "repository_discovery_not_paused", "Repository discovery is not paused");
  }
  await invalidateDashboard(deps.db, org, ["repositories"]);
  return c.json({ queued: true }, 202);
}));
```

Do not add `githubApp` or discovery scheduler dependencies to the route.

- [ ] **Step 7: Run Task 3 tests and typechecks**

Run:

```bash
bun test packages/db/src/dashboard.test.ts apps/control-plane/src/dashboard-api.test.ts apps/control-plane/src/http/app.test.ts
bun run --filter @mars/db typecheck
bun run --filter @mars/control-plane typecheck
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit and push Task 3**

```bash
git add packages/db/src/dashboard.ts packages/db/src/dashboard.test.ts apps/control-plane/src/http/dashboard-routes.ts apps/control-plane/src/dashboard-api.test.ts
git commit -m "feat: queue repository discovery rechecks"
git push origin main
```

---

### Task 4: Add per-repository force recheck controls

**Files:**
- Modify: `apps/web/src/api.ts:70-84,195-212`
- Modify: `apps/web/src/routes/RepositoriesPage.tsx`
- Modify: `apps/web/src/routes/RepositoriesPage.test.tsx`
- Modify: `apps/web/src/styles.css` near repository table styles

**Interfaces:**
- Consumes: `RepositorySummary.discoveryState`, `discoveryRetryAt`, and the Task 3 endpoint.
- Produces: `recheckRepositoryDiscovery(organizationId: string, repositoryId: string): Promise<{ queued: true }>`.
- Produces a global-admin-only **Recheck now** action for paused and queued repository rows.

- [ ] **Step 1: Add failing UI tests for paused, queued, and member states**

Refactor the test helper in `RepositoriesPage.test.tsx` to accept `isGlobalAdmin` and repository overrides. Seed the shared `me` query because `AppShell` and the page use the same key:

```ts
function markup({
  isGlobalAdmin = true,
  discoveryState = "paused",
  discoveryRetryAt = "2026-08-15T12:00:00.000Z",
}: {
  isGlobalAdmin?: boolean;
  discoveryState?: "active" | "paused" | "queued";
  discoveryRetryAt?: string | null;
} = {}) {
  const client = new QueryClient();
  client.setQueryData(["me"], { id: "user-1", githubUserId: 1, login: "admin", isGlobalAdmin });
  // Preserve the existing organizations and repositories query setup.
  // Set every repository fixture's discoveryState and discoveryRetryAt explicitly.
  return renderToStaticMarkup(
    <QueryClientProvider client={client}><RepositoriesPage /></QueryClientProvider>,
  );
}
```

Add assertions:

```ts
test("global admins can queue a paused repository recheck", () => {
  const html = markup();
  expect(html).toContain("Discovery paused until");
  expect(html).toContain(">Recheck now<");
  expect(html.match(/<button[^>]*>Recheck now<\/button>/)?.[0]).not.toContain("disabled");
});

test("queued repository rechecks cannot be submitted repeatedly", () => {
  const html = markup({ discoveryState: "queued", discoveryRetryAt: "2026-08-14T12:00:00.000Z" });
  expect(html).toContain("Recheck queued");
  expect(html.match(/<button[^>]*>Recheck now<\/button>/)?.[0]).toContain("disabled");
});

test("workspace members see the pause without an administrator action", () => {
  const html = markup({ isGlobalAdmin: false });
  expect(html).toContain("Discovery paused until");
  expect(html).not.toContain(">Recheck now<");
});
```

- [ ] **Step 2: Run the UI tests to verify RED**

Run:

```bash
bun test apps/web/src/routes/RepositoriesPage.test.tsx
```

Expected: FAIL because discovery state and the action are not rendered.

- [ ] **Step 3: Type the current-user response and add the API mutation**

Replace `z.unknown()` in `apps/web/src/api.ts` with:

```ts
const meResponse = z.object({
  id: z.string(),
  githubUserId: z.number().int(),
  login: z.string().min(1),
  isGlobalAdmin: z.boolean(),
});
```

Add:

```ts
export function recheckRepositoryDiscovery(organizationId: string, repositoryId: string) {
  return request(
    `/api/organizations/${organizationId}/repositories/${repositoryId}/discovery/recheck`,
    z.object({ queued: z.literal(true) }),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: "{}",
    },
  );
}
```

- [ ] **Step 4: Render discovery state and wire the mutation**

In `RepositoriesPage.tsx`, import `getMe` and `recheckRepositoryDiscovery`. Read the cached current user with the same query key as `AppShell`:

```ts
const me = useQuery({ queryKey: ["me"], queryFn: getMe });
const recheckDiscovery = useMutation({
  mutationFn: (repository: RepositorySummary) =>
    recheckRepositoryDiscovery(repository.organizationId, repository.id),
  onSuccess: () => client.invalidateQueries({ queryKey: ["org", organizationId, "repositories"] }),
});
```

Include `recheckDiscovery.error` in `updateError`.

In the Access cell, preserve the installation availability badge and add:

```tsx
{repository.discoveryState === "paused" && (
  <small className="repository-discovery repository-discovery-paused">
    Discovery paused until {new Date(repository.discoveryRetryAt!).toLocaleString()}
  </small>
)}
{repository.discoveryState === "queued" && (
  <small className="repository-discovery">Recheck queued</small>
)}
```

In the action group, render for global admins whenever the repository is not active:

```tsx
{me.data?.isGlobalAdmin && repository.discoveryState !== "active" && (
  <button
    type="button"
    className="control-button control-button-secondary"
    onClick={() => recheckDiscovery.mutate(repository)}
    disabled={repository.discoveryState === "queued" || recheckDiscovery.isPending}
  >
    Recheck now
  </button>
)}
```

Do not show a bulk action in the page header. Do not change GitHub installation availability or workflow setup buttons.

- [ ] **Step 5: Add compact repository discovery styling**

Near existing repository table styles in `apps/web/src/styles.css`, add:

```css
.repository-discovery {
  display: block;
  margin-top: 6px;
  color: var(--muted);
}
.repository-discovery-paused {
  color: var(--rust);
}
```

Reuse current table/action responsive behavior; do not widen the mobile table minimum width.

- [ ] **Step 6: Run Task 4 tests and web typecheck**

Run:

```bash
bun test apps/web/src/routes/RepositoriesPage.test.tsx tests/dashboard-contracts.test.ts
bun run --filter @mars/web typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit and push Task 4**

```bash
git add apps/web/src/api.ts apps/web/src/routes/RepositoriesPage.tsx apps/web/src/routes/RepositoriesPage.test.tsx apps/web/src/styles.css
git commit -m "feat: recheck paused repository discovery"
git push origin main
```

---

## Final Verification

- [ ] Run the focused regression suite:

```bash
bun test packages/db/src/schema.test.ts packages/db/src/dashboard.test.ts tests/dashboard-contracts.test.ts apps/control-plane/src/job-discovery.test.ts apps/control-plane/src/discovery-health.test.ts apps/control-plane/src/dashboard-api.test.ts apps/control-plane/src/http/app.test.ts apps/web/src/routes/RepositoriesPage.test.tsx
```

Expected: zero failures.

- [ ] Run workspace static verification:

```bash
bun run typecheck
bun run build
git diff --check
```

Expected: all commands exit 0. The existing Bun CSS parser may continue to report the repository's known `@property` warnings; no new warning class is acceptable.

- [ ] Exercise the real application surface:

1. Start the existing development stack with `bun run dev --kill`.
2. In PostgreSQL, set one available repository to `discovery_error='github_403'` and `discovery_retry_at=now()+interval '24 hours'`.
3. Open `/repositories` as a global administrator and select that repository's workspace.
4. Verify the row shows `Discovery paused until …` and an enabled **Recheck now** button.
5. Begin a network wait for the repository recheck endpoint, click **Recheck now**, and verify HTTP 202 with `{ "queued": true }`.
6. Verify the refreshed row shows `Recheck queued` and the button is disabled.
7. Allow one scheduler cycle. Verify the row becomes active after a successful GitHub scan or receives a new deadline approximately 24 hours in the future after another 403.
8. Capture an accessibility-tree snapshot and desktop screenshot proving the final state.
9. Restore only the temporary repository cooldown fields if the live GitHub result did not already clear them; do not alter availability or installation state.

- [ ] Confirm the working tree is clean and every task commit is present on `origin/main`:

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: no modified files and no unpushed commits.
