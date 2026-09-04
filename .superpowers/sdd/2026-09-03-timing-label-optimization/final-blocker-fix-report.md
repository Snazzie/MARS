# Final blocker fix report

## Blockers addressed

- Added `selectedJobId` to the shared `JobLabelOptimizationRequest` type used by the optimization callback and `TimingHistoryPage` focused modal props.
- Recommendation workflow resolution now maps only expected mapping failures (`github_workflow_job_not_found`, `github_workflow_job_ambiguous`, and non-Windows jobs) to an unavailable recommendation.
- GitHub permission, repository, rate-limit, and configuration failures no longer become HTTP 200 unavailable responses; permission/repository/pool/app-configuration errors use existing API mappings and unknown/rate-limit failures reach the existing internal-error boundary.
- When YAML workflow labels resolve successfully, the response uses those authoritative labels and uses their VCPU/G values for telemetry-null numeric fallback while preserving the resolved Windows routing label.

## Verification evidence

```text
bun test apps/web/src/components/JobLabelOptimization.test.tsx apps/web/src/routes/TimingHistoryPage.test.tsx apps/web/src/components/RunnerWorkflowPrModal.dom.test.tsx apps/control-plane/src/http/app.test.ts
121 pass
0 fail
439 expect() calls
Ran 121 tests across 4 files.

bun run --cwd apps/web typecheck
Failed with 2 pre-existing WorkerHealthPanel runtimeMode diagnostics; no diagnostics from the changed optimization, timing, or modal files.

bun run --cwd apps/control-plane typecheck
Failed with 47 pre-existing diagnostics in unrelated gateway/reconciler/release/worker/index/lease files; no diagnostics from the changed dashboard route or recommendation tests.
```

The route regression tests cover expected mapping failures, non-Windows resolution, authoritative YAML numeric fallback, `github_403`, `github_repository_unavailable`, `github_rate_limited`, `github_app_unconfigured`, and `github_runner_pool_missing`.

## Concerns

- Package typechecks remain non-zero solely because of unrelated existing diagnostics listed above.
- Authenticated GitHub API verification is unavailable in this environment; focused HTTP and rendered-component tests exercise the changed paths.
