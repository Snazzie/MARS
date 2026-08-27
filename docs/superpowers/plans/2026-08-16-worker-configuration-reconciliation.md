# Worker Configuration Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the control plane reapply durable desired configuration after every worker reconnect and make the Workers page report success only after an exact live acknowledgement.

**Architecture:** Store the full desired `WorkerConfiguration` on the worker row instead of relying on retained commands. Authentication reconciles that desired state into one replayable `worker.configure` command and moves the worker through `applying`; an exact observation records the applied revision and timestamp and restores `ready`. Dashboard contracts expose that lifecycle, and scheduling requires both `ready` and equal desired/applied revisions.

**Tech Stack:** Bun 1.2.20, TypeScript, PostgreSQL, Zod contracts, Hono, React 19, TanStack Query, Bun test.

## Global Constraints

- The control plane is authoritative for desired worker configuration.
- Configuration success means an exact worker acknowledgement; command creation or delivery is not success.
- Every authenticated worker connection must reapply desired configuration before scheduling resumes.
- `commands` is a delivery ledger, not the durable source of desired configuration.
- Duplicate reconnects reuse one pending command for the current revision.
- A worker is schedulable only when `configuration_state='ready'` and desired/applied revisions are equal.
- Preserve the last successful applied revision and timestamp while a replacement is applying or has failed.
- Keep operational connection state separate from configuration state.
- Do not add a second configuration transport or worker-local persistence mechanism.

---

### Task 1: Persist and expose desired/applied configuration state

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/schema.test.ts`
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `packages/db/src/dashboard.ts`
- Modify: `packages/db/src/dashboard.test.ts`
- Modify: `tests/dashboard-contracts.test.ts`

**Interfaces:**
- Produces: `ConfigurationState = "unconfigured" | "applying" | "ready" | "error"`.
- Produces: `WorkerDetail.configurationRevision: string | null`.
- Produces: `WorkerDetail.appliedConfigurationRevision: string | null`.
- Produces: `WorkerDetail.configurationAppliedAt: string | null`.
- Persists: `workers.desired_configuration jsonb`, `workers.applied_configuration_revision text`, and `workers.configuration_applied_at timestamptz`.

- [ ] **Step 1: Write failing schema and contract tests**

Add schema assertions to `packages/db/src/schema.test.ts`:

```ts
test("persists desired and exactly applied worker configuration", () => {
  expect(schemaSql).toContain("ALTER TABLE workers ADD COLUMN IF NOT EXISTS desired_configuration jsonb;");
  expect(schemaSql).toContain("ALTER TABLE workers ADD COLUMN IF NOT EXISTS applied_configuration_revision text;");
  expect(schemaSql).toContain("ALTER TABLE workers ADD COLUMN IF NOT EXISTS configuration_applied_at timestamptz;");
  expect(schemaSql).toContain("FROM commands c");
  expect(schemaSql).toContain("c.id=w.configuration_command_id");
});
```

Extend `tests/dashboard-contracts.test.ts` with a `WorkerDetail.parse` fixture containing:

```ts
configurationState: "applying",
configurationRevision: "a".repeat(64),
appliedConfigurationRevision: "b".repeat(64),
configurationAppliedAt: "2026-08-16T15:00:00.000Z",
```

Add a dashboard projection assertion to `packages/db/src/dashboard.test.ts` that verifies worker list SQL selects all three camel-cased fields.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
bun test packages/db/src/schema.test.ts packages/db/src/dashboard.test.ts tests/dashboard-contracts.test.ts
```

Expected: failures because the columns, `applying` enum value, and `WorkerDetail` properties do not exist.

- [ ] **Step 3: Add durable columns and a safe legacy backfill**

In `schemaSql`, add:

```sql
ALTER TABLE workers ADD COLUMN IF NOT EXISTS desired_configuration jsonb;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS applied_configuration_revision text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS configuration_applied_at timestamptz;
UPDATE workers w
SET desired_configuration=jsonb_build_object(
  'appliance',c.payload->'appliance',
  'runtime',c.payload->'runtime',
  'guestPlatforms',c.payload->'guestPlatforms'
)
FROM commands c
WHERE w.desired_configuration IS NULL
  AND c.id=w.configuration_command_id
  AND c.type='worker.configure'
  AND c.payload ? 'appliance'
  AND c.payload ? 'runtime'
  AND c.payload ? 'guestPlatforms';
UPDATE workers
SET applied_configuration_revision=configuration_revision
WHERE configuration_state='ready'
  AND desired_configuration IS NOT NULL
  AND applied_configuration_revision IS NULL;
```

