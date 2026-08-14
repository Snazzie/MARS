# VM-Backed Container Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the active Windows per-job VM path with Hyper-V-isolated Windows containers and implement real Kata-isolated Linux job containers, allowing both platforms to run concurrently on separate workers.

**Architecture:** The existing scheduler, encrypted lease envelope, worker connection, lifecycle events, and ephemeral GitHub JIT runner remain. Native Windows workers use a Docker-compatible engine with mandatory Hyper-V isolation; native Linux workers use K3s/containerd with a mandatory Kata RuntimeClass. Each lease receives one digest-pinned disposable sandbox that is removed on every terminal path.

**Tech Stack:** Bun 1.2, TypeScript, Zod, PowerShell, Docker-compatible Windows Engine/HCS, Windows Server Core, K3s, containerd, Kata Containers, Kubernetes manifests, Bash, GitHub Actions Runner.

## Global Constraints

- Job code is potentially hostile; ordinary Windows process isolation and Linux `runc` are forbidden.
- Windows workers advertise only `windows-x64`; Linux workers advertise only `linux-x64`.
- The active runtime must never fall back to weaker isolation.
- Image references must match `^[^@\s]+@sha256:[0-9a-f]{64}$`.
- Runtime sockets, host credentials, arbitrary host paths, host namespaces, host devices, and privileged mode must never enter a job sandbox.
- The encoded JIT configuration must not appear in command arguments, logs, labels, diagnostics, or runtime object names.
- One sandbox executes at most one lease and is never reused.
- Owned runtime objects carry `whitesmith.managed=true` and `whitesmith.lease-id=<uuid>` labels.
- Orphan reconciliation may remove only objects carrying both Whitesmith ownership labels.
- Pre-pulled Windows sandboxes must become runner-ready within 15 seconds before production cutover.
- Warm containers are outside scope unless the measured, optimized image misses the startup gate.
- The existing Tart macOS path remains unchanged.
- Work directly on `main`; commit and push each completed, verified task.

## Execution Checklist Rules

- This file is the canonical progress tracker; do not create a second checklist.
- The executing AI changes a step from `[ ]` to `[x]` only after running its stated verification and observing the expected result.
- Verification evidence is added directly below the checked step as `Evidence: <command or run ID> — <result>`.
- A task heading changes from `[ ]` to `[x]` only after every step in that task is checked and its commit is pushed to `main`.
- Failed or blocked steps remain unchecked and receive `Blocked: <exact reason and evidence>` below the step.
- Task 2 is a hard gate. Tasks 3–11 remain unchecked until Task 2 passes every host-level acceptance criterion.
- The executing AI updates and commits this checklist in the same commit as the implementation it records.
- Existing checked boxes are trusted only when their evidence still identifies an accessible command result, workflow run, or commit.

---

### - [ ] Task 1: Add container completion and build the Windows runner image

