import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { CURRENT_WORKER_CONTRACT_VERSION, PendingWorkerRequest, WorkerConfiguration, WorkerContractVersion, WorkerReleaseOciDigest, WorkerReleaseVersion, normalizeWindowsWorkerRelease } from "@mars/contracts";
import type { LinuxArm64WorkerRelease, LinuxWorkerRelease, MacosWorkerRelease, WindowsWorkerRelease } from "@mars/contracts";
import type { ControlPlaneEnv, ControlPlaneHttpDeps, DevelopmentArtifact, DevelopmentArtifactFetchOptions, DevelopmentLinuxArm64Artifacts, DevelopmentLinuxArtifacts, DevelopmentMacosArtifacts, DevelopmentWindowsArtifacts } from "./types.ts";
import { verifyWorkerBootstrap, initializeWorkerBootstrap, rotateWorkerBootstrap, getWorkerBootstrapStatus } from "../worker-bootstrap.ts";
import { approvePendingWorker, configurePendingWorker, createRequestLimiter, hasMachineIdentity, parseApproveWorkerRequest, requestPendingWorker, rejectPendingWorker } from "../worker-requests.ts";
import { httpOrigin } from "../http-origin.ts";
import type { WorkerReleaseTarget } from "../worker-release.ts";
function noStore(headers = new Headers()): Headers { headers.set("cache-control", "no-store"); return headers; }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\"'\"'")}'`; }
function powerShellQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
type InstallerValues = Record<string, string>;
type ArtifactPath = string | URL;
function powershellParamBlockEnd(source: string): number | undefined {
  const paramStart = /(?:^|\r?\n)[ \t]*param[ \t]*\(/g;
  const match = paramStart.exec(source);
  if (!match) return undefined;
  const open = source.indexOf("(", match.index + match[0].length - 1);
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "#" && next === ">") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote === "'") {
      if (current === "'" && next === "'") index += 1;
      else if (current === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (current === "`") index += 1;
      else if (current === '"') quote = undefined;
      continue;
    }
    if (current === "<" && next === "#") {
      blockComment = true;
      index += 1;
    } else if (current === "#") {
      lineComment = true;
    } else if (current === "'" || current === '"') {
      quote = current;
    } else if (current === "(") {
      depth += 1;
    } else if (current === ")" && --depth === 0) {
      return index + 1;
    }
  }
  return undefined;
}
function injectInstallerOrigin(source: string, baseUrl: string, extra: InstallerValues = {}, powershell = false): string {
  if (powershell) {
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    const values = { ControlPlaneUrl: new URL(baseUrl).origin, ...extra };
    const injected = Object.entries(values).map(([key, value]) => `$${key} = ${powerShellQuote(value)}`).join(newline);
    const parameterEnd = powershellParamBlockEnd(source);
    if (parameterEnd !== undefined) {
      const lineEnd = source.startsWith("\r\n", parameterEnd) ? 2 : source[parameterEnd] === "\n" ? 1 : 0;
      const insertAt = parameterEnd + lineEnd;
      return `${source.slice(0, insertAt)}${injected}${newline}${source.slice(insertAt)}`;
    }
    const cmdletBindingAttribute = source.match(/^[ \t]*\[CmdletBinding\(\)\][ \t]*\r?\n/m);
    if (cmdletBindingAttribute) {
      const insertAt = cmdletBindingAttribute.index! + cmdletBindingAttribute[0].length;
      return `${source.slice(0, insertAt)}${injected}${newline}${source.slice(insertAt)}`;
    }
    return `${injected}${newline}${source}`;
  }
  const values = { PUBLIC_BASE_URL: new URL(baseUrl).origin, ...extra };
  const injected = Object.entries(values).flatMap(([key, value]) => [`${key}=${shellQuote(value)}`, `export ${key}`]).join("\n");
  const newline = source.indexOf("\n"); const insertAt = source.startsWith("#!") && newline >= 0 ? newline + 1 : 0;
  return `${source.slice(0, insertAt)}${injected}\n${source.slice(insertAt)}`;
}
const hasValue = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const tartDigest = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !WorkerReleaseOciDigest.safeParse(value).success) return undefined;
  return value.split("@sha256:")[1];
};
const artifactExists = async (path: ArtifactPath | undefined): Promise<boolean> => Boolean(path && await Bun.file(path).exists());
const pathFor = (root: URL, name: string): URL => new URL(name, root);
async function fileSha256(path: ArtifactPath): Promise<string> {
  const hash = createHash("sha256");
  const reader = Bun.file(path).stream().getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return hash.digest("hex");
      hash.update(result.value);
    }
  } finally {
    reader.releaseLock();
  }
}
function unavailable(c: Context<ControlPlaneEnv>, artifacts: string[]) {
  return c.json({ code: "artifact_unavailable", message: "Worker installer prerequisites are unavailable", artifacts }, 503, { "cache-control": "no-store" });
}
type ArtifactSizeClass = "template" | "archive" | "binary";
type ArtifactSnapshot = {
  path: ArtifactPath;
  sha256: string;
  size: number;
  contentType?: string;
  dispose(): Promise<void>;
};

const privateIpv4 = (address: string): boolean => {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19 || second === 51))
    || (first === 203 && second === 0)
    || first >= 224;
};

const restrictedAddress = (rawAddress: string): boolean => {
  const address = rawAddress.toLowerCase().split("%", 1)[0];
  if (isIP(address) === 4) return privateIpv4(address);
  if (isIP(address) !== 6) return true;
  if (address.startsWith("::ffff:")) {
    const mapped = address.slice(7);
    if (isIP(mapped) === 4) return privateIpv4(mapped);
    const parts = mapped.split(":");
    if (parts.length === 2) {
      const high = Number.parseInt(parts[0], 16);
      const low = Number.parseInt(parts[1], 16);
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return privateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
      }
    }
    return true;
  }
  return address === "::"
    || address === "::1"
    || /^f[cd]/.test(address)
    || /^fe[89ab]/.test(address)
    || address.startsWith("ff")
    || address.startsWith("2001:db8:")
    || address.startsWith("2001:0:")
    || address.startsWith("2001:2:")
    || address.startsWith("2002:");
};

const normalizedHostname = (url: URL): string => url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

const explicitlyLocalUrl = (url: URL): boolean => {
  const hostname = normalizedHostname(url);
  return hostname === "localhost" || hostname.endsWith(".localhost") || (isIP(hostname) !== 0 && restrictedAddress(hostname));
};

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function validateProxyDestination(
  url: URL,
  allowRestricted: boolean,
  resolveHostname: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>,
  signal: AbortSignal,
): Promise<string> {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error("invalid_artifact_url");
  const hostname = normalizedHostname(url);
  if (!allowRestricted && explicitlyLocalUrl(url)) throw new Error("restricted_artifact_destination");
  const addresses = isIP(hostname) !== 0
    ? [hostname]
    : await abortable(Promise.resolve(resolveHostname(hostname, signal)), signal);
  if (!addresses.length || addresses.some(address => isIP(address) === 0 || (!allowRestricted && restrictedAddress(address)))) {
    throw new Error("restricted_artifact_destination");
  }
  return addresses[0]!;
}

function pinnedDestination(url: URL, address: string): URL {
  const pinned = new URL(url);
  const formattedAddress = isIP(address) === 6 ? `[${address}]` : address;
  pinned.host = `${formattedAddress}${url.port ? `:${url.port}` : ""}`;
  return pinned;
}

class ArtifactAdmission {
  readonly #limit: number;
  readonly #maximumQueued: number;
  #active = 0;
  readonly #waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (reason?: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  constructor(limit: number, maximumQueued: number) {
    this.#limit = limit;
    this.#maximumQueued = maximumQueued;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason;
    if (this.#active < this.#limit) {
      this.#active += 1;
      return this.#release();
    }
    if (this.#waiters.length >= this.#maximumQueued) throw new Error("artifact_admission_full");
    return await new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      while (this.#waiters.length) {
        const waiter = this.#waiters.shift()!;
        waiter.signal.removeEventListener("abort", waiter.abort);
        if (waiter.signal.aborted) continue;
        this.#active += 1;
        waiter.resolve(this.#release());
        break;
      }
    };
  }
}

