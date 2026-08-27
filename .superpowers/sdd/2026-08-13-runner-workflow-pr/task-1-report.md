
## Review fixes
- Preview now rejects empty labels with a contextual selected-workflow error.
- No-op preview errors include selected workflow path(s).
- Numeric `runs-on` scalar nodes are rejected; only string scalars and string sequences are supported, with workflow/job context.
- Verification rerun: `bun test apps/control-plane/src/workflow-pr.test.ts` — **4 pass, 0 fail, 13 expect() calls**.
- Verification rerun: `bun run --filter '@mars/control-plane' typecheck` — **exited with code 0**.
