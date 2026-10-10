import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { AiSettingsPage } from "./AiSettingsPage.tsx";

function fixture(admin: boolean, selectedProvider = true, available = true) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["me"], { id: "operator", githubUserId: 1, login: "operator", isGlobalAdmin: admin });
  client.setQueryData(["organizations"], [{ id: "org-1", login: "workspace" }]);
  client.setQueryData(["admin", "llm-providers"], [{ id: "provider-1", name: "Private profile", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "local-model", keyConfigured: true }]);
  client.setQueryData(["admin", "failure-analysis"], { enableAll: false, providerId: null, enabledSince: null });
  client.setQueryData(["admin", "pr-review"], { enableAll: false, providerId: selectedProvider ? "provider-1" : null, enabledSince: null, updatedAt: "2026-10-10T00:00:00.000Z" });
  client.setQueryData(["failure-analysis-settings", "org-1"], [{ repository: { id: "repo-1", name: "repo", fullName: "workspace/repo", available }, settings: { enabled: false, providerId: selectedProvider ? "provider-1" : null }, prReview: { organizationId: "org-1", repositoryId: "repo-1", enabled: false, providerId: "provider-1", enabledSince: null, updatedAt: "2026-10-10T00:00:00.000Z" }, latestPrReview: null }]);
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

test("saved providers allow repository and global enablement without acknowledgement", () => {
  const window = new Window();
  window.document.body.innerHTML = markup(fixture(true));
  const inputs = [...window.document.querySelectorAll("input")].filter(input => input.type === "checkbox");
  for (const label of ["Enable analysis for workspace/repo", "Enable pull request review for workspace/repo", "Enable all", "Enable all PR reviews"]) {
    const input = inputs.find(input => input.parentElement?.textContent === label);
    expect(input).toBeDefined();
    expect(input?.disabled).toBe(false);
    expect(input?.checked).toBe(false);
  }
});

test("PR review has separate opt-in and cannot be enabled by the CI setting", () => {
  const window = new Window();
  const client = fixture(true);
  client.setQueryData(["admin", "failure-analysis"], { enableAll: true, providerId: "provider-1", enabledSince: "2026-10-10T00:00:00.000Z" });
  window.document.body.innerHTML = markup(client);
  const rows = [...window.document.querySelectorAll("tbody tr")];
  const prReview = [...(rows[0]?.querySelectorAll("input") ?? [])].find(input => input.type === "checkbox" && input.parentElement?.textContent?.includes("Enable pull request review"));
  expect(prReview?.checked).toBe(false);
  expect(prReview?.disabled).toBe(false);
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

test("provider requirements still block enablement without a selected analysis or global PR provider", () => {
  const window = new Window();
  window.document.body.innerHTML = markup(fixture(true, false));
  const inputs = [...window.document.querySelectorAll("input")].filter(input => input.type === "checkbox");
  for (const label of ["Enable analysis for workspace/repo", "Enable all", "Enable all PR reviews"]) {
    expect(inputs.find(input => input.parentElement?.textContent === label)?.disabled).toBe(true);
  }
  expect(inputs.find(input => input.parentElement?.textContent === "Enable pull request review for workspace/repo")?.disabled).toBe(false);
});

test("unavailable repositories cannot enable either analysis or PR review", () => {
  const client = fixture(true, true, false);
  const window = new Window();
  window.document.body.innerHTML = markup(client);
  const inputs = [...window.document.querySelectorAll("input")].filter(input => input.type === "checkbox");
  for (const label of ["Enable analysis for workspace/repo", "Enable pull request review for workspace/repo"]) {
    expect(inputs.find(input => input.parentElement?.textContent === label)?.disabled).toBe(true);
  }
});
