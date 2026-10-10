import { useEffect } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { PipelineAnalysisMetrics, PipelineAnalysisWork, PrReviewWork } from "@mars/contracts";
import type { InfiniteData } from "@tanstack/react-query";

type AiUsageFrame = { version: 1; type: "ai_usage"; organizationId: string; id: string; kind: "pipeline" | "review"; inputTokens: number; outputTokens: number; tokensPerSecond: number | null };
function parseAiUsage(value: unknown, organizationId: string): AiUsageFrame | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as AiUsageFrame;
  if (frame.version !== 1 || frame.type !== "ai_usage" || (organizationId !== "all" && frame.organizationId !== organizationId) || typeof frame.id !== "string" || !["pipeline", "review"].includes(frame.kind)) return null;
  if (![frame.inputTokens, frame.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0) || (frame.tokensPerSecond !== null && (!Number.isFinite(frame.tokensPerSecond) || frame.tokensPerSecond < 0))) return null;
  return frame;
}
function liveMetrics(metrics: PipelineAnalysisMetrics, frame: AiUsageFrame): PipelineAnalysisMetrics {
  return { ...metrics, tokensPerSecond: frame.tokensPerSecond, usage: { input: frame.inputTokens, output: frame.outputTokens, total: frame.inputTokens + frame.outputTokens } };
}

export type DashboardInvalidation = { version: 1; type: "invalidate"; organizationId: string; sequence: number; keys: string[]; occurredAt: string };
export type WorkerStatusFrame = { version: 1; type: "worker_status"; workerId: string; state: "online" | "offline"; occurredAt: string };

export function queryKeyMatchesInvalidation(queryKey: QueryKey, organizationId: string, keys: readonly string[]): boolean {
  const [scope, id, resource] = queryKey;
  if (scope === "org" && id === organizationId && typeof resource === "string") return keys.includes(resource) || (resource === "run" && keys.includes("runs"));
  if (scope === "pools" && id === "global") return keys.includes("pools");
  if (scope === "workers" && id === "global") return keys.includes("workers");
  if (scope === "pending-workers") return keys.includes("workers");
  if (scope === "organizations") return keys.includes("organizations");
  return false;
}

function parseInvalidation(value: unknown, organizationId: string): DashboardInvalidation | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Partial<DashboardInvalidation>;
  if (frame.version !== 1 || frame.type !== "invalidate" || frame.organizationId !== organizationId || !Number.isSafeInteger(frame.sequence) || Number(frame.sequence) < 1 || !Array.isArray(frame.keys) || !frame.keys.every((key) => typeof key === "string")) return null;
  return frame as DashboardInvalidation;
}
function parseWorkerStatus(value: unknown): WorkerStatusFrame | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Partial<WorkerStatusFrame>;
  if (frame.version !== 1 || frame.type !== "worker_status" || typeof frame.workerId !== "string" || (frame.state !== "online" && frame.state !== "offline") || typeof frame.occurredAt !== "string") return null;
  return frame as WorkerStatusFrame;
}

function workerStatusQueryKey(queryKey: QueryKey): boolean {
  const [scope, id, resource] = queryKey;
  return (scope === "org" && (resource === "workers" || resource === "worker")) || (scope === "workers" && id === "global") || (scope === "pools" && id === "global");
}

export function useDashboardInvalidations(organizationId: string | undefined): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!organizationId || typeof window === "undefined") return;
    const storageKey = `mars:invalidation:${organizationId}`;
    let cursor = Number(window.localStorage.getItem(storageKey) ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let attempt = 0;
    const connect = () => {
      if (stopped) return;
      const url = new URL("/api/browser/invalidations", window.location.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("organizationId", organizationId);
      url.searchParams.set("cursor", String(cursor));
      socket = new WebSocket(url);
      socket.onopen = () => {
        attempt = 0;
        void client.invalidateQueries({ predicate: query => workerStatusQueryKey(query.queryKey) });
        void client.invalidateQueries({ predicate: query => query.queryKey[0] === "org" && query.queryKey[1] === organizationId && ["ai-work", "ai-review-work", "run"].includes(String(query.queryKey[2])) });
      };
      socket.onmessage = (event) => {
        if (event.data === "pong") return;
        let value: unknown;
        try { value = JSON.parse(String(event.data)); } catch { return; }
        const usage = parseAiUsage(value, organizationId);
        if (usage) {
          const resource = usage.kind === "pipeline" ? "ai-work" : "ai-review-work";
          client.setQueriesData<InfiniteData<{ items: Array<PipelineAnalysisWork | PrReviewWork>; nextCursor: string | null }>>(
            { queryKey: ["org", organizationId, resource] },
            data => data ? { ...data, pages: data.pages.map(page => ({ ...page, items: page.items.map(item => item.id === usage.id && item.organizationId === usage.organizationId ? { ...item, metrics: liveMetrics(item.metrics, usage) } : item) })) } : data,
          );
          // Run details and summary costs use the persisted, authoritative projection.
          void client.invalidateQueries({ predicate: query => query.queryKey[0] === "org" && query.queryKey[1] === organizationId && query.queryKey[2] === "run" });
          return;
        }
        const workerStatus = parseWorkerStatus(value);
        if (workerStatus) {
          void client.invalidateQueries({ predicate: (query) => workerStatusQueryKey(query.queryKey) });
          return;
        }
        const frame = parseInvalidation(value, organizationId);
        if (!frame || frame.sequence <= cursor) return;
        cursor = frame.sequence;
        window.localStorage.setItem(storageKey, String(cursor));
        void client.invalidateQueries({ predicate: (query) => queryKeyMatchesInvalidation(query.queryKey, organizationId, frame.keys) });
      };
      socket.onclose = () => {
        if (stopped) return;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
        attempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [client, organizationId]);
}
