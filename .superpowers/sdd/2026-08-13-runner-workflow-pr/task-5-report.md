# Task 5 Verification Report

- Focused regression: `bun test apps/control-plane/src/workflow-pr.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/dashboard-api.test.ts apps/web/src/components/RunnerWorkflowPrModal.test.tsx apps/web/src/routes/RepositoriesPage.test.tsx apps/web/src/routes/OnboardingPage.test.tsx` — PASS, 37 tests / 131 assertions (Bun reported 4 files; requested route files were not separately discovered).
- Repository checks: `bun run typecheck` — PASS for all 6 workspaces; `bun run lint` — PASS for all 6 workspaces.
- Full suite: `bun test` — PASS, 223 passed, 1 skipped, 0 failed, 622 assertions across 44 files.
- Full-suite concerns: existing console output from reconcile/mac-agent tests and React key warnings in `PendingWorkerRequests`; no test failures.
- Local smoke attempted with `bun run dev` via supervised local server. Blocked at startup because required `PUBLIC_BASE_URL` is unset (server also requires database/GitHub credentials and master-key file); therefore onboarding/repositories browser interaction and real PR submission could not run.
- No browser smoke was performed because no configured local stack was available; focused component/route tests, typecheck, lint, and full suite are the strongest available verification.
- `git status --short` showed only pre-existing untracked `.superpowers/sdd/2026-08-13-runner-workflow-pr/progress.md` and `task-2-report.md`; `git diff --stat` was empty. No source or `IMPLEMENTATION-STATUS.md` changes made.

## Final review fixes

- GET `/runner-workflows` now requires global-admin authorization after organization membership guarding, matching preview/PR mutation routes.
- Discovery parsing is explicitly caught and returned as documented HTTP 422 `workflow_invalid`; response details include organization and repository identifiers while the discovery error retains workflow file/job context.
- The modal now requires an explicit “I confirm the selected workflow replacements” checkbox before Create PR enables. Confirmation resets whenever selected files or newly loaded workflow data changes.
- Dialog keyboard handling now cycles Tab and Shift+Tab through all dialog controls, while preserving Escape dismissal and restoration of the previously focused element.
- Focused verification: `bun test apps/web/src/components/RunnerWorkflowPrModal.test.tsx apps/web/src/components/RunnerWorkflowPrModal.dom.test.tsx apps/control-plane/src/workflow-pr.test.ts apps/control-plane/src/http/app.test.ts` — PASS, 38 tests / 88 assertions.
- Typechecks: `bun run --filter @mars/control-plane typecheck && bun run --filter @mars/web typecheck` — PASS.

- Follow-up focus-trap correction: Shift+Tab from the dialog container itself now wraps to the last available control (including during initial loading before content controls render).
