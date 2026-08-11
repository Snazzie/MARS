import { createDb, migrate } from "@whitesmith/db";
import type { WorkerCommand } from "@whitesmith/contracts";
import { WorkerCommand as WorkerCommandSchema } from "@whitesmith/contracts";
import type { Server, ServerWebSocket } from "bun";
import { createSession, getSession, SecretBox } from "./auth.ts";
import { createPkce, githubAuthorizeUrl, exchangeOAuth, ensureBootstrapAdmin, syncGithubOrganizations } from "./github.ts";
import { applyWorkflowJobWebhook, configureRunLifecycle } from "./runs.ts";
import { readBody, validSignature, acceptDelivery } from "./webhook.ts";
import { createEnrollmentCode, consumeJoin, fingerprint, adoptWorker, verifyWorkerSignature } from "./workers.ts";
import { createWorkerChallenge, decodeWorkerSignature } from "./worker-socket.ts";
import { WorkerCommandDispatcher, containsSecret } from "./worker-dispatch.ts";
import { createControlPlaneApp } from "./http/app.ts";
const required = (name:string):string => { const value=Bun.env[name]; if(!value) throw new Error(`${name} is required`); return value; };
const env = { BASE: required("PUBLIC_BASE_URL"), DATABASE: required("DATABASE_URL"), WEBHOOK_SECRET: required("GITHUB_WEBHOOK_SECRET"), CLIENT_ID: required("GITHUB_OAUTH_CLIENT_ID"), CLIENT_SECRET: required("GITHUB_OAUTH_CLIENT_SECRET"), BOOTSTRAP: required("BOOTSTRAP_GITHUB_LOGIN"), MASTER: required("APP_MASTER_KEY") };
const db = createDb(env.DATABASE); await migrate(db); new SecretBox(env.MASTER);
configureRunLifecycle(db);
const json = (data: unknown, status=200) => Response.json(data,{status,headers:{"cache-control":"no-store"}});
const cookie = (value:string, maxAge:number) => `whitesmith_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const sessions = new Map<string, {state:string; verifier:string; createdAt:number}>();
type SocketData = { actor: "browser" | "worker"; workerId: string; challenge?: Buffer; authenticated: boolean; connectionEpoch?: number };
const workerSockets = new Map<string, ServerWebSocket<SocketData>>();
const workerConnectionEpochs = new Map<string, number>();
let nextWorkerConnectionEpoch = 0;
async function current(request: Request) { return getSession(db, request.headers.get("cookie")?.match(/whitesmith_session=([^;]+)/)?.[1]); }
const commandStore = {
  async save(command: WorkerCommand): Promise<void> {
    await db`insert into commands (id,version,type,worker_id,lease_id,occurred_at,payload) values (${command.id},${command.version},${command.type},${command.workerId},${command.leaseId},${command.occurredAt},${JSON.stringify(command.payload)}) on conflict (id) do nothing`;
  },
  async listUnacknowledged(workerId: string): Promise<WorkerCommand[]> {
    const rows = await db`select id,version,type,worker_id as "workerId",lease_id as "leaseId",occurred_at as "occurredAt",payload from commands where worker_id=${workerId} and state in ('pending','sent') order by occurred_at asc,id asc`;
    return rows.map(row => WorkerCommandSchema.parse({
      ...row,
      occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
    }));
  },
  async markSent(commandId: string): Promise<void> {
    await db`update commands set state='sent' where id=${commandId} and state='pending'`;
  },
  async acknowledge(commandId: string): Promise<void> {
    await db`update commands set state='acknowledged' where id=${commandId} and state in ('pending','sent')`;
  },
};
const dispatcher = new WorkerCommandDispatcher(15_000, commandStore);
const requestSources = new WeakMap<Request, string>();
const httpApp = createControlPlaneApp({ db, baseUrl: env.BASE, githubClientId: env.CLIENT_ID, githubClientSecret: env.CLIENT_SECRET, bootstrapGithubLogin: env.BOOTSTRAP, githubWebhookSecret: env.WEBHOOK_SECRET, currentUser: current, requestId: () => crypto.randomUUID(), requestSource: (request) => requestSources.get(request) ?? "unknown", webRoot: new URL("../../web/", import.meta.url), workerInstallerRoot: new URL("../../../deploy/workers/", import.meta.url), onWorkerAdopted: (workerId) => { const socket = workerSockets.get(workerId); if (socket?.data.authenticated) dispatcher.register(workerId, socket); } });
let server: Server<SocketData>;
server = Bun.serve<SocketData>({
  port: Number(Bun.env.PORT ?? 3000),
  websocket: {
    open(ws) {
      if (ws.data.actor === "worker") {
        const challenge = createWorkerChallenge(ws.data.workerId);
        ws.data.challenge = challenge.nonce;
        ws.send(JSON.stringify({ version: 1, type: "challenge", nonce: challenge.nonce.toString("base64url") }));
      } else {
        ws.subscribe("browser");
      }
    },
    async message(ws, message) {
      if (ws.data.actor === "worker") {
        try {
          const frame = JSON.parse(String(message)) as {
            type?: string;
            signature?: string;
            workerId?: string;
            payload?: Record<string, unknown>;
          };
          if (frame.type === "authenticate" && frame.workerId === ws.data.workerId && frame.signature) {
            const epoch = ws.data.connectionEpoch;
            if (!epoch || workerConnectionEpochs.get(ws.data.workerId) !== epoch) return ws.close(4001, "superseded");
            if (!ws.data.challenge) return ws.close(1008, "worker authentication failed");
            const [worker] = await db`select public_key,admission_state from workers where id=${ws.data.workerId} and platform='macos-arm64'`;
            if (!worker || !verifyWorkerSignature(worker.public_key, ws.data.challenge, decodeWorkerSignature(frame.signature))) return ws.close(1008, "worker authentication failed");
            if (workerConnectionEpochs.get(ws.data.workerId) !== epoch) return ws.close(4001, "superseded");
            await db`update workers set connection_state='online' where id=${ws.data.workerId}`;
            if (workerConnectionEpochs.get(ws.data.workerId) !== epoch) return ws.close(4001, "superseded");
            const previousSocket = workerSockets.get(ws.data.workerId);
            workerSockets.set(ws.data.workerId, ws);
            if (previousSocket && previousSocket !== ws) previousSocket.close?.(4001, "superseded");
            ws.data.authenticated = true;
            if (worker.admission_state === "adopted") {
              if (workerConnectionEpochs.get(ws.data.workerId) !== epoch) return ws.close(4001, "superseded");
              dispatcher.register(ws.data.workerId, ws);
            }
            ws.send(JSON.stringify({ version: 1, type: "authenticated", workerId: ws.data.workerId, admissionState: worker.admission_state }));
          } else if (frame.type === "doctor" && ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && frame.workerId === ws.data.workerId && frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload) && !containsSecret(frame.payload)) {
            const epoch = ws.data.connectionEpoch;
            if (workerSockets.get(ws.data.workerId) !== ws || workerConnectionEpochs.get(ws.data.workerId) !== epoch) return;
            await db`update workers set doctor=${JSON.stringify(frame.payload)}, configuration_state=case when admission_state='adopted' then 'ready' else 'unconfigured' end where id=${ws.data.workerId}`;
            if (workerSockets.get(ws.data.workerId) !== ws || workerConnectionEpochs.get(ws.data.workerId) !== epoch) return;
            ws.send(JSON.stringify({ version: 1, type: "doctor_ack", workerId: ws.data.workerId }));
          } else if (frame.type === "pong" && ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && workerConnectionEpochs.get(ws.data.workerId) === ws.data.connectionEpoch) {
            ws.send(JSON.stringify({ version: 1, type: "ping" }));
          } else if (ws.data.authenticated && workerSockets.get(ws.data.workerId) === ws && workerConnectionEpochs.get(ws.data.workerId) === ws.data.connectionEpoch) {
            dispatcher.handleEvent(frame, ws);
          }
        } catch {
          ws.close(1008, "invalid worker frame");
        }
      } else if (message === "ping") {
        ws.send("pong");
      }
    },
    close(ws) {
      if (ws.data.actor === "worker") {
        dispatcher.unregister(ws.data.workerId, ws);
        const currentSocket = workerSockets.get(ws.data.workerId);
        if (currentSocket === ws) {
          workerSockets.delete(ws.data.workerId);
          if (ws.data.connectionEpoch === workerConnectionEpochs.get(ws.data.workerId)) {
            workerConnectionEpochs.delete(ws.data.workerId);
          }
          void db`update workers set connection_state='offline' where id=${ws.data.workerId}`;
        }
      } else {
        ws.unsubscribe("browser");
      }
    },
  },
  async fetch(request): Promise<Response | undefined> {
  const url=new URL(request.url);
    requestSources.set(request, server.requestIP(request)?.address ?? "unknown");
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname === "/api/v1/workers/connect") { const workerId = url.searchParams.get("workerId"); if (!workerId) return json({ error: "workerId required" }, 400); const previousEpoch = workerConnectionEpochs.get(workerId); const connectionEpoch = ++nextWorkerConnectionEpoch; workerConnectionEpochs.set(workerId, connectionEpoch); if (server.upgrade(request, { data: { actor: "worker", workerId, authenticated: false, connectionEpoch } })) return undefined; if (workerConnectionEpochs.get(workerId) === connectionEpoch) { if (previousEpoch === undefined) workerConnectionEpochs.delete(workerId); else workerConnectionEpochs.set(workerId, previousEpoch); } return json({ error: "websocket upgrade failed" }, 400); }
    return httpApp.fetch(request);
  },
});
console.log(`Whitesmith control plane listening on ${server.url}`);
