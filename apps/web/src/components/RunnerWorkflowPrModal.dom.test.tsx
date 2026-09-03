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
  test("focused mode edits labels, refreshes stale heads, and links the created PR", async () => {
    const window = new Window();
    // @ts-expect-error test DOM globals
    globalThis.document = window.document;
    // @ts-expect-error test DOM globals
    globalThis.window = window;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0) as unknown as number;
    const originalFetch = globalThis.fetch;
    const previewBodies: Array<Record<string, unknown>> = [];
    const createBodies: Array<Record<string, unknown>> = [];
    let previewCount = 0;
    let createCount = 0;
    const previewResponse = (labels: string[]) => ({
      labels,
      defaultBranch: "main",
      headSha: previewCount === 1 ? "abc1234" : "def5678",
      changedFiles: [".github/workflows/ci.yml"],
      jobs: [
        { id: "build", path: ".github/workflows/ci.yml", currentRunsOn: ["mars-windows-x64", "8VCPU", "16G"], proposedRunsOn: ["mars-windows-x64", labels[1], labels[2]] },
        { id: "other", path: ".github/workflows/ci.yml", currentRunsOn: "ubuntu-latest", proposedRunsOn: ["mars-windows-x64", labels[1], labels[2]] },
      ],
      replacementCount: 1,
      noOp: false,
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (url.endsWith("/pr")) {
        createBodies.push(parsed);
        createCount += 1;
        if (createCount === 1) {
          return { ok: false, status: 409, json: async () => ({ code: "workflow_head_stale", message: "Workflow files changed; refresh preview", requestId: "request-1" }) } as Response;
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ url: "https://github.com/acme/repo/pull/42", number: 42, branch: "mars/workflow-labels", changedFiles: [".github/workflows/ci.yml"], replacementCount: 1 }) } as Response;
      }
      previewBodies.push(parsed);
      previewCount += 1;
      const labels = (parsed.labels as string[] | undefined) ?? ["mars-windows-x64", "4VCPU", "8G"];
      return { ok: true, status: 200, text: async () => JSON.stringify(previewResponse(labels)) } as Response;
    }) as unknown as typeof fetch;
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
      p95CpuPeakPercent={210}
      p95MemoryPeakBytes={7 * 1024 ** 3}
      successfulRunCount={12}
      onClose={() => {}}
    /></QueryClientProvider>);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(container.querySelectorAll(".workflow-job-list article")).toHaveLength(1);
    const labelsInput = container.querySelector('input[aria-label="Runner labels"]') as HTMLInputElement;
    const reactPropsKey = Object.keys(labelsInput).find((key) => key.startsWith("__reactProps"));
    const labelChange = reactPropsKey ? (labelsInput as unknown as Record<string, { onChange?: (event: { target: { value: string } }) => void }>)[reactPropsKey]?.onChange : undefined;
    labelChange?.({ target: { value: "mars-windows-x64, 6VCPU, 12G" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(previewBodies).toHaveLength(2);
    expect(previewBodies[1]).toMatchObject({ selectedPath: ".github/workflows/ci.yml", selectedJobId: "build", labels: ["mars-windows-x64", "6VCPU", "12G"] });
    expect(container.querySelector(".workflow-job-list article")?.textContent).not.toContain("other");
    const titleInput = container.querySelector('input:not([aria-label="Runner labels"]):not([type="checkbox"])') as HTMLInputElement;
    const titlePropsKey = Object.keys(titleInput).find((key) => key.startsWith("__reactProps"));
    const titleChange = titlePropsKey ? (titleInput as unknown as Record<string, { onChange?: (event: { target: { value: string } }) => void }>)[titlePropsKey]?.onChange : undefined;
    titleChange?.({ target: { value: "Optimize labels" } });
    const description = container.querySelector("textarea") as HTMLTextAreaElement;
    const descriptionPropsKey = Object.keys(description).find((key) => key.startsWith("__reactProps"));
    const descriptionChange = descriptionPropsKey ? (description as unknown as Record<string, { onChange?: (event: { target: { value: string } }) => void }>)[descriptionPropsKey]?.onChange : undefined;
    descriptionChange?.({ target: { value: "Telemetry-backed recommendation" } });
    const confirmation = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    confirmation.click();
    const buttons = [...container.querySelectorAll("button")];
    const createButton = buttons.find((button) => button.textContent === "Create PR") as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
    createButton.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(createBodies[0]).toMatchObject({
      selectedPath: ".github/workflows/ci.yml",
      selectedJobId: "build",
      labels: ["mars-windows-x64", "6VCPU", "12G"],
      expectedHeadSha: "def5678",
      p95CpuPeakPercent: 210,
      p95MemoryPeakBytes: 7 * 1024 ** 3,
      successfulRunCount: 12,
      title: "Optimize labels",
      body: "Telemetry-backed recommendation",
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Workflow files changed");
    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent === "Refresh preview") as HTMLButtonElement;
    refresh.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(previewBodies).toHaveLength(3);
    createButton.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(container.querySelector('a[href="https://github.com/acme/repo/pull/42"]')).not.toBeNull();
    root.unmount();
    globalThis.fetch = originalFetch;
  });
});
