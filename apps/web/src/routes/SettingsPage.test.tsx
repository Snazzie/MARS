import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { isSettingsRoute } from "../components/AppShell.tsx";
import { SettingsPage } from "./SettingsPage.tsx";

function settingsClient(
  connection?: Record<string, unknown>,
  rateLimit?: Record<string, unknown>,
  organizations = [{ id: "org-1", name: "SpeedHQ", login: "SpeedHQ", role: "owner", repositoryCount: 1, workerCount: 1 }],
) {
  const client = new QueryClient();
  client.setQueryData(["me"], { id: "user-1", githubUserId: 1, login: "operator" });
  client.setQueryData(["organizations"], organizations);
  if (connection) client.setQueryData(["org", "org-1", "github-connection"], connection);
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

test("settings route detection includes settings subroutes but not similarly named paths", () => {
  expect(isSettingsRoute("/settings")).toBe(true);
  expect(isSettingsRoute("/settings/general")).toBe(true);
  expect(isSettingsRoute("/settings-legacy")).toBe(false);
});

test("settings keeps the deployment shell without per-organization resource controls", () => {
  const html = markup(settingsClient({ connected: false }));
  expect(html).toContain("Deployment settings");
  expect(html).toContain("GitHub connections");
  expect(html).not.toContain("All organizations");
  expect(html).not.toContain("Deployment organization settings");
  expect(html).not.toContain("Resource limits by organization");
  expect(html).not.toContain("Maximum concurrent pods");
  expect(html).not.toContain("Memory per pod (GiB)");
  expect(html).not.toContain("Storage per pod (GiB)");
  expect(html).not.toContain("<table");
});

test("settings exposes disconnected GitHub connection and unavailable quota states", () => {
  const html = markup(settingsClient({ connected: false }));
  expect(html).toContain("GitHub connection");
  expect(html).toContain("Add GitHub connection");
  expect(html).toContain("GitHub rate limit unavailable");
  expect(html).toContain("Signed-in identity");
  expect(html).toContain("Sign out");
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
