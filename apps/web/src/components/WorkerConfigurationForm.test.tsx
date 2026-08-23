import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkerCapacityData } from "@whitesmith/contracts";
import { WorkerConfigurationForm } from "./WorkerConfigurationForm.tsx";

const capacity: WorkerCapacityData = {
  actualVcpu: 8,
  actualMemoryBytes: 16 * 1024 ** 3,
  actualStorageBytes: 32 * 1024 ** 3,
  freeVcpu: 8,
  freeMemoryBytes: 16 * 1024 ** 3,
  freeStorageBytes: 32 * 1024 ** 3,
};

const worker = {
  id: "worker-1",
  admissionState: "adopted" as const,
  platform: "linux-x64" as const,
  guestPlatforms: ["linux-x64" as const],
  capacity,
  limits: null,
};

test("defaults Cache TTL (hours) to 48", () => {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><WorkerConfigurationForm worker={worker} organizationId="org-1" onConfigured={() => {}} /></QueryClientProvider>);
  expect(markup).toContain('name="cacheTtlHours"');
  expect(markup).toContain('value="48"');
});
test("initializes Cache TTL (hours) from desired configuration", () => {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><WorkerConfigurationForm worker={{ ...worker, desiredCacheTtlSeconds: 72 * 60 * 60 }} organizationId="org-1" onConfigured={() => {}} /></QueryClientProvider>);
  expect(markup).toContain('name="cacheTtlHours"');
  expect(markup).toContain('value="72"');
});

test("rejects non-positive Cache TTL values before configuring", () => {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><WorkerConfigurationForm worker={worker} organizationId="org-1" onConfigured={() => {}} /></QueryClientProvider>);
  expect(markup).toContain('min="1"');
});
