import { open, stat } from "node:fs/promises";
import { sanitizeDiagnosticText, WorkerLogRequestPayload, type WorkerEvent } from "@mars/contracts";

const DEFAULT_MAX_BYTES = 64 * 1024;

async function tailFile(path: string, maxBytes: number): Promise<string | null> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const length = Math.min(info.size, maxBytes);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
function boundedUtf8Tail(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.length <= maxBytes) return value;
  let start = encoded.length - maxBytes;
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

export async function readWorkerServiceLogs(paths: readonly string[], maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
  const bounded = Math.max(1, Math.min(maxBytes, 128 * 1024));
  const sections: string[] = [];
  for (const path of paths) {
    const content = await tailFile(path, bounded);
    const label = path.split(/[\\/]/).at(-1) || "worker.log";
    if (content !== null) sections.push(`=== ${label} ===\n${content}`);
  }
  const combined = sections.length ? sections.join("\n") : "Worker service log files are unavailable.";
  return boundedUtf8Tail(sanitizeDiagnosticText(combined), bounded);
}

export function workerServiceLogPaths(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = Bun.env): string[] {
  const configured = environment.MARS_WORKER_LOG_FILE?.trim();
  if (configured) return [configured];
  if (platform === "darwin") {
    const root = `${environment.HOME?.trim() || "/Users/Shared"}/Library/Application Support/Mars`;
    return [`${root}/worker.log`, `${root}/worker.error.log`];
  }
  if (platform === "win32") {
    const root = `${environment.ProgramData?.trim() || "C:\\ProgramData"}\\Mars\\logs`;
    return [`${root}\\worker.log`, `${root}\\worker.previous.log`];
  }
  return ["/var/log/mars/worker.log"];
}

export async function collectWorkerServiceLogs(command: { id: string; workerId: string; leaseId: string | null; payload: Record<string, unknown> }, paths = workerServiceLogPaths()): Promise<WorkerEvent> {
  if (command.leaseId !== null) throw new Error("worker log request must not target a lease");
  const request = WorkerLogRequestPayload.parse(command.payload);
  const observedAt = new Date().toISOString();
  return {
    version: 1,
    id: crypto.randomUUID(),
    workerId: command.workerId,
    type: "worker.logs",
    occurredAt: observedAt,
    payload: {
      commandId: command.id,
      requestId: request.requestId,
      observedAt,
      content: await readWorkerServiceLogs(paths, request.maxBytes),
    },
  };
}
