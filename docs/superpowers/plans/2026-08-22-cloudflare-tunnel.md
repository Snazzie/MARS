# Cloudflare Tunnel Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support routing the complete public hostname, including GitHub webhooks, through a token-authenticated Cloudflare Tunnel to the HTTP control-plane service.

**Architecture:** Add an optional `cloudflared` Compose profile using a Cloudflare-managed tunnel token. Cloudflare terminates public HTTPS; `cloudflared` forwards internally to `http://control-plane:3000`. The persisted public origin remains HTTPS so GitHub callback and webhook URLs are valid.

**Tech Stack:** Docker Compose, Cloudflare Tunnel, Bun/Hono control plane.

## Global Constraints

- Tunnel routing targets `http://control-plane:3000` inside the Compose network.
- The public canonical origin remains `https://<domain>`.
- The tunnel forwards all paths, including `/api/github/webhooks` and WebSockets.
- The tunnel is optional; direct control-plane deployment remains supported.
- `CLOUDFLARE_TUNNEL_TOKEN` is the only tunnel secret input.

### Task 1: Compose and documentation

- Modify `deploy/control-plane/compose.yaml` with an optional `tunnel` profile and cloudflared service.
- Update `deploy/control-plane/README.md` with token setup, Cloudflare hostname ingress, HTTPS public-origin guidance, and webhook routing.
- Update `tests/control-plane-deployment-contract.test.ts` for the optional tunnel contract.
- Verify Compose config with and without the tunnel profile.
- Commit and push.
