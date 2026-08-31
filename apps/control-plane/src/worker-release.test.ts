import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isWorkerContractCompatible,
  loadWorkerReleaseManifest,
  parseContractVersion,
} from "./worker-release.ts";

const hash = "a".repeat(64);

const linuxRelease = {
  orchestratorSha256: hash,
  brokerImage: `ghcr.io/snazzie/mars/broker@sha256:${hash}`,
  goldenImageUrl: "https://downloads.example.test/worker.qcow2",
  goldenImageSha256: hash,
  composeSha256: hash,
  domainTemplateSha256: hash,
};

const remoteManifest = (contractVersion = "0.1.0") => ({
  schemaVersion: 2,
  buildId: "release-build",
  contractVersion,
  platforms: { "linux-x64": linuxRelease, "windows-x64": null, "macos-arm64": null },
});

test("parses strict major.minor.patch versions", () => {
  expect(parseContractVersion("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0 });
  expect(() => parseContractVersion("v0.1.0")).toThrow();
  expect(() => parseContractVersion("0.1")).toThrow();
  expect(() => parseContractVersion("0.1.0-beta")).toThrow();
  expect(() => parseContractVersion("0.1.-1")).toThrow();
});

test("accepts compatible worker contract boundaries", () => {
  expect(isWorkerContractCompatible("0.1.0", "0.1.0")).toBe(true);
  expect(isWorkerContractCompatible("0.1.0", "0.1.99")).toBe(true);
  expect(isWorkerContractCompatible("0.1.0", "0.0.7")).toBe(true);
  expect(isWorkerContractCompatible("0.1.0", "0.2.0")).toBe(false);
  expect(isWorkerContractCompatible("0.1.0", "1.0.0")).toBe(false);
  expect(isWorkerContractCompatible("0.1.0", "not-a-version")).toBe(false);
});

test("loads a valid HTTPS remote manifest", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify(remoteManifest()), { status: 200 });
  const manifest = await loadWorkerReleaseManifest("https://manifest.example.test/release.json", undefined, {
    fetch: fetcher,
    controlPlaneVersion: "0.1.0",
  });
  expect(manifest.buildId).toBe("release-build");
  expect(manifest.platforms["linux-x64"]).toEqual(linuxRelease);
});

test("rejects remote HTTP failures", async () => {
  const fetcher: typeof fetch = async () => new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
  await expect(loadWorkerReleaseManifest("https://manifest.example.test/release.json", undefined, { fetch: fetcher })).rejects.toThrow("HTTP 503");
});

test("rejects remote network failures", async () => {
  const fetcher: typeof fetch = async () => { throw new Error("connection refused"); };
  await expect(loadWorkerReleaseManifest("https://manifest.example.test/release.json", undefined, { fetch: fetcher })).rejects.toThrow("connection refused");
});

test("rejects invalid remote JSON", async () => {
  const fetcher: typeof fetch = async () => new Response("{", { status: 200 });
  await expect(loadWorkerReleaseManifest("https://manifest.example.test/release.json", undefined, { fetch: fetcher })).rejects.toThrow("invalid JSON");
});

test("rejects remote schema and compatibility failures", async () => {
  const schemaFailure: typeof fetch = async () => new Response(JSON.stringify({ ...remoteManifest(), platforms: {} }), { status: 200 });
  await expect(loadWorkerReleaseManifest("https://manifest.example.test/release.json", undefined, { fetch: schemaFailure })).rejects.toThrow("schema");

  const incompatible: typeof fetch = async () => new Response(JSON.stringify(remoteManifest("0.2.0")), { status: 200 });
  await expect(loadWorkerReleaseManifest("https://manifest.example.test/release.json", undefined, {
    fetch: incompatible,
    controlPlaneVersion: "0.1.0",
  })).rejects.toThrow("incompatible");
});

test("rejects remote manifests without linux-x64", async () => {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ ...remoteManifest(), platforms: { ...remoteManifest().platforms, "linux-x64": null } }), { status: 200 });
  await expect(loadWorkerReleaseManifest("https://manifest.example.test/release.json", undefined, { fetch: fetcher })).rejects.toThrow("linux-x64");
});


test("loads a usable Windows release from local development artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-local-release-"));
  try {
    const orchestrator = join(root, "mars-orchestrator.exe");
    const serviceHost = join(root, "mars-service-host.exe");
    await Bun.write(orchestrator, "local orchestrator");
    await Bun.write(serviceHost, "local service host");

    const manifestPath = join(root, "release-manifest.json");
    await Bun.write(manifestPath, JSON.stringify({
      schemaVersion: 2,
      buildId: "development",
      contractVersion: "0.1.0",
      platforms: { "linux-x64": null, "windows-x64": null, "macos-arm64": null },
    }));

    const manifest = await loadWorkerReleaseManifest(pathToFileURL(manifestPath), {
      windows: {
        orchestrator: pathToFileURL(orchestrator),
        serviceHost: pathToFileURL(serviceHost),
        vmTemplateUrl: "https://github.com/Snazzie/Mars/releases/latest/download/windows-worker.vhdx",
        vmTemplateSha256: hash,
        container: {
          baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
          runner: { url: "https://downloads.example.test/runner.zip", sha256: hash },
          git: { url: "https://downloads.example.test/git.zip", sha256: hash },
          vcRuntime: { url: "https://downloads.example.test/vc.exe", sha256: hash },
        },
      },
    });

    expect(manifest.platforms["windows-x64"]).toMatchObject({
      serviceHostSha256: expect.any(String),
      orchestratorSha256: expect.any(String),
      vmTemplateUrl: "https://github.com/Snazzie/Mars/releases/latest/download/windows-worker.vhdx",
      container: { baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}` },
    });
    expect(manifest.platforms["windows-x64"]?.orchestratorSha256).not.toBe(hash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
