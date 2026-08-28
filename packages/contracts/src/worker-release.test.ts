import { expect, test } from "bun:test";
import { WorkerReleaseManifest } from "./worker-release.ts";

const hash = "a".repeat(64);
const asset = { url: "https://downloads.example.test/asset", sha256: hash };
const valid = {
  schemaVersion: 2 as const,
  buildId: "build-1",
  contractVersion: "0.1.0",
  platforms: {
    "linux-x64": {
      orchestratorSha256: hash,
      brokerImage: "ghcr.io/example/mars-broker@sha256:" + hash,
      goldenImageUrl: "https://downloads.example.test/worker.qcow2",
      goldenImageSha256: hash,
      composeSha256: hash,
      domainTemplateSha256: hash,
    },
    "windows-x64": {
      orchestratorSha256: hash,
      serviceHostSha256: hash,
      vmTemplateUrl: "https://downloads.example.test/worker.vhdx",
      vmTemplateSha256: hash,
      container: {
        baseImage: "mcr.microsoft.com/windows@sha256:" + hash,
        runner: asset,
        git: { ...asset, url: "https://downloads.example.test/git.zip" },
        vcRuntime: { ...asset, url: "https://downloads.example.test/vc.exe" },
      },
    },
    "macos-arm64": {
      orchestratorSha256: hash,
      tartImage: "ghcr.io/example/macos@sha256:" + hash,
      tartImageDigest: hash,
    },
  },
};

test("accepts a complete schema-2 release manifest", () => {
  expect(WorkerReleaseManifest.parse(valid)).toEqual(valid);
});

test("accepts explicit nulls for unavailable platforms", () => {
  const value = { ...valid, platforms: { ...valid.platforms, "linux-x64": null } };
  expect(WorkerReleaseManifest.parse(value).platforms["linux-x64"]).toBeNull();
});

test("rejects mutable OCI image references", () => {
  const value = structuredClone(valid);
  value.platforms["linux-x64"]!.brokerImage = "ghcr.io/example/mars-broker:latest";
  expect(() => WorkerReleaseManifest.parse(value)).toThrow();
});

test("rejects HTTP asset URLs", () => {
  const value = structuredClone(valid);
  value.platforms["windows-x64"]!.container.runner.url = "http://downloads.example.test/runner.zip";
  expect(() => WorkerReleaseManifest.parse(value)).toThrow();
});

test("rejects missing or malformed hashes", () => {
  const value = structuredClone(valid);
  value.platforms["macos-arm64"]!.tartImageDigest = "sha256:" + hash;
  expect(() => WorkerReleaseManifest.parse(value)).toThrow();
});

test("rejects partial platform records", () => {
  const value = structuredClone(valid);
  delete (value.platforms["linux-x64"] as Record<string, unknown>).composeSha256;
  expect(() => WorkerReleaseManifest.parse(value)).toThrow();
});