Do not synthesize `configuration_applied_at` for legacy rows; the next authenticated reconnect supplies the first trustworthy timestamp.

- [ ] **Step 4: Extend contracts and dashboard projections**

Change `ConfigurationState` in `packages/contracts/src/orchestration.ts`:

```ts
export const ConfigurationState = z.enum(["unconfigured", "applying", "ready", "error"]);
```

Extend `WorkerDetail` in `packages/contracts/src/dashboard.ts`:

```ts
configurationRevision: z.string().nullable(),
appliedConfigurationRevision: z.string().nullable(),
configurationAppliedAt: z.string().datetime().nullable(),
```

Select these columns in both `listWorkers` and `listAllWorkers`:

```sql
w.configuration_revision AS "configurationRevision",
w.applied_configuration_revision AS "appliedConfigurationRevision",
w.configuration_applied_at AS "configurationAppliedAt"
```

Normalize a PostgreSQL `Date` to ISO text before `WorkerDetail` parsing:

```ts
const configurationAppliedAt = row.configurationAppliedAt instanceof Date
  ? row.configurationAppliedAt.toISOString()
  : typeof row.configurationAppliedAt === "string" ? row.configurationAppliedAt : null;
```

- [ ] **Step 5: Run focused tests and typechecks**

Run:

```bash
bun test packages/db/src/schema.test.ts packages/db/src/dashboard.test.ts tests/dashboard-contracts.test.ts
bun run --filter '@mars/contracts' typecheck
bun run --filter '@mars/db' typecheck
```

Expected: all commands pass.

- [ ] **Step 6: Commit the persistence contract**

```bash
git add packages/db/src/schema.ts packages/db/src/schema.test.ts packages/contracts/src/orchestration.ts packages/contracts/src/dashboard.ts packages/db/src/dashboard.ts packages/db/src/dashboard.test.ts tests/dashboard-contracts.test.ts
git commit -m "feat: persist applied worker config"
```

---

### Task 2: Make desired configuration authoritative

**Files:**
- Modify: `apps/control-plane/src/worker-requests.ts`
- Modify: `apps/control-plane/src/worker-requests.persistence.test.ts`
- Modify: `apps/control-plane/src/worker-requests.ack.test.ts`

**Interfaces:**
- Consumes: worker columns and `ConfigurationState` from Task 1.
- Produces: `reconcileWorkerConfigurationOnConnect(db: Sql<{}>, workerId: string): Promise<{ state: "unconfigured" | "applying"; commandId: string | null }>`.
- Preserves: `configurePendingWorker(...)` public signature and idempotency response.
- Preserves: `applyWorkerConfigurationAcknowledgement(...) => Promise<boolean>`.

- [ ] **Step 1: Write failing save and acknowledgement tests**

Extend `worker-requests.persistence.test.ts` to capture configuration transaction queries and values:

```ts
test("stores desired configuration and waits for acknowledgement", async () => {
  const queries: string[] = [];
  const values: unknown[][] = [];
  // Use the existing capacity-valid transaction fixture.
  await configurePendingWorker(db, "worker", configuration, "admin");
  const update = queries.findIndex(query => query.includes("update workers set"));
  expect(queries[update]).toContain("desired_configuration=");
  expect(queries[update]).toContain("configuration_state='applying'");
  expect(values[update]).toContainEqual(expect.objectContaining(configuration));
});
```

Extend `worker-requests.ack.test.ts`:

```ts
test("records the exact applied revision and acknowledgement time", async () => {
  const accepted = await applyWorkerConfigurationAcknowledgement(db, exactEvent);
  expect(accepted).toBe(true);
  expect(queries.some(query => query.includes("applied_configuration_revision=configuration_revision"))).toBe(true);
  expect(queries.some(query => query.includes("configuration_applied_at=now()"))).toBe(true);
  expect(queries.some(query => query.includes("worker.configuration_applied"))).toBe(true);
});

test("marks only the current mismatched command as error", async () => {
  const accepted = await applyWorkerConfigurationAcknowledgement(db, mismatchedEvent);
  expect(accepted).toBe(false);
  expect(queries.some(query => query.includes("configuration_state='error'") && query.includes("configuration_command_id="))).toBe(true);
  expect(queries.every(query => !query.includes("configuration_applied_at=now()"))).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
bun test apps/control-plane/src/worker-requests.persistence.test.ts apps/control-plane/src/worker-requests.ack.test.ts
```

