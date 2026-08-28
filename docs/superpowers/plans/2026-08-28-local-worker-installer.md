# Local Worker Installer URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local-development worker enrollment and upgrade commands download installers from the running Mars control plane while preserving GitHub release URLs in production.

**Architecture:** Keep command generation pure and centralize the environment-aware installer URL policy in the web layer. Development URLs target `/api/workers/installer` on the selected control-plane origin; production URLs retain the immutable GitHub release asset path. Pass the generated URL into the existing shell/PowerShell command builders so quoting, HTTP opt-in, cleanup, and failure handling remain unchanged.

**Tech Stack:** React/TypeScript, Vite `import.meta.env.DEV`, Bun tests.

## Global Constraints

- Local development installer downloads MUST use the running control-plane `/api/workers/installer` endpoint.
- Production installer downloads MUST continue using the existing GitHub release asset URLs.
- The installer endpoint query MUST include `audience`, `runtime=container`, and URL-encoded `connectOrigin`.
- The selected `connectOrigin` MUST remain the origin embedded in the generated installer.
- Existing shell quoting, HTTP opt-in behavior, cleanup, and download failure handling MUST remain unchanged.
- Do not change installer scripts, release packaging, or unrelated worker behavior.

---

### Task 1: Add environment-aware enrollment installer URLs

**Files:**
- Modify: `apps/web/src/components/EnrollmentPanel.tsx:19-48, buildInstallerCommands`
- Test: `apps/web/src/components/EnrollmentPanel.test.ts:3-56`

**Interfaces:**
- Consumes: existing `origin`, `audience`, `code` inputs and Vite `import.meta.env.DEV`.
- Produces: `buildInstallerCommands(origin, audience, code, localDevelopment?)` with the existing return shape; default behavior is environment-aware, while the optional boolean makes tests deterministic.

- [ ] **Step 1: Write failing tests**

Add tests that call `buildInstallerCommands` with the explicit local-development flag:

```ts
test("uses the local control-plane installer endpoint in development", () => {
  const command = buildInstallerCommands("http://localhost:3000", "windows-x64", "code", true)[0]?.command ?? "";
  expect(command).toContain("http://localhost:3000/api/workers/installer?");
  expect(command).toContain("audience=windows-x64");
  expect(command).toContain("runtime=container");
  expect(command).toContain("connectOrigin=http%3A%2F%2Flocalhost%3A3000");
  expect(command).not.toContain("github.com/Snazzie/Mars/releases");
});

test("keeps the GitHub release installer URL in production", () => {
  const command = buildInstallerCommands("https://control.example", "windows-x64", "code", false)[0]?.command ?? "";
  expect(command).toContain("https://github.com/Snazzie/Mars/releases/latest/download/install-worker-windows-x64.ps1");
});
```

Update existing calls/assertions only where needed to pass the explicit production flag; preserve current platform and safety coverage.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
bun test apps/web/src/components/EnrollmentPanel.test.ts
```

Expected: FAIL because `buildInstallerCommands` does not yet accept the local-development behavior.

- [ ] **Step 3: Implement the minimal URL policy**

Keep the current release constants for production. Add a helper with this behavior:

```ts
function installerUrl(origin: string, audience: RuntimePlatform, localDevelopment: boolean): string {
  const selectedOrigin = new URL(origin).origin;
  if (!localDevelopment) return `${WORKER_RELEASE_BASE_URL}/${WORKER_RELEASE_ASSETS[audience]}`;
  const params = new URLSearchParams({ audience, runtime: "container", connectOrigin: selectedOrigin });
  return `${selectedOrigin}/api/workers/installer?${params}`;
}
```

Change `buildInstallerCommands` to accept `localDevelopment = import.meta.env.DEV`, call `installerUrl`, and pass the result to the existing `buildInstallerCommand`. Do not alter command quoting or shell behavior.

- [ ] **Step 4: Run focused tests and verify pass**

Run:

```bash
bun test apps/web/src/components/EnrollmentPanel.test.ts
```

Expected: PASS, including local URL query parameters, production release URL, platform selection, and command safety assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/EnrollmentPanel.tsx apps/web/src/components/EnrollmentPanel.test.ts
git commit -m "fix: use local worker installer in development"
```

