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
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number;
    const container = document.createElement("div"); document.body.append(container);
    const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
    const root = createRoot(container); let closed = false;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const render = (open: boolean) => root.render(<QueryClientProvider client={client}><RunnerWorkflowPrModal organizationId="org" repositoryId="repo" repositoryName="acme/repo" open={open} onClose={() => { closed = true; }} /></QueryClientProvider>);
    render(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closed).toBe(true);
    render(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(trigger);
    root.unmount();
  });
});
