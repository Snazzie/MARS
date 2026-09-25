import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingWorkerRequests, pendingWorkerQueryOptions } from "./PendingWorkerRequests.tsx";
import { WorkerConfigurationForm } from "./WorkerConfigurationForm.tsx";
const org = "44444444-4444-4444-8444-444444444444";
const worker = { id: "11111111-1111-4111-8111-111111111111", admissionState: "pending" as const, capacity: { actualVcpu: 8, actualMemoryBytes: 17179869184, actualStorageBytes: 214748364800, freeVcpu: 8, freeMemoryBytes: 17179869184, freeStorageBytes: 214748364800 }, limits: null };
const request = { id: "11111111-1111-4111-8111-111111111111", fingerprint: "SHA256:pending-fingerprint", platform: "linux-x64" as const, computerName: "linux-builder", releaseVersion: "0.1.0", contractVersion: "0.1.0", guestPlatforms: ["linux-x64" as const], admissionState: "pending" as const, connectionState: "online" as const, configurationState: "unconfigured" as const, publicKey: "ssh-ed25519 AAAA fingerprint", vmUuid: "22222222-2222-4222-8222-222222222222", machineUuid: "33333333-3333-4333-8333-333333333333", limits: null, doctor: { nestedKvm: true, probe: true, containers: [] }, capacity: worker.capacity };
function markup(data = [request]) { const client = new QueryClient(); return renderToStaticMarkup(<QueryClientProvider client={client}><PendingWorkerRequests organizationId={org} workers={data} error={null} isLoading={false} retry={() => {}} /></QueryClientProvider>); }
function formMarkup(value = worker) { const client = new QueryClient(); return renderToStaticMarkup(<QueryClientProvider client={client}><WorkerConfigurationForm worker={value} onConfigured={() => {}} /></QueryClientProvider>); }
test("keeps identity and capacity controls inside each review, with one rejection action", () => { const html = markup([request, { ...request, id: "55555555-5555-4555-8555-555555555555", vmUuid: "66666666-6666-4666-8666-666666666666" }]); expect(html.match(/class="pending-worker-review"/g)?.length).toBe(2); expect(html.match(/<summary>Review and approve/g)?.length).toBe(2); expect(html.match(/Reject worker<\/button>/g)?.length).toBe(2); expect(html).toContain(request.publicKey); expect(html).toContain(request.fingerprint); expect(html).toContain("Worker capacity"); expect(html).toContain("Per-job limits"); expect(html).toContain("Worker scheduling"); expect(html.match(/name="vcpu"/g)?.length).toBe(2); });
test("shows empty pending state", () => { expect(markup([])).toContain("No workers are waiting for approval."); });
test("shows globally configurable workers without an organization filter", () => {
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><PendingWorkerRequests organizationId="all" workers={[request]} error={null} isLoading={false} retry={() => {}} /></QueryClientProvider>);
  expect(html).toContain("Approve and configure worker");
  expect(html).not.toContain("Select an organization to adopt and configure this worker.");
});
test("reusable resource form accepts worker capacity", () => { const html = formMarkup(); expect(html).toContain("vCPU"); expect(html).toContain("GiB"); expect(html).toContain("Approve and configure worker"); });
test("uses total capacity when free telemetry is insufficient", () => {
  const lowCapacity = { ...worker, capacity: { ...worker.capacity, freeMemoryBytes: 90 * 1024 ** 2 } };
  const html = formMarkup(lowCapacity);
  expect(html).not.toContain("less than 1 GiB of free RAM");
  expect(html).toContain('name="memoryGiB"');
  expect(html).toContain('value="16"');
  expect(html).not.toContain('disabled=""');
});
test("polls for workers joined outside the browser", () => {
  expect(pendingWorkerQueryOptions().refetchInterval).toBe(2000);
});
