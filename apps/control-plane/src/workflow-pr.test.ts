import { describe, expect, test } from "bun:test";
import {
  applyWorkflowMutation,
  discoverWorkflowFiles,
  previewWorkflowMutation,
  resolveWorkflowJob,
} from "./workflow-pr";

const content = `name: CI\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`;

describe("workflow runner mutation", () => {
  test("discovers job-level runs-on", () => {
    expect(discoverWorkflowFiles([{ path: ".github/workflows/ci.yml", content }])).toMatchObject([
      { path: ".github/workflows/ci.yml", jobs: [{ id: "test", currentRunsOn: "ubuntu-latest" }] },
    ]);
  });

  test("previews all and selected files", () => {
    const files = discoverWorkflowFiles([
      { path: ".github/workflows/ci.yml", content },
      { path: ".github/workflows/release.yaml", content: content.replace("ubuntu-latest", "windows-latest") },
    ]);
    expect(previewWorkflowMutation({ files, selectedPaths: [], labels: ["self-hosted", "arm64"] })).toMatchObject({ replacementCount: 2, changedFiles: [".github/workflows/ci.yml", ".github/workflows/release.yaml"] });
    expect(previewWorkflowMutation({ files, selectedPaths: [".github/workflows/ci.yml"], labels: ["self-hosted", "arm64"] })).toMatchObject({ replacementCount: 1, changedFiles: [".github/workflows/ci.yml"] });
  });

  test("rewrites scalar, sequence, and expression-compatible values as labels sequence", () => {
    const input = `jobs:\n  a:\n    runs-on: ubuntu-latest\n  b:\n    runs-on: [self-hosted, linux]\n  c:\n    runs-on: "\${{ matrix.os }}"\n`;
    const output = applyWorkflowMutation(input, ["self-hosted", "macos", "arm64"]);
    expect(output).toContain("runs-on:\n      - self-hosted\n      - macos\n      - arm64");
    expect((output.match(/runs-on:/g) ?? []).length).toBe(3);
    expect(output).toContain("jobs:");
  });

  test("rejects invalid paths, malformed YAML, unsupported nodes, and no-op", () => {
    expect(() => discoverWorkflowFiles([{ path: "workflow.yml", content }])).toThrow(/invalid workflow path/i);
    expect(() => discoverWorkflowFiles([{ path: ".github/workflows/bad.yml", content: "jobs:\n  x:\n    runs-on: {os: linux}\n" }])).toThrow(/bad\.yml.*x/i);
    const noRuns = discoverWorkflowFiles([{ path: ".github/workflows/no.yml", content: "name: no\njobs:\n  x:\n    steps: []\n" }]);
    expect(() => previewWorkflowMutation({ files: noRuns, selectedPaths: [".github/workflows/no.yml"], labels: ["self-hosted"] })).toThrow(/no selected job.*\.github\/workflows\/no\.yml/i);
    expect(() => previewWorkflowMutation({ files: noRuns, selectedPaths: [".github/workflows/no.yml"], labels: [] })).toThrow(/labels cannot be empty/i);
    expect(() => discoverWorkflowFiles([{ path: ".github/workflows/numeric.yml", content: "jobs:\n  build:\n    runs-on: 123\n" }])).toThrow(/numeric\.yml.*build.*string/i);
    expect(() => previewWorkflowMutation({ files: noRuns, selectedPaths: [".github/workflows/no.yml"], labels: ["self-hosted"] })).toThrow(/no selected job/i);
    expect(() => previewWorkflowMutation({ files: noRuns, selectedPaths: [".github/workflows/missing.yml"], labels: ["self-hosted"] })).toThrow(/not discovered/i);
  });
});

