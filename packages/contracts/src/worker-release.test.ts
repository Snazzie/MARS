import { expect, test } from "bun:test";
import { WorkerReleaseManifest } from "./worker-release.ts";

const hash = "a".repeat(64);
const asset = (name: string) => ({ url: `https://downloads.example.test/${name}`, sha256: hash });
const valid = {
  schemaVersion: 3 as const,
  buildId: "build-1",
  contractVersion: "0.1.0",
  platforms: {
    "linux-x64": {
      installer: asset("linux-installer.sh"),
      orchestrator: asset("linux-orchestrator"),
      jobAgent: asset("linux-job-agent"),
      brokerImage: `ghcr.io/snazzie/mars/linux-broker@sha256:${hash}`,
      goldenImage: asset("linux-golden.qcow2"),
      compose: asset("linux-compose.yaml"),
      domainTemplate: asset("linux-domain.xml"),
    },
    "windows-x64": {
      installer: asset("windows-installer.ps1"),
      orchestrator: asset("windows-orchestrator.exe"),
      serviceHost: asset("windows-service-host.exe"),
      jobAgent: asset("windows-job-agent.exe"),
      container: {
        baseImage: `mcr.microsoft.com/windows/server:ltsc2025@sha256:${hash}`,
        runner: asset("windows-runner.zip"),
        git: asset("windows-git.zip"),
        vcRuntime: asset("windows-vc-runtime.exe"),
        buildScript: asset("windows-build.ps1"),
        verifyScript: asset("windows-verify.ps1"),
        containerfile: asset("windows-Containerfile"),
        entrypoint: asset("windows-entrypoint.ps1"),
      },
    },
    "macos-arm64": {
      installer: asset("macos-installer.sh"),
      orchestrator: asset("macos-orchestrator"),
      jobAgent: asset("macos-job-agent"),
      imagePreparationScript: asset("prepare-macos-job-image.sh"),
      tartSourceImage: `ghcr.io/cirruslabs/macos-sonoma-base@sha256:${hash}`,
    },
  },
};

test("accepts a complete schema-3 release manifest", () => {
  expect(WorkerReleaseManifest.parse(valid)).toEqual(valid);
});

test("accepts explicit nulls for unavailable platforms", () => {
  const value = {
    ...valid,
    platforms: {
      "linux-x64": null,
      "windows-x64": null,
      "macos-arm64": null,
    },
  };
  expect(WorkerReleaseManifest.parse(value).platforms).toEqual(value.platforms);
});

test("rejects schema-2 release manifests", () => {
  const value = { ...valid, schemaVersion: 2 };
  expect(() => WorkerReleaseManifest.parse(value)).toThrow();
});

test("rejects unknown fields", () => {
  const value = structuredClone(valid) as typeof valid & { unexpected: string };
  value.unexpected = "not part of the contract";
  expect(() => WorkerReleaseManifest.parse(value)).toThrow();
});

test("rejects mutable OCI image references", () => {
  const value = structuredClone(valid);
  value.platforms["linux-x64"].brokerImage = "ghcr.io/snazzie/mars/linux-broker:latest";
  expect(() => WorkerReleaseManifest.parse(value)).toThrow();
});

test("rejects HTTP asset URLs", () => {
  const value = structuredClone(valid);
  value.platforms["windows-x64"].container.runner.url = "http://downloads.example.test/windows-runner.zip";
  expect(() => WorkerReleaseManifest.parse(value)).toThrow();
});

test("rejects malformed and uppercase hashes", () => {
  const malformed = structuredClone(valid);
  malformed.platforms["macos-arm64"].jobAgent.sha256 = "not-a-sha256";
  expect(() => WorkerReleaseManifest.parse(malformed)).toThrow();

  const uppercase = structuredClone(valid);
  uppercase.platforms["macos-arm64"].jobAgent.sha256 = "A".repeat(64);
  expect(() => WorkerReleaseManifest.parse(uppercase)).toThrow();
});

test("rejects partial platform records", () => {
  const value = structuredClone(valid);
  delete (value.platforms["linux-x64"] as Record<string, unknown>).compose;
  expect(() => WorkerReleaseManifest.parse(value)).toThrow();
});