**Files:**
- Modify: `apps/job-agent/src/bootstrap.ts`
- Modify: `apps/job-agent/src/bootstrap.test.ts`
- Modify: `apps/job-agent/src/index.ts`
- Create: `images/jobs/windows/Containerfile`
- Create: `images/jobs/windows/entrypoint.ps1`
- Create: `deploy/workers/build-windows-container-image.ps1`
- Create: `tests/windows-container-image-contract.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `runGuestService(platform, bootstrapPath, runnerRoot, completionMode: "shutdown" | "exit"): Promise<void>`.
- Produces CLI option: `guest-service --completion-mode shutdown|exit`; default remains `shutdown` until the full-VM path is removed.
- Consumes: built `apps/job-agent/dist/whitesmith-job-agent.exe`, a GitHub Actions Runner Windows x64 archive, and a digest-pinned Microsoft Server Core base image.
- Produces: `build-windows-container-image.ps1 -BaseImage <repo@sha256> -RunnerArchive <path> -RunnerSha256 <hex> -JobAgent <path> -Image <registry/repository:tag>`; prints the pushed `repository@sha256:<hex>` reference as its final stdout line.

- [ ] **Step 1: Write failing container-completion tests**

Inject a shutdown function into `runGuestService`. Assert `completionMode: "exit"` returns after runner completion without invoking shutdown, while `"shutdown"` invokes the existing platform shutdown command after the callback:

```ts
test("container completion exits instead of shutting down a guest", async () => {
  let shutdowns = 0;
  await runGuestService("windows-x64", bootstrapPath, runnerRoot, "exit", async () => shutdowns++);
  expect(shutdowns).toBe(0);
});
```

- [ ] **Step 2: Run the job-agent test and verify it fails**

Run: `bun test apps/job-agent/src/bootstrap.test.ts`

Expected: FAIL because `runGuestService` does not accept a completion mode.

- [ ] **Step 3: Implement explicit completion behavior**

Parse `--completion-mode` in `index.ts`, accept only `shutdown` or `exit`, and pass it to `runGuestService`. After runner completion and callback, return immediately for `exit`; execute the existing platform shutdown command only for `shutdown`. Do not infer behavior from environment or container detection.

- [ ] **Step 4: Add a failing image-contract test**

Assert that the build script requires a digest-pinned base, verifies the runner archive hash, copies the job agent, and pushes before resolving a repository digest:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

const script = await readFile("deploy/workers/build-windows-container-image.ps1", "utf8");
const containerfile = await readFile("images/jobs/windows/Containerfile", "utf8");

describe("Windows job image contract", () => {
  test("pins inputs and emits a registry digest", () => {
    expect(script).toContain("@sha256:");
    expect(script).toContain("Get-FileHash");
    expect(script).toContain("docker push");
    expect(script).toContain("RepoDigests");
    expect(containerfile).toContain("whitesmith-job-agent.exe");
    expect(containerfile).toContain("entrypoint.ps1");
  });
});
```

- [ ] **Step 5: Run the contract test and verify the missing-file failure**

Run: `bun test tests/windows-container-image-contract.test.ts`

Expected: FAIL because the image files do not exist.

- [ ] **Step 6: Add the Windows image entrypoint**

Use an exec-style PowerShell process, select container completion explicitly, and propagate the agent exit code:

```powershell
$ErrorActionPreference = 'Stop'
$bootstrap = 'C:\ProgramData\Whitesmith\bootstrap\bootstrap.json'
$agent = 'C:\Whitesmith\whitesmith-job-agent.exe'
& $agent guest-service --platform windows-x64 --completion-mode exit --bootstrap-file $bootstrap --runner-root C:\actions-runner
exit $LASTEXITCODE
```

- [ ] **Step 7: Add the Containerfile**

The file must use build arguments for the pinned base and already-verified local runner archive; it must not download mutable inputs during the build:

```dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
SHELL ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';"]
WORKDIR C:/actions-runner
COPY runner.zip C:/temp/runner.zip
RUN Expand-Archive C:/temp/runner.zip C:/actions-runner; Remove-Item C:/temp/runner.zip
COPY whitesmith-job-agent.exe C:/Whitesmith/whitesmith-job-agent.exe
COPY entrypoint.ps1 C:/Whitesmith/entrypoint.ps1
ENTRYPOINT ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-File", "C:\\Whitesmith\\entrypoint.ps1"]
```

- [ ] **Step 8: Implement the build script**

Validate `BaseImage` with `^[^@\s]+@sha256:[0-9a-f]{64}$`, validate `RunnerSha256` with `^[0-9a-fA-F]{64}$`, compare `Get-FileHash`, stage only the four required build inputs in a temporary directory, run `docker build`, run `docker push`, then select the exact pushed repository from `docker image inspect --format '{{json .RepoDigests}}'`. Throw if zero or multiple matching digests exist.

- [ ] **Step 9: Add the focused script command**

Add to `package.json`:

```json
"test:windows-container-image": "bun test tests/windows-container-image-contract.test.ts"
```

- [ ] **Step 10: Verify and commit**

Run:

```text
bun test apps/job-agent/src/bootstrap.test.ts tests/windows-container-image-contract.test.ts
powershell.exe -NoProfile -Command "$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('deploy/workers/build-windows-container-image.ps1',[ref]$t,[ref]$e) | Out-Null; if($e.Count){exit 1}"
```

Expected: tests PASS; PowerShell parse exits 0.

Commit: `feat: build Windows runner container image`

---

