import { useEffect } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

export type DashboardInvalidation = { version: 1; type: "invalidate"; organizationId: string; sequence: number; keys: string[]; occurredAt: string };

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

export function useDashboardInvalidations(organizationId: string | undefined): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!organizationId || organizationId === "all" || typeof window === "undefined") return;
    const storageKey = `whitesmith:invalidation:${organizationId}`;
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
      socket.onopen = () => { attempt = 0; };
      socket.onmessage = (event) => {
        if (event.data === "pong") return;
        let value: unknown;
        try { value = JSON.parse(String(event.data)); } catch { return; }
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
