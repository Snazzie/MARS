import type { DatabaseClient } from "@mars/db";
import { defineQueries, schema } from "@mars/db";
import { eq, sql } from "drizzle-orm";
import type { AuthenticatedWorkerSocket, WorkerCommandDispatcher } from "./worker-dispatch.ts";
import { reconcileWorkerConfigurationOnConnect } from "./worker-requests.ts";

const queries = defineQueries(db => ({
  authenticateWithKey: db.update(schema.workers).set({ encryptionPublicKey: sql`coalesce(${schema.workers.encryptionPublicKey}, ${sql.placeholder("encryptionPublicKey")})`, enrollmentAuthenticatedAt: sql`now()`, enrollmentCodeHash: null }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_connection_authenticate_key"),
  authenticate: db.update(schema.workers).set({ enrollmentAuthenticatedAt: sql`now()`, enrollmentCodeHash: null }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_connection_authenticate"),
  heartbeat: db.update(schema.workers).set({ lastHeartbeatAt: sql`now()` }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_connection_heartbeat"),
  online: db.update(schema.workers).set({ connectionState: "online" }).where(eq(schema.workers.id, sql.placeholder("workerId"))).prepare("worker_connection_online"),
}));

export async function activateAuthenticatedWorkerConnection<Socket extends AuthenticatedWorkerSocket>(input: {
  db: DatabaseClient;
  workerId: string;
  encryptionPublicKey?: string;
  socket: Socket;
  workerSockets: Map<string, Socket>;
  dispatcher: Pick<WorkerCommandDispatcher, "register">;
  markAuthenticated: () => void;
  isCurrent?: () => boolean;
  activate?: () => boolean;
  reconcile?: typeof reconcileWorkerConfigurationOnConnect;
  sameProcess?: boolean;
}): Promise<boolean> {
  await (input.reconcile ?? reconcileWorkerConfigurationOnConnect)(input.db, input.workerId, input.sameProcess);
  if (input.isCurrent && !input.isCurrent()) return false;
  if (input.encryptionPublicKey) {
    await queries(input.db).authenticateWithKey.execute({ workerId: input.workerId, encryptionPublicKey: input.encryptionPublicKey });
  } else {
    await queries(input.db).authenticate.execute({ workerId: input.workerId });
  }
  await queries(input.db).heartbeat.execute({ workerId: input.workerId });
  if (input.isCurrent && !input.isCurrent()) return false;
  if (input.activate && !input.activate()) return false;
  input.markAuthenticated();
  input.workerSockets.set(input.workerId, input.socket);
  input.dispatcher.register(input.workerId, input.socket);
  await queries(input.db).online.execute({ workerId: input.workerId });
  return true;
}