Expected: failures because saves still set `unconfigured`, desired state is not stored, and acknowledgements do not record revision/time.

- [ ] **Step 3: Persist desired state during administrator saves**

In `configurePendingWorker`, keep canonical revision generation and set:

```ts
const desired = WorkerConfiguration.parse(parsed);
await tx`
  UPDATE workers
  SET limits=${JSON.stringify(desired.runtime)}::jsonb,
      guest_platforms=${JSON.stringify(desired.guestPlatforms)}::jsonb,
      desired_configuration=${JSON.stringify(desired)}::jsonb,
      admission_state='adopted',
      configuration_state='applying',
      configuration_revision=${revision},
      configuration_command_id=${commandId}
  WHERE id=${workerId}`;
```

The command payload remains:

```ts
const payload = {
  workerId,
  appliance: desired.appliance,
  runtime: desired.runtime,
  guestPlatforms: desired.guestPlatforms,
  revision,
  fingerprint: fp,
};
```

Keep `applied_configuration_revision` and `configuration_applied_at` unchanged until an exact acknowledgement.

- [ ] **Step 4: Validate acknowledgement against desired state**

Load the current desired state with the command identity:

```ts
type WorkerConfigurationRow = {
  configurationRevision: string | null;
  configurationCommandId: string | null;
  desiredConfiguration: unknown;
};
```

Require canonical equality between `observed` and `desired_configuration`, not merely an old retained command payload. On success execute:

```sql
UPDATE workers
SET configuration_state='ready',
    applied_configuration_revision=configuration_revision,
    configuration_applied_at=now()
WHERE id=$workerId
  AND configuration_command_id=$commandId
  AND configuration_revision=$revision
```

Insert:

```sql
INSERT INTO audit_events (actor,type,payload)
VALUES ('worker','worker.configuration_applied',$payload::jsonb)
```

Use payload `{ workerId, commandId, revision }`. On a current-command mismatch, set `configuration_state='error'` without changing the last applied revision/time.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
bun test apps/control-plane/src/worker-requests.persistence.test.ts apps/control-plane/src/worker-requests.ack.test.ts
bun run --filter '@mars/control-plane' typecheck
```

Expected: all commands pass.

- [ ] **Step 6: Commit authoritative desired state**

```bash
git add apps/control-plane/src/worker-requests.ts apps/control-plane/src/worker-requests.persistence.test.ts apps/control-plane/src/worker-requests.ack.test.ts
git commit -m "fix: track live worker config apply"
```

---

### Task 3: Reconcile configuration on authenticated reconnect

**Files:**
- Modify: `apps/control-plane/src/worker-requests.ts`
- Create: `apps/control-plane/src/worker-configuration-reconcile.test.ts`
- Modify: `apps/control-plane/src/index.ts`
- Create: `apps/control-plane/src/worker-connection.ts`
- Create: `apps/control-plane/src/worker-connection.test.ts`
- Modify: `apps/control-plane/src/scheduler.ts`
- Modify: `apps/control-plane/src/scheduler.test.ts`
- Create: `apps/control-plane/src/job-reconciler.test.ts`
- Modify: `apps/control-plane/src/job-reconciler.ts`

**Interfaces:**
- Consumes: `desired_configuration`, desired revision, current command ID, and `WorkerCommandDispatcher.register`.
- Produces: `reconcileWorkerConfigurationOnConnect` from Task 2.
- Scheduling `Candidate.worker` gains `configurationRevision: string | null` and `appliedConfigurationRevision: string | null`.

- [ ] **Step 1: Write failing reconnect reconciliation tests**

Create `worker-configuration-reconcile.test.ts` with transaction fixtures covering these observable queries:

```ts
test("creates one applying command from durable desired state after reconnect", async () => {
  const result = await reconcileWorkerConfigurationOnConnect(db, workerId);
  expect(result).toEqual({ state: "applying", commandId: expect.any(String) });
  expect(queries.some(query => query.includes("for update"))).toBe(true);
  expect(queries.some(query => query.includes("insert into commands") && values.flat().includes("worker.configure"))).toBe(true);
  expect(queries.some(query => query.includes("configuration_state='applying'"))).toBe(true);
});

