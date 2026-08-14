import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkersPage } from "./WorkersPage.tsx";

test("hides global pending approval controls inside a selected workspace", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "org-1", setItem: () => {} } });
  const client = new QueryClient();
  client.setQueryData(["organizations"], [{ id: "org-1", name: "Acme", login: "acme", role: "owner", repositoryCount: 0, workerCount: 0 }]);
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><WorkersPage /></QueryClientProvider>);
  expect(markup).not.toContain("Workers awaiting approval");
  Reflect.deleteProperty(globalThis, "localStorage");
});

test("renders inline enrollment and pending workers from one page query", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "all", setItem: () => {} } });
  const client = new QueryClient();
  client.setQueryData(["organizations"], []);
  client.setQueryData(["pending-workers"], [{
    id: "11111111-1111-4111-8111-111111111111",
    fingerprint: "SHA256:pending",
    platform: "linux-x64",
    publicKey: "ssh-ed25519 AAAA pending",
    vmUuid: "22222222-2222-4222-8222-222222222222",
    machineUuid: "33333333-3333-4333-8333-333333333333",
    limits: null,
    doctor: { nestedKvm: true, probe: true },
    capacity: { actualVcpu: 8, actualMemoryBytes: 17179869184, actualStorageBytes: 214748364800, freeVcpu: 8, freeMemoryBytes: 17179869184, freeStorageBytes: 214748364800 },
  }]);
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><WorkersPage /></QueryClientProvider>);
  expect(markup).toContain("Worker enrollment");
  expect(markup).toContain("ssh-ed25519 AAAA pending");
  expect(markup).not.toContain("<dialog");
  expect(markup.indexOf("Know where work lands.")).toBeLessThan(markup.indexOf("Worker enrollment"));
  Reflect.deleteProperty(globalThis, "localStorage");
});
