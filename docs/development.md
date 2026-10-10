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

Control-plane worker command, event, lease-transition, and connection logs include
`workerName` alongside `workerId`. The name is loaded from the worker record during
authentication and retained for that connection; reconnect after renaming a
worker to refresh its logged name. Frames rejected before authentication may
have only the worker ID. Lease cleanup logs load the current name with the
pending-lease query.

GitHub runner cleanup failures include the repository, runner ID, and GitHub's
JSON error message while preserving the `github_<status>` error code. After a
tracked runner deletion returns `422`, cleanup fetches that runner and logs its
`status` and `busy` fields. If inspection fails, `inspectionError` records that
failure separately. A rejected deletion retains the registration for the next
cleanup tick; neither `422` nor a failed inspection is treated as removal.

The Vite development server also watches frontend source, public assets, shared
contract source, the web entry files, and the build's icon/lockfile inputs. Saves
automatically rebuild `apps/web/dist`, which is the UI served by the control
plane and its tunnel. Rapid saves are debounced and builds run one at a time;
changes during a build trigger another pass. Wait for `[mars-ui] UI bundle
updated`, then refresh the control-plane/tunnel page—no `bun run dev` restart is
needed. Direct Vite pages continue to use HMR. Build errors appear in the web
process logs; fix the error and save again to rebuild.

Dashboard recovery and navigation:

- Dashboard URLs support direct navigation and refresh, including nested paths
  and trailing slashes; visiting `/` first is not required. The control plane
  serves the client shell after API routes. Missing `/api` endpoints and asset
  files still return errors rather than dashboard HTML.
- Authenticated setup-status failures show a retry control rather than a blank page.
- Settings keeps the normal navigation and workspace picker. Select a concrete GitHub
  workspace before managing its installation; no installation is chosen automatically
  for All workspaces. The selection survives reloads, and uninstall confirmation names
  the affected account.
- Runs search, queued-time ranges, and runner ownership are filtered on the server
  before pagination, including All workspaces. Clear filters resets all three controls.
  Charts represent the loaded matching runs, not the complete history.
- **Runs → AI** (`/runs/ai`) is a separate file-routed page, defaulting to **Recent runs**
  for completed, failed, and skipped analyses, newest-enqueued first. **Queue** shows
  pending/running analyses oldest first. Both retain captured run attempt, repository,
  provider/model, metrics, and run links. They follow workspace scope (All workspaces
  includes memberships only), independently of Jobs filters and reporting windows.
  They refresh every five seconds while visible and paginate in the page's normal
  scroll flow. Overview and **Runs → Jobs** (`/runs`) no longer embed AI lists.
- Desktop and mobile sidebar navigation are generated from the TanStack file routes'
  `staticData.navigation` metadata. Labels, ordering, section (`primary` or `settings`),
  admin-only visibility, and contextual help live with each route. Nesting follows
  the generated route tree; the Runs index supplies **Jobs** and its AI child supplies
  **AI**. Only routes with navigation metadata appear; detail and timing routes remain
  reachable without becoming menu entries. The existing Vite router plugin generates
  `routeTree.gen.ts`; do not hand-edit that file.
- Each AI run and its current-attempt failure-analysis detail show total/input/output
  tokens, estimated USD spend, time to start, and time taken. Usage comes from the
  provider response; estimates use the per-analysis pricing snapshot, not today's
  provider configuration or an invoice. Missing usage or pricing is unavailable,
  not zero; explicitly zero-priced local calls can show $0.00 without reported usage.
  Time to start measures enqueue to worker claim, including evidence-readiness waiting.
  It advances while queued and freezes on claim. Time taken measures claim to analysis
  completion, including log retrieval/model work but excluding PR publishing; it advances
  while running and freezes on completion or failure. Work skipped before claim shows
  Not started and its wait, never an invented processing time. Historical missing or
  reversed timing evidence remains unavailable. Existing analysis timestamps/usage are
  reused; no schema migration or paid-call replay is required.
