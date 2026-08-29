# Dashboard GitHub Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let dashboard administrators connect, uninstall, and reinstall Mars in any GitHub account or organization from `/repositories`.

**Architecture:** Reuse the existing unbound `POST /api/onboarding/github/install` endpoint and GitHub callback. Change the dashboard connect action to launch that endpoint, then invalidate repository data after returning. Keep existing organization-scoped sync/uninstall routes and confirmation behavior.

**Tech Stack:** React, TanStack Query, Bun test, TypeScript.

## Global Constraints

- GitHub account matching uses immutable numeric ID and `User`/`Organization` type.
- Do not expose access tokens or App credentials to the browser.
- Preserve existing sync, uninstall, repository-management, and callback behavior.
- Skip formatters, linters, and project-wide tests during implementation.

---

### Task 1: Update dashboard connection action

**Files:**
- Modify: `apps/web/src/routes/RepositoriesPage.tsx`
- Modify: `apps/web/src/api.ts` only if the existing unbound API export is unavailable
- Test: `apps/web/src/routes/RepositoriesPage.test.tsx`

**Interfaces:**
- Consume `beginUnboundOnboardingGithubInstall(): Promise<{ location: string }>`.
- Preserve `refreshGithubConnection`, `uninstallOrganizationGithub`, and repository query invalidation.

- [ ] **Step 1: Add failing dashboard interaction coverage**

Render `/repositories` with organizations and mock the unbound install request. Assert clicking `Connect workspace` calls `/api/onboarding/github/install` and assigns the returned GitHub installation URL. Assert the GitHub connection disclosure still renders sync and uninstall controls for a selected workspace.

- [ ] **Step 2: Implement the dashboard picker launch**

Import `beginUnboundOnboardingGithubInstall`, replace the bound connect mutation with a mutation that calls it, and retain `window.location.assign(location)` on success. Keep the workspace selector as context for sync/uninstall; do not use it to constrain installation target.

- [ ] **Step 3: Verify focused dashboard tests**

Run:

```bash
bun test apps/web/src/routes/RepositoriesPage.test.tsx
```

Expected: all repository page tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/RepositoriesPage.tsx apps/web/src/routes/RepositoriesPage.test.tsx apps/web/src/api.ts
git commit -m "feat(web): install GitHub app from dashboard"
```

### Task 2: Verify end-to-end contracts

**Files:**
- Test: `apps/control-plane/src/http/app.test.ts`
- Test: `apps/web/src/routes/RepositoriesPage.test.tsx`

- [ ] **Step 1: Run focused control-plane and web tests**

```bash
bun test apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/app.test.ts apps/web/src/routes/RepositoriesPage.test.tsx
```

Expected: all pass.

- [ ] **Step 2: Run web typecheck**

```bash
bun run --cwd apps/web typecheck
```

Expected: exit 0.