### - [ ] Task 2: Prove Windows Hyper-V-container feasibility

**Files:**
- Create: `deploy/workers/prove-windows-container.ps1`
- Create: `tests/windows-container-proof-contract.test.ts`
- Modify: `WINDOWS-WORKER-PROGRESS.md`

**Interfaces:**
- Consumes: `-Image <repository@sha256>`, `-BootstrapFile <path>`, and optional `-Iterations` defaulting to `5`.
- Produces: JSON containing `image`, `isolation`, `iterations`, `runnerReadyMs`, `cleanupVerified`, and `passed`; exits nonzero when any invariant fails.

- [ ] **Step 1: Write the failing proof-contract test**

```ts
const proof = await Bun.file("deploy/workers/prove-windows-container.ps1").text();
expect(proof).toContain("docker info");
expect(proof).toContain("--isolation=hyperv");
expect(proof).toContain("docker inspect");
expect(proof).toContain("docker wait");
expect(proof).toContain("docker rm -f");
expect(proof).not.toContain("--isolation=process");
```

- [ ] **Step 2: Run the test and verify it fails for the missing proof script**

Run: `bun test tests/windows-container-proof-contract.test.ts`

Expected: FAIL because `prove-windows-container.ps1` does not exist.

- [ ] **Step 3: Implement fail-closed preflight**

The script must require Administrator elevation, require `(docker info --format '{{.OSType}}') -eq 'windows'`, require a full digest reference, and compare `docker image inspect` RepoDigests with the requested image. Do not switch Docker engine mode inside the script.

- [ ] **Step 4: Implement the measured sandbox probe**

For every iteration:

```powershell
docker create --name $name `
  --isolation=hyperv `
  --label whitesmith.managed=true `
  --label "whitesmith.lease-id=$leaseId" `
  --cpus 1 --memory 2GB `
  --mount "type=bind,source=$leaseDir,target=C:\ProgramData\Whitesmith\bootstrap,readonly" `
  $Image | Out-Null
docker start $name | Out-Null
```

Inspect `.HostConfig.Isolation`, wait for a marker emitted only after the job agent consumes bootstrap, record elapsed milliseconds, then use `docker wait` and `docker rm -f` in `finally`.

- [ ] **Step 5: Add destructive cleanup verification**

Start one sandbox with a blocking synthetic workload, force-remove it, delete the lease directory, and assert that `docker ps -a --filter label=whitesmith.lease-id=<id> --format '{{.ID}}'` returns no IDs.

- [ ] **Step 6: Execute the actual host gate**

Build and push the image from Task 1, switch Docker Desktop to the Windows engine manually, pre-pull the digest, and run:

```text
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/workers/prove-windows-container.ps1 -Image <printed-digest> -BootstrapFile <synthetic-bootstrap.json> -Iterations 5
```

Expected: every inspected sandbox reports `hyperv`, every cleanup check passes, and every pre-pulled runner-ready measurement is below 15000 ms.
Blocked: `docker info --format '{{.OSType}}'` returned `linux` on 2026-08-15; Windows Docker engine switch and Hyper-V host gate were not available.

- [ ] **Step 7: Run one real GitHub JIT smoke inside the image**

Use the existing control-plane JIT generation path to create a one-job bootstrap, run the proof script against a workflow containing one CMD step and one PowerShell step, and verify the runner exits after exactly one job.

- [ ] **Step 8: Record evidence and commit the gate**

Replace the active decision and evidence in `WINDOWS-WORKER-PROGRESS.md` with the image digest, host build, engine version, five measurements, real workflow run ID, isolation inspection, and cleanup result. Keep the production worker drained.

Commit: `test: prove Hyper-V isolated Windows containers`

**Stop condition:** Do not begin Task 3 unless the actual host gate passes isolation, command execution, JIT pickup, cleanup, and the 15-second target.

---

### - [ ] Task 3: Cut over runtime contracts to native container workers