- Overview starts with time-window controls and the dispatcher card, without the
  introductory title block or Live workload panel. Six summary metrics use one row
  on wide screens, three columns on tablets, and two on phones.
  Qualify now / awaiting dispatch is one metric: eligible jobs / total queued jobs.
  Current pool checks show pool name and readiness; hover for platform, worker,
  and diagnostic reason. Rows are keyboard-focusable with accessible descriptions.
  Scheduling and previous-pass diagnostics share a collapsed disclosure; health
  warnings and queue exclusions remain visible. The three overview charts use
  180px plots and share one row on wide screens, stacking on narrow screens.
- Overview Queue p50/p95 use observed job pickup minus queued time, with pickup
  inside the selected reporting period. Duration p50/p95 use completed minus
  started time for completed jobs in that period, including failed jobs. Missing
  or reversed timestamp pairs are excluded; no samples returns zero. All workspaces
  aggregates only organizations where the current user has membership.
- Overview's Time to start chart plots queue-wait p50/p95 by job start time:
  hourly buckets for 24h, daily buckets for 7d/30d. Empty buckets have no samples
  and break the lines rather than reporting zero wait. Hover a point for the
  bucket timestamp, percentile waits, and number of jobs started. The chart uses
  the same reporting-period and workspace scope as the overview queue metrics.
- Job and step logs retain all loaded chunks. Search covers loaded output; steps with
  unsearched or partially loaded logs stay available to expand and load more output.
- Pool create/edit and delete dialogs support Escape, modal focus, and focus restoration.
  Invalid pool fields show inline feedback; uppercase SHA-256 hex is normalized on save.
- Run-detail tabs support Left/Right arrows, Home, and End.

Pipeline failure analysis is configured in **Settings** by a global administrator.
Provider profiles are deployment-wide; use an API-root URL and model ID. Local
OpenAI-compatible servers must be reachable from the control-plane host/container,
not the browser. HTTP endpoints are permitted for local setups but expose prompts
and responses in transit; use HTTPS for cloud providers. A repository opt-in
acknowledges that bounded failed-job log excerpts are sent to the selected
provider and that evidence-grounded AI suggestions may be published to associated
pull requests by the installed MARS GitHub App. Only newly completed failures
after opt-in are analyzed; no historical backfill or automatic retry is performed.

LM Studio profiles use the native server's model-discovery HTTP API and the official
SDK's WebSocket model-management endpoint at the same API root (remove `/v1` and use
`ws`/`wss`; reverse-proxy prefixes are preserved). Expose both routes to the control
plane. Generation remains OpenAI-compatible HTTP. Authentication uses the saved
profile's native LM Studio token, not an ambient `LM_API_TOKEN`.
Automatic loading requests full GPU weight offload, disables CPU expert offload,
VRAM-cap fallback, and automatic fitting. It preserves other operator load settings.
The effective load configuration is checked before sending logs or source for
inference. Existing partial-offload or capped instances fail visibly; MARS does not
unload or replace them. Insufficient GPU memory is a load failure, not permission to
silently fall back to CPU. Load a fitting model with full offload in LM Studio.


Pull-request review has independent repository opt-in and **Enable all PR reviews**
controls in **Settings**; CI failure-analysis enablement never enables it.
Both PR controls default off. Administrators select a saved PR provider separately.
The global control requires a selected provider and source-sharing acknowledgement,
overrides local PR selections for all available, approved repositories (including
newly discovered ones), and preserves their individual settings. Turn it off to use
local opt-ins again; turn it off before changing the global PR provider.
Enabling is prospective and does not backfill open PRs.
Eligible opened, reopened, ready-for-review, and synchronized revisions
may be reviewed; drafts, closed PRs, and description-only changes are not reviewed.
An authorized repository writer can also request the current revision by posting a
standalone `/review` PR-conversation comment. Publication is advisory: MARS uses GitHub
COMMENT reviews and never approves, requests changes, blocks CI, applies suggestions,
executes repository code, commits, pushes, or merges.
Repeated `/review` commands reuse pending, running, or existing same-revision work;
they do not authorize another model call or a duplicate review. Commands from bots,
users without current write/maintain/admin access, ordinary issues, quoted text,
prose, fenced code, or comments with arguments are ignored.

