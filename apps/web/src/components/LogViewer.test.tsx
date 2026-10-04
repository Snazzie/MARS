import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { RunStep } from "@mars/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LogViewer, countLogLines, deriveStepDuration, filterLoadedLogChunks, normalizeStepResult, stepDurationPercent, stepMatchesSearch } from "./LogViewer.tsx";

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

test("retains late log failures and lets a search load unopened step output", async () => {
  const dom = new Window();
  const keys = ["document", "window", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const output = Array.from({ length: 250 }, (_, sequence) => ({ sequence, content: sequence === 249 ? "late job failure" : `line ${sequence}` }));
  const globals = {
    document: dom.document, window: dom, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => new Response(JSON.stringify({
      items: [{ organizationId: "org-1", runId: "run-1", jobId: "job-1", sequence: 0, content: "compiler error needle", hasMore: false, occurredAt: "2026-08-13T14:00:00.000Z" }],
      nextCursor: null,
    }), { headers: { "Content-Type": "application/json" } }),
  };
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: globals[key] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["org", "org-1", "run", "run-1", "job", "job-1", "logs"], {
    pages: [{ items: output.slice(0, 100), nextCursor: "99" }, { items: output.slice(100, 200), nextCursor: "199" }, { items: output.slice(200), nextCursor: null }],
    pageParams: ["-1", "99", "199"],
  });
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><LogViewer organizationId="org-1" runId="run-1" jobId="job-1" logsState="ingested" steps={[step()]} /></QueryClientProvider>); });
    expect(container.querySelector(".unattributed-log-panel pre")?.textContent).toContain("late job failure");
    const search = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(search, "needle");
      search.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
    expect(container.querySelector("summary")?.textContent).toContain("Build");
    await act(async () => { container.querySelector<HTMLButtonElement>(".step-log-actions button")!.click(); });
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 30);
      await promise;
    });
    expect(container.querySelector<HTMLDetailsElement>("details")?.open).toBe(true);
    expect(container.querySelector(".step-log-body pre")?.textContent).toContain("compiler error needle");
  } finally {
    await act(async () => { root.unmount(); });
    client.clear();
    container.remove();
    for (const [index, key] of keys.entries()) {
      if (previous[index]) Object.defineProperty(globalThis, key, previous[index]!);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.close();
  }
});
