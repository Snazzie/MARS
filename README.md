# MARS

**MARS (Managed Action Runner System)** is a self-hosted control plane and worker platform for running GitHub Actions workloads on managed infrastructure.

The repository contains the control-plane API and dashboard, worker runtimes for supported host platforms, job-agent and orchestration components, deployment assets, and contract tests.

> **Development status:** MARS is an active development baseline, not a production-ready platform. Worker execution, GitHub workflow dispatch, and several end-to-end runtime gates remain incomplete. See [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) for the current evidence and remaining work.

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

- [Bun](https://bun.sh/) 1.2.20 or compatible
- Docker with Compose support for local PostgreSQL/control-plane runs
- Platform-specific worker prerequisites for Windows, Linux, or macOS development

Install dependencies:

```bash
bun install
```

## Local development

Copy the example environment file and set the required origins and database values:

```bash
cp .env.example .env
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

Useful commands:

```bash
bun run typecheck
bun run lint
bun test
bun run build
```

## Deployment

The supported control-plane deployment uses PostgreSQL plus a persistent data volume. Required configuration includes:

- `DATABASE_URL`
- `PUBLIC_BASE_URL`
- `GITHUB_WEBHOOK_URL`
- optional `WORKER_BASE_URL`

For the complete Unraid, ingress, onboarding, backup, health-check, and release instructions, see [`deploy/control-plane/README.md`](deploy/control-plane/README.md).

## Security and persistence

Keep `.env`, GitHub credentials, tunnel tokens, and the control-plane data volume out of source control. PostgreSQL and the control-plane data volume must be backed up and restored together because encrypted GitHub credentials depend on the persisted application master key.

## License

No license has been declared yet.
