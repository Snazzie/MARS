import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
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

function markup(client: QueryClient, selection = "org-1") {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => selection } });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SettingsPage />
      </QueryClientProvider>,
    );
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}



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


test("only global admins see control-plane logs in deployment settings", () => {
  const client = settingsClient({ connected: false });
  client.setQueryData(["control-plane-logs", "", ""], {
    items: [{ sequence: 1, occurredAt: "2026-09-24T12:00:00.000Z", level: "error", message: "worker <failed>" }],
    nextCursor: 1,
  });
  expect(markup(client)).not.toContain("Control-plane logs");
  client.setQueryData(["me"], { id: "admin", login: "admin", isGlobalAdmin: true });
  const html = markup(client);
  expect(html).toContain("Control-plane logs");
  expect(html).toContain("worker &lt;failed&gt;");
  expect(html).toContain('dateTime="2026-09-24T12:00:00.000Z"');
  expect(html).toContain("Search logs");
});

test("all-workspace settings cannot manage the first cached GitHub installation", () => {
  const client = settingsClient({ connected: true, login: "first-cached-account", installationId: 123 });
  const html = markup(client, "all");
  expect(html).not.toContain("first-cached-account");
  expect(html).not.toContain("settings-github-connected");
  expect(html).not.toContain("Remove connection");
});