Opting in shares PR metadata and bounded source code with the selected provider,
including private-repository content and changes originating from forks. Reviews are
limited to validated findings, with at most 20 findings and only findings at or above
60% model-estimated confidence published. The confidence is not calibrated probability.
Reviews use fixed limits of 40 changed files, 32 KiB per source file, 64 KiB
total context, and 8 KiB for `.mars/pr-rules.md`; oversized rules fail visibly
instead of being truncated. Partial file or context coverage is reported explicitly.
`.mars/pr-rules.md` is optional guidance from the PR base revision and cannot override
policy. The rules file is fetched from the immutable base commit, never the PR head.
A proposed rules-file change does not govern its own review. Missing rules use
built-in criteria; permission, unsupported-content, and size failures are visible
errors. Provider usage/cost uses the captured provider pricing and reported tokens;
unknown usage/pricing is shown as unavailable, not free. Existing reviews remain tied
to the exact reviewed commit.

The GitHub App needs `pull_request` and `issue_comment` webhook subscriptions and
existing installed Apps may need their subscriptions refreshed in GitHub App settings;
updating the generated manifest alone does not change existing installations.
Check installation permissions for source reads (`contents: read`), review publication
(`pull_requests: write`), and collaborator permission lookup (`metadata: read`, granted
by GitHub Apps). PR-conversation delivery does not require `issues: write`. Keep the
existing App's unrelated feature permissions separate from the review processor:
the processor exposes no repository mutation APIs. Each publication is one
commit-pinned batch; interrupted/unknown publication outcomes are reconciled by the
App-owned marker, bot identity, and commit ID and are never blindly reposted.

Generation requests have a 10-minute whole-request deadline, including response
body reads. Bun's separate socket-idle timer is disabled for generation so the
abort controller owns that bound; running analyses are considered interrupted after
15 minutes, leaving time for context/model loading. Unknown GitHub publication
recovery remains at five minutes. Use a configured model that
returns final structured JSON within the generation limit; reasoning-only output
is not a completed review or diagnostic. Failed attempts remain visible.
`/review` cannot rerun the same captured revision, including failed attempts;
an author-driven new revision is required for another analysis.

Drain running analyses before rolling back to shorter generation/interruption
limits. Failed attempts and published history remain durable; a rollback must not
force another request for an already attempted PR revision.

Schema rollout is additive (`0011_blue_centennial`, `0013_aspiring_the_hood`):
run `packages/db`'s `db:migrate` before starting the control plane. Disable the
global PR control before rolling back to an application without that feature.
Keep its table/settings and the migration journal; rollback does not require
deleting PR-review records, repository opt-ins, or existing CI-analysis data.

Run `bun run dev:worker` on Windows x64/ARM64, Apple Silicon macOS, or Linux
x64/ARM64. It chooses the existing worker runtime for the host; the worker
reports its actual runtime capabilities to the control plane. Host-specific
runtime prerequisites still apply.

### Run a foreground Windows development worker

On a Windows host, set the same `MARS_DEV_TOKEN` used by the development control plane at `https://mars.snazzie.space`. That deployment must run the current checkout's `scripts/control-plane-dev-entry.ts` and shared worker contracts; an older deployment can reject a valid worker doctor report with HTTP 400. A production deployment or mismatched token cannot enroll this worker. The launcher does not select or switch Docker engines: the worker discovers and advertises the active Linux Docker engine even without an image (the capability remains not ready). To prepare the local Windows job image explicitly, switch Docker to the Windows engine yourself and run with `MARS_DEV_BUILD_WINDOWS_IMAGE=true`; the development image-payload adapter must be available. To run Linux Docker jobs, provision a verified digest-pinned image for the engine architecture and set `MARS_LINUX_ARM64_CONTAINER_IMAGE` or `MARS_LINUX_X64_CONTAINER_IMAGE` before starting the worker. With a matching image configured and an active Linux engine, the launcher creates the missing `MARS_LINUX_CONTAINER_NETWORK` (default `mars-linux-arm64` or `mars-linux-x64`) before starting the worker. The development `MARS_LINUX_ARM64_JOB_IMAGE` value also supplies the ARM64 container image.

