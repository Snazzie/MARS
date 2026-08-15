# GitHub Rate-Limit Recovery Design

## Problem

The control plane repeatedly attempts GitHub JIT runner creation for every eligible queued job on each five-second reconciliation tick. When GitHub returns `403` because the installation's core quota is exhausted, the reservation is released immediately and the same job is retried on the next tick. Repository discovery also issues requests concurrently across the installation. This request storm consumed all 7,200 installation requests and prevented otherwise admissible `whitesmith-windows-x64` jobs from receiving JIT runner configuration.

The pool and workflow labels already match. The installed GitHub App has `administration: write`; permissions are not the failure.

## Decision

Introduce one process-wide, per-installation GitHub rate-limit gate shared by job discovery and JIT reconciliation.

The gate records `x-ratelimit-remaining` and `x-ratelimit-reset` from every GitHub response. When remaining reaches zero, or GitHub returns a rate-limit response, requests for that installation fail locally with a typed rate-limit error until the reset time. The error retains only status, reset time, and a stable code; it never retains tokens or response bodies.

JIT reconciliation processes at most one eligible queued job per installation per tick. A rate-limit error stops further work for that installation during the tick instead of retrying every queued job. Ordinary per-job failures remain isolated.

Repository discovery consults the same gate before starting repository work. A rate-limit error stops additional repositories for that installation without writing a misleading 24-hour repository permission failure. Permission-denied `403` responses continue to use the existing repository error path.

## Components

- `GithubRateLimitGate`: stores cooldown state keyed by installation ID, exposes a guarded fetch wrapper, and classifies rate-limit responses from headers and GitHub's rate-limit message.
- `GithubJobsClient`: preserves response status and rate-limit metadata through a typed error instead of reducing every `403` to `github_403`.
- Startup wiring: creates one gate and passes installation-scoped guarded fetchers to discovery and reconciliation.
- Reconciliation: bounds JIT attempts per installation per tick and stops that installation after a rate-limit result.
- Discovery: groups or coordinates repository work by installation and stops only the exhausted installation.

## Recovery and Observability

The current installation quota resets at `2026-08-15T03:21:12Z`. No local code can make GitHub accept JIT creation before that reset. After reset, the gate permits a probe request and normal work resumes automatically.

Logs report the installation ID and ISO reset time once when entering cooldown and once when resuming. They do not log installation tokens, JIT configuration, or GitHub response bodies.

## Verification

Focused tests must prove:

1. A zero-remaining response opens a cooldown until the supplied reset time.
2. Requests during cooldown perform no network call.
3. Separate installations do not block each other.
4. A rate-limit `403` is distinct from a permission `403`.
5. Reconciliation makes at most one JIT attempt per installation per tick and stops after rate limiting.
6. Discovery stops additional work for the exhausted installation without marking repositories as permission failures.
7. After the reset time, the next request is allowed.
8. Existing scheduler, discovery, GitHub Jobs client, and control-plane type checks pass.
