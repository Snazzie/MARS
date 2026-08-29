import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { windowsInstallerValues } from "./http/worker-routes.ts";
import { loadWorkerReleaseManifest } from "./worker-release.ts";

const hash = "a".repeat(64);

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
