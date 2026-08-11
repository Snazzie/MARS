import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingWorkerRequests } from "./PendingWorkerRequests.tsx";

const request = {
  fingerprint: "SHA256:pending-fingerprint",
  platform: "linux-x64" as const,
  publicKey: "ssh-ed25519 AAAA fingerprint",
  vmUuid: "22222222-2222-4222-8222-222222222222",
  machineUuid: "33333333-3333-4333-8333-333333333333",
  limits: { maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8589934592, maxStorageBytesPerPod: 107374182400, maxConcurrentPods: 2 },
  doctor: { nestedKvm: true, probe: true },
  capacity: { actualVcpu: 8, actualMemoryBytes: 17179869184, actualStorageBytes: 214748364800, freeVcpu: 8, freeMemoryBytes: 17179869184, freeStorageBytes: 214748364800 },
};

test("renders pending worker identity, platform, reported capacity, target, and editable limits", () => {
  const client = new QueryClient();
  client.setQueryData(["pending-workers"], [request]);
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><PendingWorkerRequests organizationId="44444444-4444-4444-8444-444444444444" /></QueryClientProvider>);
  expect(markup).toContain("Pending worker requests");
  expect(markup).toContain(request.publicKey);
  expect(markup).toContain("linux-x64");
  expect(markup).toContain(request.vmUuid);
  expect(markup).toContain("8 vCPU");
  expect(markup).toContain("44444444-4444-4444-8444-444444444444");
  expect(markup.match(/name="maxVcpuPerPod"/g)?.length).toBe(1);
  expect(markup.match(/name="maxMemoryBytesPerPod"/g)?.length).toBe(1);
  expect(markup.match(/name="maxStorageBytesPerPod"/g)?.length).toBe(1);
  expect(markup.match(/name="maxConcurrentPods"/g)?.length).toBe(1);
  expect(markup).toContain("Approve");
  expect(markup).toContain("Reject");
});

test("shows an empty pending state", () => {
  const client = new QueryClient();
  client.setQueryData(["pending-workers"], []);
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><PendingWorkerRequests organizationId="44444444-4444-4444-8444-444444444444" /></QueryClientProvider>);
  expect(markup).toContain("No pending worker requests");
});
