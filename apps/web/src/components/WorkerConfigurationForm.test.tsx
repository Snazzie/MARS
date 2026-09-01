import { act } from "react";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkerCapacityData } from "@mars/contracts";
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

test("defaults Cache TTL (hours) and runner cache settings", () => {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><WorkerConfigurationForm worker={worker} organizationId="org-1" onConfigured={() => {}} /></QueryClientProvider>);
  expect(markup).toContain('name="cacheTtlHours"');
  expect(markup).toContain('value="48"');
  expect(markup).toContain('name="runnerCacheMaxGiB"');
  expect(markup).toContain('value="20"');
  expect(markup).toContain('name="runnerCacheEnabled"');
  expect(markup).toContain('checked=""');
});
test("initializes Cache TTL and runner cache from desired configuration", () => {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><WorkerConfigurationForm worker={{ ...worker, desiredCacheTtlSeconds: 72 * 60 * 60, desiredRunnerCacheEnabled: false, desiredRunnerCacheMaxGiB: 8 }} organizationId="org-1" onConfigured={() => {}} /></QueryClientProvider>);
  expect(markup).toContain('name="cacheTtlHours"');
  expect(markup).toContain('value="72"');
  expect(markup).toContain('name="runnerCacheMaxGiB"');
  expect(markup).toContain('value="8"');
});
test("submits disabled and re-enabled runner cache through worker configuration", async () => {
  const browser = new Window();
  // @ts-expect-error test DOM globals
  globalThis.document = browser.document;
  // @ts-expect-error test DOM globals
  globalThis.window = browser;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  const bodies: Array<{ cache?: { runnerCacheEnabled?: boolean; runnerCacheMaxGiB?: number } }> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as { cache?: { runnerCacheEnabled?: boolean; runnerCacheMaxGiB?: number } });
    return new Response(JSON.stringify({ revision: "a".repeat(64), fingerprint: "b".repeat(64), commandId: "00000000-0000-4000-8000-000000000001" }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const render = (desiredRunnerCacheEnabled?: boolean) => root.render(<QueryClientProvider client={new QueryClient()}><WorkerConfigurationForm worker={{ ...worker, ...(desiredRunnerCacheEnabled === undefined ? {} : { desiredRunnerCacheEnabled }) }} organizationId="org-1" onConfigured={() => {}} /></QueryClientProvider>);
    await act(async () => { render(); });
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[name="runnerCacheEnabled"]')!.click();
      container.querySelector("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bodies[0]?.cache?.runnerCacheEnabled).toBe(false);
    expect(bodies[0]?.cache?.runnerCacheMaxGiB).toBe(20);
    await act(async () => { root.unmount(); });
    const nextRoot = createRoot(container);
    await act(async () => { nextRoot.render(<QueryClientProvider client={new QueryClient()}><WorkerConfigurationForm worker={{ ...worker, desiredRunnerCacheEnabled: false }} organizationId="org-1" onConfigured={() => {}} /></QueryClientProvider>); });
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[name="runnerCacheEnabled"]')!.click();
      container.querySelector("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bodies[1]?.cache?.runnerCacheEnabled).toBe(true);
    expect(bodies[1]?.cache?.runnerCacheMaxGiB).toBe(20);
    await act(async () => { nextRoot.unmount(); });
  } finally {
    globalThis.fetch = originalFetch;
    container.remove();
  }
});
test("rejects non-positive Cache TTL values before configuring", () => {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><WorkerConfigurationForm worker={worker} organizationId="org-1" onConfigured={() => {}} /></QueryClientProvider>);
  expect(markup).toContain('min="1"');
});
