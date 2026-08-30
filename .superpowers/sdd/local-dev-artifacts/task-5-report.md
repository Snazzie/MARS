# Task 5 Report

## Status
Verified the end-to-end non-production Windows artifact flow. `.env.example` now documents Windows artifact paths or local HTTP(S) URLs, pinned SHA-256 values, and the digest-pinned container base image. The generated development installer points to control-plane artifact endpoints and contains no GitHub artifact URL.

## Commit
Task 5 verification commit (hash reported with delivery).

## Tests
- `bun test apps/control-plane/src/http/app.test.ts tests/installer-arguments.test.ts` — 113 passed, 7 skipped, 0 failed.
- `bun test tests/control-plane-deployment-contract.test.ts` — 17 passed, 0 failed.
- `bun run --filter @mars/control-plane build` — passed; control-plane bundle emitted to `apps/control-plane/dist/index.js`.
- Local endpoint smoke — passed: generated Windows installer returned 200, local artifact endpoint returned 200 with the expected SHA-256 header, and `githubArtifactRequest` was false.

## Concerns
None. The first combined test invocation encountered a transient Windows preflight timeout; the immediate rerun passed without source changes.
