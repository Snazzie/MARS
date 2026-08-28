# Task 2: Environment-aware Windows upgrade URLs

## Status

Implemented and committed as `a943379` (`feat: use local installer for dev upgrades`).

## Implementation

- Updated `buildWindowsUpgradeCommand` in `apps/web/src/components/WorkerActions.tsx` with an optional `localDevelopment` argument defaulting to `import.meta.env?.DEV ?? false`.
- Development mode now downloads from the selected connection origin's installer route with:
  - `audience=windows-x64`
  - `runtime=container`
  - URL-encoded `connectOrigin`
- Production mode continues to use the immutable GitHub release installer URL.
- The selected connection origin remains the PowerShell `-ControlPlaneUrl` value and is normalized through `URL.origin`; the existing HTTP validation and `-AllowInsecureHttp` behavior remain intact.
- Download protocol handling remains safe: production/HTTPS downloads use HTTPS plus TLS 1.3; explicitly selected HTTP development origins use the HTTP protocol opt-in. Existing temporary-file cleanup, download failure check, upgrade flags, and PowerShell quoting were preserved.
- Added focused tests covering local development endpoint generation and production GitHub release URL selection.

## Verification

- Baseline focused test before changes: `bun test apps/web/src/components/WorkerActions.test.tsx` — **3 pass, 0 fail, 11 expect() calls**.
- Final focused test after changes: `bun test apps/web/src/components/WorkerActions.test.tsx` — **5 pass, 0 fail, 17 expect() calls**.

## Concerns

None identified for the assigned scope.
