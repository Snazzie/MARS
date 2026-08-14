# Windows Worker Development Progress

Last updated: 2026-08-14

## Current decision

The Windows runtime must use a **warm Hyper-V checkpoint pool**.

The golden source is the existing `Windows 11 dev environment` VM in its signed-in desktop state. The worker must not create a new VM from the generalized `windows.vhdx` and cold-boot through OOBE for every lease.

Target lifecycle:

1. Prepare the guest agent and startup task inside `Windows 11 dev environment`.
2. Take a running-state Standard checkpoint while the desktop is ready and the guest agent is waiting for bootstrap.
3. Export that checkpoint once as the golden checkpoint.
4. Import one generated-ID clone per worker concurrency slot.
5. Keep each clone as a stopped/saved warm slot.
6. On lease dispatch, resume a slot, copy bootstrap, execute the job, destroy the consumed slot, and replenish it asynchronously.

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

Do not delete or overwrite this user checkpoint. Create a new Whitesmith-ready checkpoint after updating the guest agent.

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

- Windows: `whitesmith-windows-x64`
- macOS: `whitesmith-macos-arm64`
- Linux: `whitesmith-linux-x64`

The live Windows pool is migrated to:

```text
labels=["whitesmith-windows-x64"]
trigger_label=whitesmith-windows-x64
```

The workflow uses scalar `runs-on: whitesmith-windows-x64`.

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

### Uncommitted source fixes

Current modified files:

```text
apps/job-agent/src/bootstrap.test.ts
apps/job-agent/src/bootstrap.ts
apps/job-agent/src/index.ts
deploy/workers/prepare-windows-hyperv-template.ps1
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
- Copy the current `apps/job-agent/dist/whitesmith-job-agent.exe` into `C:\ProgramData\Whitesmith\whitesmith-job-agent.exe` inside the guest.
- Register/restart `WhitesmithGuestService` as SYSTEM with `StartWhenAvailable`.
- Remove stale local bootstrap/result probe files only.
- Start the task and verify the corrected agent is waiting.
- Create a new running-state Standard checkpoint named clearly, for example `Whitesmith Ready 2026-08-14`.
- Preserve the user-created 23:31 checkpoint.

This step needs elevated host PowerShell and the `WhitesmithAdmin` guest credential for PowerShell Direct.

### 2. Repeat the checkpoint clone synthetic execution proof

Export the new Whitesmith checkpoint, then:

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

### 3. Implement the persistent warm-slot runtime

Replace the VHDX-per-lease path in `apps/orchestrator/src/hyperv.ts` with checkpoint slots:

- Golden exported checkpoint path/digest configuration.
- Import generated-ID clones until warm slot count equals `maxConcurrentPods`.
- Persist slot metadata so service restart can reconcile slots safely.
- Resume one saved slot per lease.
- Never share one saved VM state concurrently.
- Destroy consumed slot after completion/failure.
- Replenish the slot asynchronously.
- Keep source golden checkpoint immutable.

### 4. Update installation and configuration

The Windows installer/runtime configuration currently points at:

```text
WHITESMITH_WINDOWS_TEMPLATE_PATH=C:\ProgramData\Whitesmith\templates\windows.vhdx
```

Replace this contract with the exported golden-checkpoint location and immutable manifest/digest. Update:

- installer
- service environment
- worker configuration preflight
- dashboard configuration copy if exposed
- tests

The existing `prepare-windows-hyperv-template.ps1` VHDX/OOBE flow is obsolete for job startup after the checkpoint model is complete. Remove it or narrow it to preparation of the golden source; do not retain two runtime paths.

### 5. Verify local warm-pool behavior

Before enabling the worker:

- Prepare at least two checkpoint slots.
- Resume both independently.
- Give each a distinct synthetic command/bootstrap.
- Verify both outputs and isolation.
- Verify bootstrap consumption.
- Verify guest shutdown.
- Verify slot destruction.
- Verify asynchronous replenishment returns pool to target size.
- Restart the worker service and verify reconciliation does not delete or duplicate valid warm slots.

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
- Trigger one Windows smoke run using `whitesmith-windows-x64`.
- Confirm assignment, bootstrap, ephemeral runner pickup, workflow steps, guest shutdown, lease completion, VM cleanup, and warm-slot replenishment.

## Current external state

- Windows worker ID: `230533c9-b22e-4045-b72d-129dc81fe6d0`
- Worker connection/configuration: `online`, `ready`
- Worker draining: `true`
- Windows pool ID: `6e9c03f7-469a-4667-a3c2-df6b883b30af`
- Pool label: `whitesmith-windows-x64`
- Latest Windows smoke run `31841520964`: cancelled
- No successful end-to-end Windows GitHub smoke yet

## Useful local evidence

Temporary diagnostic/proof outputs:

```text
C:\Users\acoop\AppData\Local\Temp\windows-dev-checkpoint.txt
C:\Users\acoop\AppData\Local\Temp\whitesmith-golden-checkpoint-result.txt
C:\Users\acoop\AppData\Local\Temp\whitesmith-guest-execution-result.txt
C:\Users\acoop\AppData\Local\Temp\whitesmith-vm-lifecycle-result.txt
```

Golden checkpoint export created during the proof:

```text
C:\ProgramData\Whitesmith\golden-checkpoint
```

Treat that export as diagnostic. Re-export from the new corrected Whitesmith-ready checkpoint before production use.
