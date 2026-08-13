# Runner Workflow Pull Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let global administrators preview and submit a GitHub PR that replaces `runs-on` values in all or selected repository workflow files with the configured Whitesmith runner labels.

**Architecture:** Add a focused workflow mutation module that discovers, parses, previews, and rewrites GitHub Actions workflow files. Extend `GitHubAppService` with installation-token repository operations and expose authenticated repository-scoped preview/create routes. Reuse one React modal from onboarding and the dashboard repositories page; the server recomputes and validates the preview before creating a branch, commit, and PR.

**Tech Stack:** Bun, TypeScript, Hono, Zod, React, TanStack Query, GitHub App REST API, YAML parser.

## Global Constraints

- The action is available from onboarding and the dashboard repositories page.
- The modal defaults to all eligible `.github/workflows/*.yml` and `.yaml` files and permits explicit file selection.
- The modal lists each selected job's current `runs-on` and proposed Whitesmith labels before confirmation.
- Runner labels are server-derived from the configured repository pool; browsers cannot provide labels.
- Only `runs-on` values change; unrelated workflow content stays unchanged.
- Submission revalidates repository approval, selected paths, branch head, and file contents.
- No-op selections do not create a branch or PR; errors do not expose tokens.

---

### Task 1: Add workflow discovery and mutation module

**Files:**
- Create: `apps/control-plane/src/workflow-pr.ts`
- Modify: `apps/control-plane/package.json` (add the existing-compatible YAML parser dependency)
- Create/modify: `apps/control-plane/src/workflow-pr.test.ts`

**Interfaces:**
- Produces `WorkflowFilePreview`, `WorkflowJobPreview`, `WorkflowSelection`, `WorkflowMutation`, and pure functions consumed by the GitHub service and API routes.
- `discoverWorkflowFiles(files: readonly { path: string; content: string }[]): WorkflowFilePreview[]` accepts only `.github/workflows/*.yml`/`.yaml` paths and returns parseable files with job-level `runs-on` locations.
- `previewWorkflowMutation(input: { files: readonly WorkflowFilePreview[]; selectedPaths: readonly string[]; labels: readonly string[] }): WorkflowMutation` returns changed files, job previews, replacement count, and no-op status.
- `applyWorkflowMutation(content: string, labels: readonly string[]): string` rewrites supported scalar, array, and expression-compatible `runs-on` nodes without changing unrelated YAML.

- [ ] **Step 1: Write failing parser and selection tests**

Cover:

```ts
expect(discoverWorkflowFiles([
  { path: ".github/workflows/ci.yml", content: "name: CI\njobs:\n  test:\n    runs-on: ubuntu-latest\n" },
])).toMatchObject([{ path: ".github/workflows/ci.yml", jobs: [{ id: "test", currentRunsOn: "ubuntu-latest" }] }]);

expect(previewWorkflowMutation({
  files,
  selectedPaths: [".github/workflows/ci.yml"],
  labels: ["self-hosted", "macos", "arm64", "whitesmith-default"],
}).replacementCount).toBe(1);
```

Also assert all-vs-selected filtering, array labels, unsupported/malformed YAML errors with file/job context, traversal/unlisted paths, and no-op when no selected job has `runs-on`.

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `bun test apps/control-plane/src/workflow-pr.test.ts`

Expected: FAIL because the workflow module and exported functions do not exist.

- [ ] **Step 3: Add the YAML dependency and implement the pure module**

Use a parser that preserves document structure and emits YAML rather than regex replacement. Validate workflow paths against the exact `.github/workflows/` prefix and single-file basename shape. Represent replacement labels as a YAML sequence for deterministic `runs-on` output. Reject malformed documents, missing `jobs`, non-object job entries, and unsupported `runs-on` node shapes with structured errors.

- [ ] **Step 4: Run focused tests and confirm they pass**

