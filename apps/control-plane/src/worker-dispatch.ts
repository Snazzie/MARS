import { randomUUID } from "node:crypto";
import { WorkerCommand, WorkerEvent } from "@whitesmith/contracts";

export interface AuthenticatedWorkerSocket { send(data: string): void; close?(code?: number, reason?: string): void; }
export interface WorkerCommandStore {
  save(command: WorkerCommand): Promise<void>;
  listUnacknowledged(workerId: string): Promise<WorkerCommand[]>;
  markSent?(commandId: string): Promise<void>;
  acknowledge(commandId: string): Promise<void>;
}
export class WorkerDispatchError extends Error { constructor(message: string) { super(message); this.name = "WorkerDispatchError"; } }
type Pending = { command: WorkerCommand; resolve: (event: WorkerEvent) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export class WorkerCommandDispatcher {
  private readonly sockets = new Map<string, AuthenticatedWorkerSocket>();
  private readonly epochs = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private readonly durableWorkers = new Map<string, string>();
  private readonly chains = new Map<string, Promise<void>>();
  constructor(private readonly timeoutMs = 15_000, private readonly store?: WorkerCommandStore) {}
  private serialized<T>(workerId: string, operation: () => Promise<T>): Promise<T> {
    if (!this.store) return operation();
    const previous = this.chains.get(workerId);
    const result = previous ? previous.then(operation, operation) : operation();
    this.chains.set(workerId, result.then(() => undefined, () => undefined));
    return result;
  }
  isConnected(workerId: string): boolean { return this.sockets.has(workerId); }
  register(workerId: string, socket: AuthenticatedWorkerSocket): void {
    const old = this.sockets.get(workerId);
    if (old === socket) return;
    this.epochs.set(workerId, (this.epochs.get(workerId) ?? 0) + 1);
    old?.close?.(4001, "superseded");
    this.sockets.set(workerId, socket);
    const epoch = this.epochs.get(workerId)!;
    if (this.store) void this.serialized(workerId, () => this.replay(workerId, socket, epoch));
  }
  /** Replay committed durable commands to the currently authenticated socket. */
  replayConnected(workerId: string): Promise<void> {
    const socket = this.sockets.get(workerId);
    const epoch = this.epochs.get(workerId);
    if (!socket || epoch === undefined || !this.store) return Promise.resolve();
    return this.serialized(workerId, () => this.replay(workerId, socket, epoch));
  }
  private async replay(workerId: string, socket: AuthenticatedWorkerSocket, epoch: number): Promise<void> {
    const valid = () => this.sockets.get(workerId) === socket && this.epochs.get(workerId) === epoch;
    const seen = new Set<string>();
    if (this.store) for (const command of await this.store.listUnacknowledged(workerId)) {
      if (!valid()) return; seen.add(command.id); this.durableWorkers.set(command.id, workerId);
      try { socket.send(JSON.stringify(command)); await this.store.markSent?.(command.id); } catch { return; }
    }
    for (const pending of this.pending.values()) {
      if (pending.command.workerId !== workerId || seen.has(pending.command.id)) continue;
      if (!valid()) return;
      try { socket.send(JSON.stringify(pending.command)); await this.store?.markSent?.(pending.command.id); } catch { return; }
    }
  }
  unregister(workerId: string, socket?: AuthenticatedWorkerSocket): void {
    if (socket && this.sockets.get(workerId) !== socket) return;
    this.sockets.delete(workerId); this.epochs.set(workerId, (this.epochs.get(workerId) ?? 0) + 1);
    if (!this.store) for (const [id, pending] of this.pending) if (pending.command.workerId === workerId) {
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new WorkerDispatchError("worker disconnected"));
    }
  }
  handleEvent(input: unknown, socket?: AuthenticatedWorkerSocket): boolean {
    const parsed = WorkerEvent.safeParse(input); if (!parsed.success) return false;
    const event = parsed.data; const commandId = typeof event.payload.commandId === "string" ? event.payload.commandId : undefined;
    if (socket && this.sockets.get(event.workerId) !== socket) return false;
    if (!commandId) return true;
    const pending = this.pending.get(commandId);
    if (pending) {
      if (pending.command.workerId !== event.workerId) return false;
      clearTimeout(pending.timer); this.pending.delete(commandId); this.durableWorkers.delete(commandId);
      void this.store?.acknowledge(commandId); pending.resolve(event); return true;
    }
    if (this.durableWorkers.get(commandId) !== event.workerId) return false;
    this.durableWorkers.delete(commandId); void this.store?.acknowledge(commandId); return true;
  }
  async dispatch(input: Omit<WorkerCommand, "version" | "id" | "occurredAt"> & Partial<Pick<WorkerCommand, "leaseId">>): Promise<WorkerEvent> {
    return this.serialized(input.workerId, async () => {
      const initialSocket = this.sockets.get(input.workerId); if (!initialSocket) throw new WorkerDispatchError("worker is not authenticated");
      const command = WorkerCommand.parse({ ...input, version: 1, id: randomUUID(), occurredAt: new Date().toISOString(), leaseId: input.leaseId ?? null });
      if (containsSecret(command.payload)) throw new WorkerDispatchError("worker command payload contains secret material");
      if (this.store) {
        await this.store.save(command);
        this.durableWorkers.set(command.id, command.workerId);
      }
      if (this.sockets.get(input.workerId) !== initialSocket) throw new WorkerDispatchError("worker socket changed before send");
      try {
        initialSocket.send(JSON.stringify(command));
        await this.store?.markSent?.(command.id);
        return WorkerEvent.parse({ version: 1, id: randomUUID(), workerId: input.workerId, type: "command.accepted", occurredAt: new Date().toISOString(), payload: { commandId: command.id, leaseId: command.leaseId } });
      } catch { throw new WorkerDispatchError("worker socket send failed"); }
    });
  }
}
const SECRET_KEY_PATTERN = /(?:code|secret|token|privatekey|jobclaim|jitconfig|enrollment)/;
export function containsSecret(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSecret);
  return Object.entries(value).some(([key, child]) => SECRET_KEY_PATTERN.test(key.toLowerCase().replace(/[^a-z0-9]/g, "")) || containsSecret(child));
}
