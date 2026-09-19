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
- **Hyper-V VM** creates a disposable Generation 2 VM and differencing VHDX for
  each lease from a verified, read-only parent template. Docker is not installed
  or used by this mode.

Choose the runtime in the dashboard's Windows enrollment panel. The generated
PowerShell command passes `-WindowsRuntime 'container'` or `-WindowsRuntime 'vm'`;
upgrades preserve that selection.

The VM mode requires Windows 11 Pro or Enterprise, Hyper-V, Administrator access,
and a usable virtual switch. It uses `Default Switch` unless
`MARS_HYPERV_SWITCH_NAME` is set on the worker host before installation. Prepare
the parent VHDX with `deploy/workers/prepare-windows-hyperv-template.ps1`; the
script verifies the source image and Actions Runner archive, installs the Mars job
agent and runner, generalizes the guest, and emits the sealed VHDX plus manifest.
Configure the control plane with `MARS_WINDOWS_TEMPLATE_PATH` or
`MARS_WINDOWS_TEMPLATE_URL` and its SHA-256 value. Production release manifests
may provide the same artifact as `windows.vm.template`; Docker-only releases
remain valid.

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
