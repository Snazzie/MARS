# MARS

**MARS (Managed Action Runner System)** is a self-hosted control plane and worker platform for running GitHub Actions workloads on managed infrastructure.

The repository contains the control-plane API and dashboard, worker runtimes for supported host platforms, job-agent and orchestration components, deployment assets, and contract tests.

> **Development status:** MARS is an active development baseline, not a production-ready platform. The supported issue #9 deployment is the Linux/amd64 control-plane hosting MVP only; job execution remains issue #6. See [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) for evidence and external blockers.

## Repository layout

- `apps/control-plane` — Hono/Bun API, GitHub integration, onboarding, worker and run management
- `apps/web` — React dashboard
- `apps/orchestrator` — worker-side runtime orchestration
- `apps/job-agent` — job-agent protocol and claim handling
- `apps/windows-service-host` — Windows worker service host
- `packages/contracts` — shared API and domain contracts
- `packages/db` — PostgreSQL schema, migrations, and query modules
- `deploy/control-plane` — production-style container image and Compose deployment
- `deploy/workers` — worker installers and runtime assets
- `tests` — deployment, installer, integration, and smoke-test contracts
- `docs` — focused operational and design documentation

## Requirements

- [Bun](https://bun.sh/) 1.4.0
- Docker with Compose support for local PostgreSQL/control-plane runs
- Platform-specific worker prerequisites for Windows, Linux, or macOS development

Install dependencies:

```bash
bun install
```

## Windows worker runtimes

Windows x64 workers support two explicit, non-fallback runtime modes:

- **Docker / Windows containers** uses the existing digest-pinned local image and
  mandatory Hyper-V container isolation.
- **Hyper-V VM** imports a generated-ID clone of the verified saved checkpoint
  for each lease. Docker is not installed or used by this mode.

Choose the runtime in the dashboard's Windows enrollment panel. The generated
PowerShell command passes `-WindowsRuntime 'container'` or `-WindowsRuntime 'vm'`;
upgrades preserve that selection.

The VM mode requires Windows 11 Pro or Enterprise, Hyper-V, Administrator access,
and a usable virtual switch. It uses `Default Switch` unless
`MARS_HYPERV_SWITCH_NAME` is set on the worker host before installation.

Prepare the signed-in Mars-ready checkpoint once:

```powershell
bun run setup:windows-hyperv-checkpoint
```

The command exports the newest Standard checkpoint, creates
`windows-worker-checkpoint.zip`, creates a digest-identical local backup, and
prints the artifact SHA-256. Configure the control plane with
`MARS_WINDOWS_CHECKPOINT_PATH` or `MARS_WINDOWS_CHECKPOINT_URL` and
`MARS_WINDOWS_CHECKPOINT_SHA256`. Production release manifests expose the same
artifact as `windows.vm.checkpoint`. Worker setup downloads and verifies the ZIP
once, then imports isolated checkpoint clones for jobs.

## Local development

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

### Run a development Windows container worker without installing a service

On a Windows host with Docker Desktop in **Windows container mode** and Hyper-V available, set the same `MARS_DEV_TOKEN` used by the development control plane at `https://mars.snazzie.space`. That deployment must run `scripts/control-plane-dev-entry.ts` with the dev enrollment and image-payload adapters; a production deployment or mismatched token cannot enroll this worker.

In a separate terminal from `bun run dev`, run from this checkout:

```powershell
bun run dev:windows-worker
```

The command verifies or builds the local Windows job image and runs the orchestrator in the foreground. It does not install, stop, or modify the `MarsWorker` service; it refuses to start while that service is running. Its separate worker identity and image manifest live in `%LOCALAPPDATA%\Mars\dev-worker`. On first join, approve and configure the pending worker in the control plane before it is schedulable. Press Ctrl-C to stop the foreground worker. The production installer remains the supported path for service workers.

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
     -ControlPlaneUrl $controlPlane -WindowsRuntime 'container' -WindowsArtifactMode 'local' `
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
(see [worker routing labels](docs/worker-routing-labels.md)).

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

## Deployment

Issue #9 supports Linux/amd64 control-plane hosting only. The released control-plane image requires operator-managed PostgreSQL 17, a persistent data volume, and an immutable `MARS_CONTROL_PLANE_IMAGE` tag or digest.

Required configuration includes:

- `MARS_CONTROL_PLANE_IMAGE` (published `v<semver>` tag or full `@sha256:` digest)
- `DATABASE_URL`
- `PUBLIC_BASE_URL`
- `GITHUB_WEBHOOK_URL`
- optional `WORKER_BASE_URL`

Validate and start the deployment with:

```bash
docker compose --env-file .env -f deploy/control-plane/compose.yaml config -q
docker compose --env-file .env -f deploy/control-plane/compose.yaml up -d --wait
```

For complete Unraid, ingress, onboarding, backup, health-check, release evidence, upgrade, rollback, and restore instructions, see [`deploy/control-plane/README.md`](deploy/control-plane/README.md).

## Security and persistence

Keep `.env`, GitHub credentials, tunnel tokens, and the control-plane data volume out of source control. PostgreSQL and the control-plane data volume must be backed up and restored together because encrypted GitHub credentials depend on the persisted application master key.

## License

No license has been declared yet.
