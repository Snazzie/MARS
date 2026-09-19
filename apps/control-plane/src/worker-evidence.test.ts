import { expect, test } from "bun:test";
import { storedWorkerDoctor, workerPoolEvidence } from "./worker-evidence.ts";

const digest = `sha256:${"a".repeat(64)}`;
const readyWindowsVm = { runtimeMode: "vm", runtimeReady: true, probe: true, imageSignatures: true, artifactDigest: digest };

test("normalizes both direct and persisted doctor report envelopes", () => {
  expect(storedWorkerDoctor(readyWindowsVm)).toEqual(readyWindowsVm);
  expect(storedWorkerDoctor(JSON.stringify({ releaseVersion: "1.0.0", doctor: readyWindowsVm, capacity: {} }))).toEqual(readyWindowsVm);
});

test("accepts Windows VM evidence only when readiness and image identity match", () => {
  expect(workerPoolEvidence({ doctor: readyWindowsVm }, "windows-hyperv", digest, "windows-x64")).toEqual({ ready: true, imageMatches: true });
  expect(workerPoolEvidence({ doctor: readyWindowsVm }, "windows-hyperv", `sha256:${"b".repeat(64)}`, "windows-x64")).toEqual({ ready: true, imageMatches: false });
  expect(workerPoolEvidence({ doctor: { ...readyWindowsVm, probe: false } }, "windows-hyperv", digest, "windows-x64")).toEqual({ ready: false, imageMatches: true });
});
