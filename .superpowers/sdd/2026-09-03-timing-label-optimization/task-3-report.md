# Task 3 report — editable timing label optimization

## Status

Implemented and committed as `bfd6092` (`feat(web): add timing label optimization panel`).

## Files

- `apps/web/src/api.ts` — added `JobLabelRecommendationRequest` and `getJobLabelRecommendation`, using the strict `JobLabelRecommendation` contract and focused GET endpoint.
- `apps/web/src/components/JobLabelOptimization.tsx` — added TanStack Query recommendation panel keyed by organization, selected repository/workflow/job identity, and active `from`/`to` range. Renders loading, unavailable/error, evidence, read-only Windows routing label, editable positive-integer VCPU/G fields, exact before/after labels, validation/no-op state, and focused PR callback payload.
- `apps/web/src/components/JobLabelOptimization.test.tsx` — focused loading, unavailable, evidence/editable fields, Windows-label preservation, invalid-value, and no-op coverage.
- `apps/web/src/components/JobResourceDetail.tsx` — embeds the panel while retaining existing charts, samples, and states; passes selected identity, active range, current requested resource values, and optional PR callback.
- `apps/web/src/routes/TimingHistoryPage.tsx` — passes organization and active timing-range bounds into selected-job detail.
- `apps/web/src/styles.css` — adds responsive optimization panel, evidence, field, diff, validation, and mobile styles without staging unrelated pre-existing style changes.

## Verification

- `bun test apps/web/src/components/JobLabelOptimization.test.tsx apps/web/src/routes/TimingHistoryPage.test.tsx`
  - **PASS** — 17 tests, 0 failures, 65 expectations.
- Compatibility smoke: `bun test apps/web/src/components/JobLabelOptimization.test.tsx apps/web/src/routes/TimingHistoryPage.test.tsx apps/web/src/components/JobResourceHistory.test.tsx`
  - **PASS** — 33 tests, 0 failures, 245 expectations.
- `bun run --cwd apps/web typecheck`
  - Existing unrelated workspace diagnostics remain in `JobResourceHistory.test.tsx` (legacy callers missing newly optional-compatible detail props were reported before compatibility fix in the focused test run) and `WorkerHealthPanel.tsx`/test (pre-existing `runtimeMode` contract mismatch). No diagnostics reported from the new optimization component, API helper, route, or detail integration after the fix.

## Concerns

- Task 3 does not alter the existing PR modal/backend. The panel emits a focused `{ selectedPath, selectedJobId, labels, p95CpuPeakPercent, p95MemoryPeakBytes, successfulRunCount }` callback payload; the current timing route has no workflow-path mapping or modal integration yet, so it does not supply a PR callback/path and therefore correctly hides the action there until that metadata is available.
- The recommendation contract exposes the current Windows label but not current numeric workflow labels. The panel uses selected-job requested VCPU/memory as the displayed numeric baseline, while preserving the recommendation's Windows routing label and any supplied non-numeric labels.