**Files:**
- Modify: `packages/contracts/src/orchestration.ts`
- Modify: `packages/contracts/src/orchestration.test.ts`
- Modify: `apps/control-plane/src/lease-dispatch.ts`
- Modify: `apps/control-plane/src/lease-dispatch.test.ts`
- Modify: `apps/control-plane/src/job-reconciler.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `tests/contracts.test.ts`
- Add a database migration under the existing `packages/db` migration convention if the driver column is constrained.

**Interfaces:**
- Produces: `RuntimeDriverName = "kata-k3s" | "windows-hyperv-container" | "tart-vm"`.
- Produces commands: `kata.create_lease`, `windows-container.create_lease`, and `tart.create_lease`.
- Preserves: `LeaseBootstrapEnvelope` and all lifecycle event payloads.

- [ ] **Step 1: Change contract tests first**

Assert:

```ts
expect(RuntimeDriverName.parse("windows-hyperv-container")).toBe("windows-hyperv-container");
expect(() => RuntimeDriverName.parse("windows-hyperv")).toThrow();
expect(validateWorkerGuestPlatforms("windows-x64", ["windows-x64"])).toBe(true);
expect(validateWorkerGuestPlatforms("windows-x64", ["windows-x64", "linux-x64"])).toBe(false);
```

Update dispatch tests to expect `windows-container.create_lease` for Windows and `kata.create_lease` for Linux.

- [ ] **Step 2: Run focused tests and confirm the old contracts fail**

Run: `bun test packages/contracts/src/orchestration.test.ts apps/control-plane/src/lease-dispatch.test.ts tests/contracts.test.ts`

Expected: FAIL on the new driver and command names.

- [ ] **Step 3: Implement the clean contract cutover**

Use an exhaustive mapping rather than nested fallback logic:

```ts
const commandByDriver: Record<RuntimeDriverName, string> = {
  "kata-k3s": "kata.create_lease",
  "windows-hyperv-container": "windows-container.create_lease",
  "tart-vm": "tart.create_lease",
};
```

Change Windows worker capabilities to only `windows-x64`; remove the mixed Windows-host/Linux-guest allowance.

- [ ] **Step 4: Migrate persisted driver values**

Update `windows-hyperv` rows to `windows-hyperv-container`. Add the new enum/check constraint before removing the old value when the database schema uses a constrained type.

- [ ] **Step 5: Run focused tests and commit**

Run: `bun test packages/contracts/src/orchestration.test.ts apps/control-plane/src/lease-dispatch.test.ts tests/contracts.test.ts tests/worker-dispatch.test.ts`

Expected: PASS.

Commit: `refactor: route native container workers`

---

### - [ ] Task 4: Add a shared lease lifecycle executor

**Files:**
- Create: `apps/orchestrator/src/lease-lifecycle.ts`
- Create: `apps/orchestrator/src/lease-lifecycle.test.ts`
- Modify: `apps/orchestrator/src/windows-agent.ts`
- Modify: `apps/orchestrator/src/windows-agent.test.ts`

**Interfaces:**
- Produces:

```ts
export async function runLeaseLifecycle(
  command: WorkerCommand,
  driver: Pick<RuntimeDriver, "createLease" | "stopLease" | "removeLease">,
  bootstrap: LeaseBootstrapEnvelope,
  send: (event: WorkerEvent) => void,
): Promise<void>;
```

- [ ] **Step 1: Move lifecycle behavior into focused tests**

Cover provisioning failure, attestation before completion, successful `runner.finished`, runner failure, stop failure, remove failure, cleanup failure, and idempotent cleanup. Assert exact event order and reason values.

- [ ] **Step 2: Run the tests and verify the missing export failure**

Run: `bun test apps/orchestrator/src/lease-lifecycle.test.ts`

Expected: FAIL because `runLeaseLifecycle` is missing.

- [ ] **Step 3: Implement the shared executor**

Move the behavior currently in `runWindowsLeaseLifecycle`; preserve the existing event payloads. Put stop and remove in separate guarded blocks so removal still runs after stop failure.

- [ ] **Step 4: Replace the Windows-local implementation**

Delete `runWindowsLeaseLifecycle` and call `runLeaseLifecycle`. Do not keep a compatibility wrapper.

- [ ] **Step 5: Verify and commit**

Run: `bun test apps/orchestrator/src/lease-lifecycle.test.ts apps/orchestrator/src/windows-agent.test.ts`

Expected: PASS.

Commit: `refactor: share worker lease lifecycle`

---

### - [ ] Task 5: Implement the Windows Hyper-V-container driver

**Files:**
- Create: `apps/orchestrator/src/windows-container.ts`
- Create: `apps/orchestrator/src/windows-container.test.ts`
- Modify: `apps/orchestrator/src/runtime.ts` only if completion/log typing needs correction.

**Interfaces:**
- Produces:

```ts
export type DockerResult = { code: number; stdout: string; stderr: string };
export type DockerRunner = (args: string[]) => Promise<DockerResult>;
export type WindowsContainerConfig = {
  image: string;
  prefix: string;
  bootstrapRoot: string;
  limits: WorkerLimits;
  readyTimeoutMs: number;
  jobTimeoutMs: number;
};
export class WindowsContainerDriver implements RuntimeDriver;
```

- [ ] **Step 1: Write driver tests with an injectable fake runner**

Cover full digest validation, Windows engine preflight, real Hyper-V probe inspection, exact create labels and limits, bootstrap absence from argv, completion exit code, timeout stop, idempotent remove, and orphan filtering by both labels.

- [ ] **Step 2: Run the focused test and verify it fails for the missing driver**

Run: `bun test apps/orchestrator/src/windows-container.test.ts`

Expected: FAIL because `windows-container.ts` does not exist.

- [ ] **Step 3: Implement Docker command execution**

Use `Bun.spawn(["docker", ...args])` with piped stdout/stderr. Include argv in errors only after redacting paths beneath `bootstrapRoot`; bootstrap content never belongs in argv.

- [ ] **Step 4: Implement fail-closed reserveCapacity**

Validate resources, `docker info` OS type, exact image RepoDigest, and a disposable create/start/inspect/wait/remove probe. Require normalized inspection value `hyperv`; any other value throws.

- [ ] **Step 5: Implement createLease**

Write this bootstrap shape with exclusive creation:

```ts
{
  version: 1,
  leaseId: lease.id,
  nonce: lease.nonce,
  encodedJitConfig: lease.encodedJitConfig
}
```

Create the sandbox with `--isolation=hyperv`, lease labels, CPU/memory/storage limits, the read-only bootstrap-directory mount, and the configured digest. Start it, inspect isolation again, and expose `docker wait` as `RuntimeLease.completion`.

- [ ] **Step 6: Implement lifecycle and reconciliation**

`stopLease` uses `docker stop --time 10`; `removeLease` uses `docker rm -f` and deletes lease material in `finally`. Reconciliation first lists `label=whitesmith.managed=true`, then inspects and removes only entries whose lease label parses as a UUID and whose name begins with the configured prefix.

- [ ] **Step 7: Verify and commit**

Run: `bun test apps/orchestrator/src/windows-container.test.ts apps/orchestrator/src/lease-lifecycle.test.ts`

Expected: PASS.

Commit: `feat: run Windows leases in Hyper-V containers`

---

### - [ ] Task 6: Wire and install the Windows container worker

**Files:**
- Modify: `apps/orchestrator/src/windows-agent.ts`
- Modify: `apps/orchestrator/src/windows-agent.test.ts`
- Modify: `deploy/workers/install-worker.ps1`
- Modify: `deploy/workers/prepare-local-windows-worker.ps1`
- Modify: `tests/installer-arguments.test.ts`
- Remove after verified cutover: `deploy/workers/prepare-windows-hyperv-template.ps1`

**Interfaces:**
- Consumes environment: `WHITESMITH_WINDOWS_CONTAINER_IMAGE`, `WHITESMITH_WINDOWS_CONTAINER_PREFIX`, `WHITESMITH_WINDOWS_CONTAINER_READY_TIMEOUT_MS`, and `WHITESMITH_WINDOWS_CONTAINER_JOB_TIMEOUT_MS`.
- Removes active environment: `WHITESMITH_WINDOWS_TEMPLATE_PATH`, `WHITESMITH_WINDOWS_TEMPLATE_DIGEST`, and `WHITESMITH_HYPERV_VM_PREFIX`.

- [ ] **Step 1: Change worker and installer tests first**

Assert that the worker constructs `WindowsContainerDriver`, accepts only `windows-container.create_lease`, rejects non-Windows envelopes, and requires the immutable image environment variable. Assert that the installer checks Windows container mode and runs a Hyper-V-isolated probe.

- [ ] **Step 2: Run focused tests and verify failures**

Run: `bun test apps/orchestrator/src/windows-agent.test.ts tests/installer-arguments.test.ts`

Expected: FAIL on old Hyper-V driver wiring and VHDX configuration.

- [ ] **Step 3: Replace worker wiring**

Construct `WindowsContainerDriver` from the new environment and pass leases to `runLeaseLifecycle`. Require `bootstrap.guestPlatform === "windows-x64"`.

- [ ] **Step 4: Replace installer preflight**

Require Administrator elevation, Containers and Hyper-V features, Docker-compatible daemon availability, Windows engine mode, a full image digest, exact local RepoDigest, and successful Hyper-V probe inspection. Register the LocalSystem service only after all checks pass.

- [ ] **Step 5: Remove obsolete active paths**

After the new worker passes focused and host smoke tests, delete the VHDX template preparation script, remove Hyper-V driver construction and configuration, and remove tests that defend differencing-disk behavior. Retain no runtime alias or fallback.

- [ ] **Step 6: Verify and commit**

Run:

```text
bun test apps/orchestrator/src/windows-container.test.ts apps/orchestrator/src/windows-agent.test.ts tests/installer-arguments.test.ts tests/worker-dispatch.test.ts
bun run typecheck
bun run build:windows-worker
```

Expected: all PASS.

Commit: `feat: cut Windows workers over to containers`

---

### - [ ] Task 7: Implement the real Kata K3s driver

**Files:**
- Replace: `apps/orchestrator/src/kata-k3s.ts`
- Create or replace: `apps/orchestrator/src/kata-k3s.test.ts`
- Create: `images/jobs/linux/Containerfile`
- Create: `images/jobs/linux/entrypoint.sh`

**Interfaces:**
- Produces:

```ts
export type KubectlResult = { code: number; stdout: string; stderr: string };
export type KubectlRunner = (args: string[], stdin?: string) => Promise<KubectlResult>;
export type KataK3sConfig = {
  namespace: string;
  runtimeClassName: "whitesmith-kata";
  image: string;
  prefix: string;
  limits: WorkerLimits;
  jobTimeoutMs: number;
};
export class KataK3sDriver implements RuntimeDriver;
```

- [ ] **Step 1: Write manifest and lifecycle tests**

Assert exact `runtimeClassName: whitesmith-kata`, digest image, CPU/memory requests and limits, `emptyDir.sizeLimit`, `automountServiceAccountToken: false`, RuntimeDefault seccomp, dropped capabilities, no host fields, no privileged flag, bootstrap Secret via stdin, completion exit code, and ownership-filtered cleanup.

- [ ] **Step 2: Run tests and confirm the in-memory stub fails**

Run: `bun test apps/orchestrator/src/kata-k3s.test.ts`

Expected: FAIL because the current driver creates only an in-memory UUID.

- [ ] **Step 3: Implement the kubectl adapter**

Use `kubectl apply -f -` with manifest JSON supplied through stdin. Never place Secret data in argv. Parse JSON output from `kubectl get ... -o json`; treat nonzero exit as an error with secret values redacted.

- [ ] **Step 4: Implement reserveCapacity**

Verify the RuntimeClass exists and its handler is the configured Kata handler. Create a labeled probe Pod with `runtimeClassName: whitesmith-kata`, wait for success, inspect the resulting Pod spec and node, then delete it. Any missing class, scheduling fallback, or probe failure keeps the worker unready.

- [ ] **Step 5: Implement per-lease Kubernetes objects**

Apply one immutable Secret and one Pod. The Pod uses a disposable `emptyDir` work volume with `sizeLimit`, a read-only Secret volume, exact resource limits, no service-account token, and the two Whitesmith labels. The image entrypoint launches the job agent against `/var/lib/whitesmith/bootstrap/bootstrap.json`.

- [ ] **Step 6: Implement completion and cleanup**

Watch Pod phase until termination or timeout, read the job container exit code, expose it through `RuntimeLease.completion`, delete the Pod and Secret with UID preconditions when possible, and make repeated removal succeed.

- [ ] **Step 7: Build the Linux image**

Use a digest-pinned base and copy verified runner/job-agent inputs. The entrypoint is:

```sh
#!/usr/bin/env sh
set -eu
exec /usr/local/bin/whitesmith-job-agent guest-service \
  --platform linux-x64 \
  --completion-mode exit \
  --bootstrap-file /var/lib/whitesmith/bootstrap/bootstrap.json \
  --runner-root /opt/actions-runner
