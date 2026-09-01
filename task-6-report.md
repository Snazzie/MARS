# Task 6 Release Safety Report

## Findings fixed

- Added a separate `candidate-observability` job that uses an empty Docker config and anonymously pulls/inspects both the control-plane and Linux broker candidate GHCR manifests before promotion.
- Staged the app release as a draft/non-latest release while metadata is uploaded; worker finalization and image promotion complete before the app release is made final/latest, preventing a failed pre-promotion operation from leaving a final app release that blocks retry.
- Reordered final release operations so worker finalization completes before mutable image tags are changed; the exact immutable digests remain verified after promotion.
- Made worker manifest loading enforce the exact `https://github.com/Snazzie/MARS/releases/download/worker-v<semver>/` path for every hashed platform payload URL. `releases/latest`, foreign repositories, foreign tags, credentials, query/fragment URLs, and nested paths are rejected after schema validation. GitHub host/repository casing remains accepted. Local development file manifests retain their existing override path.

## Focused verification

- `bun test apps/control-plane/src/worker-release.test.ts tests/release-mars-workflow-contract.test.ts tests/control-plane-deployment-contract.test.ts` — 31 pass, 0 fail.
- `powershell.exe -NoLogo -NoProfile -File tests/windows-proxy-url-policy.test.ps1` — `WINDOWS_PROXY_URL_POLICY_OK`.

The focused `apps/control-plane/src/http/app.test.ts` run has an unrelated existing timeout assertion failure at line 1148 (`bodyCancelled` remained false while status was 503); the loader/workflow/deployment tests and PowerShell contract pass independently.