test("reuses a pending command for the desired revision", async () => {
  const result = await reconcileWorkerConfigurationOnConnect(db, workerId);
  expect(result.commandId).toBe(existingCommandId);
  expect(queries.filter(query => query.includes("insert into commands"))).toHaveLength(0);
});

test("leaves a worker without desired state unconfigured", async () => {
  await expect(reconcileWorkerConfigurationOnConnect(db, workerId))
    .resolves.toEqual({ state: "unconfigured", commandId: null });
});
```

Add scheduler tests:

```ts
test("rejects ready state when applied revision is stale", () => {
  expect(fits(candidate({
    configurationState: "ready",
    configurationRevision: "new",
    appliedConfigurationRevision: "old",
  }))).toBe(false);
  expect(reason(candidate({
    configurationState: "ready",
    configurationRevision: "new",
    appliedConfigurationRevision: "old",
  }))).toBe("worker_config_applying");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
bun test apps/control-plane/src/worker-configuration-reconcile.test.ts apps/control-plane/src/worker-connection.test.ts apps/control-plane/src/scheduler.test.ts apps/control-plane/src/job-reconciler.test.ts
```

Expected: failures because reconnect reconciliation and revision-aware scheduling do not exist.

- [ ] **Step 3: Implement idempotent reconnect reconciliation**

Add the exported function to `worker-requests.ts`. Inside one transaction:

```ts
const [worker] = await tx`
  SELECT desired_configuration AS "desiredConfiguration",
         configuration_revision AS "configurationRevision",
         configuration_command_id AS "configurationCommandId"
  FROM workers
  WHERE id=${workerId}
  FOR UPDATE`;
```

If desired state is absent, set `unconfigured` and return `{ state: "unconfigured", commandId: null }`.

For an existing command, reuse it only when its state is `pending` or `sent`, its type is `worker.configure`, and its payload revision equals the current desired revision. Otherwise create a new UUID command using the desired configuration and derived fingerprint:

```ts
const fingerprint = createHash("sha256").update(`${workerId}:${revision}`).digest("hex");
const payload = { workerId, ...desired, revision, fingerprint };
```

Update the worker to `applying` with the reused or new command ID. Return the selected command ID after commit.

- [ ] **Step 4: Reconcile before registering the authenticated socket**

Extract the post-signature connection transition into `worker-connection.ts`:

```ts
export async function activateAuthenticatedWorkerConnection(input: {
  db: DatabaseClient;
  workerId: string;
  socket: AuthenticatedWorkerSocket;
  dispatcher: WorkerCommandDispatcher;
  workerSockets: Map<string, AuthenticatedWorkerSocket>;
  markAuthenticated(): void;
}): Promise<void>
```

The function must await `reconcileWorkerConfigurationOnConnect`, update the database connection state, invoke `markAuthenticated`, install the socket in `workerSockets`, and only then call `dispatcher.register`. In `index.ts`, call this function after signature and encryption-key verification.

Create `worker-connection.test.ts` with fakes that append `reconcile`, `online`, `authenticated`, and `register` to an array. Assert the exact order and assert that a reconciliation rejection leaves the socket unregistered. This proves behavior without inspecting source text and prevents configuration delivery before authentication succeeds.

- [ ] **Step 5: Enforce desired/applied revision equality in scheduling**

Extend `Candidate.worker` and `fits`:

```ts
const configured = candidate.worker.configurationState === "ready"
  && candidate.worker.configurationRevision !== null
  && candidate.worker.configurationRevision === candidate.worker.appliedConfigurationRevision;
if (!configured) return false;
```

Return `worker_config_applying` from `reason` when state is `applying` or revisions differ. Select and map both revision columns in `job-reconciler.ts`.

- [ ] **Step 6: Run reconnect, scheduler, and control-plane tests**

Run:

```bash
bun test apps/control-plane/src/worker-configuration-reconcile.test.ts apps/control-plane/src/worker-connection.test.ts apps/control-plane/src/worker-requests.ack.test.ts apps/control-plane/src/scheduler.test.ts apps/control-plane/src/job-reconciler.test.ts
bun run --filter '@mars/control-plane' typecheck
```

Expected: all commands pass.

- [ ] **Step 7: Commit reconnect reconciliation**

```bash
git add apps/control-plane/src/worker-requests.ts apps/control-plane/src/worker-configuration-reconcile.test.ts apps/control-plane/src/worker-connection.ts apps/control-plane/src/worker-connection.test.ts apps/control-plane/src/index.ts apps/control-plane/src/scheduler.ts apps/control-plane/src/scheduler.test.ts apps/control-plane/src/job-reconciler.ts apps/control-plane/src/job-reconciler.test.ts
git commit -m "fix: reapply config on worker reconnect"
```

---

### Task 4: Report applying and acknowledged states in the Workers UI

**Files:**
- Modify: `apps/web/src/components/WorkerCard.tsx`
- Modify: `apps/web/src/components/WorkerCard.test.tsx`
- Modify: `apps/web/src/routes/WorkersPage.tsx`
- Modify: `apps/web/src/routes/WorkersPage.test.tsx`
- Modify: `apps/web/src/components/PendingWorkerRequests.test.tsx`

**Interfaces:**
- Consumes: Task 1 `WorkerDetail` fields and four-state configuration lifecycle.
- Produces: `workerReadinessLabel(state)` returning `Ready | Applying configuration | Needs configuration | Error`.
- Produces: `shouldPollWorkerConfiguration(items: WorkerDetail[]): boolean`.

- [ ] **Step 1: Write failing UI behavior tests**

Extend `WorkerCard.test.tsx`:

```ts
expect(workerReadinessLabel("applying")).toBe("Applying configuration");

test("reports success only with an acknowledgement timestamp", () => {
  const markup = renderToStaticMarkup(<WorkerCard worker={{
    ...worker,
    configurationState: "ready",
    configurationRevision: "a".repeat(64),
    appliedConfigurationRevision: "a".repeat(64),
    configurationAppliedAt: "2026-08-16T15:00:00.000Z",
  }} organizationId="all" onChange={() => {}} />);
  expect(markup).toContain("Configuration updated");
  expect(markup).toContain('dateTime="2026-08-16T15:00:00.000Z"');
});

test("shows applying without claiming success", () => {
  const markup = renderToStaticMarkup(<WorkerCard worker={{
    ...worker,
    configurationState: "applying",
    appliedConfigurationRevision: null,
    configurationAppliedAt: null,
  }} organizationId="all" onChange={() => {}} />);
  expect(markup).toContain("Applying configuration");
  expect(markup).not.toContain("Configuration updated");
});
```

Export and test `shouldPollWorkerConfiguration` in `WorkersPage.test.tsx`:

```ts
expect(shouldPollWorkerConfiguration([{ ...worker, configurationState: "applying" }])).toBe(true);
expect(shouldPollWorkerConfiguration([{ ...worker, configurationState: "ready" }])).toBe(false);
```

Update existing worker fixtures with nullable revision/timestamp fields.

- [ ] **Step 2: Run UI tests and verify failure**

Run:

```bash
bun test apps/web/src/components/WorkerCard.test.tsx apps/web/src/routes/WorkersPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx
```

Expected: failures because `applying` has no label, timestamps are absent, and polling still keys off `unconfigured`.

- [ ] **Step 3: Render truthful configuration lifecycle copy**

Implement:

```ts
export function workerReadinessLabel(state: WorkerDetail["configurationState"]):
  "Ready" | "Applying configuration" | "Needs configuration" | "Error" {
  if (state === "ready") return "Ready";
  if (state === "applying") return "Applying configuration";
  if (state === "error") return "Error";
  return "Needs configuration";
}
```

Render these state details:

```tsx
{worker.configurationState === "applying" &&
  <p className="pending-note" role="status">Applying configuration…</p>}
{worker.configurationState === "ready" && worker.configurationAppliedAt &&
  <p className="configuration-success" role="status">
    Configuration updated <time dateTime={worker.configurationAppliedAt}>
      {new Date(worker.configurationAppliedAt).toLocaleString()}
    </time>
  </p>}
{worker.configurationState === "error" &&
  <p className="form-error" role="alert">Configuration update failed.</p>}
```

When an error retains a prior timestamp, add `Last successfully updated` with the same semantic `<time>` element. Keep online/offline status separate.

- [ ] **Step 4: Poll only while application is pending**

Add:

```ts
export function shouldPollWorkerConfiguration(items: WorkerDetail[] | undefined): boolean {
  return items?.some(worker =>
    worker.admissionState === "adopted" && worker.configurationState === "applying"
  ) ?? false;
}
```

Use it in the query:

```ts
refetchInterval: current => shouldPollWorkerConfiguration(current.state.data?.items) ? 2_000 : false,
```

Keep the existing post-save invalidation so the first `applying` response starts polling. Do not show a toast or copy that claims the mutation response applied the configuration.

- [ ] **Step 5: Run UI tests, typecheck, and build**

Run:

```bash
bun test apps/web/src/components/WorkerCard.test.tsx apps/web/src/routes/WorkersPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx
bun run --filter '@mars/web' typecheck
bun run --filter '@mars/web' build
```

Expected: all commands pass.

- [ ] **Step 6: Commit truthful UI status**

```bash
git add apps/web/src/components/WorkerCard.tsx apps/web/src/components/WorkerCard.test.tsx apps/web/src/routes/WorkersPage.tsx apps/web/src/routes/WorkersPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx
git commit -m "feat: show applied worker config state"
```

---

### Task 5: Verify restart-to-lease behavior end to end

**Files:**
- Modify only if the focused tests expose a missing contract in files already named above.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: release evidence that a restarted worker reapplies 10-vCPU/10-GiB limits before accepting a matching lease.

- [ ] **Step 1: Run the complete focused worker suite**

Run:

```bash
bun test packages/db/src/schema.test.ts packages/db/src/dashboard.test.ts tests/dashboard-contracts.test.ts apps/control-plane/src/worker-requests.test.ts apps/control-plane/src/worker-requests.persistence.test.ts apps/control-plane/src/worker-requests.ack.test.ts apps/control-plane/src/worker-configuration-reconcile.test.ts apps/control-plane/src/worker-connection.test.ts apps/control-plane/src/scheduler.test.ts apps/control-plane/src/job-reconciler.test.ts apps/orchestrator/src/windows-agent.test.ts apps/orchestrator/src/mac-agent.test.ts apps/web/src/components/WorkerCard.test.tsx apps/web/src/routes/WorkersPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx
```

Expected: all tests pass.

- [ ] **Step 2: Run affected package typechecks and frontend build**

Run:

```bash
bun run --filter '@mars/contracts' typecheck
bun run --filter '@mars/db' typecheck
bun run --filter '@mars/control-plane' typecheck
bun run --filter '@mars/orchestrator' typecheck
bun run --filter '@mars/web' typecheck
bun run --filter '@mars/web' build
```

Expected: all commands pass.

- [ ] **Step 3: Smoke the actual Windows worker restart path**

With the local worker configured for 10 vCPU, 10 GiB memory, 30 GiB storage, and concurrency 3:

1. Record the Workers page showing `Configuration updated` and its acknowledgement time.
2. Restart the `MarsWorker` Windows service.
3. Observe the control-plane row change to `applying` and one current-revision `worker.configure` command enter `pending` or `sent`.
4. Observe the exact acknowledgement change the row to `ready`, make desired/applied revisions equal, and advance `configuration_applied_at` beyond the process restart time.
5. Browser-drive `/workers` and verify `Applying configuration…` transitions to `Configuration updated` with the new timestamp, with no uncaught console error or failed same-origin request.
6. Dispatch or rerun a workflow requesting `mars-windows-x64`, `10VCPU`, and `10G`; verify the lease advances beyond `reserved`, an ephemeral GitHub runner becomes online, and the worker log does not contain `resource ceiling exceeded` for that lease.

- [ ] **Step 4: Check the final diff and commit any verification-driven correction**

Run:

```bash
git diff --check
```

Expected: no whitespace errors. If Step 3 required a source correction, rerun the exact failing test and smoke path, then commit only that correction with a focused `fix:` message. Do not create an empty verification commit.

- [ ] **Step 5: Push completed commits to main**

```bash
git push origin main
```

Expected: `main` on `origin` contains every implementation commit and the restart smoke remains successful.