### Task 2: Add environment-aware Windows upgrade URLs

**Files:**
- Modify: `apps/web/src/components/WorkerActions.tsx:12-21, buildWindowsUpgradeCommand`
- Test: `apps/web/src/components/WorkerActions.test.tsx:4-17`

**Interfaces:**
- Consumes: existing `workerId`, `origin`, and `connectOrigin` inputs plus Vite `import.meta.env.DEV`.
- Produces: `buildWindowsUpgradeCommand(workerId, origin, connectOrigin?, localDevelopment?)` with the existing command string contract.

- [ ] **Step 1: Write failing tests**

Add tests that explicitly cover both modes:

```ts
test("uses the local installer endpoint for development upgrades", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "http://localhost:3000", "http://localhost:3000", true);
  expect(command).toContain("http://localhost:3000/api/workers/installer?");
  expect(command).toContain("audience=windows-x64");
  expect(command).toContain("runtime=container");
  expect(command).toContain("connectOrigin=http%3A%2F%2Flocalhost%3A3000");
  expect(command).not.toContain("github.com/Snazzie/Mars/releases");
});

test("uses the GitHub release installer for production upgrades", () => {
  const command = buildWindowsUpgradeCommand("worker/id", "https://control.example", "https://control.example", false);
  expect(command).toContain("https://github.com/Snazzie/Mars/releases/latest/download/install-worker-windows-x64.ps1");
});
```

Retain the existing localhost HTTP opt-in assertion.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
bun test apps/web/src/components/WorkerActions.test.tsx
```

Expected: FAIL because the upgrade builder has no local-development URL path.

- [ ] **Step 3: Implement the minimal URL policy**

Add a local-development branch that builds the same endpoint URL as Task 1, using `connectOrigin` when supplied and `origin` otherwise:

```ts
const selectedOrigin = new URL(connectOrigin ?? origin).origin;
const installerUrl = localDevelopment
  ? `${selectedOrigin}/api/workers/installer?${new URLSearchParams({ audience: "windows-x64", runtime: "container", connectOrigin: selectedOrigin })}`
  : WORKER_WINDOWS_RELEASE_URL;
```

Add `localDevelopment = import.meta.env.DEV` after the existing optional arguments. Use `installerUrl` in the existing `curl.exe` command. Leave PowerShell quoting, cleanup, upgrade flags, and HTTP opt-in logic unchanged.

- [ ] **Step 4: Run focused tests and verify pass**

Run:

```bash
bun test apps/web/src/components/WorkerActions.test.tsx apps/web/src/components/EnrollmentPanel.test.ts
```

Expected: PASS with local and production URL assertions and all existing command-safety checks.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/WorkerActions.tsx apps/web/src/components/WorkerActions.test.tsx
git commit -m "fix: use local worker installer for upgrades"
```

### Task 3: Verify the web command surface

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the combined focused contract tests**

Run:

```bash
bun test apps/web/src/components/EnrollmentPanel.test.ts apps/web/src/components/WorkerActions.test.tsx
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Inspect the final diff**

Run:

```bash
git diff HEAD~2..HEAD -- apps/web/src/components/EnrollmentPanel.tsx apps/web/src/components/EnrollmentPanel.test.ts apps/web/src/components/WorkerActions.tsx apps/web/src/components/WorkerActions.test.tsx
```

Confirm only installer URL selection changed; command quoting, cleanup, and control-plane origin handling remain intact.

- [ ] **Step 3: Commit any required test-only adjustment**

If the combined focused run exposes an assertion mismatch caused by the new optional test parameter, update only the affected focused test and commit:

```bash
git add apps/web/src/components/EnrollmentPanel.test.ts apps/web/src/components/WorkerActions.test.tsx
git commit -m "test: cover local worker installer URLs"
```
