# Run Detail Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render run-detail context, runner IDs, and requested labels with the existing `Badge` component.

**Architecture:** Keep all changes in `RunDetailView.tsx` and its focused tests. Add small helpers that map strings to `Badge` elements, then reuse those helpers in the context row and both job-header variants. No API or contract changes.

**Tech Stack:** React, TypeScript, `@astryxdesign/core/Badge`, Bun test.

## Global Constraints

- Use `Badge` from `@astryxdesign/core/Badge`.
- Preserve existing fallback strings and status components.
- Render one badge per context value and one per requested label.
- Do not change data loading or API behavior.

---

### Task 1: Add badge rendering and focused coverage

**Files:**
- Modify: `apps/web/src/components/RunDetailView.tsx`
- Modify: `apps/web/src/components/RunDetailView.test.tsx`

- [ ] Add tests asserting context, runner, and requested-label badge text.
- [ ] Add a fallback test asserting `Awaiting runner` remains visible in a badge when no job has a runner ID.
- [ ] Import `Badge` from `@astryxdesign/core/Badge`.
- [ ] Add local helpers for rendering context values and job runner/label badges.
- [ ] Replace the plain context spans with badges.
- [ ] Replace plain job runner and requested-label strings in logs and metrics headers with badges.
- [ ] Run `bun test apps/web/src/components/RunDetailView.test.tsx` and confirm it passes.
- [ ] Run `bun run --filter @whitesmith/web typecheck`.
- [ ] Run `git diff --check` and commit with `feat: improve run detail labels`.
