# Windows Worker Development Progress

Last updated: 2026-09-19

## Current decision

The first production Windows runtime uses a **downloaded Hyper-V checkpoint
archive with on-demand generated-ID clones**.

The golden source is the existing `Windows 11 dev environment` VM in its
signed-in desktop state. Worker setup downloads and verifies
`windows-worker-checkpoint.zip` once, extracts it into a digest-addressed,
read-only directory, and uses `Import-VM -Copy -GenerateNewId` for each lease.

Target lifecycle:

1. Prepare the guest agent and startup task inside `Windows 11 dev environment`.
2. Take a running-state Standard checkpoint while the desktop is ready and the guest agent is waiting for bootstrap.
3. Package and publish that checkpoint once as the immutable release artifact.
4. Download and verify the archive during worker setup.
5. Import one isolated clone per lease, resume it, copy bootstrap, execute the job, and remove the clone and copied files.

A persistent warm-slot pool is deferred until measured import latency justifies
the extra reconciliation and state-management complexity.

The Windows worker is deliberately **drained** while this is unfinished. Verified database state at handoff: `online | ready | draining=true`.

## Golden VM and checkpoint

Source VM:

- Name: `Windows 11 dev environment`
- VM ID: `7aecd28a-1b9e-4213-877e-2b16fea66f63`
- Generation: 2
- Network: `Default Switch`
- State when inspected: `Running`

User-created checkpoint:

- Name: `Windows 11 dev environment - (14/08/2026 - 23:31:10)`
- Checkpoint ID: `2ffa2f7f-e0e4-4e3a-a124-65d191d37cba`
- Type: Standard
- Created: `2026-08-14T23:31:12.4463990+01:00`
- Parent: automatic checkpoint created at 23:29:48

Do not delete or overwrite this user checkpoint. Create a new Mars-ready checkpoint after updating the guest agent.

## Proven locally

### Hyper-V host lifecycle

The local disposable VM gates proved:

- Differencing VHDX creation works.
- Generation 2 VM creation works.
- Automatic checkpoints can be disabled.
- Heartbeat reaches `OK`.
- Guest Service Interface host-to-guest copy works after enabling it on each new VM.
- VM and child-disk cleanup works.

### Signed-in checkpoint clone

The user-created signed-in checkpoint was exported and cloned with `Import-VM -Copy -GenerateNewId`.

Observed result:

- Checkpoint export: 16.77 seconds.
- Imported clone state: `Saved`.
- Clone received a new VM ID: `bc2f615c-84ac-477d-bd6c-39627f07e2ba`.
- Clone retained `Default Switch` networking.
- Resume to heartbeat: 6.07 seconds.
- Bootstrap copy succeeded.
- Bootstrap was consumed inside the clone.

This proves the chosen golden-checkpoint model and fast resume primitive.

The synthetic command did not execute in that clone because the checkpoint contains an older guest agent. The source fix exists and passes locally, but the corrected binary has not yet been installed into the running source VM and captured in a new checkpoint.

### Composite runner label

The routing contract is now one label only:

- Windows: `mars-windows-x64`
- macOS: `mars-macos-arm64`
- Linux: `mars-linux-x64`

The live Windows pool is migrated to:

```text
labels=["mars-windows-x64"]
trigger_label=mars-windows-x64
```

The workflow uses scalar `runs-on: mars-windows-x64`.

## Defects found and fixed

### Committed and pushed

- `07b0a04 fix: complete Windows runner provisioning`
  - Added worker lease failure reporting.
  - Added terminating PowerShell command behavior.
  - Fixed Hyper-V differencing disk extension to `.vhdx`.
  - Disabled automatic checkpoints for disposable VMs.
  - Added Windows service environment registration.
  - Added single composite runner labels and database migration.
- `40db26c fix: wait for Hyper-V guest readiness [skip ci]`
  - Waits for guest heartbeat before bootstrap copy.
