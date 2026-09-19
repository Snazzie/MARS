import { expect, test } from "bun:test";
import { WorkerReleaseManifest } from "./worker-release.ts";

const hash = "a".repeat(64);
const asset = (name: string) => ({ url: `https://downloads.example.test/${name}`, sha256: hash });
const valid = {
  schemaVersion: 5 as const,
  buildId: "build-1",
  contractVersion: "0.3.0",
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
    "linux-arm64": {
      installer: asset("linux-arm64-installer.ps1"),
      compose: asset("linux-arm64-compose.yaml"),
      brokerImage: `ghcr.io/snazzie/mars/linux-arm64-broker@sha256:${hash}`,
      jobImage: `ghcr.io/snazzie/mars/linux-arm64-job@sha256:${hash}`,
    },
    "windows-x64": {
      installer: asset("windows-installer.ps1"),
      orchestrator: asset("windows-orchestrator.exe"),
      serviceHost: asset("windows-service-host.exe"),
      jobAgent: asset("windows-job-agent.exe"),
      vm: { checkpoint: asset("windows-worker-checkpoint.zip") },
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
      macosJobAgent: asset("macos-job-agent"),
      linuxArm64JobAgent: asset("linux-arm64-job-agent"),
      linuxArm64Runner: asset("linux-arm64-runner.tar.gz"),
      imagePreparationScript: asset("prepare-tart-job-image.sh"),
      tartMacosSourceImage: `ghcr.io/cirruslabs/macos-sonoma-base@sha256:${hash}`,
      tartLinuxArm64SourceImage: `ghcr.io/cirruslabs/ubuntu@sha256:${hash}`,
    },
  },
};

test("accepts a complete schema-5 release manifest with both Windows runtimes", () => {
  expect(WorkerReleaseManifest.parse(valid)).toEqual(valid);
});

test("accepts explicit nulls for unavailable platforms", () => {
  const value = {
    ...valid,
    platforms: {
      "linux-x64": null,
      "linux-arm64": null,
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
  malformed.platforms["macos-arm64"].macosJobAgent.sha256 = "not-a-sha256";
  expect(() => WorkerReleaseManifest.parse(malformed)).toThrow();

  const uppercase = structuredClone(valid);
  uppercase.platforms["macos-arm64"].macosJobAgent.sha256 = "A".repeat(64);
  expect(() => WorkerReleaseManifest.parse(uppercase)).toThrow();
});

test("rejects partial platform records", () => {
  const value = structuredClone(valid);
  delete (value.platforms["linux-x64"] as Record<string, unknown>).compose;
  expect(() => WorkerReleaseManifest.parse(value)).toThrow();
});