const artifactTemporaryPrefix = "mars-worker-artifact-";
const artifactOrphanAgeMs = 3 * 60 * 60_000;
const artifactOwnerAlive = (name: string): boolean => {
  const owner = new RegExp(`^${artifactTemporaryPrefix}(\\d+)-`).exec(name);
  if (!owner) return false;
  try {
    process.kill(Number(owner[1]), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
export const orphanCleanup = (async () => {
  try {
    const now = Date.now();
    const entries = await readdir(tmpdir(), { withFileTypes: true });
    await Promise.all(entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith(artifactTemporaryPrefix))
      .map(async entry => {
        const directory = join(tmpdir(), entry.name);
        if (artifactOwnerAlive(entry.name)) return;
        try {
          const { mtimeMs } = await stat(directory);
          if (now - mtimeMs > artifactOrphanAgeMs) {
            await rm(directory, { recursive: true, force: true });
          }
        } catch {}
      }));
  } catch {
    // Verified cache files remain bounded; stale process directories are recovered on startup.
  }
})();

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

async function streamRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<StreamReadResult> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<StreamReadResult>((resolve, reject) => {
    const abort = () => {
      void reader.cancel(signal.reason);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function inspectLocalArtifact(
  path: ArtifactPath,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<ArtifactSnapshot> {
  const reader = Bun.file(path).stream().getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const result = await streamRead(reader, signal);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) throw new Error("artifact_too_large");
      hash.update(result.value);
    }
    return {
      path,
      sha256: hash.digest("hex"),
      size,
      dispose: async () => {},
    };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}


type CacheReservation = {
  ensureBytes(bytes: number): void;
};

async function stageCachedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
  path: string,
  reservation: CacheReservation,
): Promise<ArtifactSnapshot> {
  const writer = Bun.file(path).writer();
  const reader = stream.getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const result = await streamRead(reader, signal);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) throw new Error("artifact_too_large");
      reservation.ensureBytes(size);
      hash.update(result.value);
      writer.write(result.value);
    }
    await writer.end();
    return {
      path,
      sha256: hash.digest("hex"),
      size,
      dispose: async () => {},
    };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    try {
      await writer.end();
    } catch {
      // Preserve the original staging failure.
    }
    await rm(path, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

type SnapshotLifetime = {
  signal: AbortSignal;
  release(): void;
};

function snapshotResponse(
  snapshot: ArtifactSnapshot,
  filename: string,
  lifetime: SnapshotLifetime,
  expectedHash: string = snapshot.sha256,
  contentType = "application/octet-stream",
): Response {
  const reader = Bun.file(snapshot.path).stream().getReader();
  let finished = false;
  const finish = async (cancelReader: boolean, reason?: unknown) => {
    if (finished) return;
    finished = true;
    lifetime.signal.removeEventListener("abort", abort);
    try {
      if (cancelReader) await reader.cancel(reason).catch(() => undefined);
      await snapshot.dispose();
    } finally {
      lifetime.release();
    }
  };
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let bodyClosed = false;
  const closeBody = () => {
    if (bodyClosed) return;
    bodyClosed = true;
    controller?.close();
  };
  const abort = () => {
    if (finished) return;
    void finish(true, lifetime.signal.reason);
    closeBody();
  };
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      lifetime.signal.addEventListener("abort", abort, { once: true });
      if (lifetime.signal.aborted) abort();
    },
    async pull(streamController) {
      try {
        const result = await reader.read();
        if (finished) {
          closeBody();
          return;
        }
        if (result.done) {
          await finish(false);
          closeBody();
        } else {
          streamController.enqueue(result.value);
        }
      } catch (error) {
        if (bodyClosed) return;
        bodyClosed = true;
        streamController.error(error);
        await finish(true, error);
      }
    },
    async cancel(reason) {
      bodyClosed = true;
      await finish(true, reason);
    },
  });
  const headers = noStore();
  headers.set("content-type", contentType);
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  headers.set("content-length", String(snapshot.size));
  headers.set("X-Content-SHA256", expectedHash);
  return new Response(body, { status: 200, headers });
}
type LinuxInstallerMetadata = Pick<LinuxWorkerRelease, "brokerImage" | "goldenImage" | "compose" | "domainTemplate">;

export function linuxInstallerValues(platform: LinuxInstallerMetadata, connectOrigin: string, mode: "local" | "production" = "production", versions: { releaseVersion: string; contractVersion: string; targetToken?: string } = { releaseVersion: "0.0.0", contractVersion: Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim() ?? "0.2.0" }): InstallerValues {
  const artifact = (path: string) => `${connectOrigin}${path}${versions.targetToken ? `?target=${encodeURIComponent(versions.targetToken)}` : ""}`;
  return {
    MARS_ARTIFACT_MODE: mode,
    MARS_WORKER_VERSION: versions.releaseVersion,
    MARS_WORKER_CONTRACT_VERSION: versions.contractVersion,
    MARS_BROKER_IMAGE: platform.brokerImage,
    MARS_GOLDEN_IMAGE: artifact("/api/workers/linux-golden-image"),
    MARS_GOLDEN_DIGEST: `sha256:${platform.goldenImage.sha256}`,
    MARS_COMPOSE_FILE: artifact("/api/workers/linux-broker-compose"),
    MARS_COMPOSE_SHA256: platform.compose.sha256,
    MARS_DOMAIN_TEMPLATE: artifact("/api/workers/linux-domain-template"),
    MARS_DOMAIN_TEMPLATE_SHA256: platform.domainTemplate.sha256,
    MARS_LIBVIRT_NETWORK: "default",
  };
}
type LinuxArm64InstallerMetadata = Pick<LinuxArm64WorkerRelease, "brokerImage" | "jobImage" | "compose">;
type MacosInstallerMetadata = Pick<MacosWorkerRelease, "orchestrator" | "macosJobAgent" | "linuxArm64JobAgent" | "linuxArm64Runner" | "statusItem" | "imagePreparationScript" | "tartMacosSourceImage" | "tartLinuxArm64SourceImage">;
export function linuxArm64InstallerValues(platform: LinuxArm64InstallerMetadata, connectOrigin: string, mode: "local" | "production" = "production", versions: { releaseVersion: string; contractVersion: string; targetToken?: string } = { releaseVersion: "0.0.0", contractVersion: Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim() ?? "0.2.0" }): InstallerValues {
  const artifact = (path: string) => `${connectOrigin}${path}${versions.targetToken ? `?target=${encodeURIComponent(versions.targetToken)}` : ""}`;
  return {
    ControlPlaneUrl: new URL(connectOrigin).origin,
    ArtifactMode: mode,
    WorkerVersion: versions.releaseVersion,
    WorkerContractVersion: versions.contractVersion,
    BrokerImage: platform.brokerImage,
    JobImage: platform.jobImage,
    ComposeUrl: artifact("/api/workers/linux-arm64-broker-compose"),
    ComposeSha256: platform.compose.sha256,
  };
}

export type WindowsVmImageSource = "checkpoint" | "iso" | "vhdx";

export function windowsInstallerValues(platform: WindowsWorkerRelease | undefined, connectOrigin: string, development?: NonNullable<ControlPlaneHttpDeps["developmentWindowsArtifacts"]>, upgrade = false, versions: { releaseVersion: string; contractVersion: string; targetToken?: string } = { releaseVersion: "0.0.0", contractVersion: Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim() ?? "0.2.0" }, runtime: "container" | "vm" = "container", vmSource: WindowsVmImageSource = "checkpoint", installerContract: 5 | 6 = 6, provisioningRefresh = false, linuxImages: { x64?: string; arm64?: string } = {}): InstallerValues {
  const source = platform ?? (development ? ({
    installer: development.orchestrator,
    orchestrator: development.orchestrator,
    serviceHost: development.serviceHost,
    jobAgent: development.jobAgent ?? development.orchestrator,
    runner: development.runner ?? development.orchestrator,
    git: development.git ?? development.orchestrator,
    vcRuntime: development.vcRuntime ?? development.orchestrator,
    trayScript: development.trayScript,
    vm: development.vm,
    container: development.container ? {
      baseImage: development.container.baseImage,
      buildScript: development.container.buildScript ?? development.orchestrator,
      verifyScript: development.container.verifyScript ?? development.orchestrator,
      containerfile: development.container.containerfile ?? development.orchestrator,
      entrypoint: development.container.entrypoint ?? development.orchestrator,
    } : undefined,
  } as unknown as WindowsWorkerRelease) : undefined);
  if (!source) throw new Error("Windows release metadata is unavailable.");
  const legacyContainer = installerContract === 5 ? source.container as Extract<WindowsWorkerRelease, { container?: { runner: unknown } }>["container"] : undefined;
  const runner = installerContract === 5 ? legacyContainer?.runner : "runner" in source ? source.runner : undefined;
  const git = installerContract === 5 ? legacyContainer?.git : "git" in source ? source.git : undefined;
  const vcRuntime = installerContract === 5 ? legacyContainer?.vcRuntime : "vcRuntime" in source ? source.vcRuntime : undefined;
  const container = source.container;
  const vm = source.vm;
  const checkpoint = vm?.checkpoint;
  const provisioner = vm && "provisioner" in vm ? vm.provisioner : undefined;
  const artifact = (path: string) => `${connectOrigin}${path}${versions.targetToken ? `${path.includes("?") ? "&" : "?"}target=${encodeURIComponent(versions.targetToken)}` : ""}`;
  const sharedValues = {
    WindowsJobAgentUrl: artifact("/api/workers/windows-job-agent"),
    WindowsJobAgentSha256: source.jobAgent.sha256,
    ...(installerContract === 5 ? {
      WindowsContainerRunnerUrl: artifact("/api/workers/windows-runner"),
      WindowsContainerRunnerSha256: runner!.sha256,
      WindowsContainerGitUrl: artifact("/api/workers/windows-git"),
      WindowsContainerGitSha256: git!.sha256,
      WindowsContainerVcRuntimeUrl: artifact("/api/workers/windows-vc-runtime"),
      WindowsContainerVcRuntimeSha256: vcRuntime!.sha256,
    } : {
      WindowsRunnerUrl: artifact("/api/workers/windows-runner"),
      WindowsRunnerSha256: runner!.sha256,
      WindowsGitUrl: artifact("/api/workers/windows-git"),
      WindowsGitSha256: git!.sha256,
      WindowsVcRuntimeUrl: artifact("/api/workers/windows-vc-runtime"),
      WindowsVcRuntimeSha256: vcRuntime!.sha256,
    }),
  };
  return {
    WindowsArtifactMode: platform ? "production" : "local",
    ...(upgrade && provisioningRefresh ? { WindowsRuntime: runtime } : {}),
    WorkerVersion: versions.releaseVersion,
    WorkerContractVersion: versions.contractVersion,
    ...(linuxImages.x64 ? { LinuxX64ContainerImage: linuxImages.x64 } : {}),
    ...(linuxImages.arm64 ? { LinuxArm64ContainerImage: linuxImages.arm64 } : {}),
    WindowsOrchestratorUrl: artifact("/api/workers/orchestrator?audience=windows-x64"),
    WindowsOrchestratorSha256: source.orchestrator.sha256,
    WindowsServiceHostUrl: artifact("/api/workers/service-host?audience=windows-x64"),
    WindowsServiceHostSha256: source.serviceHost.sha256,
    ...(source.trayScript ? { WindowsTrayScriptUrl: artifact("/api/workers/windows-tray-script"), WindowsTrayScriptSha256: source.trayScript.sha256 } : {}),
    ...(runtime === "vm" && !upgrade ? { WindowsVmImageSource: vmSource } : {}),
    ...((upgrade || runtime === "vm") && checkpoint ? { WindowsCheckpointUrl: artifact("/api/workers/windows-vm-checkpoint"), WindowsCheckpointSha256: checkpoint.sha256 } : {}),
    ...((upgrade || runtime === "vm") && provisioner ? { WindowsVmProvisionerUrl: artifact("/api/workers/windows-vm-provisioner"), WindowsVmProvisionerSha256: provisioner.sha256 } : {}),
    ...((upgrade || runtime === "container" || vmSource !== "checkpoint") ? sharedValues : {}),
    ...(runtime === "container" && (!upgrade || provisioningRefresh) ? {
      WindowsContainerBaseImage: container!.baseImage,
      WindowsContainerImage: "mars/windows-job:local",
      WindowsContainerBuilderUrl: artifact("/api/workers/windows-container-builder"),
      WindowsContainerBuilderSha256: container!.buildScript.sha256,
      WindowsContainerVerifierUrl: artifact("/api/workers/windows-container-verifier"),
      WindowsContainerVerifierSha256: container!.verifyScript.sha256,
      WindowsContainerfileUrl: artifact("/api/workers/windows-containerfile"),
      WindowsContainerfileSha256: container!.containerfile.sha256,
      WindowsContainerEntrypointUrl: artifact("/api/workers/windows-container-entrypoint"),
      WindowsContainerEntrypointSha256: container!.entrypoint.sha256,
    } : {}),
  };
}