test("focused mutation previews composite alternatives and changes resources independently", () => {
  const input = `name: CI
jobs:
  build:
    runs-on: [mars-windows-x64-8vcpu-16g, mars-macos-arm64-2vcpu-4g, mars-linux-x64-2vcpu-4g]
    steps:
      - run: echo build
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`;
  const files = discoverWorkflowFiles([{ path: ".github/workflows/ci.yml", content: input }]);
  const labels = ["mars-linux-x64-4vcpu-12g", "MARS-WINDOWS-X64-4VCPU-20G", "mars-macos-arm64-2vcpu-4g"];
  const preview = previewWorkflowMutation({
    files,
    selectedPaths: [],
    selectedPath: ".github/workflows/ci.yml",
    selectedJobId: "build",
    labels,
  });
  expect(preview.jobs).toEqual([{
    id: "build",
    currentRunsOn: ["mars-windows-x64-8vcpu-16g", "mars-macos-arm64-2vcpu-4g", "mars-linux-x64-2vcpu-4g"],
    path: ".github/workflows/ci.yml",
    proposedRunsOn: ["MARS-WINDOWS-X64-4VCPU-20G", "mars-macos-arm64-2vcpu-4g", "mars-linux-x64-4vcpu-12g"],
  }]);
  expect(preview.changedFiles).toEqual([".github/workflows/ci.yml"]);
  const output = applyWorkflowMutation(input, labels, "build", true);
  expect(output).toContain("mars-macos-arm64-2vcpu-4g");
  expect(output).toContain("MARS-WINDOWS-X64-4VCPU-20G");
  expect(output).toContain("mars-linux-x64-4vcpu-12g");
  expect(output).toContain("echo lint");
});

test("focused mutation rejects old syntax, malformed alternatives, duplicates, and route changes", () => {
  const focusedContent = content.replace("ubuntu-latest", "[mars-windows-x64-4vcpu-8g, mars-macos-arm64-2vcpu-4g]");
  const files = discoverWorkflowFiles([{ path: ".github/workflows/ci.yml", content: focusedContent }]);
  const request = (labels: string[]) => previewWorkflowMutation({
    files,
    selectedPaths: [],
    selectedPath: ".github/workflows/ci.yml",
    selectedJobId: "test",
    labels,
  });
  for (const labels of [
    ["mars-windows-x64", "4VCPU", "8G"],
    ["mars-windows-x64-4vcpu"],
    ["mars-windows-x64-0vcpu-8g"],
    ["mars-windows-x64-4vcpu-8g", "mars-windows-x64-2vcpu-4g"],
    ["mars-windows-x64-4vcpu-8g", "mars-linux-x64-2vcpu-4g"],
  ]) {
    expect(() => request(labels)).toThrow(/focused workflow labels/i);
  }
  expect(() => previewWorkflowMutation({
    files,
    selectedPaths: [],
    selectedPath: ".github/workflows/ci.yml",
    labels: ["mars-windows-x64-4vcpu-8g"],
  })).toThrow(/focused workflow selection/i);
  expect(() => previewWorkflowMutation({
    files,
    selectedPaths: [],
    selectedJobId: "test",
    labels: ["mars-windows-x64-4vcpu-8g"],
  })).toThrow(/focused workflow selection/i);
  const oldFiles = discoverWorkflowFiles([{ path: ".github/workflows/ci.yml", content: content.replace("ubuntu-latest", "[mars-windows-x64, 4VCPU, 8G]") }]);
  expect(() => previewWorkflowMutation({
    files: oldFiles,
    selectedPaths: [],
    selectedPath: ".github/workflows/ci.yml",
    selectedJobId: "test",
    labels: ["mars-windows-x64-4vcpu-8g"],
  })).toThrow(/focused workflow labels/i);
});

test("focused mutation reports no-op when composite alternatives are unchanged", () => {
  const labels = ["mars-windows-x64-4vcpu-8g", "mars-macos-arm64-2vcpu-4g"];
  const noOp = previewWorkflowMutation({
    files: discoverWorkflowFiles([{ path: ".github/workflows/ci.yml", content: content.replace("ubuntu-latest", `[${labels.join(", ")}]`) }]),
    selectedPaths: [],
    selectedPath: ".github/workflows/ci.yml",
    selectedJobId: "test",
    labels,
  });
  expect(noOp.noOp).toBe(true);
  expect(noOp.changedFiles).toEqual([]);
});


test("resolves the YAML job key from workflow and job display names", () => {
  const files = [{
    path: ".github/workflows/ci.yml",
    content: `name: CI
jobs:
  build:
    name: Build Windows
    runs-on: mars-windows-x64-2vcpu-4g
`,
  }];
  expect(resolveWorkflowJob(files, "CI", "Build Windows")).toEqual({
    path: ".github/workflows/ci.yml",
    jobId: "build",
    currentRunsOn: "mars-windows-x64-2vcpu-4g",
  });
  expect(() => resolveWorkflowJob(files, "CI", "dashboard-uuid")).toThrow("github_workflow_job_not_found");
});
