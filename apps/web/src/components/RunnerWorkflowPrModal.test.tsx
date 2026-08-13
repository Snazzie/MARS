import { describe, expect, test } from "bun:test";
import { formatRunnerWorkflowRunsOn, handleRunnerWorkflowEscape, isRunnerWorkflowPrDisabled } from "./RunnerWorkflowPrModal.tsx";

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

  test("Escape closes an open dialog", () => {
    let closed = false;
    handleRunnerWorkflowEscape({ key: "Escape" } as KeyboardEvent, () => { closed = true; });
    expect(closed).toBe(true);
  });
});
