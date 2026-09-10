import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verifyPublishedWorkerRelease } from "./verify-worker-release.ts";

const manifestUrl = "https://github.com/Snazzie/MARS/releases/download/worker-v0.1.1/worker-release-manifest.json";
const bytes = new TextEncoder().encode("worker release fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const asset = (name: string) => ({ url: `https://github.com/Snazzie/MARS/releases/download/worker-v0.1.1/${name}`, sha256 });
const manifest = {
  schemaVersion: 3 as const,
  buildId: "worker-build",
  contractVersion: "0.1.0",
  platforms: { "linux-x64": { installer: asset("installer.sh"), orchestrator: asset("orchestrator"), jobAgent: asset("job-agent"), brokerImage: "ghcr.io/snazzie/mars/linux-broker@sha256:" + "a".repeat(64), goldenImage: asset("golden.qcow2"), compose: asset("compose.yaml"), domainTemplate: asset("domain.xml") }, "windows-x64": null, "macos-arm64": null },
};

function fetcher(options: { missing?: string; mismatch?: string } = {}) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === manifestUrl) return new Response(JSON.stringify(manifest));
    if (options.missing && url.endsWith(options.missing)) return new Response("missing", { status: 404 });
    return new Response(options.mismatch && url.endsWith(options.mismatch) ? "wrong bytes" : bytes);
  };
}

test("verifies manifest and every hashed asset into normalized binding data", async () => {
  await expect(verifyPublishedWorkerRelease(manifestUrl, "0.1.0", { fetch: fetcher() })).resolves.toMatchObject({ workerTag: "worker-v0.1.1", workerVersion: "0.1.1", manifestUrl, contractVersion: "0.1.0", workerBuildId: "worker-build", brokerDigest: `sha256:${"a".repeat(64)}` });
});

test("rejects mutable, missing, inaccessible, mismatched, or incompatible releases", async () => {
  await expect(verifyPublishedWorkerRelease("https://github.com/Snazzie/MARS/releases/latest/download/worker-release-manifest.json", "0.1.0", { fetch: fetcher() })).rejects.toThrow("immutable");
  await expect(verifyPublishedWorkerRelease(manifestUrl, "0.1.0", { fetch: async () => new Response("missing", { status: 404 }) })).rejects.toThrow("HTTP 404");
  await expect(verifyPublishedWorkerRelease(manifestUrl, "0.1.0", { fetch: fetcher({ missing: "installer.sh" }) })).rejects.toThrow("HTTP 404");
  await expect(verifyPublishedWorkerRelease(manifestUrl, "0.1.0", { fetch: fetcher({ mismatch: "installer.sh" }) })).rejects.toThrow("SHA-256 mismatch");
  const withoutLinux = { ...manifest, platforms: { ...manifest.platforms, "linux-x64": null } };
  await expect(verifyPublishedWorkerRelease(manifestUrl, "0.1.0", { fetch: async () => new Response(JSON.stringify(withoutLinux)) })).rejects.toThrow("linux-x64");
  await expect(verifyPublishedWorkerRelease(manifestUrl, "0.2.0", { fetch: fetcher() })).rejects.toThrow("incompatible");
});
