import { describe, expect, test } from "bun:test";
import {
  applyWorkflowMutation,
  discoverWorkflowFiles,
  previewWorkflowMutation,
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

test("focused mutation previews and rewrites only the selected job", () => {
  const input = `name: CI
jobs:
  build:
    runs-on: [mars-windows-x64, 8VCPU, 16G]
    steps:
      - run: echo build
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`;
  const files = discoverWorkflowFiles([{ path: ".github/workflows/ci.yml", content: input }]);
  const preview = previewWorkflowMutation({
    files,
    selectedPaths: [],
    selectedPath: ".github/workflows/ci.yml",
    selectedJobId: "build",
    labels: ["4VCPU", "8G"],
  });
  expect(preview.jobs).toEqual([{
    id: "build",
    currentRunsOn: ["mars-windows-x64", "8VCPU", "16G"],
    path: ".github/workflows/ci.yml",
    proposedRunsOn: ["mars-windows-x64", "4VCPU", "8G"],
  }]);
  expect(preview.changedFiles).toEqual([".github/workflows/ci.yml"]);
  const output = applyWorkflowMutation(input, ["4VCPU", "8G"], "build", true);
  expect(output).toContain("runs-on:\n      - mars-windows-x64\n      - 4VCPU\n      - 8G");
  expect(output).toContain("runs-on: ubuntu-latest");
  expect(output).toContain("echo lint");
});

test("focused mutation rejects invalid numeric labels and reports no-op", () => {
  const files = discoverWorkflowFiles([{ path: ".github/workflows/ci.yml", content }]);
  expect(() => previewWorkflowMutation({
    files,
    selectedPaths: [],
    selectedPath: ".github/workflows/ci.yml",
    selectedJobId: "test",
    labels: ["0VCPU", "8G"],
  })).toThrow(/invalid resource label/i);
  const noOp = previewWorkflowMutation({
    files: discoverWorkflowFiles([{ path: ".github/workflows/ci.yml", content: content.replace("ubuntu-latest", "4VCPU") }]),
    selectedPaths: [],
    selectedPath: ".github/workflows/ci.yml",
    selectedJobId: "test",
    labels: ["4VCPU"],
  });
  expect(noOp.noOp).toBe(true);
  expect(noOp.changedFiles).toEqual([]);
});
