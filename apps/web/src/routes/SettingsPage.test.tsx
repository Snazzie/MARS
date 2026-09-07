import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage } from "./SettingsPage.tsx";

function settingsClient(connection: Record<string, unknown>, rateLimit?: Record<string, unknown>) {
  const client = new QueryClient();
  client.setQueryData(["me"], { id: "user-1", githubUserId: 1, login: "operator" });
  client.setQueryData(["organizations"], [{ id: "org-1", name: "SpeedHQ", login: "SpeedHQ", role: "owner", repositoryCount: 1, workerCount: 1 }]);
  client.setQueryData(["org", "org-1", "settings"], { organizationId: "org-1", maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8589934592, maxStorageBytesPerPod: 107374182400, maxConcurrentPods: 2 });
  client.setQueryData(["org", "org-1", "github-connection"], connection);
  if (rateLimit) client.setQueryData(["org", "org-1", "github-rate-limit"], rateLimit);
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

test("settings route renders its organization controls", () => {
  const html = markup(settingsClient({ connected: false }));
  expect(html).toContain("Organization settings");
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
