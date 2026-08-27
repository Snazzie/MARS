# Windows Hyper-V Template Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Windows Docker-container worker with a native Hyper-V Gen 2 worker that runs concurrent Windows and Linux guests from verified, sealed vendor-derived VHDX templates.

**Architecture:** Downloaded Microsoft Windows and official Ubuntu images are verified source inputs. An operator preparation workflow installs the Mars guest service/job agent, removes state, generalizes and seals each image, then publishes a digest-pinned template manifest. Windows workers cache and verify those templates, create per-lease differencing disks and Gen 2 VMs, transfer encrypted bootstrap data through Guest Service Interface, and route leases by guest platform.

**Tech Stack:** Bun/TypeScript, Zod contracts, PostgreSQL migrations, Hono HTTP routes, React/TypeScript UI, PowerShell, Hyper-V PowerShell cmdlets, Windows service integration.

## Global Constraints

- Windows workers use `windows-hyperv` directly; Docker, WSL, SSH, containers, and unpinned images are not runtime fallbacks.
- Windows workers default to `guestPlatforms: ["windows-x64"]`; `linux-x64` is enabled only after Linux-template preflight.
- Capability changes require drained workers with zero active leases and a `ready` configuration acknowledgment.
- Sealed templates are immutable parent VHDX files; every lease uses a differencing VHDX.
- Every source artifact and sealed template is SHA-256 verified and represented in a manifest.
- The worker runs as LocalSystem; Hyper-V management and machine-scoped identity are required.
- Guest bootstrap data remains encrypted and must not appear in process arguments or logs.
- Existing lease, worker socket, event, and job-agent contracts remain compatible unless explicitly extended below.
- Physical Hyper-V execution is an operator-host verification; deterministic fake Hyper-V adapters cover automated tests.

---

### Task 1: Remove superseded Docker path and preserve clean baseline

**Files:**
- Modify: `apps/orchestrator/src/windows-agent.ts`
- Modify: `apps/orchestrator/src/index.ts`
- Modify: `deploy/workers/install-worker.ps1`
- Delete: `apps/orchestrator/src/windows-container.ts`, `apps/orchestrator/src/windows-container.test.ts`
- Modify: `apps/control-plane/src/http/worker-routes.ts`, `apps/control-plane/src/http/types.ts`, `apps/control-plane/src/index.ts`
- Modify: `apps/control-plane/src/http/onboarding-routes.ts`
- Modify: `packages/contracts/src/dashboard.ts`, `packages/contracts/src/orchestration.ts`
- Test: existing focused worker and contract tests

**Interfaces:**
- Consumes: existing `WorkerBootstrapRequest`, `WorkerCommand`, `WorkerEvent`, `LeaseBootstrapEnvelope`, and worker configuration contracts.
- Produces: no Docker-specific installer placeholders, environment variables, routes, image bundles, or runtime driver references.

- [ ] **Step 1: Identify and remove Docker-only changes from the current working tree**
  - Retain guest-platform contract changes that are still required.
  - Remove `MARS_WINDOWS_CONTAINER_*` configuration, Docker image bundle routes, Docker image preparation scripts, and local generated bundle artifacts.
  - Do not remove the existing guest-platform persistence or UI work if it is independent of Docker.
- [ ] **Step 2: Update focused tests to assert Hyper-V template behavior instead of Docker behavior**
- [ ] **Step 3: Run the focused tests and confirm Docker assumptions fail before replacement**
  - Run: `bun test apps/orchestrator/src/windows-container.test.ts apps/control-plane/src/http/app.test.ts`
  - Expected: tests are either removed/replaced or fail only because the new Hyper-V driver is not yet present.
- [ ] **Step 4: Commit the clean architectural cutover baseline**
  - Run: `git add apps packages deploy tests && git commit -m "refactor: replace Windows Docker runtime baseline"`

---

