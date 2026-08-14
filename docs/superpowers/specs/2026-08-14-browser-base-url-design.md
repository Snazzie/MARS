# Browser Base URL Design

## Problem

Development runs the control plane at `http://localhost:3000` and Vite at `http://localhost:5173`. `PUBLIC_BASE_URL` correctly points GitHub callbacks, webhooks, worker enrollment, and API clients at port 3000. The same value is also used for browser destinations after OAuth and GitHub App setup.

That coupling sends the user from the current Vite UI to the control plane's separately built `apps/web/dist` bundle. When that bundle predates a frontend change, onboarding resumes in stale code. This caused the GitHub step to show the old `Register GitHub App` path after the fixed manifest flow was already available through Vite.

## Decision

Add an optional `BROWSER_BASE_URL` configuration value. It is the origin for successful human-facing browser destinations only. It defaults to `PUBLIC_BASE_URL`, preserving current production behavior without a new required setting.

Local development sets:

```text
PUBLIC_BASE_URL=http://localhost:3000
BROWSER_BASE_URL=http://localhost:5173
```

Both values must be absolute HTTP or HTTPS origins without credentials, path segments, query parameters, or fragments. Invalid values fail control-plane startup instead of producing unusable callback links.

## Routing Boundaries

`PUBLIC_BASE_URL` remains authoritative for machine-facing and inbound URLs:

- GitHub OAuth callback URL
- GitHub App manifest `redirect_url`, `setup_url`, and callback URLs
- GitHub webhook URL unless `GITHUB_WEBHOOK_URL` overrides it
- worker enrollment and installer control-plane URLs
- API origin and cookie security policy

`BROWSER_BASE_URL` is used for destinations where the server returns a person to the UI:

- successful GitHub OAuth completion, including safe `returnTo` paths
- onboarding resume when an approved installation already exists
- GitHub App installation completion
- repository-selection remediation
- non-onboarding GitHub installation completion back to the dashboard

Redirect destinations are constructed from the validated browser origin and repository-owned relative paths. Request input never supplies an origin.

## Components

- `apps/control-plane/src/index.ts` reads and validates both origins, defaulting `BROWSER_BASE_URL` to `PUBLIC_BASE_URL`.
- `ControlPlaneHttpDeps` gains `browserBaseUrl`; deterministic test dependencies default it to `baseUrl`.
- `GitHubAppService` receives `browserBaseUrl` separately from `baseUrl`. Manifest and webhook construction continue using `baseUrl`; existing-install onboarding resume uses `browserBaseUrl`.
- Authentication and GitHub HTTP routes use `browserBaseUrl` only for successful UI redirects.
- `.env` sets the Vite origin for local development. Production configuration remains backward compatible.

## Error Handling and Security

- Startup rejects non-HTTP(S) URLs, credentials, non-root paths, queries, and fragments.
- OAuth return paths remain allowlisted relative paths; they are resolved against the configured browser origin.
- Session and setup cookies retain their current scope and secure flag derived from `PUBLIC_BASE_URL`. Localhost cookies are shared across ports, so the session remains available after redirecting from port 3000 to 5173.
- API and worker traffic never use the Vite origin.

## Verification

Automated tests cover:

1. Default behavior when `BROWSER_BASE_URL` is absent.
2. Startup rejection for malformed browser origins.
3. OAuth callback redirect to the browser origin while its registered callback remains on the public origin.
4. Existing-install onboarding resume to the browser origin.
5. GitHub App setup success and repository-selection remediation redirects to the browser origin.
6. Non-onboarding installation completion to the browser dashboard origin.
7. Existing GitHub manifest, webhook, worker installer, and cookie-origin expectations remain unchanged.

Browser verification starts the normal development stack, completes the mocked GitHub return paths through port 3000, and confirms the final page is served by Vite on port 5173 with the current onboarding copy.
