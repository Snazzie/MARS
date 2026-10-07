import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { AiSettingsPage } from "./AiSettingsPage.tsx";

function fixture(admin: boolean, acknowledgedProvider = true) {
  const client = new QueryClient();
  client.setQueryData(["me"], { id: "operator", githubUserId: 1, login: "operator", isGlobalAdmin: admin });
  client.setQueryData(["organizations"], [{ id: "org-1", login: "workspace" }]);
  client.setQueryData(["admin", "llm-providers"], [{ id: "provider-1", name: "Private profile", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "local-model", keyConfigured: true }]);
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
  const html = markup(fixture(true));
  const inputs = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((match) => match[0]);
  expect(inputs).toHaveLength(2);
  expect(inputs[0]).toContain("disabled");
  expect(inputs[1]).not.toContain("disabled");
});
