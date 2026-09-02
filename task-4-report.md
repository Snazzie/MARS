# Task 4 report

Implemented the Windows request-path coverage and focused package-cache smoke workflow.

## Changes

- Added a Windows-only `run.cmd` bootstrap test that records the official runner child environment and verifies all proxy variables, empty `NO_PROXY` variants, readable temporary CA variables, CA contents, and cleanup after runner exit.
- Added a Windows smoke step that installs `tests/fixtures/bun-package-cache` twice using freshly empty, distinct `BUN_INSTALL_CACHE_DIR` directories, removing `node_modules` between installs and verifying the package materializes on the second run.
- Kept the existing no-cache Windows JIT, non-Windows shell, and shared Hyper-V/container worker-cache serialization paths unchanged.

## Verification

`bun test apps/job-agent/src/bootstrap.test.ts apps/orchestrator/src/hyperv.test.ts apps/orchestrator/src/windows-container.test.ts`

Result: 36 passing, 0 failing.

`git diff --check -- apps/job-agent/src/bootstrap.test.ts .github/workflows/windows-smoke.yml`

Result: clean.

The GitHub Actions workflow itself was not dispatched from this environment.
