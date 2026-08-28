import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { PendingWorkerRequest, WorkerConfiguration } from "@mars/contracts";
import type { LinuxWorkerRelease, MacosWorkerRelease, WindowsWorkerRelease } from "@mars/contracts";
import type { ControlPlaneEnv, ControlPlaneHttpDeps } from "./types.ts";
import { verifyWorkerBootstrap, initializeWorkerBootstrap, rotateWorkerBootstrap, getWorkerBootstrapStatus } from "../worker-bootstrap.ts";
import { approvePendingWorker, configurePendingWorker, createRequestLimiter, hasMachineIdentity, parseApproveWorkerRequest, requestPendingWorker, rejectPendingWorker } from "../worker-requests.ts";
import { httpOrigin } from "../http-origin.ts";
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
const artifactExists = async (path: ArtifactPath | undefined): Promise<boolean> => Boolean(path && await Bun.file(path).exists());
const pathFor = (root: URL, name: string): URL => new URL(name, root);
async function fileSha256(path: ArtifactPath): Promise<string> {
  return createHash("sha256").update(Buffer.from(await Bun.file(path).arrayBuffer())).digest("hex");
}
function unavailable(c: Context<ControlPlaneEnv>, artifacts: string[]) {
  return c.json({ code: "artifact_unavailable", message: "Worker installer prerequisites are unavailable", artifacts }, 503, { "cache-control": "no-store" });
}
export function linuxInstallerValues(platform: LinuxWorkerRelease, connectOrigin: string): InstallerValues {
  return {
    MARS_BROKER_IMAGE: platform.brokerImage,
    MARS_GOLDEN_IMAGE: platform.goldenImageUrl,
    MARS_GOLDEN_DIGEST: `sha256:${platform.goldenImageSha256}`,
    MARS_COMPOSE_FILE: `${connectOrigin}/api/workers/linux-broker-compose`,
    MARS_COMPOSE_SHA256: platform.composeSha256,
    MARS_DOMAIN_TEMPLATE: `${connectOrigin}/api/workers/linux-domain-template`,
    MARS_DOMAIN_TEMPLATE_SHA256: platform.domainTemplateSha256,
    MARS_LIBVIRT_NETWORK: "default",
  };
}

export function windowsInstallerValues(platform: WindowsWorkerRelease, connectOrigin: string): InstallerValues {
  return {
    WindowsRuntime: "container",
    WindowsOrchestratorSha256: platform.orchestratorSha256,
    WindowsServiceHostSha256: platform.serviceHostSha256,
    WindowsTemplateUrl: platform.vmTemplateUrl,
    WindowsTemplatePath: "C:\\ProgramData\\Mars\\worker-template.vhdx",
    WindowsTemplateDigest: `sha256:${platform.vmTemplateSha256}`,
    WindowsContainerImage: "mars/windows-job:local",
    WindowsContainerBaseImage: platform.container.baseImage,
    WindowsContainerRunnerUrl: platform.container.runner.url,
    WindowsContainerRunnerSha256: platform.container.runner.sha256,
    WindowsContainerGitUrl: platform.container.git.url,
    WindowsContainerGitSha256: platform.container.git.sha256,
    WindowsContainerVcUrl: platform.container.vcRuntime.url,
    WindowsContainerVcSha256: platform.container.vcRuntime.sha256,
    WindowsContainerBuilderUrl: `${connectOrigin}/api/workers/windows-container-builder`,
    WindowsContainerVerifierUrl: `${connectOrigin}/api/workers/windows-container-verifier`,
    WindowsContainerfileUrl: `${connectOrigin}/api/workers/windows-containerfile`,
    WindowsContainerEntrypointUrl: `${connectOrigin}/api/workers/windows-container-entrypoint`,
    WindowsContainerJobAgentUrl: `${connectOrigin}/api/workers/windows-container-job-agent`,
  };
}

export function macosInstallerValues(platform: MacosWorkerRelease, connectOrigin: string): InstallerValues {
  return {
    PUBLIC_BASE_URL: new URL(connectOrigin).origin,
    MARS_ORCHESTRATOR_SHA256: platform.orchestratorSha256,
    TART_IMAGE: platform.tartImage,
    TART_IMAGE_DIGEST: platform.tartImageDigest,
  };
}

