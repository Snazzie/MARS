# PostgreSQL Compose Auto-Start Design

## Goal

Ensure the PostgreSQL container restarts automatically whenever the Docker daemon or host starts, including after an intentional container stop.

## Scope

Update the `postgres` service in the root `compose.yaml` only. No Windows Task Scheduler task, service wrapper, startup script, or control-plane lifecycle change is required.

## Design

Change the PostgreSQL service restart policy from `unless-stopped` to `always`.

The existing Compose stack already defines the PostgreSQL container, persistent volume, healthcheck, and loopback-only port binding. The restart-policy change preserves those behaviors while making Docker restart the container after daemon/host startup even if it had previously been stopped intentionally.

The stack must still be created once with:

```text
docker compose up -d postgres
```

Docker Desktop must be configured to start with Windows for host-boot auto-start to occur.

## Alternatives considered

- Keep `unless-stopped`: restarts after crashes and daemon restarts unless the container was intentionally stopped; does not meet the requested behavior after an intentional stop.
- Add Windows Task Scheduler or a service wrapper: can launch Compose at logon/boot, but adds platform-specific operational code outside the requested Compose change.

## Verification

Validate the Compose file and confirm the rendered PostgreSQL service has `restart: always` without altering its environment, volume, port, or healthcheck configuration.
