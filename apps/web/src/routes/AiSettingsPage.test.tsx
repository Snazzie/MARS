import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { AiSettingsPage } from "./AiSettingsPage.tsx";

function fixture(admin: boolean, acknowledgedProvider = true) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["me"], { id: "operator", githubUserId: 1, login: "operator", isGlobalAdmin: admin });
  client.setQueryData(["organizations"], [{ id: "org-1", login: "workspace" }]);
  client.setQueryData(["admin", "llm-providers"], [{ id: "provider-1", name: "Private profile", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "local-model", keyConfigured: true }]);
  client.setQueryData(["admin", "failure-analysis"], { enableAll: false, providerId: null, enabledSince: null });
  client.setQueryData(["admin", "pr-review"], { enableAll: false, providerId: acknowledgedProvider ? "provider-1" : null, enabledSince: null, updatedAt: "2026-10-10T00:00:00.000Z" });
  client.setQueryData(["failure-analysis-settings", "org-1"], [{ repository: { id: "repo-1", name: "repo", fullName: "workspace/repo", available: true }, settings: { enabled: false, providerId: acknowledgedProvider ? "provider-1" : null }, prReview: { organizationId: "org-1", repositoryId: "repo-1", enabled: false, providerId: "provider-1", enabledSince: null, updatedAt: "2026-10-10T00:00:00.000Z" }, latestPrReview: null }]);
  return client;
}

const markup = (client: QueryClient) => renderToStaticMarkup(<QueryClientProvider client={client}><AiSettingsPage /></QueryClientProvider>);

test("nonadmin direct access does not expose cached provider or repository configuration", () => {
  const html = markup(fixture(false));
  expect(html).not.toContain("Private profile");
  expect(html).not.toContain("localhost:11434");
  expect(html).not.toContain("workspace/repo");
  expect(html).not.toContain("<form");
});

test("repository enabling is disabled until disclosure is acknowledged even with a saved provider", () => {
  const window = new Window();
  window.document.body.innerHTML = markup(fixture(true));
  const inputs = [...window.document.querySelectorAll("input")].filter(input => input.type === "checkbox");
  const repository = inputs.find(input => input.parentElement?.textContent?.includes("Enable analysis for workspace/repo"));
  const disclosure = inputs.find(input => input.parentElement?.textContent?.includes("I acknowledge"));
  const blanket = inputs.find(input => input.parentElement?.textContent === "Enable all");
  const prBlanket = inputs.find(input => input.parentElement?.textContent === "Enable all PR reviews");
  expect(repository?.disabled).toBe(true);
  expect(blanket?.disabled).toBe(true);
  expect(prBlanket?.disabled).toBe(true);
  expect(disclosure?.disabled).toBe(false);
});

test("PR review has separate opt-in and cannot be enabled by the CI setting", () => {
  const window = new Window();
  const client = fixture(true);
  client.setQueryData(["admin", "failure-analysis"], { enableAll: true, providerId: "provider-1", enabledSince: "2026-10-10T00:00:00.000Z" });
  window.document.body.innerHTML = markup(client);
  const rows = [...window.document.querySelectorAll("tbody tr")];
  const prReview = [...(rows[0]?.querySelectorAll("input") ?? [])].find(input => input.type === "checkbox" && input.parentElement?.textContent?.includes("Enable pull request review"));
  const consent = [...window.document.querySelectorAll("input")].find(input => input.type === "checkbox" && input.parentElement?.textContent?.includes("I acknowledge"));
  expect(prReview?.checked).toBe(false);
  expect(prReview?.disabled).toBe(true);
  expect(consent?.disabled).toBe(false);
});

test("global PR enablement preserves local opt-in and leaves CI off", () => {
  const client = fixture(true);
  client.setQueryData(["admin", "pr-review"], { enableAll: true, providerId: "provider-1", enabledSince: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z" });
  const window = new Window();
  window.document.body.innerHTML = markup(client);
  const inputs = [...window.document.querySelectorAll("input")].filter(input => input.type === "checkbox");
  const pr = inputs.find(input => input.parentElement?.textContent?.includes("Enable pull request review for workspace/repo"));
  const ci = inputs.find(input => input.parentElement?.textContent?.includes("Enable analysis for workspace/repo"));
  const globalPr = inputs.find(input => input.parentElement?.textContent === "Enable all PR reviews");
  expect(globalPr?.checked).toBe(true);
  expect(pr?.checked).toBe(false);
  expect(pr?.disabled).toBe(true);
  expect(ci?.checked).toBe(false);
});
