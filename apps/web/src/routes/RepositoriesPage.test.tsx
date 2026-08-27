import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { getRepositories } from "../api.ts";
import { RepositoriesPage } from "./RepositoriesPage.tsx";

function markup({
  isGlobalAdmin = true,
  discoveryState = "paused",
  discoveryRetryAt = "2026-08-15T12:00:00.000Z",
}: {
  isGlobalAdmin?: boolean;
  discoveryState?: "active" | "paused" | "queued";
  discoveryRetryAt?: string | null;
} = {}) {
  const client = new QueryClient();
  client.setQueryData(["me"], { id: "user-1", githubUserId: 1, login: "admin", isGlobalAdmin });
  client.setQueryData(["organizations"], [{ id: "org-1", name: "Acme", login: "acme", repositoryCount: 2, workerCount: 1 }]);
  client.setQueryData(["org", "all", "repositories", "", "available", "all"], {
    pages: [{
      items: [
        { id: "repo-1", organizationId: "org-1", name: "private", fullName: "acme/private", visibility: "private", available: true, installationId: "inst-1", discoveryState, discoveryRetryAt },
      ],
      nextCursor: null,
    }],
    pageParams: [null],
  });
  return renderToStaticMarkup(<QueryClientProvider client={client}><RepositoriesPage /></QueryClientProvider>);
}

test("repository table presents GitHub installation access without approval policy", () => {
  const html = markup();
  expect(html).toContain("Access follows the GitHub App installation");
  expect(html).toContain("acme/private");
  expect(html).toContain("Available");
  expect(html).toContain("Manage GitHub");
  expect(html).toContain("Use Mars runners");
  expect(html).not.toContain("Mars access");
  expect(html).not.toContain("Approved");
  expect(html).not.toContain("Not approved");
  expect(html).not.toContain(">Remove<");
});

test("available repositories enable workflow setup without a second authorization gate", () => {
  const html = markup();
  const action = html.match(/<button[^>]*>Use Mars runners<\/button>/)?.[0] ?? "";
  expect(action).not.toContain("disabled");
  expect(html).not.toContain("acme/removed");
});

test("global admins can queue a paused repository recheck", () => {
  const html = markup();
  expect(html).toContain("Discovery paused until");
  expect(html).toContain(">Recheck now<");
  expect(html.match(/<button[^>]*>Recheck now<\/button>/)?.[0]).not.toContain("disabled");
});

test("queued repository rechecks cannot be submitted repeatedly", () => {
  const html = markup({ discoveryState: "queued", discoveryRetryAt: "2026-08-14T12:00:00.000Z" });
  expect(html).toContain("Recheck queued");
  expect(html.match(/<button[^>]*>Recheck now<\/button>/)?.[0]).toContain("disabled");
});

test("workspace members see the pause without an administrator action", () => {
  const html = markup({ isGlobalAdmin: false });
  expect(html).toContain("Discovery paused until");
  expect(html).not.toContain(">Recheck now<");
});

test("loads one repository page and preserves its cursor", async () => {
  const originalFetch = globalThis.fetch;
  const cursor = "11111111-1111-4111-8111-111111111111";
  const repository = (index: number, owner: string) => ({
    id: crypto.randomUUID(),
    organizationId: "22222222-2222-4222-8222-222222222222",
    name: `repo-${index}`,
    fullName: `${owner}/repo-${index}`,
    visibility: "private",
    available: true,
    installationId: "33333333-3333-4333-8333-333333333333",
    discoveryState: "active",
    discoveryRetryAt: null,
  });
  const calls: string[] = [];
  try {
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return Response.json(calls.length === 1
        ? { items: Array.from({ length: 50 }, (_, index) => repository(index, "Snazzie")), nextCursor: cursor }
        : { items: Array.from({ length: 5 }, (_, index) => repository(index, "SpeedHQ")), nextCursor: null });
    }) as typeof fetch;

    const page = await getRepositories("all");

    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBe(cursor);
    expect(calls).toEqual([
      "/api/organizations/all/repositories?limit=50",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