In a separate terminal from `bun run dev`, run from this checkout:

```powershell
bun run dev:worker
```

The Windows development launcher starts the Mars system tray alongside the worker
and closes it when the launcher exits. The tray's **Pause New Leases** /
**Resume New Leases** actions use
`%LOCALAPPDATA%\Mars\dev-worker\lease-pickup.json`; this local pause persists across
restarts. It is independent of the dashboard's server-side drain flag: a worker
can be resumed in the dashboard but still have local pickup paused. Use the tray
to clear a local pause. Restart an already-running development launcher after
updating the tray integration.

The Windows worker publishes running-lease counts separately in
`lease-pickup.json.inventory.json`, so doctor reports cannot overwrite tray pause
preferences. Tray reads allow atomic file replacement on Windows. Failed tray
saves show an error instead of silently ignoring the action.

The worker detail and fleet/pool views include the reported local pickup pause.
Online adopted workers refresh every five seconds, so tray changes appear without
reloading the page. **Pause in dashboard** / **Resume in dashboard** control only
the server-side drain flag; a local pause blocks dispatch readiness independently.

Run the native tray transition regression on Windows:
`powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File tests/windows-worker-tray.test.ps1`.
Also run `bun run typecheck` from the repository root before pushing runner
changes. The Windows smoke workflow checks every workspace, including the control
plane; a frontend-only typecheck does not cover worker configuration HTTP routes.

To use the control plane from this checkout instead of the default remote development deployment, start `bun run dev` with PostgreSQL and the development environment configured, then run `$env:MARS_DEV_CONTROL_PLANE_URL = 'http://127.0.0.1:3000'` before launching the worker. Use the same `MARS_DEV_TOKEN` in both processes. Pushing a worker change to `main` does not update an already-running control plane at `mars.snazzie.space`; it must be updated and restarted before it can parse new doctor fields.

Linux container jobs embed `mars-job-agent` in the digest-pinned job image. Updating
this checkout or restarting the orchestrator does not update that embedded binary.
After changing job-agent trust configuration, rebuild and publish the job image,
set `MARS_LINUX_ARM64_JOB_IMAGE` (or `MARS_LINUX_ARM64_CONTAINER_IMAGE`) to its new
digest, then restart the foreground worker after active jobs finish. An explicitly
set `MARS_LINUX_ARM64_CONTAINER_IMAGE` takes precedence over
`MARS_LINUX_ARM64_JOB_IMAGE`. For Linux, leave `http.sslBackend` unset: Ubuntu Git
uses GnuTLS, and installing the OpenSSL CLI does not change Git's supported backend.

Bun preserves inherited process variables ahead of `.env.development`. A stale
Windows user-level `MARS_LINUX_ARM64_JOB_IMAGE` can therefore override the image
pin in this checkout, including after a worker restart from the same terminal.
When changing a persistent user-level pin, refresh the current PowerShell session
before launching the worker; existing worker processes retain their old value:

```powershell
$env:MARS_LINUX_ARM64_JOB_IMAGE = [Environment]::GetEnvironmentVariable('MARS_LINUX_ARM64_JOB_IMAGE', 'User')
bun -e 'console.log(Bun.env.MARS_LINUX_ARM64_CONTAINER_IMAGE?.trim() || Bun.env.MARS_LINUX_ARM64_JOB_IMAGE?.trim())'
bun run dev:worker
```

The command runs the orchestrator in the foreground; without a ready runtime it can enroll and report capabilities but cannot run jobs. It does not install, stop, or modify the `MarsWorker` service; it refuses to start while that service is running. Its separate worker identity and image manifest live in `%LOCALAPPDATA%\Mars\dev-worker`. On first join, approve and configure the pending worker in the control plane before it is schedulable. Press Ctrl-C to stop the foreground worker. The production installer remains the supported path for service workers.

