import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingWorkerRequests, pendingWorkerQueryOptions } from "./PendingWorkerRequests.tsx";
import { WorkerConfigurationForm } from "./WorkerConfigurationForm.tsx";
const org = "44444444-4444-4444-8444-444444444444";
const worker = { id: "11111111-1111-4111-8111-111111111111", capacity: { actualVcpu: 8, actualMemoryBytes: 17179869184, actualStorageBytes: 214748364800, freeVcpu: 8, freeMemoryBytes: 17179869184, freeStorageBytes: 214748364800 }, limits: null };
const request = { fingerprint: "SHA256:pending-fingerprint", platform: "linux-x64" as const, publicKey: "ssh-ed25519 AAAA fingerprint", vmUuid: "22222222-2222-4222-8222-222222222222", machineUuid: "33333333-3333-4333-8333-333333333333", limits: null, doctor: { nestedKvm: true, probe: true }, capacity: worker.capacity };
function markup(data = [request]) { const client = new QueryClient(); client.setQueryData(["pending-workers"], data); return renderToStaticMarkup(<QueryClientProvider client={client}><PendingWorkerRequests organizationId={org} /></QueryClientProvider>); }
test("renders explicit approval, capacity, and per-job limits", () => { const html = markup(); expect(html).toContain(request.publicKey); expect(html).toContain("Approve and configure worker"); expect(html).toContain("Worker capacity"); expect(html).toContain("Per-job limits"); expect(html.match(/name=\"vcpu\"/g)?.length).toBe(1); expect(html.match(/name=\"maxConcurrentPods\"/g)?.length).toBe(1); });
test("shows empty pending state", () => { expect(markup([])).toContain("No workers are waiting for approval."); });
test("shows globally configurable workers without an organization filter", () => {
  const client = new QueryClient();
  client.setQueryData(["pending-workers"], [request]);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><PendingWorkerRequests organizationId="all" /></QueryClientProvider>);
  expect(html).toContain("Review and configure workers from");
  expect(html).toContain("Approve and configure worker");
  expect(html).not.toContain("Select an organization to adopt and configure this worker.");
});
test("reusable resource form accepts worker capacity", () => { const html = renderToStaticMarkup(<WorkerConfigurationForm worker={worker} onConfigured={() => {}} />); expect(html).toContain("vCPU"); expect(html).toContain("GiB"); expect(html).toContain("Approve and configure worker"); });
test("does not offer an invalid zero-GiB default for insufficient capacity", () => {
  const lowCapacity = { ...worker, capacity: { ...worker.capacity, freeMemoryBytes: 90 * 1024 ** 2 } };
  const html = renderToStaticMarkup(<WorkerConfigurationForm worker={lowCapacity} onConfigured={() => {}} />);
  expect(html).toContain("less than 1 GiB of free RAM");
  expect(html).toContain('name="memoryGiB"');
  expect(html).toContain('value=""');
  expect(html).toContain('disabled=""');
});
test("polls for workers joined outside the browser", () => {
  expect(pendingWorkerQueryOptions().refetchInterval).toBe(2000);
});
