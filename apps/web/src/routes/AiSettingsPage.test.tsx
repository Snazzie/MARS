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
  client.setQueryData(["failure-analysis-settings", "org-1"], [{ repository: { id: "repo-1", name: "repo", fullName: "workspace/repo", available: true }, settings: { enabled: false, providerId: acknowledgedProvider ? "provider-1" : null } }]);
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
  expect(repository?.disabled).toBe(true);
  expect(blanket?.disabled).toBe(true);
  expect(disclosure?.disabled).toBe(false);
});
