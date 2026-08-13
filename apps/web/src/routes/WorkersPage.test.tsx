import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkersPage } from "./WorkersPage.tsx";

test("hides global pending approval controls inside a selected workspace", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "org-1", setItem: () => {} } });
  const client = new QueryClient();
  client.setQueryData(["organizations"], [{ id: "org-1", name: "Acme", login: "acme", role: "owner", repositoryCount: 0, workerCount: 0 }]);
  const markup = renderToStaticMarkup(<QueryClientProvider client={client}><WorkersPage /></QueryClientProvider>);
  expect(markup).not.toContain("Workers awaiting approval");
  Reflect.deleteProperty(globalThis, "localStorage");
});
