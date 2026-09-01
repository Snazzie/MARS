# Task 6 Release Safety Report

## Findings fixed

- Added a separate `candidate-observability` job that uses an empty Docker config and anonymously pulls/inspects both the control-plane and Linux broker candidate GHCR manifests before promotion.
- Staged the app release as a draft/non-latest release while metadata is uploaded; image promotion runs with rollback of prior latest digests and release state on failure, then app and worker releases are finalized only after both latest promotions succeed.
- Kept the worker release prerelease until mutable image promotion and app finalization succeed; the rollback trap restores both release states and any prior latest image digests if finalization fails.
- Made worker manifest loading enforce the exact `https://github.com/Snazzie/MARS/releases/download/worker-v<semver>/` path for every hashed platform payload URL. `releases/latest`, foreign repositories, foreign tags, credentials, query/fragment URLs, and nested paths are rejected after schema validation. GitHub host/repository casing remains accepted. Local development file manifests retain their existing override path.

- Rollback safety requires both existing `:latest` tags to have a confirmed digest; explicit GHCR manifest-not-found and all transient/auth/invalid-digest lookup errors abort before any promotion. No unsupported Docker tag-removal command is used.
- Rollback mutation flags are set before each tag write, digest mismatches fail through the ERR trap, and rollback errors are surfaced and cause the run to remain failed rather than being silently ignored.

## Focused verification

- `bun test apps/control-plane/src/worker-release.test.ts apps/control-plane/src/http/app.test.ts tests/release-mars-workflow-contract.test.ts tests/control-plane-deployment-contract.test.ts` — 118 pass, 0 fail.
- `powershell.exe -NoLogo -NoProfile -File tests/windows-proxy-url-policy.test.ps1` — `WINDOWS_PROXY_URL_POLICY_OK`.

An earlier isolated app timeout assertion was transient (`bodyCancelled` remained false); the same focused app test and the complete focused command passed on rerun. `pwsh` is unavailable; Windows PowerShell 5.1 executed the contract test successfully.
