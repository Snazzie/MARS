import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingWorkerRequests } from "./PendingWorkerRequests.tsx";
import { WorkerConfigurationForm } from "./WorkerConfigurationForm.tsx";
const org = "44444444-4444-4444-8444-444444444444";
const worker = { id: "11111111-1111-4111-8111-111111111111", capacity: { actualVcpu: 8, actualMemoryBytes: 17179869184, actualStorageBytes: 214748364800, freeVcpu: 8, freeMemoryBytes: 17179869184, freeStorageBytes: 214748364800 }, limits: null };
const request = { fingerprint: "SHA256:pending-fingerprint", platform: "linux-x64" as const, publicKey: "ssh-ed25519 AAAA fingerprint", vmUuid: "22222222-2222-4222-8222-222222222222", machineUuid: "33333333-3333-4333-8333-333333333333", limits: null, doctor: { nestedKvm: true, probe: true }, capacity: worker.capacity };
function markup(data = [request]) { const client = new QueryClient(); client.setQueryData(["pending-workers"], data); return renderToStaticMarkup(<QueryClientProvider client={client}><PendingWorkerRequests organizationId={org} /></QueryClientProvider>); }
test("renders identity, capacity, adoption fields, and null limits safely", () => { const html = markup(); expect(html).toContain(request.publicKey); expect(html).toContain("Adopt and configure"); expect(html.match(/name=\"vcpu\"/g)?.length).toBe(1); expect(html.match(/name=\"maxConcurrentPods\"/g)?.length).toBe(1); });
test("shows empty pending state", () => { expect(markup([])).toContain("No pending worker requests"); });
test("reusable resource form accepts worker capacity and organization props", () => { const html = renderToStaticMarkup(<WorkerConfigurationForm worker={worker} organizationId={org} onConfigured={() => {}} />); expect(html).toContain("vCPU"); expect(html).toContain("GiB"); expect(html).toContain("Configure worker"); });
