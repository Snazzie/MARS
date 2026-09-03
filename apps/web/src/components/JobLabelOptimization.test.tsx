import type { JobLabelRecommendation } from "@mars/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JobLabelOptimization, isPositiveIntegerLabel, type JobLabelRecommendationRequest } from "./JobLabelOptimization.tsx";

const request: JobLabelRecommendationRequest = {
  from: "2026-08-27T12:00:00.000Z",
  to: "2026-09-03T12:00:00.000Z",
  repositoryId: "11111111-1111-4111-8111-111111111111",
  workflowName: "CI",
  jobName: "build",
};
const available: JobLabelRecommendation = {
  status: "available",
  currentWindowsLabel: "mars-windows-x64",
  recommendedVcpu: 3,
  recommendedMemoryGiB: 5,
  p95CpuPeakPercent: 201,
  p95MemoryPeakBytes: 4 * 1024 ** 3,
  successfulRunCount: 8,
  telemetryCoveragePercent: 100,
  reason: null,
};

function markup(data: JobLabelRecommendation | undefined, props: Partial<ComponentProps<typeof JobLabelOptimization>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (data) client.setQueryData(["org", "org-1", "job-label-recommendation", request], data);
  return renderToStaticMarkup(<QueryClientProvider client={client}><JobLabelOptimization organizationId="org-1" activeRange={{ from: request.from, to: request.to }} repositoryId={request.repositoryId} repositoryName="acme/app" workflowName={request.workflowName} jobName={request.jobName} selectedPath=".github/workflows/ci.yml" selectedJobId="job-1" currentVcpu={8} currentMemoryGiB={16} onRequestPullRequest={() => {}} {...props} /></QueryClientProvider>);
}

test("renders loading and unavailable recommendation states", () => {
  const loading = markup(undefined);
  expect(loading).toContain("Loading label recommendation");
  const unavailable = markup({ ...available, status: "unavailable", reason: "insufficient_history", recommendedVcpu: null, recommendedMemoryGiB: null });
  expect(unavailable).toContain("Label recommendation unavailable");
  expect(unavailable).toContain("At least five successful runs");
  const telemetryUnavailable = markup({ ...available, status: "unavailable", reason: "insufficient_telemetry_coverage", recommendedVcpu: null, recommendedMemoryGiB: null });
  expect(telemetryUnavailable).toContain("At least 80% CPU and memory telemetry coverage");
  const missingCpu = markup({ ...available, status: "unavailable", reason: "missing_cpu_telemetry", recommendedVcpu: null, recommendedMemoryGiB: null });
  expect(missingCpu).toContain("CPU telemetry is not available");

});
test("renders evidence, preserves the Windows label, and emits an exact editable diff", () => {
  const html = markup(available);
  expect(html).toContain("Successful runs");
  expect(html).toContain("201.0%");
  expect(html).toContain("4.0 GiB");
  expect(html).toContain('value="mars-windows-x64"');
  expect(html).toContain('readOnly=""');
  expect(html).toContain('name="vcpu"');
  expect(html).toContain('value="3"');
  expect(html).toContain('value="5"');
  expect(html).toContain("mars-windows-x64 8VCPU 16G");
  expect(html).toContain("mars-windows-x64 3VCPU 5G");
  expect(html).toContain("Review pull request");
});

test("disables the pull request action for a no-op and rejects invalid values", () => {
  const html = markup({ ...available, recommendedVcpu: 8, recommendedMemoryGiB: 16 }, { currentVcpu: 8, currentMemoryGiB: 16 });
  expect(html).toContain("The proposed labels are unchanged");
  expect(html).toContain('disabled=""');
  expect(isPositiveIntegerLabel("1")).toBe(true);
  expect(isPositiveIntegerLabel("0")).toBe(false);
  expect(isPositiveIntegerLabel("1.5")).toBe(false);
  expect(isPositiveIntegerLabel("-1")).toBe(false);
  expect(isPositiveIntegerLabel("9007199254740992")).toBe(false);
});
