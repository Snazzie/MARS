export type StoredWorkerDoctor = Record<string, unknown>;

export function storedWorkerDoctor(value: unknown): StoredWorkerDoctor {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return {}; }
  }
  if (!parsed || typeof parsed !== "object") return {};
  const record = parsed as Record<string, unknown>;
  const nested = record.doctor;
  return nested && typeof nested === "object" ? nested as StoredWorkerDoctor : record;
}

export function workerPoolEvidence(value: unknown, driver: string, imageDigest: string, guestPlatform?: string): { ready: boolean; imageMatches: boolean } {
  const capabilities = storedWorkerDoctor(value).capabilities;
  if (!Array.isArray(capabilities)) return { ready: false, imageMatches: false };
  const capability = capabilities.find((entry) => entry && typeof entry === "object"
    && (entry as Record<string, unknown>).driver === driver
    && (entry as Record<string, unknown>).guestPlatform === guestPlatform);
  if (!capability || typeof capability !== "object") return { ready: false, imageMatches: false };
  const record = capability as Record<string, unknown>;
  return { ready: record.ready === true, imageMatches: record.imageDigest === imageDigest };
}