function installerArtifacts(deps: ControlPlaneHttpDeps, audience: string, runtime: string, platform: LinuxWorkerRelease | WindowsWorkerRelease | MacosWorkerRelease | null | undefined): Promise<string[]> {
  return (async () => {
    const missing: string[] = [];
    if (!deps.workerReleaseManifest) missing.push("release-manifest");
    if (!platform) {
      missing.push(`platform:${audience}`);
      return missing;
    }
    const fields = audience === "linux-x64"
      ? ["orchestratorSha256", "brokerImage", "goldenImageUrl", "goldenImageSha256", "composeSha256", "domainTemplateSha256"]
      : audience === "windows-x64"
        ? ["orchestratorSha256", "serviceHostSha256", "vmTemplateUrl", "vmTemplateSha256"]
        : ["orchestratorSha256", "tartImage", "tartImageDigest"];
    for (const field of fields) if (!hasValue((platform as unknown as Record<string, unknown>)[field])) missing.push(releaseField(audience, field));
    if (audience === "windows-x64" && runtime === "container") {
      const container = (platform as WindowsWorkerRelease).container as unknown as Record<string, unknown> | undefined;
      for (const field of ["baseImage", "runner", "git", "vcRuntime"]) {
        if (!container?.[field]) missing.push(releaseField(audience, `container.${field}`));
      }
      for (const [name, value] of [["runner", container?.runner], ["git", container?.git], ["vcRuntime", container?.vcRuntime]] as const) {
        const asset = value as { url?: unknown; sha256?: unknown } | undefined;
        if (!hasValue(asset?.url)) missing.push(releaseField(audience, `container.${name}.url`));
        if (!hasValue(asset?.sha256)) missing.push(releaseField(audience, `container.${name}.sha256`));
      }
    }
    const installerName = audience === "linux-x64" ? "install-worker.sh" : audience === "windows-x64" ? "install-worker.ps1" : "install-worker-macos.sh";
    if (!await artifactExists(pathFor(deps.workerInstallerRoot, installerName))) missing.push(`installer:${installerName}`);
    const executable = deps.workerOrchestratorExecutables?.[audience as keyof NonNullable<ControlPlaneHttpDeps["workerOrchestratorExecutables"]>] ?? (audience === "macos-arm64" ? deps.workerOrchestratorExecutable : undefined);
    if (audience !== "linux-x64" && !await artifactExists(executable)) missing.push(`orchestrator:${audience}`);
    if (audience === "windows-x64" && !await artifactExists(deps.workerServiceHostExecutable)) missing.push("service-host:windows-x64");
    if (audience === "linux-x64") {
      if (!await artifactExists(pathFor(deps.workerInstallerRoot, "linux-broker-compose.yaml"))) missing.push("linux-broker-compose");
      if (!await artifactExists(pathFor(deps.workerInstallerRoot, "worker-domain.xml"))) missing.push("linux-domain-template");
    } else if (audience === "windows-x64" && runtime === "container") {
      const files = deps.windowsContainerArtifacts ?? deps.windowsContainerBuild;
      const artifactNames: Array<[keyof NonNullable<typeof deps.windowsContainerArtifacts>, string]> = [
        ["builderPath", "windows-container-builder"], ["verifierPath", "windows-container-verifier"],
        ["containerfilePath", "windows-containerfile"], ["entrypointPath", "windows-container-entrypoint"],
        ["jobAgentPath", "windows-container-job-agent"],
      ];
      for (const [key, name] of artifactNames) if (!await artifactExists(files?.[key])) missing.push(name);
    }
    return missing;
  })();
}

