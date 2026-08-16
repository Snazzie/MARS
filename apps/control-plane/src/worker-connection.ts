import type { DatabaseClient } from "@whitesmith/db";
import type { AuthenticatedWorkerSocket, WorkerCommandDispatcher } from "./worker-dispatch.ts";
import { reconcileWorkerConfigurationOnConnect } from "./worker-requests.ts";

export async function activateAuthenticatedWorkerConnection<Socket extends AuthenticatedWorkerSocket>(input: {
  db: DatabaseClient;
  workerId: string;
  encryptionPublicKey?: string;
  socket: Socket;
  workerSockets: Map<string, Socket>;
  dispatcher: Pick<WorkerCommandDispatcher, "register">;
  markAuthenticated: () => void;
  isCurrent?: () => boolean;
  reconcile?: typeof reconcileWorkerConfigurationOnConnect;
}): Promise<boolean> {
  await (input.reconcile ?? reconcileWorkerConfigurationOnConnect)(input.db, input.workerId);
  if (input.isCurrent && !input.isCurrent()) return false;
  if (input.encryptionPublicKey) {
    await input.db`update workers set encryption_public_key=COALESCE(encryption_public_key,${input.encryptionPublicKey}), connection_state='online' where id=${input.workerId}`;
  } else {
    await input.db`update workers set connection_state='online' where id=${input.workerId}`;
  }
  if (input.isCurrent && !input.isCurrent()) return false;
  input.markAuthenticated();
  input.workerSockets.set(input.workerId, input.socket);
  input.dispatcher.register(input.workerId, input.socket);
  return true;
}
