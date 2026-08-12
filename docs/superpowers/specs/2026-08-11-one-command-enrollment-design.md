# Stable bootstrap worker requests

## Goal

Worker enrollment uses one deployment-wide bootstrap code as first-stage request authentication. The same code can submit multiple worker requests. Every request remains inert until a global administrator explicitly approves it.

The Workers enrollment dialog is the setup and rotation surface. It displays the code and complete platform-specific commands exactly once. If they are lost, rotation is the only recovery path.

## Hono HTTP architecture

Hono 4.13.1 owns every ordinary control-plane HTTP request. `createControlPlaneApp(deps)` composes a Hono API app rooted at `/api` for health, OAuth, GitHub webhooks, dashboard resources, worker bootstrap and requests, approval, and installer downloads.

All backend endpoints live below `/api`; the existing root health endpoint moves cleanly from `/healthz` to `/api/healthz`. API routes return JSON or explicit artifact responses, and API not-found responses never fall through to the SPA.

Hono also serves the SPA shell, built assets, and client-route fallbacks at their browser-facing paths outside `/api`. Bun retains only WebSocket upgrade dispatch and the existing socket callbacks, with WebSocket endpoints remaining below `/api/v1`.

Protected Hono route groups use session middleware that sets a typed authenticated-user context variable. Public routes are explicit: health, OAuth start/callback, GitHub webhook delivery, worker bootstrap request submission, and installer artifact download. Route tests call `app.request()` without starting a network server.

## Accepted tradeoff

The bootstrap code is intentionally included in copied installer commands. It may appear in the clipboard, shell history, and installer process arguments. This is accepted for private-machine provisioning.

The code authenticates only a request. Possession never authorizes jobs, JIT credentials, management APIs, organization access, or scheduling.

## Bootstrap code lifecycle

Setup generates one random 256-bit bootstrap code for the control-plane deployment. Whitesmith displays the plaintext once and stores only:

- its SHA-256 hash;
- creation and rotation timestamps;
- the global administrator responsible for setup or rotation;
- audit metadata that never contains the plaintext.

Whitesmith does not store encrypted or plaintext code and cannot reveal it later.

Rotation generates and displays a replacement once and atomically invalidates the previous hash for new requests. Requests already recorded as pending remain pending for explicit approval or rejection. Losing the code or saved commands requires rotation.

## Command generation

During setup or rotation, Whitesmith emits Linux, Windows, and macOS command blocks containing the same bootstrap code:

- `macos-arm64`: download to a temporary file, then run `zsh <file> --code <code>`.
- `linux-x64`: download to a temporary file, then run `bash <file> --code <code>`.
- `windows-x64`: download to a temporary `.ps1`, then run PowerShell with `-Code <code>`.

The URL and code are quoted for the target shell. Loopback HTTP uses curl `--proto '=http'`; public installers require HTTPS and TLS 1.3. Temporary installer files are removed after execution.

After the show-once screen closes, the UI cannot regenerate a command because it no longer possesses the code.

## Installer interface

The POSIX installers require exactly `--code <value>`. The PowerShell installer requires `-Code <value>`. Missing, empty, duplicated, or unknown arguments fail before changing the machine.

Each installer clears its local code variable after submitting the request. The installer download URL remains code-free and public.

## Pending request admission

A valid bootstrap code may create multiple worker requests. Each request contains:

- worker public key and fingerprint;
- platform and runtime driver;
- stable machine or VM identity;
- reported capacity and doctor data;
- request timestamps and connection state.

The server stores no plaintext bootstrap code with the request. Repeated requests with the same public key and machine identity are idempotent and refresh the same pending record. Conflicting key or machine combinations create an auditable conflict instead of replacing identity.

Invalid bootstrap attempts are rate-limited without revealing whether a supplied value was close or previously valid.

## Administrative approval

Pending requests receive no jobs, JIT credentials, durable commands, management access, or organization data. A global administrator must inspect the fingerprint and machine details, assign the organization and limits, then approve or reject the request.

Approval binds the worker identity and preserves the existing adopted/configured/online scheduling gates. Rejection affects that request only; it does not rotate the deployment bootstrap code.

## Error handling

- Unsupported audience: command generation fails.
- Non-loopback HTTP installer URL: command generation fails closed.
- Missing or malformed code: installer exits before machine changes.
- Invalid or rotated code: request receives a generic authentication failure.
- Download failure: installer is not executed and its temporary file is removed.
- Duplicate request: existing pending identity is returned idempotently.
- Conflicting identity: request is rejected and audited.
- Lost code or commands: global administrator rotates; old code stops authorizing new requests.

## Verification

Automated tests cover:

1. POSIX and PowerShell quoting for codes containing shell metacharacters.
2. Platform-specific interpreter and code-argument syntax.
3. Loopback HTTP versus public HTTPS curl policy.
4. Missing, empty, duplicate, and unknown installer arguments.
5. Setup and rotation showing plaintext exactly once and persisting only its hash.
6. Reuse of one valid code for multiple distinct pending requests.
7. Idempotent replay for the same key and machine identity.
8. Conflict handling for mismatched key and machine identity.
9. Rotation rejecting new requests with the old code while preserving existing pending records.
10. Pending workers remaining unable to schedule or access protected channels.
11. Global-admin approval binding organization and limits.
12. Browser copy actions returning the exact displayed command blocks.
13. Every ordinary HTTP route through `app.request()`, including auth middleware and typed API errors.
14. `/api/healthz` succeeding while `/healthz` is absent and `/api/**` never receiving an SPA fallback.
15. Existing worker and browser WebSocket upgrades continuing through Bun at `/api/v1/**`.

Browser smoke tests generate setup and rotation commands for all platforms, copy each block, and confirm that a request appears as pending without receiving work before approval.