On restart, the launcher checks the saved worker's admission state using `MARS_DEV_TOKEN`. If revoked, it archives the identity as `worker-identity.json.revoked-<worker ID>` and creates a fresh identity and a new pending worker for approval; the machine UUID remains stable. It does not replace an active worker or reset its identity when the admission check fails; verify the URL and token if the check returns an error. A remote control plane with older worker contracts may reject the new join with HTTP 400; update and restart that deployment or use the local control plane.

### Run a foreground macOS development worker

On an Apple Silicon Mac with Bun, Tart, Xcode Command Line Tools, and prepared macOS and Linux Tart images, set `MARS_DEV_TOKEN` to the token used by the development control plane at `https://mars.snazzie.space`. Place the corresponding `macos-tart-image-manifest.json` and `linux-arm64-tart-image-manifest.json` in `~/Library/Application Support/Mars/dev-worker` (copy them from an installed worker before uninstalling it). If an installed worker exists, drain it and wait for active jobs to finish before manually unloading its LaunchAgent with `launchctl bootout "gui/$(id -u)/com.mars.worker"`. This command refuses to run while the LaunchAgent is loaded and never changes it.

```bash
bun run dev:worker
```

The command builds the menu-bar status item locally and runs the macOS orchestrator in the foreground. It prints worker commands, lease lifecycle events, and live job output to the terminal (resource samples stay quiet); these console logs are enabled only for the development worker. It uses the prepared local Tart images and development manifests without modifying them. Its own identity, UUID, lease state, and cache live under `~/Library/Application Support/Mars/dev-worker`; the first join uses the development token and requires approval and configuration in the control plane before scheduling. Press Ctrl-C to stop it. If retaining an installed worker, restore it afterward with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.mars.worker.plist"`. The macOS installer remains the supported path for a persistent worker.

### Run a foreground Linux development worker

Set `MARS_DEV_TOKEN` to the development control plane's token and run
`bun run dev:worker`. Linux x64 uses the existing libvirt VM worker and requires
`MARS_GOLDEN_DISK`, `MARS_GOLDEN_DIGEST`, `MARS_DOMAIN_TEMPLATE`,
`MARS_CLONE_ROOT`, `MARS_CHANNEL_ROOT`, and `MARS_LIBVIRT_NETWORK`.
Linux ARM64 uses the existing Docker worker and requires
`MARS_LINUX_ARM64_CONTAINER_IMAGE` (immutable digest) and
`MARS_LINUX_CONTAINER_NETWORK`. The ARM64 job image built from
`images/jobs/linux-arm64/Containerfile` includes `tar`, `gzip`, and `unzip`,
plus browser runtime libraries for GLib, NSPR/NSS, ATK/AT-SPI (including
ATK Bridge), D-Bus, X11, GBM, XCB, xkbcommon, ALSA, CUPS, Cairo, and Pango.
Liberation fonts provide a fallback for browser text rendering.
Browser binaries are not bundled.
JavaScript actions use the runner's bundled runtime; workflows should use
`actions/setup-node`, `actions/setup-python`, or `actions/setup-java` for
language toolchains. Docker-based container actions and service containers
are not supported in these jobs; the job container has no Docker socket.
Rebuild and deploy the image, then update the configured digest to use it.
These runtimes currently require their image and host prerequisites before
enrollment; the launcher does not provision them.
The development identity and cache live under `~/.local/share/Mars/dev-worker`,
separate from an installed worker. Distinct `mars-dev` VM/container prefixes
prevent the development worker from taking over installed worker guests. Review
and approve the new worker in the UI before scheduling.

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

Windows worker network reconnects from the same running process keep an acknowledged configuration ready; no dashboard Apply is needed. A `MarsWorker` process or control-plane restart replays the durable desired configuration before scheduling because in-memory runtime limits must be restored. If the worker remains unready, inspect its doctor capability/remediation and configuration failure rather than repeatedly applying unchanged settings.

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

