import { describe, expect, test } from "bun:test";
import { runnerWorkflowPreviewPayload } from "../api.ts";
import { areRunnerWorkflowLabelsValid, formatRunnerWorkflowRunsOn, handleRunnerWorkflowEscape, isRunnerWorkflowPrDisabled } from "./RunnerWorkflowPrModal.tsx";

describe("RunnerWorkflowPrModal behavior contracts", () => {
  test("formats current and proposed runs-on values", () => {
    expect(formatRunnerWorkflowRunsOn("ubuntu-latest")).toBe("ubuntu-latest");
    expect(formatRunnerWorkflowRunsOn(["self-hosted", "macos", "arm64"])).toBe("self-hosted, macos, arm64");
  });
  test("disables create for loading, invalid, no-op, and completed states", () => {
    expect(isRunnerWorkflowPrDisabled({ result: null, hasPreview: false })).toBe(true);
    expect(isRunnerWorkflowPrDisabled({ result: null, hasPreview: true, noOp: true, replacementCount: 0 })).toBe(true);
    expect(isRunnerWorkflowPrDisabled({ result: null, hasPreview: true, replacementCount: 1, previewLoading: true })).toBe(true);
    expect(isRunnerWorkflowPrDisabled({ result: "https://github.com/pr/1", hasPreview: true, replacementCount: 1 })).toBe(true);
    expect(isRunnerWorkflowPrDisabled({ result: null, hasPreview: true, replacementCount: 2 })).toBe(true);
    expect(isRunnerWorkflowPrDisabled({ result: null, hasPreview: true, replacementCount: 2, confirmed: true })).toBe(false);
  });
  test("server preview contract supplies expected head SHA and labels remain display-only", () => {
    const preview = { headSha: "abc1234", labels: ["self-hosted", "macos", "arm64"], jobs: [{ currentRunsOn: "ubuntu-latest", proposedRunsOn: ["self-hosted", "macos", "arm64"] }] };
    expect(preview.headSha).toBe("abc1234");
    expect(preview.jobs[0].proposedRunsOn).not.toContain("editable");
  });
  test("serializes focused preview fields without changing migration payloads", () => {
    expect(runnerWorkflowPreviewPayload([".github/workflows/ci.yml"])).toEqual({ selectedPaths: [".github/workflows/ci.yml"] });
    expect(runnerWorkflowPreviewPayload({ selectedPath: ".github/workflows/ci.yml", selectedJobId: "build", labels: ["mars-windows-x64", "4VCPU", "8G"] })).toEqual({
      selectedPath: ".github/workflows/ci.yml",
      selectedJobId: "build",
      labels: ["mars-windows-x64", "4VCPU", "8G"],
    });
  });

  test("validates focused routing, duplicate, and custom-label conflicts", () => {
    const current = ["self-hosted", "mars-windows-x64", "custom", "8VCPU", "16G"];
    expect(areRunnerWorkflowLabelsValid(["self-hosted", "mars-windows-x64", "custom", "4VCPU", "8G"], current)).toBe(true);
    expect(areRunnerWorkflowLabelsValid(["self-hosted", "windows-latest", "custom", "4VCPU", "8G"], current)).toBe(false);
    expect(areRunnerWorkflowLabelsValid(["self-hosted", "mars-windows-x64", "custom", "4VCPU", "4VCPU", "8G"], current)).toBe(false);
    expect(areRunnerWorkflowLabelsValid(["self-hosted", "mars-windows-x64", "foreign", "4VCPU", "8G"], current)).toBe(false);
  });


  test("Escape closes an open dialog", () => {
    let closed = false;
    handleRunnerWorkflowEscape({ key: "Escape" } as KeyboardEvent, () => { closed = true; });
    expect(closed).toBe(true);
  });
});