- `26f9f9e fix: enable Hyper-V guest file service [skip ci]`
  - Enables `Guest Service Interface` on every newly created VM.

### Windows Docker startup ordering

The container-mode Windows worker depends on the Windows Docker engine. Docker
can be configured as a Windows engine and still be unavailable briefly during
service startup because the `docker_engine` named pipe has not been created.

The worker handles this race in two layers:

1. `WindowsContainerDriver.reserveCapacity()` retries `docker info` indefinitely
   with exponential backoff capped at 30 seconds.
2. `deploy/workers/install-worker.ps1` configures the Windows service dependency:

   ```powershell
   sc.exe config MarsWorker depend= docker
   ```

Image, manifest, and engine-mode validation still fail fast after Docker is
reachable. The worker log records each Docker readiness retry.

Operational checks:

```powershell
Get-Service docker,MarsWorker
docker info --format "OSType={{.OSType}}"
Get-Content C:\ProgramData\Mars\logs\worker.log -Tail 50
sc.exe qc MarsWorker
```

Expected values:

- `docker`: `Running`
- `MarsWorker`: `Running`
- `OSType`: `windows`
- `MarsWorker` dependencies: `docker`

If the service was installed before this fix, rerun the worker installer from
an elevated PowerShell to install the updated orchestrator and register the
dependency. The change was committed as `b67305f`.

### Uncommitted source fixes

Current modified files:

```text
apps/job-agent/src/bootstrap.test.ts
apps/job-agent/src/bootstrap.ts
apps/job-agent/src/index.ts
deploy/workers/prepare-windows-hyperv-checkpoint.ps1
tests/installer-arguments.test.ts
```

Changes in those files:

1. Guest service waits for post-start bootstrap instead of failing immediately on `ENOENT`.
2. Warm checkpoint guest service waits indefinitely; a checkpoint may remain idle longer than five minutes.
3. Windows guest commands launch through `cmd.exe /c run.cmd`.
4. CLI flag parsing no longer treats `Bun.argv[0]` as the value of a missing `--runner-root` flag.
5. Missing `--runner-root` now correctly defaults to `C:\actions-runner` on Windows.
6. Scheduled task preparation explicitly uses a SYSTEM service-account principal and `StartWhenAvailable` settings.
7. Regression tests cover bootstrap arrival, Windows batch launch, real synthetic command execution, and missing optional arguments.

Verification already run for these changes:

```text
4 pass, 0 fail: targeted job-agent bootstrap tests
workspace typecheck: all packages passed
job-agent Windows executable build: passed
```

## Root causes encountered

1. **Wrong lifecycle model**: generalized VHDX cold booted through OOBE instead of restoring the signed-in desktop checkpoint.
2. **Guest file service disabled**: new Hyper-V VMs defaulted `Guest Service Interface` to disabled.
3. **Bootstrap startup race**: the startup task launched before `bootstrap.json` was copied and exited on `ENOENT`.
4. **Windows batch invocation**: guest agent attempted to execute `run.cmd` directly instead of using `cmd.exe /c`.
5. **CLI argument parsing**: absent `--runner-root` produced index `-1 + 1 = 0`, so the executable path became the runner working directory.
6. **Old agent in checkpoint**: the signed-in checkpoint clone consumed bootstrap with the agent version captured before fixes, so it could not execute the synthetic command.

## What remains

Perform these in order. Do not resume GitHub assignment before step 6 passes.

### 1. Update the source guest and create a new golden checkpoint

- Keep `Windows 11 dev environment` running and signed in.
- Copy the current `apps/job-agent/dist/mars-job-agent.exe` into `C:\ProgramData\Mars\mars-job-agent.exe` inside the guest.
- Register/restart `MarsGuestService` as SYSTEM with `StartWhenAvailable`.
- Remove stale local bootstrap/result probe files only.
- Start the task and verify the corrected agent is waiting.
- Create a new running-state Standard checkpoint named clearly, for example `Mars Ready 2026-08-14`.
- Preserve the user-created 23:31 checkpoint.

