# Final review fix report

## Findings fixed

- Wired TimingHistoryPage's selected-job action through JobResourceDetail and JobLabelOptimization into an opened RunnerWorkflowPrModal, carrying repository/workflow metadata, resolved workflow path/YAML job key, edited labels, and telemetry metadata so Create PR is reachable.
- Added safe workflow/job resolution against the repository YAML (workflow display name plus explicit job display name or YAML key). Dashboard UUIDs and webhook display names are never used as `jobs.<id>` without resolution.
- Focused mutations now preserve existing nonnumeric labels and the selected Windows routing label while replacing only VCPU/G labels.
- Focused validation rejects missing/multiple/conflicting Windows routing labels, duplicate or invalid numeric labels, and foreign custom labels; route errors are returned as workflow-invalid 422 responses.
- Focused no-op rejection remains focused-only; legacy repository-wide migration callers still use configured pool labels and retain legacy behavior.
- Recommendation responses carry current workflow labels and resolved path/job metadata; the UI before/after diff is based on those labels rather than timing allocation fields.

## Verification commands and output

```text
bun test packages/contracts/src/dashboard-api.test.ts packages/db/src/job-label-recommendations.test.ts apps/control-plane/src/workflow-pr.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/app.test.ts apps/web/src/components/JobLabelOptimization.test.tsx apps/web/src/components/RunnerWorkflowPrModal.dom.test.tsx
153 pass
0 fail
556 expect() calls
Ran 153 tests across 7 files.

bun test apps/web/src/routes/TimingHistoryPage.test.tsx apps/web/src/components/JobResourceHistory.test.tsx apps/web/src/components/JobLabelOptimization.test.tsx apps/web/src/components/RunnerWorkflowPrModal.test.tsx apps/web/src/components/RunnerWorkflowPrModal.dom.test.tsx
41 pass
0 fail
276 expect() calls
Ran 41 tests across 5 files.

bun run --cwd apps/web typecheck
Failed only on pre-existing WorkerHealthPanel.tsx / WorkerHealthPanel.test.tsx runtimeMode diagnostics; no diagnostics were reported from changed timing, optimization, modal, or route files.

bun run --cwd apps/control-plane typecheck
Failed on pre-existing diagnostics in control-plane gateway/job reconciler/worker release/worker routes/index/lease files; no changed workflow-pr, GitHub workflow, dashboard route, or recommendation diagnostic was reported.
```

## Concerns

- Full package typechecks remain non-zero because of unrelated pre-existing diagnostics listed above.
- Authenticated GitHub API/browser verification is not available in this environment; focused route, resolver, mutation, and rendered component tests provide the exercised proof.

## Final rerun addendum

```text
bun test packages/contracts/src/dashboard-api.test.ts packages/db/src/job-label-recommendations.test.ts apps/control-plane/src/workflow-pr.test.ts apps/control-plane/src/github-app.test.ts apps/control-plane/src/http/app.test.ts apps/web/src/components/JobLabelOptimization.test.tsx apps/web/src/components/RunnerWorkflowPrModal.dom.test.tsx apps/web/src/components/RunnerWorkflowPrModal.test.tsx apps/web/src/routes/TimingHistoryPage.test.tsx
173 pass
0 fail
617 expect() calls
Ran 173 tests across 9 files.
```