Run: `bun test apps/control-plane/src/workflow-pr.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the pure workflow implementation**

```bash
git add apps/control-plane/src/workflow-pr.ts apps/control-plane/src/workflow-pr.test.ts apps/control-plane/package.json bun.lock
git commit -m "feat: add workflow runner mutation preview"
```

---

### Task 2: Add GitHub App repository PR operations

**Files:**
- Modify: `apps/control-plane/src/github-app.ts`
- Modify: `apps/control-plane/src/github-app.test.ts`
- Modify: `apps/control-plane/src/http/types.ts` only if a new typed helper dependency is required

**Interfaces:**
- `GitHubAppService.listRepositoryWorkflows(owner: string, repo: string): Promise<{ defaultBranch: string; files: Array<{ path: string; sha: string; content: string }> }>`
- `GitHubAppService.previewRepositoryRunnerPr(input: { organizationId: string; repositoryId: string; selectedPaths: string[] }): Promise<WorkflowMutation & { defaultBranch: string; headSha: string; labels: string[] }>`
- `GitHubAppService.createRepositoryRunnerPr(input: { organizationId: string; repositoryId: string; selectedPaths: string[]; expectedHeadSha: string; title?: string; body?: string }): Promise<{ url: string; number: number; branch: string; changedFiles: string[]; replacementCount: number }>`

- [ ] **Step 1: Write failing GitHub API tests**

Mock the existing `fetch` dependency and assert installation-token creation, repository metadata/tree/content reads, ref creation, blob/tree/commit creation, branch ref creation, and pull-request creation. Assert the API never receives secret values in returned DTOs. Add stale-head and no-op tests that prove no write endpoint is called.

- [ ] **Step 2: Run the focused GitHub tests and confirm failure**

Run: `bun test apps/control-plane/src/github-app.test.ts`

Expected: FAIL because the new service methods are absent.

- [ ] **Step 3: Implement authenticated GitHub operations**

Reuse `getInstallationToken` and `gh`. Resolve the approved repository and installation from `dashboard_repositories`/`dashboard_installations`, derive labels from the repository's effective pool query, and reject missing approval/pool state. Read the default branch and current tree, fetch only workflow file blobs, then call the pure workflow module. On create, re-read the branch head and selected blobs, compare against `expectedHeadSha`, and stop before any write if stale or no-op. Generate a unique `whitesmith/use-runners-${random}` branch and standard commit/PR text; accept only optional title/body text from the caller.

- [ ] **Step 4: Run focused GitHub tests and typecheck**

Run: `bun test apps/control-plane/src/github-app.test.ts && bun run --filter '@whitesmith/control-plane' typecheck`

Expected: PASS.

- [ ] **Step 5: Commit GitHub PR operations**

```bash
git add apps/control-plane/src/github-app.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/types.ts
git commit -m "feat: create runner workflow pull requests"
```

---

### Task 3: Expose repository preview and create API contracts

**Files:**
- Modify: `packages/contracts/src/dashboard.ts`
- Modify: `apps/control-plane/src/http/dashboard-routes.ts`
- Modify: `apps/control-plane/src/http/dashboard-api.test.ts`
- Modify: `apps/web/src/api.ts`

**Interfaces:**
- `RunnerWorkflowFile`, `RunnerWorkflowJobPreview`, `RunnerWorkflowPreview`, `RunnerWorkflowPrRequest`, and `RunnerWorkflowPrResult` Zod contracts in `packages/contracts/src/dashboard.ts`.
- `GET /api/organizations/:organizationId/repositories/:repositoryId/runner-workflows` returns workflow files and current job `runs-on` values.
- `POST /api/organizations/:organizationId/repositories/:repositoryId/runner-workflows/preview` accepts `{ selectedPaths: string[] }` and returns server-derived proposed labels, current/proposed jobs, `headSha`, changed files, and `replacementCount`.
- `POST /api/organizations/:organizationId/repositories/:repositoryId/runner-workflows/pr` accepts `{ selectedPaths: string[]; expectedHeadSha: string; title?: string; body?: string }` and returns PR metadata.

- [ ] **Step 1: Add contract tests for response/request boundaries**

Assert strict parsing rejects arbitrary labels, unknown paths, missing head SHA on create, secret-like fields, and malformed optional title/body values. Assert preview and result schemas accept only the documented fields.

- [ ] **Step 2: Add route tests for authorization and GitHub service delegation**

Cover non-member 404, non-admin 403, unapproved repository, missing GitHub App 503, preview success, stale create 409, no-op 422, and successful PR response. Verify idempotency is required for create and that the selected labels are not read from request JSON.

- [ ] **Step 3: Implement contracts and routes**

Add strict Zod schemas. Use the existing `guard`, `safe`, `requireMutation`, and global-admin checks. Delegate all GitHub content and mutation work to `GitHubAppService`; route handlers only parse, authorize, map known errors, and return contracts. Keep preview cache disabled and use a fresh request for submission.

- [ ] **Step 4: Implement web API functions**

Add typed `getRunnerWorkflowPreview`/metadata and `createRunnerWorkflowPr` functions using the existing request helper, generated idempotency keys, and contract parsing.

- [ ] **Step 5: Run focused route/contract tests and typecheck**

Run: `bun test apps/control-plane/src/http/dashboard-api.test.ts packages/contracts/src/*.test.ts && bun run --filter '*' typecheck`

Expected: PASS.

- [ ] **Step 6: Commit API contracts and routes**

```bash
git add packages/contracts/src/dashboard.ts apps/control-plane/src/http/dashboard-routes.ts apps/control-plane/src/http/dashboard-api.test.ts apps/web/src/api.ts
 git commit -m "feat: expose runner workflow PR API"
```

---

### Task 4: Build the shared workflow preview modal

**Files:**
- Create: `apps/web/src/components/RunnerWorkflowPrModal.tsx`
- Modify: `apps/web/src/routes/RepositoriesPage.tsx`
- Modify: `apps/web/src/routes/OnboardingPage.tsx`
- Modify: relevant web stylesheet file where existing modal/button styles live
- Create/modify: `apps/web/src/components/RunnerWorkflowPrModal.test.tsx`
- Modify: `apps/web/src/routes/RepositoriesPage.test.tsx` and `apps/web/src/routes/OnboardingPage.test.tsx`

**Interfaces:**
- `RunnerWorkflowPrModal({ organizationId, repositoryId, repositoryName, open, onClose, onCreated })` owns workflow selection, preview loading, title/body fields, confirmation, and result link.
- It consumes `getRunnerWorkflowFiles`, `previewRunnerWorkflowPr`, and `createRunnerWorkflowPr` from `apps/web/src/api.ts`.

- [ ] **Step 1: Write failing component tests**

Render the modal with mocked API responses and assert: all files are selected initially; each selected job displays current and proposed `runs-on`; deselecting a file refreshes the preview; malformed/no-op states disable Create PR; confirmation sends `expectedHeadSha`; success renders an external PR link; API errors remain visible in the modal.

- [ ] **Step 2: Implement the accessible modal**

Use semantic dialog markup with labelled heading, close button, focus-visible controls, checkbox group, current/proposed code text, title/body inputs, `aria-live` status, and disabled submit while loading or invalid. Do not expose label editing. Keep stale preview errors actionable with a refresh action.

- [ ] **Step 3: Add repository-page entrypoint**

Add a `Use Whitesmith runners` action to approved/available repository rows. Track the selected repository and render the shared modal. Invalidate the repository query after creation only if needed; show the PR URL directly.

- [ ] **Step 4: Add onboarding entrypoint**

Add the same action to the completed/onboarding repository context. Reuse the component and pass the selected approved repository and organization identifiers from server-derived onboarding detail.

- [ ] **Step 5: Run focused web tests and browser smoke test**

Run: `bun test apps/web/src/components/RunnerWorkflowPrModal.test.tsx apps/web/src/routes/RepositoriesPage.test.tsx apps/web/src/routes/OnboardingPage.test.tsx`

Then run the local web/control-plane stack and verify both entrypoints: open the modal, inspect current/proposed values, change selection, confirm, and observe the PR link or actionable error.

- [ ] **Step 6: Commit the UI flow**

```bash
git add apps/web/src/components/RunnerWorkflowPrModal.tsx apps/web/src/routes/RepositoriesPage.tsx apps/web/src/routes/OnboardingPage.tsx apps/web/src/components/RunnerWorkflowPrModal.test.tsx apps/web/src/routes/RepositoriesPage.test.tsx apps/web/src/routes/OnboardingPage.test.tsx
 git commit -m "feat: add runner workflow PR preview modal"
```

---

### Task 5: Run complete verification and record completion

**Files:**
- Modify: `IMPLEMENTATION-STATUS.md` only if the repository's current status must record the completed capability.

- [ ] **Step 1: Run focused regression tests**

Run: `bun test apps/control-plane/src/workflow-pr.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/dashboard-api.test.ts apps/web/src/components/RunnerWorkflowPrModal.test.tsx apps/web/src/routes/RepositoriesPage.test.tsx apps/web/src/routes/OnboardingPage.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run repository checks**

Run: `bun run typecheck && bun run lint && bun test`

Expected: PASS with no new failures.

- [ ] **Step 3: Verify the actual surface**

Launch the local app, use an approved repository with workflow files, open the action from onboarding and repositories, confirm the modal lists current/proposed values, submit a PR against a test repository, and verify the returned PR URL and changed-file list.

- [ ] **Step 4: Commit only required status/documentation changes**

If status documentation changed, commit it with:

```bash
git add IMPLEMENTATION-STATUS.md
git commit -m "docs: record runner workflow PR capability"
```
