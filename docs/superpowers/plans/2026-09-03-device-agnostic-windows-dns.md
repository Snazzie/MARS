# Device-Agnostic Windows Container DNS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Windows job containers use DNS servers from the host's currently active network adapters, with explicit configuration retained as an override.

**Architecture:** The Windows worker discovers active IPv4/IPv6 DNS servers on the host immediately before each container creation. The container driver passes the discovered servers through Docker `--dns`; `MARS_WINDOWS_CONTAINER_DNS_SERVERS` remains an explicit override. If discovery yields no usable servers, use the existing explicit list only and fail clearly when none is configured.

**Tech Stack:** Bun/TypeScript, PowerShell, Docker Windows containers, Bun tests.

## Global Constraints

- Do not hardcode Ethernet, Wi-Fi, VPN, hotspot, or site-specific DNS addresses.
- Preserve explicit `MARS_WINDOWS_CONTAINER_DNS_SERVERS` override behavior.
- Existing container creation ordering and resource validation remain unchanged.
- Add tests before production code and verify the failing behavior first.

---

### Task 1: Active DNS discovery

**Files:**
- Modify: `apps/orchestrator/src/windows-container.ts`
- Modify: `apps/orchestrator/src/windows-container.test.ts`
- Modify: `apps/orchestrator/src/windows-agent.ts`

**Steps:**
- Add a failing test for parsing active adapter DNS output and selecting non-empty valid IP addresses.
- Add a failing test proving container creation uses discovered DNS when no explicit override is configured.
- Implement a host DNS discovery helper using PowerShell `Get-DnsClientServerAddress -AddressFamily IPv4,IPv6`, filtering adapters with usable DNS addresses and deduplicating results.
- Resolve DNS immediately before Docker create; explicit `dnsServers` takes precedence.
- Keep Docker `--dns` absent only when neither override nor discovery yields a usable address, and throw a clear configuration error before creating the container.
- Run `bun test apps/orchestrator/src/windows-container.test.ts apps/orchestrator/src/windows-agent.test.ts`.
- Commit as `fix(windows): discover active container DNS`.

### Task 2: Installer and live configuration

**Files:**
- Modify: `deploy/workers/install-worker.ps1`
- Modify: `.env` only for local development configuration if needed

**Steps:**
- Keep installer propagation of `MARS_WINDOWS_CONTAINER_DNS_SERVERS` for explicit overrides.
- Ensure no device-specific resolver is embedded in installer defaults.
- Run `bun test tests/installer-arguments.test.ts`.
- Commit only if installer changes are required.

### Task 3: Verification

- Run focused orchestrator and installer tests.
- Build the orchestrator worker.
- Create a new Windows container on the active hotspot and verify Docker inspect shows DNS servers matching active host configuration.
- Verify the runner diagnostic log reaches the GitHub broker without `HostNotFound`.
