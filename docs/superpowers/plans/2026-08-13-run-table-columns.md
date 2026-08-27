# Run Table Identifier Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make run number, short commit hash, and branch independently scannable in the workflow-runs table.

**Architecture:** Keep the existing `RunTable` component and `RunSummary` contract. Change only the table header/cell layout; derive the seven-character commit display locally and preserve the full SHA in accessible metadata.

**Tech Stack:** React, TypeScript, `@mars/contracts`, Bun tests, existing web app CSS.

## Global Constraints

- Do not change the `RunSummary` contract or API.
- Preserve `allowDetails`, run-detail links, actor metadata, status, timing, and duration behavior.
- Display the first seven characters of `commitSha`; expose the full SHA through `title` and an accessible label.
- Do not add responsive redesign or unrelated styling.

---

### Task 1: Update run table columns

**Files:**
- Modify: `apps/web/src/components/RunTable.tsx:8-10`
- Test: `apps/web/src/components/RunTable.test.tsx` (create only if no focused table test exists)

**Interfaces:**
- Consumes: existing `RunSummary` fields `runNumber`, `workflowName`, `commitSha`, `branch`, `repositoryName`, and `actorLogin`.
- Produces: table headers `Run #`, `Commit`, and `Branch`, with each value in its own cell.

- [ ] **Step 1: Add a focused rendering assertion**

Render `RunTable` with a representative run containing `runNumber: 11`, a 40-character SHA, `branch: "main"`, and `actorLogin: "Snazzie"`. Assert that the output contains the three dedicated headers, `#11`, `abcdef1`, and `main`; assert that the repository cell still contains the actor login and that the full SHA is present in the commit cell's metadata.

- [ ] **Step 2: Run the focused test to verify the current layout fails**

Run:

```bash
bun test apps/web/src/components/RunTable.test.tsx
```

Expected: the new assertions fail because the current component combines run/repository metadata and does not render commit hash.

- [ ] **Step 3: Implement the minimal table layout change**

In `RunTable`, change the header order to `Run #`, `Commit`, `Branch`, `Repository`, `Result`, `Boundary`, `Queued`, `Start delay`, `Duration`. Keep the existing run link/workflow markup in the first cell. Render the commit as `run.commitSha.slice(0, 7)` with `title={run.commitSha}` and `aria-label={`Commit ${run.commitSha}`}`. Render `run.branch` alone in the branch cell, and keep repository name plus actor login in the repository cell. Leave all other cells unchanged.

- [ ] **Step 4: Run the focused component test**

Run:

```bash
bun test apps/web/src/components/RunTable.test.tsx
```

Expected: PASS, including the separate-column and full-SHA metadata assertions.

- [ ] **Step 5: Commit the implementation**

```bash
git add apps/web/src/components/RunTable.tsx apps/web/src/components/RunTable.test.tsx
git commit -m "feat: split run table identifiers"
```

### Task 2: Verify the web UI

**Files:**
- Verify: `apps/web/src/components/RunTable.tsx`

- [ ] **Step 1: Run the repository's focused web checks**

```bash
bun test apps/web/src/components/RunTable.test.tsx apps/web/src/components/RunTelemetry.test.tsx
bun run typecheck
```

Expected: all focused tests pass and TypeScript reports no diagnostics.

- [ ] **Step 2: Inspect the rendered runs page**

Open the local web app's runs page and confirm the header row visibly separates `Run #`, `Commit`, and `Branch`; confirm the short SHA is shown and the existing result/timing columns remain present. Check browser console for no new errors.
