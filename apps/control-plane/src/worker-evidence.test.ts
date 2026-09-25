import { expect, test } from "bun:test";
import { storedWorkerDoctor, workerPoolEvidence } from "./worker-evidence.ts";

const digest = `sha256:${"a".repeat(64)}`;
const readyWindowsVm = { capabilities: [{ driver: "windows-hyperv", guestPlatform: "windows-x64", imageDigest: digest, ready: true, remediation: null }] };

test("normalizes both direct and persisted doctor report envelopes", () => {
  expect(storedWorkerDoctor(readyWindowsVm)).toEqual(readyWindowsVm);
  expect(storedWorkerDoctor(JSON.stringify({ releaseVersion: "1.0.0", doctor: readyWindowsVm, capacity: {} }))).toEqual(readyWindowsVm);
});

test("matches evidence only for the exact advertised ready capability and digest", () => {
  expect(workerPoolEvidence({ doctor: readyWindowsVm }, "windows-hyperv", digest, "windows-x64")).toEqual({ ready: true, imageMatches: true });
  expect(workerPoolEvidence({ doctor: readyWindowsVm }, "windows-hyperv", `sha256:${"b".repeat(64)}`, "windows-x64")).toEqual({ ready: true, imageMatches: false });
  expect(workerPoolEvidence({ doctor: { capabilities: [{ ...readyWindowsVm.capabilities[0], ready: false }] } }, "windows-hyperv", digest, "windows-x64")).toEqual({ ready: false, imageMatches: true });
  expect(workerPoolEvidence({ doctor: readyWindowsVm }, "windows-process-container", digest, "windows-x64")).toEqual({ ready: false, imageMatches: false });
});