### Task 2: Add template manifest and source-artifact contracts

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/templates.ts`
- Test: `packages/contracts/src/templates.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const TemplateGuestPlatform = z.enum(["windows-x64", "linux-x64"]);
  export const TemplateManifest = z.object({
    format: z.literal(1),
    guestPlatform: TemplateGuestPlatform,
    source: z.object({ url: z.string().url(), sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict(),
    template: z.object({ sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/), path: z.string().min(1) }).strict(),
    hyperv: z.object({ generation: z.literal(2), secureBoot: z.boolean(), guestServiceInterface: z.literal(true) }).strict(),
    guestAgentVersion: z.string().min(1),
    preparedAt: z.string().datetime(),
  }).strict();
  export type TemplateManifest = z.infer<typeof TemplateManifest>;
  export const WorkerTemplateSet = z.array(TemplateManifest).min(1).superRefine((items, ctx) => {
    const platforms = items.map(item => item.guestPlatform);
    if (new Set(platforms).size !== platforms.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate guest platform" });
  });
  export function validateTemplateSet(platform: RuntimePlatform, templates: WorkerTemplateSet): void;
  ```
- Consumes: `RuntimePlatform` and `WorkerGuestPlatforms` from orchestration contracts.

- [ ] **Step 1: Write failing contract tests**
  - Accept valid Windows and Ubuntu manifest records.
  - Reject non-SHA-256 values, generation 1, missing Guest Service Interface, invalid dates, duplicate guest platforms, and host/platform mismatches.
- [ ] **Step 2: Run `bun test packages/contracts/src/templates.test.ts` and verify failure**
- [ ] **Step 3: Implement the schemas and `validateTemplateSet`**
- [ ] **Step 4: Run the focused contract test and existing contracts suite**
  - Run: `bun test packages/contracts/src/templates.test.ts packages/contracts/src/orchestration.test.ts`
- [ ] **Step 5: Commit**
  - Run: `git add packages/contracts && git commit -m "feat: add Hyper-V template contracts"`

---

### Task 3: Persist template metadata and worker capability readiness

**Files:**
- Modify: `packages/db/src/schema.ts` (the repository stores migrations in the schema bootstrap; no separate migration directory exists)
- Modify: `apps/control-plane/src/http/worker-routes.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/control-plane/src/http/types.ts`
- Test: `apps/control-plane/src/http/worker-routes.test.ts`

**Interfaces:**
- Produces database records for template manifests keyed by guest platform and digest.
- Produces worker configuration responses containing `guestPlatforms`, template readiness, and configuration errors.
- Configuration endpoint rejects capability/template changes unless `draining = true` and active lease count is zero.

- [ ] **Step 1: Add failing route/database tests**
  - Test default Windows-only capability.
  - Test Linux enablement rejection when no valid Linux template exists.
  - Test rejection while active leases exist.
  - Test successful drained update and error acknowledgment behavior.
- [ ] **Step 2: Run focused tests and verify failure**
- [ ] **Step 3: Add migration and persistence helpers**
  - Store manifest JSON plus normalized guest platform, source digest, template digest, and readiness/error state.
  - Preserve immutable digests; updates create a new manifest version rather than mutating a used template.
- [ ] **Step 4: Wire route validation and response normalization**
- [ ] **Step 5: Run focused route tests and database migration checks**
- [ ] **Step 6: Commit**
  - Run: `git add packages/db apps/control-plane && git commit -m "feat: persist Hyper-V template readiness"`

---

### Task 4: Implement template preparation and sealing workflow

**Files:**
- Create: `deploy/workers/prepare-windows-hyperv-template.ps1`
- Create: `deploy/workers/prepare-linux-hyperv-template.ps1`
- Create: `deploy/workers/template-manifest.ps1`
- Modify: `apps/job-agent/package.json` (add the Windows and Linux guest-service build outputs to the preparation input contract)
- Test: `tests/hyperv-template-preparation.test.ts`

**Interfaces:**
- PowerShell entry points accept explicit source URL/path, source SHA-256, output VHDX, guest-agent binary, and output manifest paths.
- Preparation scripts emit a `TemplateManifest`-compatible JSON file and fail closed on any checksum, VM, provisioning, or sealing error.

- [ ] **Step 1: Write script-source tests**
  - Assert source checksum validation, Generation 2 VM creation, Guest Service Interface use, agent installation, state cleanup, Sysprep/generalization, VHDX sealing, and manifest emission.
  - Assert no SSH, WSL-only, Docker, or mutable-image fallback appears in the workflow.
- [ ] **Step 2: Run the script-source tests and verify failure**
- [ ] **Step 3: Implement common manifest/hash helper**
  - Use `Get-FileHash -Algorithm SHA256` and emit lowercase `sha256:<hex>` values.
- [ ] **Step 4: Implement Windows preparation**
  - Import Microsoft Hyper-V VHDX as a temporary Gen 2 VM.
  - Install the guest service/job-agent binary through a controlled provisioning path.
  - Remove local identities, secrets, runner registration, caches, logs, and machine-specific state.
  - Run Sysprep/generalization where supported, shut down, compact, and seal.
- [ ] **Step 5: Implement Linux preparation**
  - Import the official Ubuntu Hyper-V/cloud image.
  - Install the Linux guest service and job-agent startup unit.
  - Remove SSH keys, cloud-init instance state, runner registration, logs, and credentials.
  - Shut down, compact, and hash the sealed VHDX.
- [ ] **Step 6: Run parser tests and a dry-run preparation test with fake Hyper-V commands**
- [ ] **Step 7: Commit**
  - Run: `git add deploy/workers tests apps/job-agent && git commit -m "feat: prepare sealed Hyper-V templates"`

---

### Task 5: Implement Hyper-V runtime adapter

**Files:**
- Create: `apps/orchestrator/src/hyperv.ts`
- Create: `apps/orchestrator/src/hyperv.test.ts`
- Modify: `apps/orchestrator/src/runtime.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface HyperVRuntime {
    verifyHost(): Promise<void>;
    verifyTemplate(manifest: TemplateManifest, path: string): Promise<void>;
    createDifferencingDisk(parent: string, child: string, sizeBytes: number): Promise<void>;
    createVm(input: { name: string; diskPath: string; resources: PoolResources; guestPlatform: TemplateGuestPlatform }): Promise<void>;
    copyBootstrap(vmName: string, sourcePath: string, guestPath: string): Promise<void>;
    start(vmName: string): Promise<void>;
    waitForGuestReady(vmName: string, timeoutMs: number): Promise<void>;
    streamGuestLogs(vmName: string): AsyncIterable<string>;
    stop(vmName: string): Promise<void>;
    remove(vmName: string): Promise<void>;
    removeDisk(path: string): Promise<void>;
  }
  export function createHyperVRuntime(): HyperVRuntime;
  export class HyperVDriver implements RuntimeDriver {
    readonly name: "windows-hyperv";
    validatePool(resources: PoolResources): void;
    reserveCapacity(resources: PoolResources): Promise<void>;
    createLease(lease: Lease): Promise<RuntimeLease>;
    inspectLease(leaseId: string): Promise<RuntimeLease>;
    stopLease(leaseId: string): Promise<void>;
    removeLease(leaseId: string): Promise<void>;
    collectDiagnostics(leaseId: string): Promise<Record<string, unknown>>;
  }
  ```
- Consumes: `TemplateManifest`, `PoolResources`, `Lease`, and encrypted bootstrap envelope.

- [ ] **Step 1: Write failing fake-runtime tests**
  - Verify command ordering and arguments.
  - Verify resource bounds, Generation 2, secure boot, Guest Service Interface, differencing disks, readiness timeout, cleanup on failure, and orphan recovery.
  - Verify bootstrap contents never occur in command arguments.
- [ ] **Step 2: Run `bun test apps/orchestrator/src/hyperv.test.ts` and verify failure**
- [ ] **Step 3: Implement PowerShell command runner with injectable `run(args)`**
  - Use `Get-VM`, `New-VM`, `New-VHD`, `Set-VMProcessor`, `Set-VMMemory`, `Add-VMHardDiskDrive`, `Enable-VMIntegrationService`, `Copy-VMFile`, `Start-VM`, `Stop-VM`, and `Remove-VM` through PowerShell.
  - Treat non-zero exit and malformed output as errors.
- [ ] **Step 4: Implement `HyperVDriver` lease lifecycle**
  - Validate guest platform and digest against the selected manifest.
  - Track active leases by lease ID and VM name.
  - Remove disks and VM records in `finally` cleanup paths.
- [ ] **Step 5: Run focused tests and commit**
  - Run: `bun test apps/orchestrator/src/hyperv.test.ts`
  - Commit: `git add apps/orchestrator && git commit -m "feat: add Hyper-V VM runtime"`

---

### Task 6: Replace Windows worker enrollment and dispatch

**Files:**
- Modify: `apps/orchestrator/src/windows-agent.ts`
- Modify: `apps/orchestrator/src/index.ts`
- Modify: `apps/orchestrator/src/windows-service.ts`
- Create: `apps/orchestrator/src/worker-client.ts` if reusable socket logic is not already isolated
- Test: `apps/orchestrator/src/windows-agent.test.ts`

**Interfaces:**
- `runWindowsWorker(baseUrl: string, limits: Limits): Promise<never>` uses `HyperVDriver`, cached manifests, and the existing authenticated worker socket.
- `buildWindowsWorkerJoinPayload` advertises Windows host plus configured guest platforms.
- Command dispatch selects `HyperVDriver` for `hyperv.create_lease`, `hyperv.stop_lease`, and configuration commands.

- [ ] **Step 1: Write failing worker tests**
  - Verify enrollment reports default Windows-only capability.
  - Verify configured Linux capability is reported only after template preflight.
  - Verify Hyper-V command types are accepted and Docker command types are rejected.
  - Verify reconnect and command idempotency remain intact.
- [ ] **Step 2: Implement reusable worker socket client**
  - Preserve challenge signing, encryption key exchange, event acknowledgments, reconnect delay, and lease bootstrap decryption.
- [ ] **Step 3: Implement Windows host capacity and Hyper-V preflight**
  - Query CPU, memory, storage, Hyper-V feature state, virtualization support, and virtual switch availability.
- [ ] **Step 4: Wire Hyper-V lifecycle dispatch and configuration acknowledgment**
- [ ] **Step 5: Run focused tests and commit**
  - Run: `bun test apps/orchestrator/src/windows-agent.test.ts apps/orchestrator/src/hyperv.test.ts`
  - Commit: `git add apps/orchestrator && git commit -m "feat: run Windows workers on Hyper-V"`

---

### Task 7: Wire scheduler routing and dashboard configuration

**Files:**
- Modify: `apps/control-plane/src/lease-dispatch.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `apps/web/src/components/WorkerConfigurationForm.tsx`
- Modify: `apps/web/src/components/WorkerCard.tsx`
- Modify: `apps/web/src/routes/WorkersPage.tsx`
- Test: `apps/control-plane/src/lease-dispatch.test.ts`, existing web component tests

**Interfaces:**
- Scheduler input includes `guestPlatform` and selects only workers whose persisted `guestPlatforms` contains it and whose template state is ready.
- UI displays available guest platforms, template readiness/errors, and the drained/zero-active-lease requirement.

- [ ] **Step 1: Write failing routing tests**
  - Windows lease cannot route to Linux-only worker.
  - Linux lease routes to a dual-capability Windows worker.
  - Unready template excludes the worker.
  - No eligible worker produces the existing explicit capacity error.
- [ ] **Step 2: Implement platform-aware query and dispatch command selection**
- [ ] **Step 3: Add configuration UI controls and disabled-state explanations**
- [ ] **Step 4: Run routing and component tests**
- [ ] **Step 5: Commit**
  - Run: `git add apps/control-plane packages/contracts apps/web && git commit -m "feat: route leases by guest platform"`

---

### Task 8: Replace installer and artifact distribution

**Files:**
- Modify: `deploy/workers/install-worker.ps1`
- Modify: `apps/control-plane/src/http/worker-routes.ts`
- Modify: `apps/control-plane/src/http/types.ts`
- Modify: `apps/control-plane/src/index.ts`
- Test: `tests/installer-arguments.test.ts`, `apps/control-plane/src/http/worker-routes.test.ts`

**Interfaces:**
- Installer parameters include control-plane URL, join code, template manifest URL, local cache root, and optional explicit Windows/Linux template paths.
- Control plane exposes authenticated manifest and VHDX artifact routes with range/streaming support where existing HTTP conventions allow.

- [ ] **Step 1: Write failing installer/distribution tests**
  - Reject missing manifest, source digest mismatch, template digest mismatch, wrong generation, and missing required guest service.
  - Accept cached verified templates without downloading again.
  - Verify no Docker variables or commands occur.
- [ ] **Step 2: Implement authenticated template manifest/artifact endpoints**
- [ ] **Step 3: Implement atomic worker download and cache verification**
- [ ] **Step 4: Implement Hyper-V installer preflight and LocalSystem service registration**
- [ ] **Step 5: Run PowerShell parser checks and focused tests**
- [ ] **Step 6: Commit**
  - Run: `git add deploy/workers apps/control-plane tests && git commit -m "feat: distribute Hyper-V worker templates"`

---

### Task 9: End-to-end verification and cleanup

**Files:**
- Modify: affected tests and docs only where verification exposes a contract gap.
- Delete: obsolete Docker image preparation scripts, Docker bundle fixtures, and Docker-specific environment entries.
- Update: `docs/superpowers/specs/2026-08-13-windows-hyperv-template-design.md` only if implementation changes an approved invariant.

- [ ] **Step 1: Run all targeted contract, routing, runtime, installer, and guest-agent tests**
  - Run: `bun test packages/contracts/src/*.test.ts apps/orchestrator/src/hyperv.test.ts apps/orchestrator/src/windows-agent.test.ts apps/control-plane/src/http/worker-routes.test.ts apps/control-plane/src/lease-dispatch.test.ts tests/installer-arguments.test.ts`
- [ ] **Step 2: Run package typechecks**
  - Run: `bun run --filter @mars/contracts typecheck && bun run --filter @mars/control-plane typecheck && bun run --filter @mars/orchestrator typecheck && bun run --filter @mars/web typecheck`
- [ ] **Step 3: Run control-plane smoke verification**
  - Launch PostgreSQL and the control plane, fetch a manifest fixture, verify authenticated artifact streaming, and exercise Windows/Linux routing through the fake Hyper-V adapter.
- [ ] **Step 4: Run PowerShell syntax verification**
  - Parse every changed `.ps1` file with `System.Management.Automation.Language.Parser` and require zero errors.
- [ ] **Step 5: Run physical Hyper-V preflight if available**
  - Verify Hyper-V feature, Generation 2 VM creation, Guest Service Interface, VHDX differencing, start/readiness, and cleanup.
  - If nested Hyper-V is unavailable, record that limitation and retain fake-runtime evidence; do not claim physical VM execution passed.
- [ ] **Step 6: Remove generated artifacts and stale environment entries**
- [ ] **Step 7: Commit final cleanup**
  - Run: `git add -A && git commit -m "chore: finalize Hyper-V worker migration"`