Queued GitHub job discovery runs immediately at startup, then on the in-process
Bun cron schedule `JOB_QUEUED_DISCOVERY_CRON` (default `*/5 * * * *`, every five
wall-clock minutes). A still-running discovery is not started twice. Discovery
runs independently of the dispatch pass: a slow discovery does not prevent
already-queued eligible jobs from being reserved. Newly ingested jobs request
an immediate dispatch pass. Check the control-plane logs for
`Queued GitHub job discovery started` and `Queued GitHub job discovery finished`
when diagnosing delayed ingestion.

The dispatcher normally routes queued jobs whose parent run is queued or in
progress. A worker finishing one job does not finish its workflow run: GitHub
can create downstream jobs later. Only GitHub's terminal run status completes
the parent. For older locally completed runs with a queued job, dispatch first
checks the current GitHub run and job, then restores the run if still active.
If a queued job is absent from the dispatch queue, compare its parent run state
and the `Queued GitHub job webhook` log before investigating worker availability.

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

Log responses use `Cache-Control: no-store`.

`GET /api/workers/:workerId/health` returns the global-admin-only worker
health snapshot. Add `?configuration=1` to include `configuration.state` and
`configuration.failureReason`; without it, the response retains the original
shape for older dashboards. The reason is `null` unless the current
configuration command failed and reported a matching reason. Unknown workers
return 404; the response uses `Cache-Control: no-store`.

The development control-plane entry point enables the admin log buffer and
prefixes console output with UTC ISO-8601 timestamps, as does the worker entry
point. For websocket code `1008`, filter admin logs by worker ID: the frame
failure includes the frame type, connection epoch, and error without recording
the frame body; the close record includes code, reason, and whether the socket
was current. Logs are process-local and disappear when the control plane exits.

Worker lifecycle events describe the runner lease, not the GitHub job outcome.
Sandbox attestation does not mean GitHub assigned a job, and `runner.finished`
(including exit code `125`) only completes or fails the lease and schedules
cleanup. GitHub webhooks and authoritative discovery own job/run status. A job
still queued on GitHub remains eligible for dispatch after lease cleanup.

Application query modules register fixed `defineQueries` families at module load.
Import every required query module before calling `createDb` or
`createDbFromClient`: startup compiles their explicit Drizzle builders once per
client. Request handlers execute the cached statements with placeholders; late
query registration is an error, not a lazy-compilation fallback. Do not use
`db.query.*` or the removed callable SQL client for application persistence.
Transaction callbacks reuse the database identity and cached queries, including
nested savepoints; `$client` raw SQL is for migrations and administrative fixtures.
PostgreSQL-specific expressions (including JSONB traversal, aggregate/window
functions, and advisory locks) may use `sql` fragments inside these fixed
builders. Schema migrations retain raw SQL. Worker-local Bun SQLite caches are
outside this PostgreSQL migration.

All-workspace Overview keeps `"all"` in the response only. Timeseries, outcomes,
and running-container queries bind a null organization UUID and scope rows by
the signed-in user's memberships; an `OR` guard cannot make `"all"` a valid UUID.

Run PostgreSQL-backed persistence regressions against a migrated, disposable test
database:

```sh
MARS_E2E_DATABASE_URL=<url> bun test packages/db/src/prepared.integration.test.ts tests/job-pickup.e2e.test.ts tests/runner-completion.e2e.test.ts
```

Prepared-query tests use a test-owned schema and remove it afterward. Pickup
fixtures roll back or delete their own rows; runner-completion fixtures roll back.
Coverage includes transaction isolation, rollback/savepoints, membership-scoped
resource trends, queued-job pickup, command replay, successful/failed runner exits,
duplicate exits, cleanup, dispatch eligibility, and GitHub completion ordering.

Run the Overview scope regression with
`MARS_E2E_DATABASE_URL=<url> bun test packages/db/src/dashboard.integration.test.ts`.
It compares aggregate and single-workspace results across all reporting periods
and verifies that nonmember jobs stay excluded. Its temporary tables disappear
when the fixture transaction ends.

