import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { isSettingsRoute } from "../components/AppShell.tsx";
import { SettingsPage, buildSettingsUpdate } from "./SettingsPage.tsx";

function settingsClient(connection?: Record<string, unknown>, rateLimit?: Record<string, unknown>, organizations = [{ id: "org-1", name: "SpeedHQ", login: "SpeedHQ", role: "owner", repositoryCount: 1, workerCount: 1 }]) {
  const client = new QueryClient();
  client.setQueryData(["me"], { id: "user-1", githubUserId: 1, login: "operator" });
  client.setQueryData(["organizations"], organizations);
  client.setQueryData(["org", "org-1", "settings"], { organizationId: "org-1", maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8589934592, maxStorageBytesPerPod: 107374182400, maxConcurrentPods: 2 });
  if (connection) client.setQueryData(["org", "org-1", "github-connection"], connection);
  if (rateLimit) client.setQueryData(["org", "org-1", "github-rate-limit"], rateLimit);
  return client;
}

function deploymentSettingsClient() {
  const organizations = [
    { id: "org-1", name: "SpeedHQ", login: "SpeedHQ", role: "owner", repositoryCount: 1, workerCount: 1 },
    { id: "org-2", name: "Acme", login: "Acme", role: "admin", repositoryCount: 2, workerCount: 3 },
  ];
  const client = settingsClient({ connected: false }, undefined, organizations);
  client.setQueryData(["org", "org-2", "settings"], { organizationId: "org-2", maxVcpuPerPod: 8, maxMemoryBytesPerPod: 4294967296, maxStorageBytesPerPod: 21474836480, maxConcurrentPods: 5 });
  return client;
}

function markup(client: QueryClient) {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "org-1" } });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>,
    );
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
}
test("settings route detection includes settings subroutes but not similarly named paths", () => {
  expect(isSettingsRoute("/settings")).toBe(true);
  expect(isSettingsRoute("/settings/general")).toBe(true);
  expect(isSettingsRoute("/settings-legacy")).toBe(false);
});

test("settings route renders its deployment controls", () => {
  const html = markup(settingsClient({ connected: false }));
  expect(html).toContain("Deployment settings");
  expect(html).toContain("Maximum concurrent pods");
});

test("settings exposes disconnected GitHub connection and unavailable quota states", () => {
  const html = markup(settingsClient({ connected: false }));
  expect(html).toContain("GitHub connection");
  expect(html).toContain("Add GitHub connection");
  expect(html).toContain("GitHub rate limit unavailable");
  expect(html).toContain("Signed-in identity");
  expect(html).toContain("Sign out");
});

test("settings renders one deployment resource row per organization without workspace gating", () => {
  const html = markup(deploymentSettingsClient());
  expect(html).toContain("Deployment organization settings");
  expect(html).toContain("SpeedHQ");
  expect(html).toContain("Acme");
  expect(html).toContain("Memory per pod (GiB)");
  expect(html).toContain("Storage per pod (GiB)");
  expect(html).toContain("Maximum concurrent pods");
  expect(html).toContain("Save");
  expect(html).not.toContain("vCPU");
  expect(html).not.toContain("Select a workspace");
  expect(html).not.toContain("Select workspace");
});

