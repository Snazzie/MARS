# Final review fix: local worker installer origins and Bun-safe mode detection

## Findings addressed

1. `WorkerActions` previously passed `window.location.origin` as both the browser origin and worker `connectOrigin`. During Vite development this made the copied upgrade command target the Vite server (`:5173`) even though the control plane served the installer and accepted worker connections on its own origin (`:3000`).
2. Both installer command builders read `import.meta.env?.DEV` directly. The web TypeScript configuration includes Bun types but not `vite/client`, so that access is not a type-safe contract for the Bun build/typecheck path.

## Implementation

- Added `apps/web/src/environment.ts` with `isLocalDevelopment()`. Vite's optional build-time `DEV` flag is accessed through an explicit `ImportMeta` extension; Bun's `NODE_ENV === "development"` is the fallback when Vite has not injected the flag; all other runtimes default to production behavior. Explicit boolean command-builder overrides remain unchanged and deterministic.
- Updated `EnrollmentPanel` and `WorkerActions` to use the shared resolver instead of direct `import.meta.env` access.
- Updated `WorkerActions.openUpgrade()` in local development to call the existing authenticated `getWorkerControlPlaneUrls()` API seam and use the first server-approved origin as both installer endpoint origin and encoded `connectOrigin`. Production continues to use the GitHub release installer and browser origin behavior.
- The generated local upgrade command therefore resolves to, for example, `http://localhost:3000/api/workers/installer?...&connectOrigin=http%3A%2F%2Flocalhost%3A3000`, while never embedding the Vite browser origin (`http://localhost:5173`).

## Regression coverage

- `WorkerActions.test.tsx`: verifies a Vite `:5173` browser with a `:3000` control plane downloads from `:3000`, encodes `connectOrigin=:3000`, passes `-ControlPlaneUrl :3000`, and contains no `:5173`; verifies Bun-safe default mode preserves the release URL.
- `EnrollmentPanel.test.ts`: verifies the shared Bun-safe default mode and release URL behavior when no explicit override is supplied. Existing explicit local-development tests continue to cover installer endpoint/query generation.

## Verification

- `bun test apps/web/src/components/EnrollmentPanel.test.ts apps/web/src/components/WorkerActions.test.tsx`
  - **21 passed, 0 failed, 73 expect() calls**.
- `bun run --filter @mars/web typecheck`
  - The changed files compile; the command remains blocked by an unrelated pre-existing `TS2578` at `apps/web/src/routes/OnboardingPage.test.tsx:61` (unused `@ts-expect-error` on restoring `globalThis.window`). No changed-file diagnostic was reported.

## Commit

Final review fix committed; exact hash is supplied in the completion handoff.

## Follow-up review fix

The scoped re-review found that `openUpgrade()` caught API/origin failures into the shared action `error` state, but that state is only rendered inside the separate action-confirmation dialog. A missing server-approved origin could therefore leave the user with no upgrade command and no visible explanation.

- Added dedicated `upgradeError` state.
- Upgrade preparation clears and sets `upgradeError`; action confirmation continues to use its independent `error` state.
- Rendered upgrade preparation failures as an inline `role="alert"` beside the worker actions, including when no upgrade dialog was opened.
- Closing an upgrade dialog or opening another action clears stale upgrade errors.
- Added a focused source regression test proving the dedicated alert is rendered outside the closed confirmation dialog.

Follow-up focused result: **22 passed, 0 failed, 75 expect() calls**.