### Container failure evidence and memory resilience

Select a job in the run graph to see **Runner failure evidence**. Container
termination now retains the exit code, Docker `OOMKilled` flag, runtime error,
start/finish timestamps, RAM and Linux RAM-plus-swap limits, and Docker wait or
inspection failures. Exit `137` alone is not classified as OOM: only Docker's
OOM flag or explicit OOM evidence confirms that reason. Missing inventory is
reported as `runner_lost`, not as a proven crash. GitHub remains authoritative
for the job outcome.

Worker health includes `connection.lastDisconnect` after a disconnect is
observed: UTC timestamp, WebSocket close code, and sanitized close reason.
The control plane stores this in PostgreSQL and retains it through reconnects
and subsequent doctor reports. A heartbeat timeout cannot distinguish a
network outage, stalled worker, process crash, or host reboot by itself.

Container diagnostics are captured before terminal events can trigger cleanup.
They include bounded Docker state/limits, the last 2,000 timestamped console
lines, copied `Runner_*.log` / `Worker_*.log` tails, and the Windows guest service
log when available. Copying works with stopped containers; no `docker exec`
or indefinitely following log stream is needed. Known credential assignments,
Bearer authorization values, and signed URL tokens are redacted. Treat remaining
workflow output as sensitive; restrict archive directory access and Windows ACLs.

Workers save up to 100 distinct bundles, each capped at 10 MiB, named
`<leaseId>-<bundleId>.log`. Repeated attempts do not overwrite earlier bundles.
Set worker `MARS_DIAGNOSTICS_ROOT` to persistent storage; otherwise Windows uses
`<bootstrapRoot>/diagnostics` (normally
`C:\ProgramData\Mars\leases\diagnostics`) and Linux uses
`<temporary-directory>/mars-linux-{arm64,x64}/diagnostics`. The ARM64 broker
Compose file sets `/var/lib/mars/diagnostics` in its existing state volume.
Startup orphan reconciliation archives a **pre-cleanup snapshot** before deleting
an abandoned container; inspect these worker-local bundles after a worker crash.
The control plane also stores uploaded chunks under
`<MARS_DIAGNOSTICS_ROOT-or-DATA_ROOT/diagnostics>/<workerId>/<diagnosticId>/`,
with `metadata.json` identifying the job and lease. Its existing diagnostics
retention defaults to three days.

Linux Docker containers now explicitly bound swap:

- Unset/empty `MARS_LINUX_CONTAINER_SWAP_BYTES`: allow extra swap equal to the
  lease RAM limit, matching Docker's existing implicit default.
- `0`: disable container swap (`--memory-swap` equals `--memory`).
- A nonnegative integer: allow that many extra swap bytes per container.
  Docker's `--memory-swap` value is **RAM + swap**, not swap alone.

Verify `swapon --show --bytes` on the **Docker engine host** and Docker's swap-limit
support before relying on the allowance. Docker Desktop Linux needs swap in its
Linux VM/WSL environment; paging on the Windows host alone does not establish
guest swap availability. Provision host swap with the host's normal administration
tools. Mars does not run privileged `swapon` commands or change system paging
settings automatically. A host reporting no swap-limit support logs a warning.
Swap is an emergency cushion, not schedulable RAM or a replacement for adequate
RAM and concurrency headroom; the OOM killer remains enabled.

Windows containers do not support the Linux swap flag. Keep host paging enabled
and use a system-managed page file unless the host's operational policy requires
otherwise. Increase pool RAM or reduce concurrency when failures demonstrate
container memory exhaustion; a host page file does not remove a container's hard
RAM limit. For unexplained process/host loss, correlate the archived timestamps
with Windows System/Application events (service termination, HCS/Hyper-V, resource
exhaustion) or Linux kernel/service journals. No archive can prove a root cause
that the runtime or host never recorded.



Useful commands:

```bash
bun run typecheck
bun run lint
bun test
bun run build
```

