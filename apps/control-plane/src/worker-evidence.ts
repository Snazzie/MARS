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

export function storedWorkerRuntimeMode(value: unknown): "container" | "vm" | "tart" | undefined {
  const mode = storedWorkerDoctor(value).runtimeMode;
  return mode === "container" || mode === "vm" || mode === "tart" ? mode : undefined;
}

export function workerPoolEvidence(value: unknown, driver: string, imageDigest: string, guestPlatform?: string): { ready: boolean; imageMatches: boolean } {
  const doctor = storedWorkerDoctor(value);
  if (driver === "tart-vm") {
    const digests = doctor.artifactDigests && typeof doctor.artifactDigests === "object" ? doctor.artifactDigests as Record<string, unknown> : {};
    return { ready: doctor.runtimeReady === true, imageMatches: typeof guestPlatform === "string" && digests[guestPlatform] === imageDigest };
  }
  if (driver === "linux-libvirt-vm") return {
    ready: [doctor.runtimeReady, doctor.libvirtReady, doctor.networkReady, doctor.cloneStorageReady, doctor.imageSignatures, doctor.realVmSmoke].every(value => value === true),
    imageMatches: doctor.artifactDigest === imageDigest && doctor.smokeArtifactDigest === imageDigest,
  };
  if (driver === "linux-docker-container") return {
    ready: [doctor.runtimeReady, doctor.networkReady, doctor.imageSignatures].every(value => value === true),
    imageMatches: doctor.artifactDigest === imageDigest,
  };
  if (driver === "windows-hyperv" || driver === "windows-hyperv-container") return {
    ready: [doctor.runtimeReady, doctor.probe, doctor.imageSignatures].every(value => value === true),
    imageMatches: doctor.artifactDigest === imageDigest,
  };
  return { ready: false, imageMatches: false };
}