export function macosInstallerValues(platform: MacosInstallerMetadata, connectOrigin: string, contractVersion: string, mode: "local" | "production" = "production", versions: { releaseVersion?: string; targetToken?: string } = {}): InstallerValues {
  const artifact = (path: string) => `${connectOrigin}${path}${versions.targetToken ? `?target=${encodeURIComponent(versions.targetToken)}` : ""}`;
  return {
    MARS_ARTIFACT_MODE: mode,
    MARS_WORKER_VERSION: versions.releaseVersion ?? "0.0.0",
    MARS_WORKER_CONTRACT_VERSION: WorkerContractVersion.parse(contractVersion),
    PUBLIC_BASE_URL: new URL(connectOrigin).origin,
    TART_MACOS_IMAGE: platform.tartMacosSourceImage,
    TART_MACOS_IMAGE_DIGEST: platform.tartMacosSourceImage.split("@sha256:")[1]!,
    TART_LINUX_ARM64_IMAGE: platform.tartLinuxArm64SourceImage,
    TART_LINUX_ARM64_IMAGE_DIGEST: platform.tartLinuxArm64SourceImage.split("@sha256:")[1]!,
    MARS_ORCHESTRATOR_URL: artifact("/api/workers/orchestrator?audience=macos-arm64"),
    MARS_ORCHESTRATOR_SHA256: platform.orchestrator.sha256,
    MARS_MACOS_JOB_AGENT_URL: artifact("/api/workers/macos-job-agent"),
    MARS_MACOS_JOB_AGENT_SHA256: platform.macosJobAgent.sha256,
    MARS_LINUX_ARM64_JOB_AGENT_URL: artifact("/api/workers/linux-arm64-job-agent"),
    MARS_LINUX_ARM64_JOB_AGENT_SHA256: platform.linuxArm64JobAgent.sha256,
    MARS_LINUX_ARM64_RUNNER_URL: artifact("/api/workers/linux-arm64-runner"),
    MARS_LINUX_ARM64_RUNNER_SHA256: platform.linuxArm64Runner.sha256,
    IMAGE_PREPARATION_SCRIPT_URL: artifact("/api/workers/tart-image-preparation"),
    IMAGE_PREPARATION_SCRIPT_SHA256: platform.imagePreparationScript.sha256,
    MARS_MACOS_STATUS_ITEM_URL: artifact("/api/workers/macos-status-item"),
    MARS_MACOS_STATUS_ITEM_SHA256: platform.statusItem?.sha256 ?? platform.orchestrator.sha256,
  };
}

type DevelopmentPlatformArtifacts = DevelopmentLinuxArtifacts | DevelopmentLinuxArm64Artifacts | DevelopmentWindowsArtifacts | DevelopmentMacosArtifacts;


async function installerArtifacts(
  deps: ControlPlaneHttpDeps,
  audience: "linux-x64" | "linux-arm64" | "windows-x64" | "macos-arm64",
  platform: LinuxWorkerRelease | LinuxArm64WorkerRelease | WindowsWorkerRelease | MacosWorkerRelease | null | undefined,
  development?: DevelopmentPlatformArtifacts,
  upgrade = false,
  runtime: "container" | "vm" = "container",
  vmSource: WindowsVmImageSource = "checkpoint",
): Promise<string[]> {
  const missing: string[] = [];
  const installerName = audience === "linux-x64" ? "install-worker.sh" : audience === "linux-arm64" ? "install-worker-linux-arm64.ps1" : audience === "windows-x64" ? "install-worker.ps1" : "install-worker-macos.sh";
  if (development) {
    if (!deps.workerInstallerRoot || !await artifactExists(pathFor(deps.workerInstallerRoot, installerName))) missing.push(`installer:${installerName}`);
    if (audience === "linux-x64") {
      const linux = development as DevelopmentLinuxArtifacts;
      if (!hasValue(linux.brokerImage)) missing.push("development:broker-image");
      if (!linux.goldenImage) missing.push("development:golden-image");
      if (!linux.compose) missing.push("development:linux-broker-compose");
      if (!linux.domainTemplate) missing.push("development:linux-domain-template");
    } else if (audience === "linux-arm64") {
      const arm = development as DevelopmentLinuxArm64Artifacts;
      if (!hasValue(arm.brokerImage)) missing.push("development:linux-arm64-broker-image");
      if (!hasValue(arm.jobImage)) missing.push("development:linux-arm64-job-image");
      if (!arm.compose) missing.push("development:linux-arm64-broker-compose");
    } else if (audience === "windows-x64") {
      const windows = development as DevelopmentWindowsArtifacts;
      if (!windows.orchestrator) missing.push("development:orchestrator");
      if (!windows.serviceHost) missing.push("development:service-host");
      if (!windows.trayScript) missing.push("development:tray-script");
      if (!upgrade && runtime === "vm") {
        if (!windows.vm?.provisioner) missing.push("development:vm.provisioner");
        if (vmSource === "checkpoint" && !windows.vm?.checkpoint) missing.push("development:vm.checkpoint");
        if (vmSource !== "checkpoint") {
          for (const field of ["jobAgent", "runner", "git", "vcRuntime"] as const) if (!windows[field]) missing.push(`development:${field}`);
        }
      } else if (!upgrade) {
        for (const field of ["jobAgent", "runner", "git", "vcRuntime"] as const) if (!windows[field]) missing.push(`development:${field}`);
        const container = windows.container;
        if (!container || !WorkerReleaseOciDigest.safeParse(container.baseImage).success) missing.push("development:container");
        else for (const field of ["buildScript", "verifyScript", "containerfile", "entrypoint"] as const) if (!container[field]) missing.push(`development:container.${field}`);
      }
    } else if (audience === "macos-arm64") {
      const macos = development as DevelopmentMacosArtifacts;
      if (!macos.orchestrator || !(macos.macosJobAgent ?? macos.jobAgent) || !(macos.linuxArm64JobAgent ?? macos.jobAgent) || !(macos.linuxArm64Runner ?? macos.jobAgent) || !macos.imagePreparationScript || !(macos.tartMacosImage ?? macos.tartImage) || !(macos.tartLinuxArm64Image ?? macos.tartImage)) missing.push(`development:${audience}`);
    }
    return missing;
  }
  if (!platform) return [`platform:${audience}`];
  if (audience !== "windows-x64") {
    const fields = audience === "linux-x64"
      ? ["installer", "orchestrator", "jobAgent", "brokerImage", "goldenImage", "compose", "domainTemplate"]
      : audience === "linux-arm64"
        ? ["installer", "compose", "brokerImage", "jobImage"]
        : ["installer", "orchestrator", "macosJobAgent", "linuxArm64JobAgent", "linuxArm64Runner", "imagePreparationScript", "tartMacosSourceImage", "tartLinuxArm64SourceImage"];
    for (const field of fields) if (!(platform as unknown as Record<string, unknown>)[field]) missing.push(releaseField(audience, field));
    return missing;
  }
  const windows = platform as WindowsWorkerRelease;
  for (const field of ["installer", "orchestrator", "serviceHost", "trayScript"] as const) if (!windows[field]) missing.push(releaseField(audience, field));
  if (upgrade) return missing;
  const schema6 = "runner" in windows;
  if (runtime === "vm") {
    if (!schema6) {
      if (vmSource !== "checkpoint") missing.push("manifest:windows-x64.schema5-local-source-unsupported");
      if (!windows.vm?.checkpoint) missing.push("manifest:windows-x64.vm.checkpoint");
      if (!windows.container) missing.push("manifest:windows-x64.container");
    } else {
      if (!windows.vm?.provisioner) missing.push("manifest:windows-x64.vm.provisioner");
      if (vmSource === "checkpoint" && !windows.vm?.checkpoint) missing.push("manifest:windows-x64.vm.checkpoint");
      if (vmSource !== "checkpoint" && (!windows.jobAgent || !windows.runner || !windows.git || !windows.vcRuntime)) missing.push("manifest:windows-x64.shared-assets");
    }
  } else if (!windows.jobAgent || !windows.container || (schema6 && (!windows.runner || !windows.git || !windows.vcRuntime))) {
    missing.push("manifest:windows-x64.container");
  }
  return missing;
}