This step needs elevated host PowerShell and the `MarsAdmin` guest credential for PowerShell Direct.

### 2. Repeat the checkpoint clone synthetic execution proof

Export the new Mars checkpoint, then:

- `Import-VM -Copy -GenerateNewId`.
- Verify imported state is `Saved`.
- Resume and measure heartbeat time.
- Copy a synthetic `run.cmd` and bootstrap envelope.
- Verify inside the child disk:
  - `script.executed=true`
  - supplied JIT value reached the script
  - bootstrap file was deleted
  - guest shut down
- Remove clone and all copied VM files.

No GitHub runner is involved in this proof.

### 3. On-demand checkpoint runtime implemented

The VHDX-per-lease path in `apps/orchestrator/src/hyperv.ts` now:

- uses the installed checkpoint export path and archive digest;
- imports one generated-ID clone into a lease-specific directory;
- applies lease CPU, memory, and switch settings before resume;
- destroys the imported VM and all copied files after completion/failure; and
- removes orphan Mars VMs and lease directories after service restart.

### 4. Download and installation implemented

The artifact contract is now:

```text
MARS_WINDOWS_CHECKPOINT_PATH=C:\ProgramData\Mars\checkpoints\<sha256>
MARS_WINDOWS_CHECKPOINT_DIGEST=sha256:<archive-digest>
```

`deploy/workers/prepare-windows-hyperv-checkpoint.ps1` exports the newest
Standard checkpoint by default, creates a ZIP and digest-identical backup, and
prints the control-plane configuration values. Worker setup downloads and
verifies the ZIP, extracts it to a digest-addressed path, validates one `.vmcx`
plus `manifest.json`, and makes the export read-only. The obsolete generalized
VHDX preparation scripts were removed.

### 5. Verify local clone behavior

Before enabling the worker:

- install the exact published checkpoint archive;
- import at least two clones independently;
- give each a distinct synthetic command/bootstrap;
- verify bootstrap consumption and output isolation;
- verify guest shutdown;
- verify VM and copied-file destruction; and
- restart the worker service and verify orphan cleanup.

### 6. Publish and deploy verified source

- Run targeted tests.
- Run workspace typecheck.
- Build all packages.
- Build Windows worker and service host.
- Commit directly to `main` and push, per repository policy.
- Install the exact built worker binary and verify SHA-256 equality.
- Update the live pool image/checkpoint digest.
- Keep the worker drained until all local checks pass.

### 7. Run one GitHub smoke

Only after local checkpoint execution and warm-pool recovery pass:

- Set `draining=false`.
- Trigger one Windows smoke run using `mars-windows-x64`.
- Confirm assignment, bootstrap, ephemeral runner pickup, workflow steps, guest shutdown, lease completion, VM cleanup, and warm-slot replenishment.

## Current external state

- Windows worker ID: `230533c9-b22e-4045-b72d-129dc81fe6d0`
- Worker connection/configuration: `online`, `ready`
- Worker draining: `true`
- Windows pool ID: `6e9c03f7-469a-4667-a3c2-df6b883b30af`
- Pool label: `mars-windows-x64`
- Latest Windows smoke run `31841520964`: cancelled
- No successful end-to-end Windows GitHub smoke yet

## Useful local evidence

Temporary diagnostic/proof outputs:

```text
C:\Users\acoop\AppData\Local\Temp\windows-dev-checkpoint.txt
C:\Users\acoop\AppData\Local\Temp\mars-golden-checkpoint-result.txt
C:\Users\acoop\AppData\Local\Temp\mars-guest-execution-result.txt
C:\Users\acoop\AppData\Local\Temp\mars-vm-lifecycle-result.txt
```

Golden checkpoint export created during the proof:

```text
C:\ProgramData\Mars\golden-checkpoint
```

Treat that export as diagnostic. Re-export from the new corrected Mars-ready checkpoint before production use.