```

- [ ] **Step 8: Verify and commit**

Run: `bun test apps/orchestrator/src/kata-k3s.test.ts apps/orchestrator/src/lease-lifecycle.test.ts && bun run typecheck`

Expected: PASS.

Commit: `feat: run Linux leases with Kata`

---

### - [ ] Task 8: Implement the Linux worker lease loop and installer

**Files:**
- Modify: `apps/orchestrator/src/linux-agent.ts`
- Modify: `apps/orchestrator/src/linux-agent.test.ts`
- Modify: `apps/orchestrator/src/index.ts`
- Modify: `deploy/workers/install-worker.sh`
- Modify: `deploy/workers/prepare-linux-job-image.sh`

**Interfaces:**
- Consumes environment: `WHITESMITH_LINUX_CONTAINER_IMAGE`, `WHITESMITH_KATA_NAMESPACE`, `WHITESMITH_KATA_RUNTIME_CLASS=whitesmith-kata`, and `WHITESMITH_KATA_JOB_TIMEOUT_MS`.
- Consumes command: `kata.create_lease` with the existing encrypted `LeaseBootstrapEnvelope`.

- [ ] **Step 1: Write worker-loop tests**

Cover enrollment as `linux-x64`, authenticated socket connection, `worker.configure`, `kata.create_lease`, encrypted envelope opening, rejection of non-Linux envelopes, event order through `runLeaseLifecycle`, reconnect, and unsupported command failure.

- [ ] **Step 2: Run focused tests and verify the current configure-only worker fails**

Run: `bun test apps/orchestrator/src/linux-agent.test.ts`

Expected: FAIL because the worker does not consume lease commands.

- [ ] **Step 3: Implement `runLinuxWorker`**

Follow the existing authenticated worker protocol, construct `KataK3sDriver`, run reserveCapacity and reconciliation before connecting, and accept only `worker.configure` and `kata.create_lease`.

- [ ] **Step 4: Add Linux installer preflight**

Require KVM, K3s/containerd, the `whitesmith-kata` RuntimeClass, the configured handler, exact image digest, egress, capacity, and a successful Kata probe. Install the worker service only after preflight succeeds.

- [ ] **Step 5: Replace VM-oriented image preparation**

Change `prepare-linux-job-image.sh` from systemd guest mutation to building and pushing the Linux container image with verified runner and job-agent inputs, then print its RepoDigest.

- [ ] **Step 6: Verify and commit**

Run:

```text
bun test apps/orchestrator/src/linux-agent.test.ts apps/orchestrator/src/kata-k3s.test.ts tests/worker-dispatch.test.ts
bun run typecheck
bun run build
```

Expected: all PASS.

Commit: `feat: connect Kata Linux workers`

---

### - [ ] Task 9: Verify real Linux isolation and one-job execution

**Files:**
- Create: `deploy/workers/prove-linux-kata.sh`
- Create: `tests/linux-kata-proof-contract.test.ts`
- Modify: `IMPLEMENTATION-STATUS.md`

**Interfaces:**
- Consumes: `--image <repository@sha256>`, `--runtime-class whitesmith-kata`, and `--namespace <name>`.
- Produces JSON containing the runtime class, handler, guest-kernel evidence, runner-ready duration, job exit code, and cleanup result.

- [ ] **Step 1: Add a failing proof-contract test**

Assert the script checks the RuntimeClass handler, submits the bootstrap through stdin/Secret, creates a Pod with `runtimeClassName`, captures `uname -r` from inside the sandbox, and deletes owned Pod/Secret objects.

- [ ] **Step 2: Implement and run the host proof**

Run one synthetic shell workload and one real GitHub JIT smoke. Compare host `uname -r` with sandbox `uname -r`; require the Kata guest kernel evidence, successful job completion, and zero remaining owned objects.

- [ ] **Step 3: Verify fail-closed behavior**

Temporarily specify a nonexistent RuntimeClass and confirm the worker remains unready. Do not test fallback by allowing `runc`; the system must reject before lease acceptance.

- [ ] **Step 4: Record evidence and commit**

Record K3s, containerd, Kata, kernel, image digest, workflow run, completion, and cleanup evidence in `IMPLEMENTATION-STATUS.md`.

Commit: `test: prove Kata Linux job isolation`

---

### - [ ] Task 10: Verify concurrent Linux and Windows actions

**Files:**
- Create: `tests/live-cross-platform-smoke.ts`
- Create: `.github/workflows/cross-platform-smoke.yml`
- Modify: `WINDOWS-WORKER-PROGRESS.md`
- Modify: `IMPLEMENTATION-STATUS.md`

**Interfaces:**
- Workflow jobs use `runs-on: whitesmith-windows-x64` and `runs-on: whitesmith-linux-x64` without dependencies between them.
- Smoke output records each job's runner start, first step, completion, sandbox ID, and cleanup time.

- [ ] **Step 1: Add the two-job workflow**

```yaml
name: Cross-platform smoke
on: workflow_dispatch
jobs:
  linux:
    runs-on: whitesmith-linux-x64
    steps:
      - shell: bash
        run: echo "linux-start=$(date -u +%s)"; sleep 20; uname -a
  windows:
    runs-on: whitesmith-windows-x64
    steps:
      - shell: pwsh
        run: Write-Output "windows-start=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"; Start-Sleep 20; cmd /c ver
