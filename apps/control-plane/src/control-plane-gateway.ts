import type { Server, ServerWebSocket } from "bun";
import { WorkerDoctorReport } from "@mars/contracts";
import { jsonParameter, type DashboardDb } from "@mars/db";
import { canSubscribeToOrganization, loadBrowserInvalidations } from "./browser-invalidations.ts";
import { reconcileWorkerInventory } from "./lease-reconciliation.ts";
import { verifyWorkerSignature } from "./workers.ts";
import { createWorkerChallenge, decodeWorkerSignature } from "./worker-socket.ts";
import { WorkerCommandDispatcher, containsSecret } from "./worker-dispatch.ts";
import { applyWorkerConfigurationAcknowledgement } from "./worker-requests.ts";
import { activateAuthenticatedWorkerConnection } from "./worker-connection.ts";
import { handleAuthenticatedWorkerEvent } from "./worker-lifecycle.ts";


type WorkerSocketData = { actor: "worker"; workerId: string; challenge?: Buffer; authenticated: boolean; connectionEpoch?: number; authTimer?: ReturnType<typeof setTimeout>; heartbeatTimer?: ReturnType<typeof setTimeout> };
type BrowserSocketData = { actor: "browser"; organizationId: string; cursor: number };
export type ControlPlaneSocketData = WorkerSocketData | BrowserSocketData;
type GatewayServer = Server<ControlPlaneSocketData>;
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
type ScheduleTimeout = (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
export function scheduleWorkerPing(sendPing: () => void, scheduleTimeout: ScheduleTimeout = setTimeout): ReturnType<typeof setTimeout> {
  return scheduleTimeout(sendPing, WORKER_HEARTBEAT_INTERVAL_MS);
}

export function enqueueWorkerMessage(
  tails: WeakMap<object, Promise<void>>,
  socket: object,
  work: () => Promise<void>,
): Promise<void> {
  const previous = tails.get(socket) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  tails.set(socket, current);
  return current;
}


type GatewayOptions = {
  db: DashboardDb;
  httpFetch(request: Request): Promise<Response>;
  current(request: Request): Promise<{ id: string; githubUserId: number; login: string; isGlobalAdmin: boolean } | null>;
  requestSource(request: Request, server: GatewayServer): string;
  dispatcher: WorkerCommandDispatcher;
  triggerReconciliation(): Promise<void>;
  requestId(): string;
};

export function createControlPlaneGateway(options: GatewayOptions) {
  const workerSockets = new Map<string, ServerWebSocket<ControlPlaneSocketData>>();
  const browserSockets = new Set<ServerWebSocket<ControlPlaneSocketData>>();
  const replayingBrowserSockets = new WeakSet<ServerWebSocket<ControlPlaneSocketData>>();
  const workerConnectionEpochs = new Map<string, number>();
  const workerMessageTails = new WeakMap<object, Promise<void>>();

  let nextWorkerConnectionEpoch = 0;

  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store" } });

  async function replayBrowserInvalidations(ws: ServerWebSocket<ControlPlaneSocketData>): Promise<void> {
    if (ws.data.actor !== "browser" || replayingBrowserSockets.has(ws)) return;
    replayingBrowserSockets.add(ws);
    try {
      for (let page = 0; page < 10; page += 1) {
        const rows = await loadBrowserInvalidations(options.db, ws.data.organizationId, ws.data.cursor);
        for (const row of rows) {
          ws.send(JSON.stringify({ version: 1, type: "invalidate", ...row }));
          ws.data.cursor = row.sequence;
        }
        if (rows.length < 100) break;
      }
    } finally {
      replayingBrowserSockets.delete(ws);
    }
  }

  const websocket: NonNullable<Parameters<typeof Bun.serve<ControlPlaneSocketData>>[0]["websocket"]> = {
    open(ws) {
      if (ws.data.actor === "worker") {
        const workerData = ws.data;
        workerData.authTimer = setTimeout(() => { if (!workerData.authenticated) ws.close(1008, "worker authentication timeout"); }, 10_000);
        const challenge = createWorkerChallenge(workerData.workerId);
        workerData.challenge = challenge.nonce;
        ws.send(JSON.stringify({ version: 1, type: "challenge", nonce: challenge.nonce.toString("base64url") }));
      } else {
        browserSockets.add(ws);
        void replayBrowserInvalidations(ws);
      }
    },
    message(ws, message) {
      if (ws.data.actor === "worker") {
        return enqueueWorkerMessage(workerMessageTails, ws, async () => {
          await handleWorkerMessage(ws, message);
        });
      }
      if (String(message) === "ping") {
        ws.send("pong");
      }
    },
    close(ws) {
      if (ws.data.actor === "worker") {
        if (ws.data.authTimer) {
          clearTimeout(ws.data.authTimer);
          ws.data.authTimer = undefined;
        }
        if (ws.data.heartbeatTimer) {
          clearTimeout(ws.data.heartbeatTimer);
          ws.data.heartbeatTimer = undefined;
        }
        options.dispatcher.unregister(ws.data.workerId, ws);
        const currentSocket = workerSockets.get(ws.data.workerId);
        if (currentSocket === ws) {
          workerSockets.delete(ws.data.workerId);
          if (ws.data.connectionEpoch === workerConnectionEpochs.get(ws.data.workerId)) workerConnectionEpochs.delete(ws.data.workerId);
        }
      }
      browserSockets.delete(ws);
    },
  };


  async function handleWorkerMessage(ws: ServerWebSocket<ControlPlaneSocketData>, message: string | Buffer): Promise<void> {
    if (ws.data.actor !== "worker") return;
    const workerData = ws.data;
    try {
      if (typeof message === "string" ? message.length > 256 * 1024 : message.byteLength > 256 * 1024) return ws.close(1009, "worker frame too large");
      const frame = JSON.parse(String(message)) as { type?: string; signature?: string; workerId?: string; encryptionPublicKey?: string; payload?: Record<string, unknown> };
      if (frame.type === "authenticate" && frame.workerId === ws.data.workerId && frame.signature && typeof frame.encryptionPublicKey === "string") {
        const epoch = ws.data.connectionEpoch;
        if (!epoch || workerConnectionEpochs.get(ws.data.workerId) !== epoch) return ws.close(4001, "superseded");
        if (!ws.data.challenge) return ws.close(1008, "worker authentication failed");
        const [worker] = await options.db`select public_key,encryption_public_key,admission_state from workers where id=${ws.data.workerId}`;
        const canonical = Buffer.from(`${ws.data.challenge.toString("base64url")}\n${ws.data.workerId}\n${frame.encryptionPublicKey}`);
        if (!worker || !verifyWorkerSignature(worker.public_key, canonical, decodeWorkerSignature(frame.signature))) return ws.close(1008, "worker authentication failed");
        if (worker.encryption_public_key && worker.encryption_public_key !== frame.encryptionPublicKey) return ws.close(1008, "worker encryption key mismatch");
        if (workerConnectionEpochs.get(ws.data.workerId) !== epoch) return ws.close(4001, "superseded");
        const activated = await activateAuthenticatedWorkerConnection({
          db: options.db,
          workerId: ws.data.workerId,
          encryptionPublicKey: frame.encryptionPublicKey,
          socket: ws,
          workerSockets,
          dispatcher: options.dispatcher,
          isCurrent: () => workerConnectionEpochs.get(workerData.workerId) === epoch,
          markAuthenticated: () => {
            workerData.authTimer && clearTimeout(workerData.authTimer);
            workerData.authTimer = undefined;
            workerData.authenticated = true;
          },
        });
        if (!activated) return ws.close(4001, "superseded");
        ws.send(JSON.stringify({ version: 1, type: "authenticated", workerId: ws.data.workerId, admissionState: worker.admission_state }));
        ws.send(JSON.stringify({ version: 1, type: "ping" }));
      } else if (frame.type === "doctor" && ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && frame.workerId === ws.data.workerId && frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload)) {
        const epoch = ws.data.connectionEpoch;
        if (workerSockets.get(ws.data.workerId) !== ws || workerConnectionEpochs.get(ws.data.workerId) !== epoch) return;
        if (containsSecret(frame.payload)) return;
        const parsed = WorkerDoctorReport.safeParse(frame.payload);
        if (!parsed.success) return;
        const doctorPayload = parsed.data;
        await options.db`update workers set doctor=${jsonParameter(options.db, doctorPayload)}, doctor_observed_at=now(), last_heartbeat_at=now() where id=${ws.data.workerId}`;
        if (doctorPayload.doctor.activeLeases) {
          await reconcileWorkerInventory(options.db, ws.data.workerId, doctorPayload.doctor.activeLeases);
        }
        if (workerSockets.get(ws.data.workerId) !== ws || workerConnectionEpochs.get(ws.data.workerId) !== epoch) return;
        ws.send(JSON.stringify({ version: 1, type: "doctor_ack", workerId: ws.data.workerId }));
      } else if (frame.type === "pong" && ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && workerConnectionEpochs.get(ws.data.workerId) === ws.data.connectionEpoch) {
        await options.db`update workers set last_heartbeat_at=now() where id=${ws.data.workerId}`;
        clearTimeout(workerData.heartbeatTimer);
        const epoch = workerData.connectionEpoch;
        workerData.heartbeatTimer = scheduleWorkerPing(() => {
          workerData.heartbeatTimer = undefined;
          if (!workerData.authenticated || workerSockets.get(workerData.workerId) !== ws || workerConnectionEpochs.get(workerData.workerId) !== epoch) return;
          ws.send(JSON.stringify({ version: 1, type: "ping" }));
        });
      } else if (ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && workerConnectionEpochs.get(ws.data.workerId) === ws.data.connectionEpoch && frame.workerId === ws.data.workerId) {
        if (frame.type === "worker.configured") {
          const acknowledged = await applyWorkerConfigurationAcknowledgement(options.db, { workerId: ws.data.workerId, payload: frame.payload });
          if (!acknowledged) {
            const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as Record<string, unknown> : {};
            const [state] = await options.db`SELECT configuration_command_id AS "commandId", configuration_revision AS revision, desired_configuration AS desired FROM workers WHERE id=${ws.data.workerId}`;
            console.error("Worker configuration acknowledgement rejected", { workerId: ws.data.workerId, commandId: payload.commandId, revision: payload.revision, expectedCommandId: state?.commandId, expectedRevision: state?.revision, observed: payload.observed, desired: state?.desired });
          }
          console.log(`Worker configuration acknowledgement: ${ws.data.workerId} accepted=${acknowledged}`);
          options.dispatcher.handleEvent(frame, ws);
          void options.triggerReconciliation();
        } else {
          const accepted = await handleAuthenticatedWorkerEvent(options.db, options.dispatcher, frame, ws);
          if (!accepted) throw new Error("invalid worker event");
          console.log(`Worker event: ${ws.data.workerId} type=${frame.type}`);
        }
      }
    } catch (error) {
      console.error("Worker websocket frame failed", { workerId: ws.data.workerId, error: error instanceof Error ? error.message : String(error) });
      ws.close(1008, "invalid worker frame");
    }
  }

  async function fetch(request: Request, server: GatewayServer): Promise<Response | undefined> {
    const url = new URL(request.url);
    options.requestSource(request, server);
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname === "/api/browser/invalidations") {
      try {
        const user = await options.current(request);
        if (!user) return json({ code: "unauthorized", message: "Authentication required", requestId: options.requestId() }, 401);
        const organizationId = url.searchParams.get("organizationId") ?? "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)) return json({ code: "invalid_request", message: "A concrete organization is required" }, 400);
        const rawCursor = Number(url.searchParams.get("cursor") ?? 0);
        const cursor = Number.isSafeInteger(rawCursor) && rawCursor >= 0 ? rawCursor : 0;
        if (!await canSubscribeToOrganization(options.db, user, organizationId)) return json({ code: "not_found", message: "Organization not found" }, 404);
        if (server.upgrade(request, { data: { actor: "browser", organizationId, cursor } })) return undefined;
        return json({ code: "upgrade_failed", message: "WebSocket upgrade failed" }, 400);
      } catch (error) {
        console.error("Browser invalidation websocket upgrade failed", error);
        return json({ code: "internal_error", message: "WebSocket upgrade failed", requestId: options.requestId() }, 500);
      }
    }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname === "/api/v1/workers/connect") {
      const workerId = url.searchParams.get("workerId");
      if (!workerId) return json({ error: "workerId required" }, 400);
      const [worker] = await options.db`select admission_state from workers where id=${workerId}`;
      if (!worker || worker.admission_state === "revoked" || worker.admission_state === "rejected") return json({ code: "worker_unavailable", message: "Worker is unknown or revoked" }, 403);
      const previousEpoch = workerConnectionEpochs.get(workerId);
      const connectionEpoch = ++nextWorkerConnectionEpoch;
      workerConnectionEpochs.set(workerId, connectionEpoch);
      if (server.upgrade(request, { data: { actor: "worker", workerId, authenticated: false, connectionEpoch } })) return undefined;
      if (workerConnectionEpochs.get(workerId) === connectionEpoch) {
        if (previousEpoch === undefined) workerConnectionEpochs.delete(workerId); else workerConnectionEpochs.set(workerId, previousEpoch);
      }
      return json({ error: "websocket upgrade failed" }, 400);
    }
    return options.httpFetch(request);
  }
  return { fetch, websocket, browserSockets, replayBrowserInvalidations };
}