async function packagedResponse(path: ArtifactPath, filename: string, hash: string | undefined): Promise<Response> {
  const headers = noStore();
  headers.set("content-type", "application/octet-stream");
  headers.set("content-disposition", `attachment; filename="${filename}"`);
  if (hash) headers.set("X-Content-SHA256", hash);
  return new Response(Bun.file(path), { headers });
}
function releaseField(platform: string, field: string): string { return `manifest:${platform}.${field}`; }
export function pendingWorkerDto(row: Record<string, unknown>, workerConnected?: (workerId: string) => boolean) {
  if (!hasMachineIdentity(row) || typeof row.id !== "string" || typeof row.fingerprint !== "string") return null;
  const telemetry = (row.doctor && typeof row.doctor === "object" ? row.doctor : {}) as Record<string, unknown>;
  const rawGuestPlatforms = typeof row.guestPlatforms === "string" ? (() => { try { return JSON.parse(row.guestPlatforms); } catch { return null; } })() : row.guestPlatforms;
  const guestPlatforms = Array.isArray(rawGuestPlatforms) ? rawGuestPlatforms : row.platform === "windows-x64" ? ["windows-x64"] : [row.platform];
  const pending = PendingWorkerRequest.parse({
    platform: row.platform,
    guestPlatforms,
    admissionState: row.admissionState,
    connectionState: workerConnected ? (workerConnected(row.id) ? "online" : "offline") : row.connectionState,
    configurationState: row.configurationState,
    publicKey: row.publicKey,
    vmUuid: row.vmUuid,
    machineUuid: row.machineUuid,
    limits: row.limits,
    doctor: telemetry.doctor ?? {},
    capacity: telemetry.capacity ?? {},
  });
  return { id: row.id, fingerprint: row.fingerprint, ...pending };
}
function idempotency(c: Context<ControlPlaneEnv>): boolean { return Boolean(c.req.header("Idempotency-Key")?.trim()); }
export function registerWorkerRoutes(app: Hono<ControlPlaneEnv>, deps: ControlPlaneHttpDeps) {
  const approvalBody = async (c: Context<ControlPlaneEnv>) => { try { return parseApproveWorkerRequest(await c.req.json()); } catch { return null; } };
  const auth = async (c: Context<ControlPlaneEnv>) => deps.currentUser(c.req.raw);
  const limiter = deps.workerRequestLimiter ?? createRequestLimiter();
  app.get("/api/workers/control-plane-urls", async (c) => {
    const user = await auth(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403);
    return c.json(deps.workerConnectionOrigins(), { headers: noStore() });
  });
  app.get("/api/workers/templates/:platform/manifest", async (c) => {
    const platform = c.req.param("platform") as "windows-x64" | "linux-x64";
    const path = deps.templateManifestPaths?.[platform];
    if (!path || !await artifactExists(path)) return c.json({ code: "artifact_unavailable", message: "Template manifest is unavailable", artifact: `template-manifest:${platform}` }, 503, { "cache-control": "no-store" });
    return new Response(Bun.file(path), { headers: noStore() });
  });
  app.get("/api/workers/templates/:platform/artifact", async (c) => {
    const platform = c.req.param("platform") as "windows-x64" | "linux-x64";
    const path = deps.templateArtifactPaths?.[platform];
    if (!path || !await artifactExists(path)) return c.json({ code: "artifact_unavailable", message: "Template artifact is unavailable", artifact: `template:${platform}` }, 503, { "cache-control": "no-store" });
    const headers = noStore();
    headers.set("content-type", "application/octet-stream");
    headers.set("content-disposition", `attachment; filename="${platform}.vhdx"`);
    return new Response(Bun.file(path), { headers });
  });
  const buildArtifact = async (c: Context<ControlPlaneEnv>, key: keyof NonNullable<typeof deps.windowsContainerArtifacts>, filename: string) => {
    const path = (deps.windowsContainerArtifacts ?? deps.windowsContainerBuild)?.[key];
    if (!path || !await artifactExists(path)) return c.json({ code: "artifact_unavailable", message: "Windows container build artifact is unavailable", artifact: `windows-container-${key}` }, 503, { "cache-control": "no-store" });
    return packagedResponse(path, filename, await fileSha256(path));
  };
  app.get("/api/workers/windows-container-builder", (c) => buildArtifact(c, "builderPath", "build-windows-container-image-local.ps1"));
  app.get("/api/workers/windows-container-verifier", (c) => buildArtifact(c, "verifierPath", "verify-runtime.ps1"));
  app.get("/api/workers/windows-containerfile", (c) => buildArtifact(c, "containerfilePath", "Containerfile"));
  app.get("/api/workers/windows-container-entrypoint", (c) => buildArtifact(c, "entrypointPath", "entrypoint.ps1"));
  app.get("/api/workers/windows-container-job-agent", (c) => buildArtifact(c, "jobAgentPath", "mars-job-agent.exe"));
  const packaged = async (c: Context<ControlPlaneEnv>, name: string, filename: string, hash: string | undefined) => {
    const path = pathFor(deps.workerInstallerRoot, name);
    if (!hash) return c.json({ code: "artifact_unavailable", message: "Worker artifact is unavailable", artifacts: [`manifest:linux-x64.${name === "linux-broker-compose.yaml" ? "composeSha256" : "domainTemplateSha256"}`] }, 503, { "cache-control": "no-store" });
    if (!await artifactExists(path)) return c.json({ code: "artifact_unavailable", message: "Worker artifact is unavailable", artifacts: [name] }, 503, { "cache-control": "no-store" });
    return packagedResponse(path, filename, hash);
  };
  const linuxCompose = (c: Context<ControlPlaneEnv>) => packaged(c, "linux-broker-compose.yaml", "linux-broker-compose.yaml", deps.workerReleaseManifest?.platforms["linux-x64"]?.composeSha256);
  const linuxDomain = (c: Context<ControlPlaneEnv>) => packaged(c, "worker-domain.xml", "worker-domain.xml", deps.workerReleaseManifest?.platforms["linux-x64"]?.domainTemplateSha256);
  app.get("/api/workers/linux-broker-compose", linuxCompose);
  app.get("/api/workers/linux-compose", linuxCompose);
  app.get("/api/workers/linux-domain-template", linuxDomain);
  app.get("/api/workers/worker-domain", linuxDomain);
  app.get("/api/workers/installer", async (c) => {
    const audience = c.req.query("audience") as "linux-x64" | "windows-x64" | "macos-arm64" | undefined;
    const runtime = c.req.query("runtime") ?? "container";
    const file = audience === "linux-x64" ? "install-worker.sh" : audience === "windows-x64" ? "install-worker.ps1" : audience === "macos-arm64" ? "install-worker-macos.sh" : null;
    if (!audience || !file) return c.json({ error: "unsupported installer audience" }, 400);
    if (runtime !== "container") return c.json({ code: "unsupported_runtime", message: "Only the container runtime is supported in worker v1" }, 400);
    let connectOrigin: string;
    try {
      const value = c.req.query("connectOrigin");
      if (!value) throw new Error("missing worker origin");
      connectOrigin = httpOrigin("connectOrigin", value);
    } catch {
      return c.json({ code: "invalid_worker_origin", message: "Choose a configured worker connection origin" }, 400);
    }
    if (!deps.workerConnectionOrigins().includes(connectOrigin)) return c.json({ code: "invalid_worker_origin", message: "Choose a configured worker connection origin" }, 400);
    const release = deps.workerReleaseManifest?.platforms[audience];
    const missing = await installerArtifacts(deps, audience, runtime, release);
    if (missing.length) return unavailable(c, missing);
    const source = await Bun.file(pathFor(deps.workerInstallerRoot, file)).text();
    const values = audience === "linux-x64"
      ? linuxInstallerValues(release as LinuxWorkerRelease, connectOrigin)
      : audience === "windows-x64"
        ? windowsInstallerValues(release as WindowsWorkerRelease, connectOrigin)
        : macosInstallerValues(release as MacosWorkerRelease, connectOrigin);
    const generated = injectInstallerOrigin(source, connectOrigin, values, audience === "windows-x64");
    if (generated.includes("__PLACEHOLDER__") || /__[A-Za-z0-9_]+__/.test(generated)) return unavailable(c, [`installer:${file}`]);
    return new Response(generated, { headers: noStore() });
  });
  app.get("/api/workers/orchestrator", async (c) => {
    const audience = c.req.query("audience") as keyof NonNullable<typeof deps.workerOrchestratorExecutables>;
    const executable = deps.workerOrchestratorExecutables?.[audience] ?? (audience === "macos-arm64" ? deps.workerOrchestratorExecutable : undefined);
    const hash = deps.workerReleaseManifest?.platforms[audience]?.orchestratorSha256;
    if (!executable || !hash) return c.json({ code: "artifact_unavailable", message: "Orchestrator is unavailable", artifacts: [`orchestrator:${audience}`] }, 503, { "cache-control": "no-store" });
    if (!await artifactExists(executable)) return c.json({ code: "artifact_unavailable", message: "Orchestrator is unavailable", artifacts: [`orchestrator:${audience}`] }, 503, { "cache-control": "no-store" });
    const filename = audience === "windows-x64" ? "mars-orchestrator.exe" : "mars-orchestrator";
    return packagedResponse(executable, filename, hash);
  });
  app.get("/api/workers/service-host", async (c) => {
    if (c.req.query("audience") !== "windows-x64") return c.json({ error: "unsupported service host audience" }, 400);
    const executable = deps.workerServiceHostExecutable;
    const hash = deps.workerReleaseManifest?.platforms["windows-x64"]?.serviceHostSha256;
    if (!hash) return c.json({ code: "artifact_unavailable", message: "Windows service host is unavailable", artifacts: ["manifest:windows-x64.serviceHostSha256"] }, 503, { "cache-control": "no-store" });
    if (!executable || !await artifactExists(executable)) return c.json({ code: "artifact_unavailable", message: "Windows service host is unavailable", artifacts: ["service-host:windows-x64"] }, 503, { "cache-control": "no-store" });
    return packagedResponse(executable, "mars-service-host.exe", hash);
  });
  app.post("/api/workers/join", async (c) => {
    const source = deps.requestSource(c.req.raw);
    if (!limiter.allow(source)) return c.json({ error: "invalid or rotated bootstrap credential" }, 429);
    try {
      const body = await c.req.json();
      const result = await requestPendingWorker(deps.db, body);
      limiter.clear(source);
      return c.json(result, { status: result.status === "created" ? 201 : 200 });
    } catch (error) {
      if (error instanceof SyntaxError || (error && typeof error === "object" && "issues" in error)) return c.json({ error: "invalid worker request" }, 400);
      if (error instanceof Error && (error.message === "identity_conflict" || error.message === "invalid_bootstrap")) return c.json({ error: "invalid or rotated bootstrap credential" }, error.message === "identity_conflict" ? 409 : 401);
      throw error;
    }
  });
  app.post("/api/workers/bootstrap/initialize", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); try { const result = await initializeWorkerBootstrap(deps.db, user.id); return c.json(result, { status: 201, headers: noStore() }); } catch (error) { if (error instanceof Error && error.message === "already initialized") return c.json({ error: "bootstrap credential is already initialized" }, 409); throw error; } });
  app.get("/api/workers/bootstrap", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); return c.json(await getWorkerBootstrapStatus(deps.db), { headers: noStore() }); });
  app.post("/api/workers/bootstrap/rotate", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); try { const result = await rotateWorkerBootstrap(deps.db, user.id); return c.json(result, { status: 201, headers: noStore() }); } catch (error) { if (error instanceof Error && error.message === "bootstrap credential is not initialized") return c.json({ error: "bootstrap credential is not initialized" }, 409); throw error; } });
  app.post("/api/workers/pending/:workerId/approve", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); const body = await approvalBody(c); if (!body) return c.json({ error: "invalid approval request" }, 400); await approvePendingWorker(deps.db, c.req.param("workerId"), body, user.id); deps.onWorkerAdopted(c.req.param("workerId")); return c.json({ ok: true }); });
  app.post("/api/workers/pending/:workerId/configure", async (c) => {
    const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401);
    if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403);
    if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400);
    try {
      const body = await c.req.json();
      const parsed = WorkerConfiguration.safeParse({ appliance: body.appliance, runtime: body.runtime, guestPlatforms: body.guestPlatforms });
      if (!parsed.success) return c.json({ error: "invalid worker configuration" }, 400);
      const key = c.req.header("Idempotency-Key")!.trim();
      const [prior] = await deps.db<{ response: Record<string, unknown> | null }[]>`select response from worker_mutations where worker_id=${c.req.param("workerId")} and idempotency_key=${key}`;
      if (prior?.response) return c.json(prior.response, { status: 202, headers: noStore() });
      const result = await configurePendingWorker(deps.db, c.req.param("workerId"), parsed.data, user.id, deps.workerDispatcher, key);
      deps.onWorkerAdopted(c.req.param("workerId"));
      return c.json(result, { status: 202, headers: noStore() });
    } catch (error) {
      if (error instanceof SyntaxError || (error && typeof error === "object" && "issues" in error)) return c.json({ error: "invalid worker configuration" }, 400);
      if (error instanceof Error && error.message.includes("capacity")) return c.json({ error: error.message }, 422);
      if (error instanceof Error && error.message.includes("conflict")) return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  app.get("/api/workers/pending", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); const rows = await deps.db`select id,name,platform,guest_platforms as "guestPlatforms",admission_state as "admissionState",connection_state as "connectionState",configuration_state as "configurationState",public_key as "publicKey",fingerprint,vm_uuid as "vmUuid",machine_uuid as "machineUuid",limits,doctor,last_requested_at as "lastRequestedAt" from workers where admission_state='pending' order by created_at desc`; return c.json(rows.map((row) => pendingWorkerDto(row, deps.workerConnected)).filter((row): row is NonNullable<typeof row> => row !== null)); });
  app.post("/api/workers/pending/:workerId/reject", async (c) => { const user = await auth(c); if (!user) return c.json({ error: "unauthorized" }, 401); if (!user.isGlobalAdmin) return c.json({ error: "forbidden" }, 403); if (!idempotency(c)) return c.json({ error: "Idempotency-Key required" }, 400); await rejectPendingWorker(deps.db, c.req.param("workerId"), user.id); return c.json({ ok: true }); });
}
