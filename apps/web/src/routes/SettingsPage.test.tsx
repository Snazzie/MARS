import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsPage } from "./SettingsPage.tsx";

test("settings route renders its organization controls", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "org-1" } });
  const client = new QueryClient();
  client.setQueryData(["organizations"], [{ id: "org-1", name: "SpeedHQ", login: "SpeedHQ", role: "owner", repositoryCount: 1, workerCount: 1 }]);
  client.setQueryData(["org", "org-1", "settings"], { organizationId: "org-1", maxVcpuPerPod: 4, maxMemoryBytesPerPod: 8589934592, maxStorageBytesPerPod: 107374182400, maxConcurrentPods: 2 });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );

  expect(markup).toContain("Organization settings");
  expect(markup).toContain("Maximum concurrent pods");
  Reflect.deleteProperty(globalThis, "localStorage");
});
import { bytesToGiB, gibToBytes } from "./SettingsPage.tsx";

test("converts human GiB values at the settings boundary", () => {
  expect(bytesToGiB(8589934592)).toBe(8);
  expect(gibToBytes(100.5)).toBe(107911053312);
});
