import { expect, test } from "bun:test";
import { storedWorkerDoctor, workerPoolEvidence } from "./worker-evidence.ts";

const digest = `sha256:${"a".repeat(64)}`;
const readyWindowsVm = { capabilities: [{ driver: "windows-hyperv", guestPlatform: "windows-x64", imageDigest: digest, ready: true, remediation: null }] };

test("normalizes both direct and persisted doctor report envelopes", () => {
  expect(storedWorkerDoctor(readyWindowsVm)).toEqual(readyWindowsVm);
  expect(storedWorkerDoctor(JSON.stringify({ releaseVersion: "1.0.0", doctor: readyWindowsVm, capacity: {} }))).toEqual(readyWindowsVm);
});

test("selects readiness and image from the advertised driver and guest platform", () => {
  expect(workerPoolEvidence({ doctor: readyWindowsVm }, "windows-hyperv", "windows-x64")).toEqual({ ready: true, imageDigest: digest });
  expect(workerPoolEvidence({ doctor: { capabilities: [{ ...readyWindowsVm.capabilities[0], ready: false }] } }, "windows-hyperv", "windows-x64")).toEqual({ ready: false, imageDigest: digest });
  expect(workerPoolEvidence({ doctor: readyWindowsVm }, "windows-process-container", "windows-x64")).toEqual({ ready: false, imageDigest: null });
  expect(workerPoolEvidence({ doctor: readyWindowsVm }, "windows-hyperv", "linux-arm64")).toEqual({ ready: false, imageDigest: null });
});
