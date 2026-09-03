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
  test("focused mode previews one selected job with editable recommendation labels", async () => {
    const window = new Window();
    // @ts-expect-error test DOM globals
    globalThis.document = window.document;
    // @ts-expect-error test DOM globals
    globalThis.window = window;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        labels: ["mars-windows-x64", "4VCPU", "8G"],
        defaultBranch: "main",
        headSha: "abc1234",
        changedFiles: [".github/workflows/ci.yml"],
        jobs: [
          { id: "build", path: ".github/workflows/ci.yml", currentRunsOn: ["mars-windows-x64", "8VCPU", "16G"], proposedRunsOn: ["mars-windows-x64", "4VCPU", "8G"] },
          { id: "other", path: ".github/workflows/ci.yml", currentRunsOn: "ubuntu-latest", proposedRunsOn: ["mars-windows-x64", "4VCPU", "8G"] },
        ],
        replacementCount: 1,
        noOp: false,
      }),
    })) as unknown as typeof fetch;
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root.render(<QueryClientProvider client={client}><RunnerWorkflowPrModal
      organizationId="org"
      repositoryId="repo"
      repositoryName="acme/repo"
      open
      selectedPath=".github/workflows/ci.yml"
      selectedJobId="build"
      labels={["mars-windows-x64", "4VCPU", "8G"]}
      onClose={() => {}}
    /></QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(container.querySelector('input[aria-label="Runner labels"]')?.getAttribute("value")).toBe("mars-windows-x64, 4VCPU, 8G");
    expect(container.querySelectorAll(".workflow-job-list article")).toHaveLength(1);
    expect(container.querySelector(".workflow-job-list article")?.textContent).toContain("build");
    expect(container.querySelector(".workflow-job-list article")?.textContent).not.toContain("other");
    root.unmount();
    globalThis.fetch = originalFetch;
  });
});
