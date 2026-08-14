# Inline Worker Enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace modal enrollment everywhere with one inline panel and make onboarding reliably show, identify, and explicitly select a connected worker.

**Architecture:** `EnrollmentPanel` owns bootstrap-code lifecycle and receives pending-worker state from its page owner. Onboarding and Workers each own one `pendingWorkerQueryOptions()` query, pass its data into the panel, and render worker choices from the same query. Enrollment success is correlated against a pre-generation connection snapshot rather than any online worker.

**Tech Stack:** React 19, TypeScript, TanStack Query, Zod-backed API client, Bun tests, Vite.

## Global Constraints

- Remove the modal implementation globally; do not retain an inline/modal mode.
- Keep explicit **Use this worker** selection after connection.
- Do not report worker completion unless `OnboardingDetail.worker` is non-null.
- Display actionable API errors and Retry without discarding previously loaded workers.
- Recognize only a new online worker or an offline-to-online transition after code generation.
- Reuse one pending-worker query per page; do not add panel-owned polling.

---

### Task 1: Inline enrollment panel

**Files:**
- Rename: `apps/web/src/components/EnrollmentWizard.tsx` → `apps/web/src/components/EnrollmentPanel.tsx`
- Rename: `apps/web/src/components/EnrollmentWizard.test.ts` → `apps/web/src/components/EnrollmentPanel.test.ts`

**Interfaces:**
- Consumes: `getWorkerBootstrapStatus`, `getWorkerControlPlaneUrls`, `initializeWorkerBootstrap`, `rotateWorkerBootstrap`; pending workers shaped as `{ id: string; connectionState?: string }`.
- Produces: `EnrollmentPanel({ workers, onConnected, showRotation? })`; `connectionSnapshot(workers)`; `connectedEnrollmentWorker(snapshot, workers)`; existing `buildInstallerCommand`, `buildInstallerCommands`, and `normalizeControlPlaneUrls` exports.

- [ ] **Step 1: Rename the component and test files with symbol-aware import updates**

Use LSP `rename_file` for both files and LSP `rename` for `EnrollmentWizard` → `EnrollmentPanel`. Confirm all imports in `OnboardingPage.tsx` and `WorkersPage.tsx` point to `EnrollmentPanel.tsx`.

- [ ] **Step 2: Write failing connection-correlation tests**

Add tests equivalent to:

```ts
const before = connectionSnapshot([
  { id: "existing-online", connectionState: "online" },
  { id: "existing-offline", connectionState: "offline" },
]);
expect(connectedEnrollmentWorker(before, [
  { id: "existing-online", connectionState: "online" },
  { id: "existing-offline", connectionState: "online" },
])).toBe("existing-offline");
expect(connectedEnrollmentWorker(before, [
  { id: "existing-online", connectionState: "online" },
  { id: "existing-offline", connectionState: "offline" },
  { id: "new-worker", connectionState: "online" },
])).toBe("new-worker");
expect(connectedEnrollmentWorker(before, [
  { id: "existing-online", connectionState: "online" },
])).toBeNull();
```

Also remove the old `openEnrollmentDialog` and `shouldCloseEnrollmentDialog` tests.

- [ ] **Step 3: Run the focused tests and confirm red**

Run: `bun test apps/web/src/components/EnrollmentPanel.test.ts`

Expected: FAIL because the snapshot helpers and inline panel contract do not exist.

- [ ] **Step 4: Implement snapshot helpers**

Use exact data contracts:

```ts
type WorkerConnection = { id: string; connectionState?: string };
export type WorkerConnectionSnapshot = Record<string, string | undefined>;
export function connectionSnapshot(workers: readonly WorkerConnection[]): WorkerConnectionSnapshot;
export function connectedEnrollmentWorker(snapshot: WorkerConnectionSnapshot, workers: readonly WorkerConnection[]): string | null;
```

`connectedEnrollmentWorker` must ignore workers already online in the snapshot and return only a newly online ID or an offline-to-online transition.

- [ ] **Step 5: Write failing inline-state component assertions**

Update component/source assertions to require:

```ts
expect(source).not.toContain("<dialog");
expect(source).not.toContain("showModal");
expect(source).toContain("Worker connected");
expect(source).toContain("Enroll another worker");
```