```

- [ ] **Step 2: Implement the smoke verifier**

Trigger the workflow, poll both jobs through the existing GitHub client conventions, and require overlapping `[startedAt, completedAt]` intervals. Query Whitesmith lease state and require both leases to reach reaped with distinct worker IDs and runtime instance IDs.

- [ ] **Step 3: Verify runtime cleanup**

On the Windows worker, require no containers with either lease ID. On the Linux worker, require no Pod or Secret with either lease ID. Search worker logs for the encoded JIT values and require zero matches.

- [ ] **Step 4: Run complete repository verification**

Run:

```text
bun test
bun run typecheck
bun run build
bun run build:windows-worker
bun run tests/live-cross-platform-smoke.ts
```

Expected: all local checks PASS; the live smoke reports overlapping execution and complete cleanup.

- [ ] **Step 5: Update status and commit**

Remove obsolete statements claiming the Windows runtime uses full Hyper-V VMs or the Linux driver is an in-memory stub. Record the two workflow job IDs, overlap interval, image digests, runtime versions, and cleanup checks.

Commit: `test: verify parallel Linux and Windows actions`

---

### - [ ] Task 11: Deploy the clean cutover

**Files:**
- Modify only deployment configuration and status files required by the verified binaries and image digests.

**Interfaces:**
- Windows pool driver: `windows-hyperv-container`.
- Linux pool driver: `kata-k3s`.
- Pool images: exact immutable RepoDigests proven in Tasks 2 and 9.

- [ ] **Step 1: Drain both workers**

Require zero active leases before changing driver or image configuration.

- [ ] **Step 2: Install exact verified worker binaries**

Build once, copy each binary, and compare SHA-256 between build output and installed service path before starting the service.

- [ ] **Step 3: Apply image digests and run readiness probes**

Pre-pull each digest, start services, require online plus ready, and verify the observed driver and guest platform exactly match the pool.

- [ ] **Step 4: Enable one platform at a time**

Enable Windows, run one smoke, and re-drain on any failure. Then enable Linux and run one smoke. Finally run the concurrent smoke from Task 10.

- [ ] **Step 5: Remove obsolete host artifacts**

After successful production smoke, remove only Whitesmith-owned old Hyper-V disposable VMs, exported diagnostic checkpoint copies, VHDX templates, and obsolete service environment entries. Preserve the user's named Hyper-V checkpoint and source VM identified in `WINDOWS-WORKER-PROGRESS.md`.

- [ ] **Step 6: Commit and push final status**

Run focused status/document checks, commit `chore: deploy VM-backed container workers`, and push `main`.