test("settings update payload preserves each organization's existing vCPU ceiling", () => {
  expect(buildSettingsUpdate(
    { organizationId: "org-2", maxVcpuPerPod: 8, maxMemoryBytesPerPod: 4294967296, maxStorageBytesPerPod: 21474836480, maxConcurrentPods: 5 },
    { maxMemoryGiB: 6, maxStorageGiB: 32, maxConcurrentPods: 7 },
  )).toEqual({
    maxVcpuPerPod: 8,
    maxMemoryBytesPerPod: 6442450944,
    maxStorageBytesPerPod: 34359738368,
    maxConcurrentPods: 7,
  });
});
test("settings saves an individual organization row with its existing vCPU contract value", async () => {
  const browserWindow = new Window();
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const client = deploymentSettingsClient();
  client.setDefaultOptions({ queries: { staleTime: Infinity, retry: false } });
  // @ts-expect-error test DOM globals
  globalThis.document = browserWindow.document;
  // @ts-expect-error test DOM globals
  globalThis.window = browserWindow;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return { ok: true, status: 200, text: async () => JSON.stringify({ organizationId: "org-2", maxVcpuPerPod: 8, maxMemoryBytesPerPod: 6442450944, maxStorageBytesPerPod: 34359738368, maxConcurrentPods: 7 }) } as Response;
  }) as typeof fetch;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><SettingsPage /></QueryClientProvider>); });
    const row = [...container.querySelectorAll("tbody tr")].find((candidate) => candidate.textContent?.includes("Acme"));
    const saveButton = row?.querySelector("button");
    if (!saveButton) throw new Error("Acme save button was not rendered");
    await act(async () => { saveButton.dispatchEvent(new browserWindow.MouseEvent("click", { bubbles: true })); });
    const mutationRequest = requests.find((request) => request.body.maxVcpuPerPod === 8);
    expect(mutationRequest).toBeDefined();
    expect(mutationRequest?.url).toContain("/api/organizations/org-2/settings");
    expect(mutationRequest?.body).toEqual({ maxVcpuPerPod: 8, maxMemoryBytesPerPod: 4294967296, maxStorageBytesPerPod: 21474836480, maxConcurrentPods: 5 });
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    globalThis.fetch = previousFetch;
  }
});
test("settings keeps quota state unknown while connection status is loading", () => {
  const html = markup(settingsClient());
  expect(html).toContain("Checking GitHub connection before loading rate limit");
  expect(html).not.toContain("until a connection is added");
});
test("settings does not show cached connection or quota data after connection error", () => {
  const client = settingsClient({ connected: true, login: "stale-login" }, { limit: 5000, remaining: 4000, used: 1000, resetAt: "2026-09-07T12:00:00.000Z" });
  const query = client.getQueryCache().find({ queryKey: ["org", "org-1", "github-connection"] });
  if (!query) throw new Error("connection query was not seeded");
  query.setState({ ...query.state, status: "error", error: new Error("connection unavailable"), fetchStatus: "idle" });
  const html = markup(client);
  expect(html).toContain("Unable to load GitHub connection");
  expect(html).toContain("connection status could not be loaded");
  expect(html).not.toContain("stale-login");
  expect(html).not.toContain("4,000");
});
test("settings does not show cached quota values after rate-limit error", () => {
  const client = settingsClient({ connected: true, login: "acme-bot" }, { limit: 5000, remaining: 4000, used: 1000, resetAt: "2026-09-07T12:00:00.000Z" });
  const query = client.getQueryCache().find({ queryKey: ["org", "org-1", "github-rate-limit"] });
  if (!query) throw new Error("rate-limit query was not seeded");
  query.setState({ ...query.state, status: "error", error: new Error("rate limit unavailable"), fetchStatus: "idle" });
  const html = markup(client);
  expect(html).toContain("GitHub rate limit unavailable");
  expect(html).not.toContain("4,000");
  expect(html).not.toContain("5,000");
});

test("settings exposes connected identity, management actions, and quota values", () => {
  const html = markup(
    settingsClient(
      { connected: true, login: "acme-bot", accountType: "Organization", installationId: 123, location: "https://github.com/apps/mars/installations/123" },
      { limit: 5000, remaining: 4321, used: 679, resetAt: "2026-09-07T12:00:00.000Z" },
    ),
  );
  expect(html).toContain("GitHub connection");
  expect(html).toContain("acme-bot");
  expect(html).toContain("Organization");
  expect(html).toContain("Manage installation");
  expect(html).toContain("Sync repositories");
  expect(html).toContain("Remove connection");
  expect(html).toContain("GitHub API rate limit");
  expect(html).toContain("5,000");
  expect(html).toContain("4,321");
  expect(html).toContain("679");
  expect(html).toContain("Reset time");
  expect(html).toContain("Refresh rate limit");
});

import { bytesToGiB, gibToBytes } from "./SettingsPage.tsx";

test("converts human GiB values at the settings boundary", () => {
  expect(bytesToGiB(8589934592)).toBe(8);
  expect(gibToBytes(100.5)).toBe(107911053312);
});