Keep installer command, platform, HTTP opt-in, and URL-normalization tests unchanged.

- [ ] **Step 6: Implement `EnrollmentPanel`**

Use props:

```ts
type EnrollmentPanelProps = {
  workers: readonly { id: string; connectionState?: string }[];
  onConnected: (workerId: string) => void;
  showRotation?: boolean;
};
```

On mount, load bootstrap status and control-plane URLs. Render platform and URL fields directly in `<section className="enrollment-panel">`. On code creation, snapshot `workers` before awaiting initialize/rotate. While `reveal` exists, render the selected installer command. In an effect over `workers`, resolve `connectedEnrollmentWorker`; on success set `connectedWorkerId`, hide the command, show **Worker connected**, and call `onConnected` once. **Enroll another worker** clears reveal/success/snapshot and returns to controls. Preserve explicit rotation confirmation when `showRotation` is true.

- [ ] **Step 7: Run the panel tests green**

Run: `bun test apps/web/src/components/EnrollmentPanel.test.ts`

Expected: all command-generation, correlation, and no-dialog assertions pass.

- [ ] **Step 8: Commit the panel cutover**

```bash
git add -A apps/web/src/components apps/web/src/routes/OnboardingPage.tsx apps/web/src/routes/WorkersPage.tsx
git commit -m "feat: render worker enrollment inline"
```

---

### Task 2: Reliable onboarding Worker step

**Files:**
- Modify: `apps/web/src/routes/OnboardingPage.tsx`
- Modify: `apps/web/src/routes/OnboardingPage.test.tsx`

**Interfaces:**
- Consumes: `EnrollmentPanel`, `pendingWorkerQueryOptions()`, and pending worker DTOs returned by `getPendingWorkerRequests`.
- Produces: one Worker-step query shared by panel connection detection and explicit worker cards; truthful review summary.

- [ ] **Step 1: Add failing onboarding tests**

Add/adjust static and source-level assertions for these contracts:

```ts
expect(workerStepHtml).toContain("Worker enrollment");
expect(workerStepHtml).not.toContain("<dialog");
expect(workerStepHtml).toContain("Use this worker");
expect(unselectedReviewHtml).not.toContain("Worker: Selected");
expect(selectedReviewHtml).toContain("Worker: linux-builder");
```

Add a source assertion that the Worker-step error renders `q.error instanceof Error ? q.error.message` and a Retry button invoking `q.refetch()`.

- [ ] **Step 2: Run the onboarding test red**

Run: `bun test apps/web/src/routes/OnboardingPage.test.tsx`

Expected: FAIL because the false `Selected` fallback, generic load error, and modal-oriented component remain.

- [ ] **Step 3: Refactor `WorkerStep` around one query**

Use `useQuery(pendingWorkerQueryOptions())`. Pass `(q.data ?? [])` to `EnrollmentPanel`; `onConnected` calls `q.refetch()`. Render the pending cards from the same `q.data`. Preserve **Use this worker** as the only call to `onSelect`.

If `q.error` exists, render its actual message when it is an `Error`, otherwise `Could not load workers.`, plus:

```tsx
<button type="button" onClick={() => void q.refetch()}>Retry</button>
```

Continue rendering cached `q.data` when present.

- [ ] **Step 4: Make completed review server-truthful**

In `ReviewSummary`, render the worker completion paragraph only when both `through >= 1` and `detail.worker` is non-null. Use `detail.worker.name ?? detail.worker.vmUuid`; remove the `"Selected"` fallback completely.

- [ ] **Step 5: Run onboarding tests green**

Run: `bun test apps/web/src/routes/OnboardingPage.test.tsx`

Expected: worker controls inline, explicit selection present, real error/Retry contract present, unselected review absent, selected review accurate.

- [ ] **Step 6: Commit the onboarding fix**

```bash
git add apps/web/src/routes/OnboardingPage.tsx apps/web/src/routes/OnboardingPage.test.tsx
git commit -m "fix: make worker onboarding state truthful"
```

---

### Task 3: Shared Workers-page query and inline styling

