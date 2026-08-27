import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { RunJob, RunStep } from "@mars/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LogViewer, countLogLines, deriveStepDuration, filterLoadedLogChunks, normalizeStepResult, stepDurationPercent, stepLogEmptyMessage, stepMatchesSearch } from "./LogViewer.tsx";

const step = (overrides: Partial<RunStep> = {}): RunStep => ({
  id: "step-1",
  name: "Build",
  number: 1,
  status: "completed",
  conclusion: "success",
  queuedAt: "2026-08-13T14:00:00.000Z",
  startedAt: "2026-08-13T14:00:02.000Z",
  completedAt: "2026-08-13T14:00:07.000Z",
  durationMs: 0,
  ...overrides,
});

test("normalizes step result and derives duration from timestamps", () => {
  expect(normalizeStepResult(step())).toBe("success");
  expect(normalizeStepResult(step({ conclusion: "failure" }))).toBe("failure");
  expect(normalizeStepResult(step({ conclusion: "skipped" }))).toBe("skipped");
  expect(normalizeStepResult(step({ status: "in_progress", conclusion: null }))).toBe("in progress");
  expect(deriveStepDuration(step())).toBe(5000);
  expect(deriveStepDuration(step({ completedAt: null }))).toBeNull();
});

test("scales each step duration against the slowest visible step", () => {
  expect(stepDurationPercent(step({ durationMs: 5_000 }), 5_000)).toBe(100);
  expect(stepDurationPercent(step({ durationMs: 1_000 }), 5_000)).toBe(20);
  expect(stepDurationPercent(step({ durationMs: 0, startedAt: null, completedAt: null }), 5_000)).toBe(0);
});

test("counts lines and searches only the step name plus loaded text", () => {
  expect(countLogLines("one\ntwo\n")).toBe(2);
  expect(countLogLines("")).toBe(0);
  expect(stepMatchesSearch(step({ name: "İstanbul" }), "", "İSTANBUL")).toBe(true);
  expect(stepMatchesSearch(step({ name: "Build" }), "bun test\npass", "PASS")).toBe(true);
  expect(stepMatchesSearch(step({ name: "Build" }), "bun test", "network")).toBe(false);
});

test("filters already-loaded unattributed chunks by output without fetching", () => {
  const chunks = [{ sequence: 1, content: "compile complete" }, { sequence: 2, content: "deploy failed" }];
  expect(filterLoadedLogChunks(chunks, "DEPLOY")).toEqual([chunks[1]]);
  expect(filterLoadedLogChunks(chunks, "missing")).toEqual([]);
  expect(filterLoadedLogChunks(chunks, "")).toEqual(chunks);
});

test("describes step log synchronization state instead of showing a workspace empty state", () => {
  expect(stepLogEmptyMessage("pending")).toContain("synchronized");
  expect(stepLogEmptyMessage("ingested")).toContain("attributed");
  expect(stepLogEmptyMessage("unavailable")).toContain("no longer provides");
});

test("renders steps collapsed and keeps unattributed job logs as a fallback", () => {
  const client = new QueryClient();
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <LogViewer
        organizationId="org-1"
        runId="run-1"
        jobId="job-1"
        logsState="pending"
        steps={[step()]}
      />
    </QueryClientProvider>,
  );
  expect(markup).toContain("Build");
  expect(markup).toContain("Search job steps and loaded logs");
  expect(markup).toContain("step-log-search");
  expect(markup).toContain("step-log-actions");
  expect(markup).toContain("Expand all");
  expect(markup).toContain("Collapse all");
  expect(markup).toContain(">success</span>");
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("Unattributed job logs");
  expect(markup).not.toContain("/steps/step-1/logs");
  expect(markup).toContain("Logs are being synchronized");
  expect(markup).not.toContain("No records yet");
});


test("controls visible step disclosures and reports loaded line count", async () => {
  const window = new Window();
  // @ts-expect-error test DOM globals
  globalThis.document = window.document;
  // @ts-expect-error test DOM globals
  globalThis.window = window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const second = step({ id: "step-2", name: "Test" });
  client.setQueryData(["org", "org-1", "run", "run-1", "job", "job-1", "logs"], { pages: [{ items: [], nextCursor: null }], pageParams: ["-1"] });
  client.setQueryData(["org", "org-1", "run", "run-1", "job", "job-1", "step", "step-2", "logs"], { pages: [{ items: [], nextCursor: null }], pageParams: ["-1"] });
  client.setQueryData(["org", "org-1", "run", "run-1", "job", "job-1", "step", "step-1", "logs"], { pages: [{ items: [{ sequence: 1, content: "bun install" }, { sequence: 2, content: "pass" }], nextCursor: null }], pageParams: ["-1"] });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><LogViewer organizationId="org-1" runId="run-1" jobId="job-1" logsState="ingested" steps={[step(), second]} /></QueryClientProvider>);
  });
  const summaries = () => [...container.querySelectorAll<HTMLElement>("summary")];
  expect([...container.querySelectorAll("details")].every((detail) => !detail.open)).toBe(true);
  await act(async () => { container.querySelector<HTMLButtonElement>("button")?.click(); });
  expect([...container.querySelectorAll("details")].every((detail) => detail.open)).toBe(true);
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search job steps and loaded logs"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(search, "Test");
    search.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    search.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(summaries()).toHaveLength(1);
  expect(summaries()[0]?.textContent).toContain("Test");
  await act(async () => { container.querySelector<HTMLButtonElement>("button:last-of-type")?.click(); });
  expect(container.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 30);
    await promise;
  });
  await act(async () => { search.value = ""; search.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event); });
  expect(container.textContent).toContain("2 lines");
  await act(async () => { root.unmount(); });
  container.remove();
});
