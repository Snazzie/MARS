import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RunnerWorkflowPrModal } from "./RunnerWorkflowPrModal.tsx";

describe("RunnerWorkflowPrModal rendered smoke", () => {
  test("opens as a dialog and closes on Escape", async () => {
    const window = new Window();
    // @ts-expect-error test DOM globals
    globalThis.document = window.document;
    // @ts-expect-error test DOM globals
    globalThis.window = window;
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container); let closed = false;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root.render(<QueryClientProvider client={client}><RunnerWorkflowPrModal organizationId="org" repositoryId="repo" repositoryName="acme/repo" open onClose={() => { closed = true; }} /></QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closed).toBe(true);
    root.unmount();
  });
});