**Files:**
- Modify: `apps/web/src/routes/WorkersPage.tsx`
- Modify: `apps/web/src/routes/WorkersPage.test.tsx`
- Modify: `apps/web/src/components/PendingWorkerRequests.tsx`
- Modify: `apps/web/src/components/PendingWorkerRequests.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `EnrollmentPanel`, `pendingWorkerQueryOptions()`, and pending-query state owned by `WorkersPage`.
- Produces: `PendingWorkerRequests({ organizationId, workers, error, isLoading, retry })` with no internal pending-worker query.

- [ ] **Step 1: Add failing Workers-page placement and ownership tests**

Assert the rendered page contains inline enrollment outside the header dialog path and that selected-workspace behavior still hides global approval cards. Add source assertions that `WorkersPage` calls `useQuery(pendingWorkerQueryOptions())` and passes that query to both panel and pending list, while `PendingWorkerRequests.tsx` no longer calls `useQuery`.

- [ ] **Step 2: Run Workers and pending-list tests red**

Run: `bun test apps/web/src/routes/WorkersPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx`

Expected: FAIL because `PendingWorkerRequests` still owns its query and enrollment is still header/modal-oriented.

- [ ] **Step 3: Lift pending query ownership into `WorkersPage`**

Create `const pendingQuery = useQuery(pendingWorkerQueryOptions())`. Render the page header first, then `EnrollmentPanel`, then—only for `organizationId === "all"`—`PendingWorkerRequests`. Pass pending workers to the panel everywhere so additional enrollment correlation works in selected workspaces.

`onConnected` invalidates `pending-workers` and the organization worker query. Do not remove the existing active-worker query or revoked toggle.

- [ ] **Step 4: Convert `PendingWorkerRequests` to a pure query-state consumer**

Use props:

```ts
type Props = {
  organizationId: string;
  workers: readonly PendingRequest[];
  error: Error | null;
  isLoading: boolean;
  retry: () => void;
};
```

Retain rejection/configuration mutations and organization-worker invalidation. Remove its `useQuery` import and internal pending query. Preserve unauthorized/403 states using the supplied error.

- [ ] **Step 5: Replace modal styles with inline panel styles**

Remove `.enrollment-dialog` selectors and add `.enrollment-panel` styling consistent with existing `.onboarding-card`, `.list-panel`, inputs, command blocks, status, error, and responsive rules. The panel must participate in normal document flow and use no fixed positioning/backdrop.

- [ ] **Step 6: Run focused web tests and typecheck**

Run:

```bash
bun test apps/web/src/components/EnrollmentPanel.test.ts apps/web/src/routes/OnboardingPage.test.tsx apps/web/src/routes/WorkersPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx
bun run --filter @whitesmith/web typecheck
```

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 7: Browser-verify the real flow**

On `http://localhost:5173/onboarding`, verify:

1. Worker enrollment is inline and no modal opens.
2. Generate/reveal shows one command.
3. An already-online unrelated worker does not complete a new attempt.
4. A newly connected worker replaces the command with **Worker connected**.
5. The worker card remains and requires **Use this worker**.
6. Selecting it advances to the next server-owned onboarding step.
7. Before selection, the completed summary does not say `Worker: Selected`.
8. Simulated API failure shows the actual message and Retry.

Also open `/workers` and confirm the same inline panel appears below the header without obscuring fleet content.

- [ ] **Step 8: Commit final UI integration**

```bash
git add apps/web/src/routes/WorkersPage.tsx apps/web/src/routes/WorkersPage.test.tsx apps/web/src/components/PendingWorkerRequests.tsx apps/web/src/components/PendingWorkerRequests.test.tsx apps/web/src/styles.css
git commit -m "feat: integrate inline worker enrollment"
```

- [ ] **Step 9: Run final verification and publish**

Run:

```bash
bun test apps/web/src/components/EnrollmentPanel.test.ts apps/web/src/routes/OnboardingPage.test.tsx apps/web/src/routes/WorkersPage.test.tsx apps/web/src/components/PendingWorkerRequests.test.tsx
bun run --filter @whitesmith/web typecheck
git diff --check
git push origin main
```

Expected: focused tests pass, web typecheck exits 0, diff check is clean, and `main` is pushed.
