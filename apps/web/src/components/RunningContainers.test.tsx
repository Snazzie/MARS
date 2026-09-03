import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunningContainers } from "./RunningContainers.tsx";
import type { OverviewDto } from "@mars/contracts";

const container: OverviewDto["runningContainers"][number] = {
  id: "lease-1", organizationId: "org-1", jobId: "job-1", runId: "run-1", jobName: "build", repositoryName: "acme/project", workflowName: "CI", workerName: "worker-1", runtime: "windows-hyperv-container", startedAt: "2026-08-17T20:00:00.000Z", cpuUsagePercent: 42.5, memoryWorkingSetBytes: 2 * 1024 ** 3, memoryLimitBytes: 4 * 1024 ** 3, diskUsageBytes: null, allocatedStorageBytes: 10 * 1024 ** 3, sampledAt: "2026-08-17T20:05:00.000Z",
};

test("renders identity and resource columns for running containers", () => {
  const html = renderToStaticMarkup(<RunningContainers containers={[container]} />);
  expect(html).toContain("Running containers");
  expect(html).toContain("acme/project");
  expect(html).toContain("42.5%");
  expect(html).toContain("2.0 GiB");
  expect(html).toContain("Disk telemetry unavailable");
  expect(html).toContain("/runs/run-1?organizationId=org-1#job-job-1");
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noreferrer"');
  expect(html).toContain('aria-label="Open job build in a new tab"');
});

test("renders unavailable telemetry without converting it to zero", () => {
  const html = renderToStaticMarkup(<RunningContainers containers={[{ ...container, cpuUsagePercent: null, memoryWorkingSetBytes: null, memoryLimitBytes: null, sampledAt: null }]} />);
  expect(html).toContain("No telemetry sample");
  expect(html.match(/Not reported/g)?.length).toBeGreaterThanOrEqual(3);
  expect(html).not.toContain("0.0%");
});

test("renders an empty state", () => {
  expect(renderToStaticMarkup(<RunningContainers containers={[]} />)).toContain("No containers are running.");
});
