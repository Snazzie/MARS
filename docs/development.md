# Development

Commands below run from the repository root.

## Requirements

- [Bun](https://bun.sh/) 1.4.0
- Docker with Compose support for local PostgreSQL/control-plane runs
- Platform-specific worker prerequisites for Windows, Linux, or macOS development

Install dependencies:

```bash
bun install
```

## Local setup

Copy the example environment file and set the required origins and database values:

```bash
cp .env.example .env
```
Create an untracked development override for the local super-admin credential:

```bash
printf 'MARS_DEV_TOKEN=<development secret>\n' > .env.development
```

Start the control-plane and web development processes:

```bash
bun run dev
```

The local control plane listens on `http://127.0.0.1:3000` and the web development server uses the configured frontend port. Start PostgreSQL separately with Docker Compose when needed:

```bash
docker compose up -d postgres
```

Local development ports and service behavior are defined in `scripts/dev.ts` and `scripts/dev-ports.ts`.

### Run a foreground Windows development worker

On a Windows host, set the same `MARS_DEV_TOKEN` used by the development control plane at `https://mars.snazzie.space`. That deployment must run the current checkout's `scripts/control-plane-dev-entry.ts` and shared worker contracts; an older deployment can reject a valid worker doctor report with HTTP 400. A production deployment or mismatched token cannot enroll this worker. The launcher does not select or switch Docker engines: the worker discovers and advertises the active Linux Docker engine even without an image (the capability remains not ready). To prepare the local Windows job image explicitly, switch Docker to the Windows engine yourself and run with `MARS_DEV_BUILD_WINDOWS_IMAGE=true`; the development image-payload adapter must be available. To run Linux Docker jobs, provision a verified digest-pinned image for the engine architecture and set `MARS_LINUX_ARM64_CONTAINER_IMAGE` or `MARS_LINUX_X64_CONTAINER_IMAGE` before starting the worker.

In a separate terminal from `bun run dev`, run from this checkout:

```powershell
bun run dev:windows-worker
```

To use the control plane from this checkout instead of the default remote development deployment, start `bun run dev` with PostgreSQL and the development environment configured, then run `$env:MARS_DEV_CONTROL_PLANE_URL = 'http://127.0.0.1:3000'` before launching the worker. Use the same `MARS_DEV_TOKEN` in both processes. Pushing a worker change to `main` does not update an already-running control plane at `mars.snazzie.space`; it must be updated and restarted before it can parse new doctor fields.

The command runs the orchestrator in the foreground; without a ready runtime it can enroll and report capabilities but cannot run jobs. It does not install, stop, or modify the `MarsWorker` service; it refuses to start while that service is running. Its separate worker identity and image manifest live in `%LOCALAPPDATA%\Mars\dev-worker`. On first join, approve and configure the pending worker in the control plane before it is schedulable. Press Ctrl-C to stop the foreground worker. The production installer remains the supported path for service workers.

### Run a foreground macOS development worker

On an Apple Silicon Mac with Bun, Tart, Xcode Command Line Tools, and prepared macOS and Linux Tart images, set `MARS_DEV_TOKEN` to the token used by the development control plane at `https://mars.snazzie.space`. Place the corresponding `macos-tart-image-manifest.json` and `linux-arm64-tart-image-manifest.json` in `~/Library/Application Support/Mars/dev-worker` (copy them from an installed worker before uninstalling it). If an installed worker exists, drain it and wait for active jobs to finish before manually unloading its LaunchAgent with `launchctl bootout "gui/$(id -u)/com.mars.worker"`. This command refuses to run while the LaunchAgent is loaded and never changes it.

```bash
bun run dev:mac-worker
```

The command builds the menu-bar status item locally and runs the macOS orchestrator in the foreground. It prints worker commands, lease lifecycle events, and live job output to the terminal (resource samples stay quiet); these console logs are enabled only for the development worker. It uses the prepared local Tart images and development manifests without modifying them. Its own identity, UUID, lease state, and cache live under `~/Library/Application Support/Mars/dev-worker`; the first join uses the development token and requires approval and configuration in the control plane before scheduling. Press Ctrl-C to stop it. If retaining an installed worker, restore it afterward with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.mars.worker.plist"`. The macOS installer remains the supported path for a persistent worker.

In the worker health panel, **Managed VM workloads** shows the latest per-lease CPU,
memory, and disk sample alongside requested capacity. Samples arrive roughly every
five seconds while the runner is active; the sample column marks observations older
than five minutes as stale. Lease age is time since the last lease state update, not
sample freshness. If a running VM has no sample, check the foreground worker for
`macOS VM resource sample failed` and the control-plane worker connection.

### Upgrade a local Windows worker from the current checkout

Use this when the local control plane cannot issue a release-catalog upgrade target. It downloads artifacts from the running local control plane, verifies SHA-256 values, and invokes the existing identity-preserving installer upgrade. Do not run it while jobs are active.

1. From the repository root, build the Windows worker artifacts and drain the worker in the dashboard. Wait until its active sandboxes and health jobs are both zero:

   ```powershell
   bun run build:windows-worker
   ```

2. Generate a temporary PowerShell script. Set `$controlPlane` to the local API origin and `$repo` to this checkout's absolute path. The script computes hashes from the build outputs; it does not need a release token or GitHub release:

   ```powershell
   $repo = (Get-Location).Path
   $controlPlane = 'http://127.0.0.1:3000'
   $temporaryScript = Join-Path $env:TEMP ('mars-local-upgrade-' + [guid]::NewGuid().ToString('N') + '.ps1')
   $body = @'
   $ErrorActionPreference = 'Stop'
   $repo = '__REPO__'
   $controlPlane = '__CONTROL_PLANE__'
   function Hash([string]$Path) {
     if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing build artifact: $Path" }
     (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
   }
   $orchestrator = Join-Path $repo 'apps\orchestrator\dist\mars-orchestrator.exe'
   $serviceHost = Join-Path $repo 'apps\windows-service-host\target\release\mars-service-host.exe'
   $tray = Join-Path $repo 'deploy\workers\mars-worker-tray.ps1'
   function LocalEnvValue([string]$Name) {
     foreach ($file in @('.env.development', '.env')) {
       $path = Join-Path $repo $file
       if (Test-Path -LiteralPath $path) {
         foreach ($line in Get-Content -LiteralPath $path) {
           if ($line -match ('^' + [regex]::Escape($Name) + '=(.*)$')) {
             return $Matches[1].Trim().Trim('"').Trim("'")
           }
         }
       }
     }
     return $null
   }
   $workerVersion = LocalEnvValue 'MARS_WORKER_VERSION'
   if (-not $workerVersion) { $workerVersion = '0.0.0' }
   $contractVersion = LocalEnvValue 'MARS_WORKER_CONTRACT_VERSION'
   if (-not $contractVersion) { throw 'Set MARS_WORKER_CONTRACT_VERSION in .env.development or .env.' }
   & (Join-Path $repo 'deploy\workers\install-worker.ps1') `
     -ControlPlaneUrl $controlPlane -WindowsArtifactMode 'local' `
     -WorkerVersion $workerVersion -WorkerContractVersion $contractVersion `
     -WindowsOrchestratorUrl "$controlPlane/api/workers/orchestrator?audience=windows-x64" `
     -WindowsOrchestratorSha256 (Hash $orchestrator) `
     -WindowsServiceHostUrl "$controlPlane/api/workers/service-host?audience=windows-x64" `
     -WindowsServiceHostSha256 (Hash $serviceHost) `
     -WindowsTrayScriptUrl "$controlPlane/api/workers/windows-tray-script" `
     -WindowsTrayScriptSha256 (Hash $tray) -Upgrade
   '@
   $body = $body.Replace('__REPO__', $repo.Replace("'", "''")).Replace('__CONTROL_PLANE__', $controlPlane)
   Set-Content -LiteralPath $temporaryScript -Value $body -Encoding utf8
   ```

3. Run the temporary script elevated and wait for it to finish:

   ```powershell
   try {
     $process = Start-Process powershell.exe -Verb RunAs -Wait -PassThru `
       -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$temporaryScript`""
     if ($process.ExitCode -ne 0) { throw "Worker upgrade failed with exit code $($process.ExitCode)" }
   } finally {
     Remove-Item -LiteralPath $temporaryScript -Force -ErrorAction SilentlyContinue
   }
   ```

The installer requires the worker identity and `MarsWorker` service to exist. It preserves identity and runtime data, replaces the orchestrator, service host, and tray script, and restarts the service. Check `C:\ProgramData\Mars\install.log`, then confirm the service is running and the worker has reconnected with a fresh doctor report. If any jobs remain active, wait for them to finish rather than stopping the service.

### Recover a local macOS worker connected to the dev instance

Use the existing worker identity; **do not re-enroll** an adopted worker. On the
Mac, inspect the user LaunchAgent and the installed runtime before changing
anything:

```bash
app="$HOME/Library/Application Support/Mars"
launchctl print "gui/$(id -u)/com.mars.worker"
cat "$app/install-state.json"
codesign --verify --deep --strict "$app/mars-orchestrator"
codesign --verify --deep --strict "$app/mars-macos-job-agent"
```

`state = spawn scheduled` with `last exit reason = OS_REASON_CODESIGNING`
and `invalid signature (code or signature have been modified)` from `codesign`
means macOS cannot run the installed binary. If no installer is currently
replacing binaries, re-sign the installed macOS executables and restart
the existing LaunchAgent:

```bash
codesign --force --sign - --timestamp=none "$app/mars-orchestrator" "$app/mars-macos-job-agent"
codesign --verify --deep --strict "$app/mars-orchestrator"
codesign --verify --deep --strict "$app/mars-macos-job-agent"
launchctl kickstart -k "gui/$(id -u)/com.mars.worker"
launchctl print "gui/$(id -u)/com.mars.worker"
```

The installer signs its staged macOS executables, but verify the **installed**
copies if LaunchAgent reports a signing failure. Do not sign while an upgrade
is running; inspect `install-state.json` and installer processes first. Logs
are at `$app/worker.log`, `$app/worker.error.log`, and `$app/install.log`.
Old connection errors in append-only logs do not establish current status.

In the dashboard, check the worker is **adopted**, **online**, and
**configuration ready**, with a fresh doctor report showing `runtimeReady:
true`, `imageSignatures: true`, and `acceptingLeases: true`. If doctor says
the prepared Tart images or digests are unavailable, check the local image
manifests and Tart images (`tart list --source local --quiet`), and finish
image preparation before accepting jobs. If the worker is **draining**,
select **Resume** in the dashboard once it is ready. Draining remains set
across a service restart; a live connection alone does not make it schedulable.
Do not restart or upgrade a worker with active jobs just to clear draining.

For a non-production dev instance with `MARS_DEV_TOKEN` configured, an admin
can verify the same state from the API without exposing the token in logs:

```bash
base=https://mars.snazzie.space
worker_id=YOUR_WORKER_UUID
# Load MARS_DEV_TOKEN from the untracked .env.development or your secret store.
curl --fail-with-body -sS -H "Authorization: Bearer $MARS_DEV_TOKEN" \
  "$base/api/organizations/all/workers/$worker_id" |
  jq '{connectionState, admissionState, configurationState, draining, doctor, activeSandboxes}'
curl --fail-with-body -sS -H "Authorization: Bearer $MARS_DEV_TOKEN" \
  "$base/api/workers/$worker_id/health" |
  jq '{connection, jobs}'
```

A fresh heartbeat proves connectivity; a job in `dispatched` or
`sandbox_ready` proves assignment and sandbox provisioning, **not** job
completion. Verify the job outcome separately in the run. For routing,
macOS workflows use the composite label `mars-macos-arm64-2vcpu-4g`
(see [worker routing labels](worker-routing-labels.md)).

### Development log APIs

Development log APIs require a global administrator. Outside production, the
existing `MARS_DEV_TOKEN` from the untracked `.env.development` may be supplied
as `Authorization: Bearer <token>`; never commit the token.

- `GET /api/admin/logs?limit=200&level=error&contains=<text>` returns the
  current process's bounded, redacted control-plane log buffer. Use `after`
  with the returned `nextCursor` for incremental reads.
- `GET /api/workers/:workerId/logs?maxBytes=65536` requests a bounded,
  redacted service-log tail from a connected worker. The worker must run an
  artifact that supports `worker.collect_logs`.

Both responses use `Cache-Control: no-store`.


Useful commands:

```bash
bun run typecheck
bun run lint
bun test
bun run build
```

