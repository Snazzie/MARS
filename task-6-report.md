# Task 6 Release Safety Report

## Findings fixed

- Added a separate `candidate-observability` job that uses an empty Docker config and anonymously pulls/inspects both the control-plane and Linux broker candidate GHCR manifests before promotion.
- Reordered final release operations so app release creation/metadata upload and worker prerelease finalization complete before either mutable `:latest` image tag is changed. The exact immutable digests remain verified after promotion.
- Made worker manifest loading enforce the exact `https://github.com/Snazzie/MARS/releases/download/worker-v<semver>/` path for every hashed platform payload URL. `releases/latest`, foreign repositories, foreign tags, credentials, query/fragment URLs, and nested paths are rejected after schema validation. Local development file manifests retain their existing override path.
- Migrated the Windows proxy URL-policy fixture to schema-3 Windows container artifact parameters while retaining insecure/non-HTTP URL assertions, and aligned CI/README baked manifest examples to the exact canonical path.

## Focused verification

- `bun test apps/control-plane/src/worker-release.test.ts apps/control-plane/src/http/app.test.ts tests/release-mars-workflow-contract.test.ts tests/control-plane-deployment-contract.test.ts` — 116 pass, 0 fail.
- `powershell.exe -NoLogo -NoProfile -File tests/windows-proxy-url-policy.test.ps1` — `WINDOWS_PROXY_URL_POLICY_OK`.

`pwsh` is unavailable in this environment; Windows PowerShell 5.1 executed the PowerShell contract test successfully.