type CachedArtifactFactory = (
  path: string,
  reservation: CacheReservation,
  signal: AbortSignal,
) => Promise<ArtifactSnapshot>;

type ArtifactFlightWaiter = {
  resolve: (snapshot: ArtifactSnapshot) => void;
  reject: (reason?: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
};

type ArtifactFlight = {
  cancelTimeout(): void;
  waiters: Set<ArtifactFlightWaiter>;
};

class ArtifactCache {
  readonly #maximumBytes: number;
  readonly #totalTimeoutMs: number;
  readonly #admission: ArtifactAdmission;
  readonly #maximumFlightWaiters: number;
  #root?: Promise<string>;
  readonly #artifacts = new Map<string, ArtifactSnapshot>();
  readonly #flights = new Map<string, ArtifactFlight>();
  #cachedBytes = 0;
  #stagedBytes = 0;

  constructor(maximumBytes: number, totalTimeoutMs: number, admission: ArtifactAdmission, maximumFlightWaiters: number) {
    this.#maximumBytes = maximumBytes;
    this.#totalTimeoutMs = totalTimeoutMs;
    this.#admission = admission;
    this.#maximumFlightWaiters = maximumFlightWaiters;
  }

  async get(hash: string, signal: AbortSignal, create: CachedArtifactFactory): Promise<ArtifactSnapshot> {
    const digest = hash.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("artifact_digest_invalid");
    if (signal.aborted) throw signal.reason;
    const cached = this.#artifacts.get(digest);
    if (cached && await artifactExists(cached.path)) return cached;
    if (cached) {
      this.#artifacts.delete(digest);
      this.#cachedBytes -= cached.size;
    }
    const existing = this.#flights.get(digest);
    if (existing) return await this.#join(existing, signal);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("artifact_total_timeout")),
      this.#totalTimeoutMs,
    );
    const flight: ArtifactFlight = {
      cancelTimeout: () => clearTimeout(timer),
      waiters: new Set(),
    };
    this.#flights.set(digest, flight);
    void this.#fill(digest, create, controller.signal).then(
      snapshot => this.#settle(digest, flight, { snapshot }),
      error => this.#settle(digest, flight, { error }),
    );
    return await this.#join(flight, signal);
  }

  async #join(flight: ArtifactFlight, signal: AbortSignal): Promise<ArtifactSnapshot> {
    if (signal.aborted) throw signal.reason;
    if (flight.waiters.size >= this.#maximumFlightWaiters) throw new Error("artifact_flight_full");
    return await new Promise<ArtifactSnapshot>((resolve, reject) => {
      const waiter: ArtifactFlightWaiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          flight.waiters.delete(waiter);
          signal.removeEventListener("abort", waiter.abort);
          reject(signal.reason);
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      flight.waiters.add(waiter);
    });
  }

  #settle(
    digest: string,
    flight: ArtifactFlight,
    outcome: { snapshot: ArtifactSnapshot } | { error: unknown },
  ): void {
    flight.cancelTimeout();
    if (this.#flights.get(digest) === flight) this.#flights.delete(digest);
    const waiters = [...flight.waiters];
    flight.waiters.clear();
    for (const waiter of waiters) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      if ("snapshot" in outcome) waiter.resolve(outcome.snapshot);
      else waiter.reject(outcome.error);
    }
  }

  async #fill(
    digest: string,
    create: CachedArtifactFactory,
    signal: AbortSignal,
  ): Promise<ArtifactSnapshot> {
    const release = await this.#admission.acquire(signal);
    try {
      return await this.#create(digest, create, signal);
    } finally {
      release();
    }
  }

  async #create(
    digest: string,
    create: CachedArtifactFactory,
    signal: AbortSignal,
  ): Promise<ArtifactSnapshot> {
    this.#root ??= (async () => {
      await orphanCleanup;
      return await mkdtemp(join(tmpdir(), `${artifactTemporaryPrefix}${process.pid}-`));
    })();
    const path = join(await this.#root, digest);
    let reserved = 0;
    const reservation: CacheReservation = {
      ensureBytes: bytes => {
        if (bytes <= reserved) return;
        const additional = bytes - reserved;
        if (this.#cachedBytes + this.#stagedBytes + additional > this.#maximumBytes) {
          throw new Error("artifact_cache_budget_exceeded");
        }
        reserved = bytes;
        this.#stagedBytes += additional;
      },
    };
    try {
      const artifact = await create(path, reservation, signal);
      if (artifact.sha256 !== digest) throw new Error("artifact_digest_mismatch");
      this.#stagedBytes -= reserved;
      this.#cachedBytes += artifact.size;
      this.#artifacts.set(digest, artifact);
      return artifact;
    } catch (error) {
      this.#stagedBytes -= reserved;
      await rm(path, { force: true });
      throw error;
    }
  }
}
type ProxyPolicy = {
  fetcher: (input: string | URL | Request, init?: DevelopmentArtifactFetchOptions) => Promise<Response>;
  resolveHostname: (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;
  headerTimeoutMs: number;
  totalTimeoutMs: number;
  downstreamTimeoutMs: number;
  maxRedirects: number;
  maximumBytes: Record<ArtifactSizeClass, number>;
};

type ArtifactOperation = {
  signal: AbortSignal;
  response(snapshot: ArtifactSnapshot, filename: string, expectedHash?: string, contentType?: string): Response;
  close(): void;
};

async function beginArtifactOperation(
  requestSignal: AbortSignal,
  policy: ProxyPolicy,
  admission: ArtifactAdmission,
  totalScope: "operation" | "admission" = "operation",
): Promise<ArtifactOperation> {
  const totalController = new AbortController();
  const totalTimer = setTimeout(() => totalController.abort(new Error("artifact_total_timeout")), policy.totalTimeoutMs);
  const admissionSignal = AbortSignal.any([requestSignal, totalController.signal]);
  let release: (() => void) | undefined;
  try {
    release = await admission.acquire(admissionSignal);
  } catch (error) {
    clearTimeout(totalTimer);
    throw error;
  }
  if (totalScope === "admission") clearTimeout(totalTimer);
  const signal = totalScope === "operation" ? admissionSignal : requestSignal;
  let transferred = false;
  return {
    signal,
    response(snapshot, filename, expectedHash = snapshot.sha256, contentType = "application/octet-stream") {
      if (transferred) throw new Error("artifact_operation_transferred");
      transferred = true;
      clearTimeout(totalTimer);
      const downstreamController = new AbortController();
      const downstreamTimer = setTimeout(
        () => downstreamController.abort(new Error("artifact_downstream_timeout")),
        policy.downstreamTimeoutMs,
      );
      let lifetimeReleased = false;
      return snapshotResponse(snapshot, filename, {
        signal: AbortSignal.any([requestSignal, downstreamController.signal]),
        release: () => {
          if (lifetimeReleased) return;
          lifetimeReleased = true;
          clearTimeout(downstreamTimer);
          release?.();
        },
      }, expectedHash, contentType);
    },
    close() {
      if (transferred) return;
      transferred = true;
      clearTimeout(totalTimer);
      release?.();
    },
  };
}

async function proxyPackagedResponse(
  url: string,
  filename: string,
  hash: string,
  sizeClass: ArtifactSizeClass,
  requestSignal: AbortSignal,
  policy: ProxyPolicy,
  admission: ArtifactAdmission,
  cache: ArtifactCache,
): Promise<Response | undefined> {
  let operation: ArtifactOperation | undefined;
  try {
    const snapshot = await cache.get(hash, requestSignal, async (path, reservation, flightSignal) => {
      let upstream: Response | undefined;
      try {
        const initial = new URL(url);
        const restrictedOrigin = explicitlyLocalUrl(initial) ? initial.origin : undefined;
        let current = initial;
        let redirects = 0;
        while (true) {
          const headerController = new AbortController();
          const headerTimer = setTimeout(() => headerController.abort(new Error("artifact_header_timeout")), policy.headerTimeoutMs);
          try {
            const hopSignal = AbortSignal.any([flightSignal, headerController.signal]);
            const address = await validateProxyDestination(
              current,
              restrictedOrigin !== undefined && current.origin === restrictedOrigin,
              policy.resolveHostname,
              hopSignal,
            );
            const options: DevelopmentArtifactFetchOptions = {
              redirect: "manual",
              signal: hopSignal,
              keepalive: false,
              headers: { host: current.host },
            };
            const hostname = normalizedHostname(current);
            if (current.protocol === "https:" && isIP(hostname) === 0) options.tls = { serverName: hostname };
            upstream = await policy.fetcher(pinnedDestination(current, address), options);
            if (hopSignal.aborted) throw hopSignal.reason;
          } finally {
            clearTimeout(headerTimer);
          }
          if ([301, 302, 303, 307, 308].includes(upstream.status)) {
            if (redirects >= policy.maxRedirects) throw new Error("artifact_redirect_limit");
            const location = upstream.headers.get("location");
            if (!location) throw new Error("artifact_redirect_without_location");
            await upstream.body?.cancel();
            upstream = undefined;
            current = new URL(location, current);
            redirects += 1;
            continue;
          }
          if (!upstream.ok || !upstream.body) throw new Error("artifact_upstream_unavailable");
          const maximumBytes = policy.maximumBytes[sizeClass];
          const declaredLength = Number(upstream.headers.get("content-length"));
          if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error("artifact_too_large");
          if (Number.isFinite(declaredLength) && declaredLength > 0) reservation.ensureBytes(declaredLength);
          const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
          const staged = await stageCachedStream(upstream.body, maximumBytes, flightSignal, path, reservation);
          upstream = undefined;
          staged.contentType = contentType;
          return staged;
        }
      } catch (error) {
        await upstream?.body?.cancel().catch(() => undefined);
        throw error;
      }
    });
    operation = await beginArtifactOperation(requestSignal, policy, admission, "admission");
    return operation.response(snapshot, filename, hash, snapshot.contentType);
  } catch {
    return undefined;
  } finally {
    operation?.close();
  }
}

function releaseField(platform: string, field: string): string { return `manifest:${platform}.${field}`; }
export function pendingWorkerDto(row: Record<string, unknown>, workerConnected?: (workerId: string) => boolean) {
  if (!hasMachineIdentity(row) || typeof row.id !== "string" || typeof row.fingerprint !== "string") return null;
  if (typeof row.releaseVersion !== "string" || typeof row.contractVersion !== "string") return null;
  const rawTelemetry = (row.doctor && typeof row.doctor === "object" ? row.doctor : {}) as Record<string, unknown>;
  const telemetry = "doctor" in rawTelemetry || "capacity" in rawTelemetry ? rawTelemetry : { doctor: rawTelemetry, capacity: {} };
  const rawGuestPlatforms = typeof row.guestPlatforms === "string" ? (() => { try { return JSON.parse(row.guestPlatforms); } catch { return null; } })() : row.guestPlatforms;
  const guestPlatforms = Array.isArray(rawGuestPlatforms) ? rawGuestPlatforms : row.platform === "windows-x64" ? ["windows-x64"] : [row.platform];
  const capacity = telemetry.capacity && typeof telemetry.capacity === "object" ? telemetry.capacity : {};
  const normalizedCapacity = {
    actualVcpu: 0,
    actualMemoryBytes: 0,
    actualStorageBytes: 0,
    freeVcpu: 0,
    freeMemoryBytes: 0,
    freeStorageBytes: 0,
    ...capacity as Record<string, unknown>,
  };
  const pending = PendingWorkerRequest.parse({
    platform: row.platform,
    computerName: row.name,
    releaseVersion: row.releaseVersion,
    contractVersion: row.contractVersion,
    guestPlatforms,
    admissionState: row.admissionState,
    connectionState: workerConnected ? (workerConnected(row.id) ? "online" : "offline") : row.connectionState,
    configurationState: row.configurationState,
    publicKey: row.publicKey,
    vmUuid: row.vmUuid,
    machineUuid: row.machineUuid,
    limits: row.limits,
    doctor: telemetry.doctor ?? {},
    capacity: normalizedCapacity,
  });
  return { id: row.id, fingerprint: row.fingerprint, ...pending };
}
function idempotency(c: Context<ControlPlaneEnv>): boolean { return Boolean(c.req.header("Idempotency-Key")?.trim()); }
export function registerWorkerRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  const approvalBody = async (c: Context<ControlPlaneEnv>) => { try { return parseApproveWorkerRequest(await c.req.json()); } catch { return null; } };
  const auth = async (c: Context<ControlPlaneEnv>) => deps.currentUser(c.req.raw);
  const proxyOptions = deps.developmentArtifactProxy;
  const bounded = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
  };
  const proxyPolicy: ProxyPolicy = {
    fetcher: proxyOptions?.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    resolveHostname: proxyOptions?.resolveHostname ?? (async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(result => result.address)),
    headerTimeoutMs: bounded(proxyOptions?.headerTimeoutMs, 10_000, 1, 60_000),
    totalTimeoutMs: bounded(proxyOptions?.totalTimeoutMs, 15 * 60_000, 1, 60 * 60_000),
    downstreamTimeoutMs: bounded(proxyOptions?.downstreamTimeoutMs, 15 * 60_000, 1, 60 * 60_000),
    maxRedirects: bounded(proxyOptions?.maxRedirects, 3, 0, 10),
    maximumBytes: {
      template: bounded(proxyOptions?.maxBytes?.template, 128 * 1024 ** 3, 1, 512 * 1024 ** 3),
      archive: bounded(proxyOptions?.maxBytes?.archive, 4 * 1024 ** 3, 1, 16 * 1024 ** 3),
      binary: bounded(proxyOptions?.maxBytes?.binary, 1024 ** 3, 1, 4 * 1024 ** 3),
    },
  };
  const artifactAdmission = new ArtifactAdmission(
    bounded(proxyOptions?.maxConcurrent, 4, 1, 16),
    bounded(proxyOptions?.maxQueued, 16, 0, 64),
  );
  const artifactCache = new ArtifactCache(
    bounded(proxyOptions?.maxCacheBytes, 32 * 1024 ** 3, 1, 512 * 1024 ** 3),
    proxyPolicy.totalTimeoutMs,
    artifactAdmission,
    bounded(proxyOptions?.maxFlightWaiters, 16, 1, 64),
  );
  const localPackaged = async (
    c: Context<ControlPlaneEnv>,
    path: ArtifactPath,
    unavailableArtifact: string,
    filename: string,
    sizeClass: ArtifactSizeClass,
    expectedHash?: string,
  ) => {
    let operation: ArtifactOperation | undefined;
    let snapshot: ArtifactSnapshot | undefined;
    try {
      operation = await beginArtifactOperation(c.req.raw.signal, proxyPolicy, artifactAdmission);
      snapshot = await inspectLocalArtifact(path, proxyPolicy.maximumBytes[sizeClass], operation.signal);
      if (expectedHash && (!/^[a-f0-9]{64}$/i.test(expectedHash) || snapshot.sha256 !== expectedHash.toLowerCase())) {
        await snapshot.dispose();
        snapshot = undefined;
        return unavailable(c, [unavailableArtifact]);
      }
      return operation.response(snapshot, filename, expectedHash ?? snapshot.sha256);
    } catch {
      await snapshot?.dispose().catch(() => undefined);
      return unavailable(c, [unavailableArtifact]);
    } finally {
      operation?.close();
    }
  };
  const developmentPackaged = async (
    c: Context<ControlPlaneEnv>,
    artifact: DevelopmentArtifact | undefined,
    name: string,
    filename: string,
    sizeClass: ArtifactSizeClass,
  ) => {
    if (!artifact) return unavailable(c, [`development:${name}`]);
    if (artifact.path && await artifactExists(artifact.path)) return localPackaged(c, artifact.path, `development:${name}`, filename, sizeClass, artifact.sha256);
    if (artifact.url) {
      return await proxyPackagedResponse(artifact.url, filename, artifact.sha256, sizeClass, c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache)
        ?? unavailable(c, [`development:${name}`]);
    }
    return unavailable(c, [`development:${name}`]);
  };
  const immutablePackaged = async (
    c: Context<ControlPlaneEnv>,
    artifact: DevelopmentArtifact | undefined,
    name: string,
    filename: string,
    sizeClass: ArtifactSizeClass,
  ) => {
    if (!artifact) return unavailable(c, [name]);
    if (artifact.path && await artifactExists(artifact.path)) {
      return localPackaged(c, artifact.path, name, filename, sizeClass, artifact.sha256);
    }
    if (artifact.url) {
      return await proxyPackagedResponse(artifact.url, filename, artifact.sha256, sizeClass, c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache)
        ?? unavailable(c, [name]);
    }
    return unavailable(c, [name]);
  };
  const releaseManifestFor = async (c: Context<ControlPlaneEnv>, platform: "linux-x64" | "linux-arm64" | "windows-x64" | "macos-arm64") => {
    const token = c.req.query("target");
    if (!token) return deps.workerReleaseManifest;
    if (!deps.workerUpgradeService || !deps.workerReleaseCatalog) return undefined;
    try {
      const target = deps.workerUpgradeService.read(token);
      if (target.platform !== platform) return undefined;
      const release = await deps.workerReleaseCatalog.release(target.targetReleaseVersion);
      if (release.manifestUrl !== target.targetManifestUrl) return undefined;
      return release.manifest;
    } catch {
      return undefined;
    }
  };
  const currentDevelopmentArtifact = async (
    artifact: { path?: string; url?: string; sha256: string } | undefined,
  ): Promise<{ path?: string; url?: string; sha256: string } | undefined> => {
    if (!artifact) return undefined;
    if (artifact.path && await artifactExists(artifact.path)) {
      return { ...artifact, sha256: await fileSha256(artifact.path) };
    }
    return artifact.url ? { url: artifact.url, sha256: artifact.sha256 } : undefined;
  };
  const limiter = deps.workerRequestLimiter ?? createRequestLimiter();
  app.get("/api/workers/control-plane-urls", async (c) => {
    const user = await auth(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403);
    return c.json(deps.workerConnectionOrigins(), { headers: noStore() });
  });
  app.get("/api/workers/templates/:platform/manifest", (c) => unavailable(c, [`template-manifest:${c.req.param("platform")}`]));
  app.get("/api/workers/templates/:platform/artifact", (c) => unavailable(c, [`template:${c.req.param("platform")}`]));
  app.get("/api/workers/windows-vm-checkpoint", async c => {
    const development = deps.developmentWindowsArtifacts?.vm?.checkpoint;
    if (development) return developmentPackaged(c, development, "windows-vm-checkpoint", "windows-worker-checkpoint.zip", "template");
    const asset = (await releaseManifestFor(c, "windows-x64"))?.platforms["windows-x64"]?.vm?.checkpoint;
    return asset ? await immutablePackaged(c, asset, "windows-vm-checkpoint", "windows-worker-checkpoint.zip", "template") : unavailable(c, ["manifest:windows-x64.vm.checkpoint"]);
  });
  app.get("/api/workers/windows-tray-script", async c => {
    const development = deps.developmentWindowsArtifacts?.trayScript;
    if (development) return developmentPackaged(c, development, "windows-tray-script", "mars-worker-tray.ps1", "binary");
    const asset = (await releaseManifestFor(c, "windows-x64"))?.platforms["windows-x64"]?.trayScript;
    return asset ? await proxyPackagedResponse(asset.url, "mars-worker-tray.ps1", asset.sha256, "binary", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, ["windows-tray-script"]) : unavailable(c, ["manifest:windows-x64.trayScript"]);
  });
  const releaseWindowsAsset = (
    key: "buildScript" | "verifyScript" | "containerfile" | "entrypoint" | "jobAgent" | "runner" | "git" | "vcRuntime" | "provisioner",
    name: string,
    filename: string,
    sizeClass: ArtifactSizeClass,
  ) => async (c: Context<ControlPlaneEnv>) => {
    const configured = deps.developmentWindowsArtifacts;
    const development = !configured ? undefined
      : key === "jobAgent" || key === "runner" || key === "git" || key === "vcRuntime"
        ? configured[key]
        : key === "provisioner" ? configured.vm?.provisioner : configured.container?.[key];
    if (development) return developmentPackaged(c, development, name, filename, sizeClass);
    const manifest = await releaseManifestFor(c, "windows-x64");
    const normalized = manifest ? normalizeWindowsWorkerRelease(manifest) : undefined;
    const asset = !normalized ? undefined
      : key === "jobAgent" ? normalized.release.jobAgent
      : key === "runner" || key === "git" || key === "vcRuntime" ? normalized[key]
      : key === "provisioner" ? normalized.provisioner
      : normalized.release.container?.[key];
    if (!asset || typeof asset === "string") return unavailable(c, [name]);
    return await proxyPackagedResponse(asset.url, filename, asset.sha256, sizeClass, c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, [name]);
  };
  app.get("/api/workers/windows-container-builder", releaseWindowsAsset("buildScript", "windows-container-builder", "build-windows-container-image-local.ps1", "binary"));
  app.get("/api/workers/windows-container-verifier", releaseWindowsAsset("verifyScript", "windows-container-verifier", "verify-runtime.ps1", "binary"));
  app.get("/api/workers/windows-containerfile", releaseWindowsAsset("containerfile", "windows-containerfile", "Containerfile", "binary"));
  app.get("/api/workers/windows-container-entrypoint", releaseWindowsAsset("entrypoint", "windows-container-entrypoint", "entrypoint.ps1", "binary"));
  const windowsJobAgent = releaseWindowsAsset("jobAgent", "windows-job-agent", "mars-job-agent.exe", "binary");
  const windowsRunner = releaseWindowsAsset("runner", "windows-runner", "runner.zip", "archive");
  const windowsGit = releaseWindowsAsset("git", "windows-git", "git.zip", "archive");
  const windowsVcRuntime = releaseWindowsAsset("vcRuntime", "windows-vc-runtime", "vc-runtime.exe", "binary");
  app.get("/api/workers/windows-job-agent", windowsJobAgent);
  app.get("/api/workers/windows-runner", windowsRunner);
  app.get("/api/workers/windows-git", windowsGit);
  app.get("/api/workers/windows-vc-runtime", windowsVcRuntime);
  app.get("/api/workers/windows-vm-provisioner", releaseWindowsAsset("provisioner", "windows-vm-provisioner", "mars-windows-vm-provisioner.zip", "archive"));
  app.get("/api/workers/windows-container-job-agent", windowsJobAgent);
  app.get("/api/workers/windows-container-runner", windowsRunner);
  app.get("/api/workers/windows-container-git", windowsGit);
  app.get("/api/workers/windows-container-vc-runtime", windowsVcRuntime);
  const linuxCompose = async (c: Context<ControlPlaneEnv>) => {
    if (deps.developmentLinuxArtifacts) return developmentPackaged(c, deps.developmentLinuxArtifacts.compose, "linux-broker-compose", "linux-broker-compose.yaml", "binary");
    const asset = (await releaseManifestFor(c, "linux-x64"))?.platforms["linux-x64"]?.compose;
    return asset ? await proxyPackagedResponse(asset.url, "linux-broker-compose.yaml", asset.sha256, "binary", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, ["linux-broker-compose"]) : unavailable(c, ["manifest:linux-x64.compose"]);
  };
  const linuxArm64Compose = async (c: Context<ControlPlaneEnv>) => {
    if (deps.developmentLinuxArm64Artifacts) return developmentPackaged(c, deps.developmentLinuxArm64Artifacts.compose, "linux-arm64-broker-compose", "linux-arm64-broker-compose.yaml", "binary");
    const asset = (await releaseManifestFor(c, "linux-arm64"))?.platforms["linux-arm64"]?.compose;
    return asset ? await proxyPackagedResponse(asset.url, "linux-arm64-broker-compose.yaml", asset.sha256, "binary", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, ["linux-arm64-broker-compose"]) : unavailable(c, ["manifest:linux-arm64.compose"]);
  };
  const linuxDomain = async (c: Context<ControlPlaneEnv>) => {
    if (deps.developmentLinuxArtifacts) return developmentPackaged(c, deps.developmentLinuxArtifacts.domainTemplate, "linux-domain-template", "worker-domain.xml", "binary");
    const asset = (await releaseManifestFor(c, "linux-x64"))?.platforms["linux-x64"]?.domainTemplate;
    return asset ? await proxyPackagedResponse(asset.url, "worker-domain.xml", asset.sha256, "binary", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, ["linux-domain-template"]) : unavailable(c, ["manifest:linux-x64.domainTemplate"]);
  };
  app.get("/api/workers/linux-golden-image", async c => {
    if (deps.developmentLinuxArtifacts) return developmentPackaged(c, deps.developmentLinuxArtifacts.goldenImage, "golden-image", "worker.qcow2", "template");
    const asset = (await releaseManifestFor(c, "linux-x64"))?.platforms["linux-x64"]?.goldenImage;
    return asset ? await immutablePackaged(c, asset, "linux-golden-image", "worker.qcow2", "template") : unavailable(c, ["manifest:linux-x64.goldenImage"]);
  });
  app.get("/api/workers/linux-arm64-broker-compose", linuxArm64Compose);
  app.get("/api/workers/linux-broker-compose", linuxCompose);
  app.get("/api/workers/linux-compose", linuxCompose);
  app.get("/api/workers/installer", async (c) => {
    const audience = c.req.query("audience") as "linux-x64" | "linux-arm64" | "windows-x64" | "macos-arm64" | undefined;
    const legacyRuntime = c.req.query("runtime");
    const upgrade = c.req.query("upgrade") === "true";
    const targetToken = c.req.query("target");
    const requestedVmSource = c.req.query("vmSource");
    const runtime = audience === "windows-x64" && (legacyRuntime === "vm" || requestedVmSource) ? "vm" : "container";
    if (audience === "windows-x64" && legacyRuntime !== undefined && legacyRuntime !== "container" && legacyRuntime !== "vm") {
      return c.json({ code: "unsupported_runtime", message: "Windows runtime must be container or vm" }, 400);
    }
    if (requestedVmSource && (audience !== "windows-x64" || upgrade)) {
      return c.json({ code: "invalid_vm_source", message: "vmSource is valid only for a fresh Windows VM provisioning request" }, 400);
    }
    if (requestedVmSource && !["checkpoint", "iso", "vhdx"].includes(requestedVmSource)) {
      return c.json({ code: "invalid_vm_source", message: "Windows VM source must be checkpoint, iso, or vhdx" }, 400);
    }
    const vmSource = (requestedVmSource ?? "checkpoint") as WindowsVmImageSource;
    let targetRelease: WorkerReleaseTarget | undefined;
    if (upgrade) {
      if (!targetToken || !deps.workerUpgradeService || !deps.workerReleaseCatalog) return c.json({ code: "upgrade_target_stale", message: "A valid upgrade target is required" }, 409);
      try {
        const token = deps.workerUpgradeService.read(targetToken);
        if (token.platform !== audience) throw new Error("upgrade_target_stale");
        const [worker] = await deps.db`select id,platform,release_version as "releaseVersion" from workers where id=${token.workerId}`;
        if (!worker || worker.platform !== audience) throw new Error("upgrade_target_stale");
        const selected = await deps.workerReleaseCatalog.release(token.targetReleaseVersion);
        await deps.workerUpgradeService.verify(targetToken, { id: String(worker.id), platform: worker.platform, releaseVersion: worker.releaseVersion }, selected);
        const next = await deps.workerReleaseCatalog.findNextCompatible(String(worker.releaseVersion), audience);
        if (!next || next.releaseVersion !== selected.releaseVersion || next.manifestUrl !== selected.manifestUrl) throw new Error("upgrade_target_stale");
        targetRelease = selected;
      } catch {
        return c.json({ code: "upgrade_target_stale", message: "The upgrade target is stale or invalid" }, 409);
      }
    }
    const file = audience === "linux-x64" ? "install-worker.sh" : audience === "linux-arm64" ? "install-worker-linux-arm64.ps1" : audience === "windows-x64" ? "install-worker.ps1" : audience === "macos-arm64" ? "install-worker-macos.sh" : null;
    if (!audience || !file) return c.json({ error: "unsupported installer audience" }, 400);
    if (audience === "windows-x64" && runtime !== "container" && runtime !== "vm") {
      return c.json({ code: "unsupported_runtime", message: "Windows runtime must be container or vm" }, 400);
    }
    let connectOrigin: string;
    try {
      const value = c.req.query("connectOrigin");
      if (!value) throw new Error("missing worker origin");
      connectOrigin = httpOrigin("connectOrigin", value);
    } catch { return c.json({ code: "invalid_worker_origin", message: "Choose a configured worker connection origin" }, 400); }
    if (!deps.workerConnectionOrigins().includes(connectOrigin)) return c.json({ code: "invalid_worker_origin", message: "Choose a configured worker connection origin" }, 400);
    let development: DevelopmentPlatformArtifacts | undefined;
    if (audience === "linux-x64" && deps.developmentLinuxArtifacts) {
      const configured = deps.developmentLinuxArtifacts;
      const [goldenImage, compose, domainTemplate] = await Promise.all([currentDevelopmentArtifact(configured.goldenImage), currentDevelopmentArtifact(configured.compose), currentDevelopmentArtifact(configured.domainTemplate)]);
      development = { ...configured, goldenImage, compose, domainTemplate };
    } else if (audience === "linux-arm64" && deps.developmentLinuxArm64Artifacts) {
      const configured = deps.developmentLinuxArm64Artifacts;
      development = { ...configured, compose: await currentDevelopmentArtifact(configured.compose) };
    } else if (audience === "windows-x64" && deps.developmentWindowsArtifacts) {
      const configured = deps.developmentWindowsArtifacts;
      const [orchestrator, serviceHost, jobAgent, runner, git, vcRuntime, trayScript, checkpoint, provisioner] = await Promise.all([
        currentDevelopmentArtifact(configured.orchestrator),
        currentDevelopmentArtifact(configured.serviceHost),
        currentDevelopmentArtifact(configured.jobAgent),
        currentDevelopmentArtifact(configured.runner),
        currentDevelopmentArtifact(configured.git),
        currentDevelopmentArtifact(configured.vcRuntime),
        currentDevelopmentArtifact(configured.trayScript),
        currentDevelopmentArtifact(configured.vm?.checkpoint),
        currentDevelopmentArtifact(configured.vm?.provisioner),
      ]);
      const vm = checkpoint || provisioner ? { ...(checkpoint ? { checkpoint } : {}), ...(provisioner ? { provisioner } : {}) } : undefined;
      development = { ...configured, orchestrator: orchestrator!, serviceHost: serviceHost!, jobAgent, runner, git, vcRuntime, trayScript, ...(vm ? { vm } : {}) } as DevelopmentWindowsArtifacts;
    } else if (audience === "macos-arm64" && deps.developmentMacosArtifacts) {
      const configured = deps.developmentMacosArtifacts;
      development = { ...configured, orchestrator: await currentDevelopmentArtifact(configured.orchestrator), jobAgent: await currentDevelopmentArtifact(configured.jobAgent), imagePreparationScript: await currentDevelopmentArtifact(configured.imagePreparationScript) };
    }
    let selectedManifest = deps.workerReleaseManifest;
    if (!development && !targetRelease && !selectedManifest && deps.workerReleaseCatalog) {
      try { selectedManifest = (await deps.workerReleaseCatalog.defaultRelease()).manifest; } catch { return unavailable(c, ["release-manifest"]); }
    }
    if (targetRelease) selectedManifest = targetRelease.manifest;
    const release = selectedManifest?.platforms[audience];
    if (audience === "windows-x64" && runtime === "vm" && vmSource !== "checkpoint" && selectedManifest?.schemaVersion === 5) {
      return c.json({ code: "unsupported_vm_source", message: "Schema-5 Windows releases support prepared checkpoints only" }, 400);
    }
    const configuredReleaseVersion = Bun.env.MARS_WORKER_VERSION?.trim() ?? "0.0.0";
    const releaseVersion = targetRelease?.releaseVersion ?? (WorkerReleaseVersion.safeParse(configuredReleaseVersion).success ? configuredReleaseVersion : "0.0.0");
    const missing = await installerArtifacts(deps, audience, release, development, upgrade, runtime as "container" | "vm", vmSource);
    if (missing.length) return unavailable(c, missing);
    let source: string;
    const localInstallerPath = deps.workerInstallerRoot ? pathFor(deps.workerInstallerRoot, file) : undefined;
    if (localInstallerPath && await artifactExists(localInstallerPath)) {
      try { source = await Bun.file(localInstallerPath).text(); } catch { return unavailable(c, [`installer:${file}`]); }
    } else if (development) {
      return unavailable(c, [`installer:${file}`]);
    } else {
      const asset = release?.installer;
      if (!asset) return unavailable(c, [`manifest:${audience}.installer`]);
      const response = await proxyPackagedResponse(asset.url, file, asset.sha256, "binary", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache);
      if (!response) return unavailable(c, [`installer:${file}`]);
      try { source = await response.text(); } catch { return unavailable(c, [`installer:${file}`]); }
    }
    let values: InstallerValues;
    if (audience === "linux-x64") {
      if (development) {
        const linux = development as DevelopmentLinuxArtifacts;
        if (!linux.brokerImage || !linux.goldenImage || !linux.compose || !linux.domainTemplate) return unavailable(c, [`platform:${audience}`]);
        values = linuxInstallerValues({ brokerImage: linux.brokerImage, goldenImage: { url: "", sha256: linux.goldenImage.sha256 }, compose: { url: "", sha256: linux.compose.sha256 }, domainTemplate: { url: "", sha256: linux.domainTemplate.sha256 } }, connectOrigin, "local", { releaseVersion: "0.0.0", contractVersion: Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim() ?? "0.2.0", targetToken });
      } else values = linuxInstallerValues(release as LinuxWorkerRelease, connectOrigin, "production", { releaseVersion, contractVersion: selectedManifest!.contractVersion, targetToken });
    } else if (audience === "linux-arm64") {
      const arm = development as DevelopmentLinuxArm64Artifacts | undefined;
      if (arm) {
        if (!arm.brokerImage || !arm.jobImage || !WorkerReleaseOciDigest.safeParse(arm.brokerImage).success || !WorkerReleaseOciDigest.safeParse(arm.jobImage).success || !arm.compose) return unavailable(c, [`platform:${audience}`]);
        values = linuxArm64InstallerValues({ brokerImage: arm.brokerImage, jobImage: arm.jobImage, compose: { url: "", sha256: arm.compose.sha256 } }, connectOrigin, "local", { releaseVersion: "0.0.0", contractVersion: Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim() ?? "0.2.0", targetToken });
      } else values = linuxArm64InstallerValues(release as LinuxArm64WorkerRelease, connectOrigin, "production", { releaseVersion, contractVersion: selectedManifest!.contractVersion, targetToken });
    } else if (audience === "windows-x64") {
      values = windowsInstallerValues(release as WindowsWorkerRelease | undefined, connectOrigin, development as DevelopmentWindowsArtifacts | undefined, upgrade, { releaseVersion, contractVersion: selectedManifest?.contractVersion ?? (Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim() || CURRENT_WORKER_CONTRACT_VERSION), targetToken }, runtime as "container" | "vm", vmSource, selectedManifest?.schemaVersion ?? 6, upgrade && legacyRuntime !== undefined, {
        x64: Bun.env.MARS_LINUX_X64_CONTAINER_IMAGE?.trim(),
        arm64: selectedManifest?.platforms["linux-arm64"]?.jobImage ?? Bun.env.MARS_LINUX_ARM64_CONTAINER_IMAGE?.trim(),
      });
    } else if (development) {
      const macos = development as DevelopmentMacosArtifacts;
      const contractVersion = selectedManifest?.contractVersion ?? Bun.env.MARS_WORKER_CONTRACT_VERSION?.trim() ?? "0.3.0";
      const macosJobAgent = macos.macosJobAgent ?? macos.jobAgent;
      const linuxArm64JobAgent = macos.linuxArm64JobAgent ?? macos.jobAgent;
      const linuxArm64Runner = macos.linuxArm64Runner ?? macos.jobAgent;
      const tartMacosSourceImage = macos.tartMacosImage ?? macos.tartImage;
      const tartLinuxArm64SourceImage = macos.tartLinuxArm64Image ?? macos.tartImage;
      if (!macos.orchestrator || !macosJobAgent || !linuxArm64JobAgent || !linuxArm64Runner || !macos.imagePreparationScript || !tartMacosSourceImage || !tartLinuxArm64SourceImage || !WorkerContractVersion.safeParse(contractVersion).success) return unavailable(c, [`platform:${audience}`]);
      values = macosInstallerValues({ orchestrator: { url: "", sha256: macos.orchestrator.sha256 }, macosJobAgent: { url: "", sha256: macosJobAgent.sha256 }, linuxArm64JobAgent: { url: "", sha256: linuxArm64JobAgent.sha256 }, linuxArm64Runner: { url: "", sha256: linuxArm64Runner.sha256 }, imagePreparationScript: { url: "", sha256: macos.imagePreparationScript.sha256 }, tartMacosSourceImage, tartLinuxArm64SourceImage }, connectOrigin, contractVersion, "local", { releaseVersion: "0.0.0", targetToken });
    } else values = macosInstallerValues(release as MacosWorkerRelease, connectOrigin, selectedManifest?.contractVersion ?? "0.3.0", "production", { releaseVersion, targetToken });
    const generated = injectInstallerOrigin(source, connectOrigin, values, audience === "windows-x64" || audience === "linux-arm64");
    if (generated.includes("__PLACEHOLDER__") || /__[A-Za-z0-9_]+__/.test(generated)) return unavailable(c, [`installer:${file}`]);
    return new Response(generated, { headers: noStore() });
  });
  app.get("/api/workers/orchestrator", async c => {
    const audience = c.req.query("audience") as "linux-x64" | "windows-x64" | "macos-arm64";
    const configured = audience === "windows-x64" ? deps.developmentWindowsArtifacts?.orchestrator : audience === "macos-arm64" ? deps.developmentMacosArtifacts?.orchestrator : undefined;
    const development = audience === "macos-arm64" ? await currentDevelopmentArtifact(configured) : configured;
    if (development) return developmentPackaged(c, development, "orchestrator", audience === "windows-x64" ? "mars-orchestrator.exe" : "mars-orchestrator", "binary");
    const asset = (await releaseManifestFor(c, audience))?.platforms[audience]?.orchestrator;
    return asset ? await proxyPackagedResponse(asset.url, audience === "windows-x64" ? "mars-orchestrator.exe" : "mars-orchestrator", asset.sha256, "binary", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, [`orchestrator:${audience}`]) : unavailable(c, [`orchestrator:${audience}`]);
  });
  app.get("/api/workers/service-host", async c => {
    if (c.req.query("audience") !== "windows-x64") return c.json({ error: "unsupported service host audience" }, 400);
    if (deps.developmentWindowsArtifacts?.serviceHost) return developmentPackaged(c, deps.developmentWindowsArtifacts.serviceHost, "service-host", "mars-service-host.exe", "binary");
    const asset = (await releaseManifestFor(c, "windows-x64"))?.platforms["windows-x64"]?.serviceHost;
    return asset ? await proxyPackagedResponse(asset.url, "mars-service-host.exe", asset.sha256, "binary", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, ["service-host:windows-x64"]) : unavailable(c, ["manifest:windows-x64.serviceHost"]);
  });
  app.get("/api/workers/macos-job-agent", async c => {
    const configured = deps.developmentMacosArtifacts?.macosJobAgent ?? deps.developmentMacosArtifacts?.jobAgent;
    const development = await currentDevelopmentArtifact(configured);
    if (development) return developmentPackaged(c, development, "job-agent", "mars-macos-job-agent", "binary");
    const asset = (await releaseManifestFor(c, "macos-arm64"))?.platforms["macos-arm64"]?.macosJobAgent;
    return asset ? await proxyPackagedResponse(asset.url, "mars-macos-job-agent", asset.sha256, "binary", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, ["macos-job-agent"]) : unavailable(c, ["manifest:macos-arm64.macosJobAgent"]);
  });
  app.get("/api/workers/linux-arm64-job-agent", async c => {
    const configured = deps.developmentMacosArtifacts?.linuxArm64JobAgent;
    const development = await currentDevelopmentArtifact(configured);
    if (development) return developmentPackaged(c, development, "job-agent", "mars-linux-arm64-job-agent", "binary");
    const asset = (await releaseManifestFor(c, "macos-arm64"))?.platforms["macos-arm64"]?.linuxArm64JobAgent;
    return asset ? await proxyPackagedResponse(asset.url, "mars-linux-arm64-job-agent", asset.sha256, "binary", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, ["linux-arm64-job-agent"]) : unavailable(c, ["manifest:macos-arm64.linuxArm64JobAgent"]);
  });
  app.get("/api/workers/linux-arm64-runner", async c => {
    const configured = deps.developmentMacosArtifacts?.linuxArm64Runner;
    const development = await currentDevelopmentArtifact(configured);
    if (development) return developmentPackaged(c, development, "runner", "runner.tar.gz", "archive");
    const asset = (await releaseManifestFor(c, "macos-arm64"))?.platforms["macos-arm64"]?.linuxArm64Runner;
    return asset ? await proxyPackagedResponse(asset.url, "runner.tar.gz", asset.sha256, "archive", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, ["linux-arm64-runner"]) : unavailable(c, ["manifest:macos-arm64.linuxArm64Runner"]);
  });
  app.get("/api/workers/macos-status-item", async c => {
    const asset = (await releaseManifestFor(c, "macos-arm64"))?.platforms["macos-arm64"]?.statusItem;
    return asset ? await proxyPackagedResponse(asset.url, "mars-status-item", asset.sha256, "binary", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, ["macos-status-item"]) : unavailable(c, ["manifest:macos-arm64.statusItem"]);
  });
  app.get("/api/workers/tart-image-preparation", async c => {
    const configured = deps.developmentMacosArtifacts?.imagePreparationScript;
    const development = await currentDevelopmentArtifact(configured);
    if (development) return developmentPackaged(c, development, "image-preparation", "prepare-tart-job-image.sh", "binary");
    const asset = (await releaseManifestFor(c, "macos-arm64"))?.platforms["macos-arm64"]?.imagePreparationScript;
    return asset ? await proxyPackagedResponse(asset.url, "prepare-tart-job-image.sh", asset.sha256, "binary", c.req.raw.signal, proxyPolicy, artifactAdmission, artifactCache) ?? unavailable(c, ["tart-image-preparation"]) : unavailable(c, ["manifest:macos-arm64.imagePreparationScript"]);
  });
  app.get("/api/workers/dev-windows-image-build", async c => {
    if (!deps.devWindowsImageBuild) return c.json({ error: "not found" }, 404);
    const user = await auth(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403);
    const payload = await deps.devWindowsImageBuild();
    return payload ? c.json(payload, { headers: noStore() }) : c.json({ error: "Windows container build inputs unavailable" }, 503);
  });
  app.post("/api/workers/join", async c => {
    const source = deps.requestSource(c.req.raw);
    if (!limiter.allow(source)) return c.json({ error: "invalid or rotated bootstrap credential" }, 429);
    try {
      const body = await c.req.json();
      const result = await (deps.workerJoin ?? requestPendingWorker)(deps.db, body);
      limiter.clear(source);
      return c.json(result, { status: result.status === "created" ? 201 : 200 });
    } catch (error) {
      if (error instanceof SyntaxError || (error && typeof error === "object" && "issues" in error)) return c.json({ error: "invalid worker request" }, 400);
      if (error instanceof Error && (error.message === "identity_conflict" || error.message === "invalid_bootstrap")) return c.json({ error: "invalid or rotated bootstrap credential" }, error.message === "identity_conflict" ? 409 : 401);
      throw error;
    }
  });
  app.post("/api/workers/bootstrap/initialize", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (deps.disableWorkerBootstrapManagement) return c.json({ error: "development bootstrap code is fixed" }, 409); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); try { const result = await initializeWorkerBootstrap(deps.db, user.id); return c.json(result, { status: 201, headers: noStore() }); } catch (error) { if (error instanceof Error && error.message === "already initialized") return c.json({ error: "bootstrap credential is already initialized" }, 409); throw error; } });
  app.get("/api/workers/bootstrap", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); return c.json(await getWorkerBootstrapStatus(deps.db), { headers: noStore() }); });
  app.post("/api/workers/bootstrap/rotate", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (deps.disableWorkerBootstrapManagement) return c.json({ error: "development bootstrap code is fixed" }, 409); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); try { const result = await rotateWorkerBootstrap(deps.db, user.id); return c.json(result, { status: 201, headers: noStore() }); } catch (error) { if (error instanceof Error && error.message === "bootstrap credential is not initialized") return c.json({ error: "bootstrap credential is not initialized" }, 409); throw error; } });
  app.post("/api/workers/pending/:workerId/approve", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); const body = await approvalBody(c); if (!body) return c.json({ error: "invalid approval request" }, 400); await approvePendingWorker(deps.db, c.req.param("workerId"), body, user.id); await deps.onWorkerChanged(c.req.param("workerId")); return c.json({ ok: true }); });
  app.post("/api/workers/pending/:workerId/configure", async (c) => {
    const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403);
    if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400);
    try {
      const body = await c.req.json();
      const parsed = WorkerConfiguration.safeParse({ appliance: body.appliance, runtime: body.runtime, guestPlatforms: body.guestPlatforms, selectedDriver: body.selectedDriver });
      if (!parsed.success) return c.json({ error: "invalid worker configuration" }, 400);
      const key = c.req.header("Idempotency-Key")!.trim();
      const [prior] = await deps.db<{ response: Record<string, unknown> | null }[]>`select response from worker_mutations where worker_id=${c.req.param("workerId")} and idempotency_key=${key}`;
      if (prior?.response) return c.json(prior.response, { status: 202, headers: noStore() });
      const result = await configurePendingWorker(deps.db, c.req.param("workerId"), parsed.data, user.id, deps.workerDispatcher, key);
      await deps.onWorkerChanged(c.req.param("workerId"));
      return c.json(result, { status: 202, headers: noStore() });
    } catch (error) {
      if (error instanceof SyntaxError || (error && typeof error === "object" && "issues" in error)) return c.json({ error: "invalid worker configuration" }, 400);
      if (error instanceof Error && error.message.includes("capacity")) return c.json({ error: error.message }, 422);
      if (error instanceof Error && error.message.includes("conflict")) return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  app.get("/api/workers/pending", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); const rows = await deps.db`select id,name,platform,release_version as "releaseVersion",contract_version as "contractVersion",guest_platforms as "guestPlatforms",admission_state as "admissionState",connection_state as "connectionState",configuration_state as "configurationState",public_key as "publicKey",fingerprint,vm_uuid as "vmUuid",machine_uuid as "machineUuid",limits,doctor,last_requested_at as "lastRequestedAt" from workers where admission_state='pending' order by created_at desc`; return c.json(rows.map((row) => pendingWorkerDto(row, deps.workerConnected)).filter((row): row is NonNullable<typeof row> => row !== null)); });
  app.post("/api/workers/pending/:workerId/reject", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); await rejectPendingWorker(deps.db, c.req.param("workerId"), user.id); await deps.onWorkerChanged(c.req.param("workerId")); return c.json({ ok: true }); });
}
