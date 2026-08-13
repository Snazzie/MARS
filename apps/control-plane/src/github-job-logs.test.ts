import { describe, expect, test } from "bun:test";
import { attributeGithubJobLog } from "./github-job-logs.ts";
import type { GithubStepSnapshot } from "./runs.ts";

const step = (number: number, name: string, startedAt: string, completedAt: string): GithubStepSnapshot => ({
  id: null,
  number,
  name,
  status: "completed",
  conclusion: "success",
  queuedAt: startedAt,
  startedAt,
  completedAt,
  durationMs: Date.parse(completedAt) - Date.parse(startedAt),
});

describe("GitHub job log attribution", () => {
  test("attributes timestamped lines to the matching step interval", () => {
    const result = attributeGithubJobLog([
      "2026-08-13T19:06:31.0000000Z runner setup",
      "2026-08-13T19:06:33.1000000Z checkout line",
      "2026-08-13T19:06:37.9000000Z checkout done",
      "2026-08-13T19:06:38.1000000Z bun line",
      "2026-08-13T19:06:43.0000000Z job cleanup",
      "",
    ].join("\n"), [
      step(2, "Check out project", "2026-08-13T19:06:33Z", "2026-08-13T19:06:38Z"),
      step(3, "Set up Bun", "2026-08-13T19:06:38Z", "2026-08-13T19:06:42Z"),
    ]);

    expect(result.steps.get(2)).toBe("2026-08-13T19:06:33.1000000Z checkout line\n2026-08-13T19:06:37.9000000Z checkout done\n");
    expect(result.steps.get(3)).toBe("2026-08-13T19:06:38.1000000Z bun line\n");
    expect(result.unattributed).toBe("2026-08-13T19:06:31.0000000Z runner setup\n2026-08-13T19:06:43.0000000Z job cleanup\n");
  });

  test("keeps malformed and untimestamped lines with the previous destination", () => {
    const result = attributeGithubJobLog([
      "2026-08-13T19:06:33.1000000Z action output",
      "untimestamped continuation",
      "2026-08-13T19:06:43.0000000Z cleanup",
      "cleanup continuation",
    ].join("\n"), [step(2, "Action", "2026-08-13T19:06:33Z", "2026-08-13T19:06:38Z")]);

    expect(result.steps.get(2)).toContain("untimestamped continuation\n");
    expect(result.unattributed).toContain("cleanup continuation\n");
  });

  test("strips terminal control sequences before persistence", () => {
    const result = attributeGithubJobLog("2026-08-13T19:06:33.1000000Z \u001b[31mfailed\u001b[0m\n", [step(2, "Action", "2026-08-13T19:06:33Z", "2026-08-13T19:06:38Z")]);
    expect(result.steps.get(2)).toEndWith("failed\n");
    expect(result.steps.get(2)).not.toContain("\u001b");
  });
});


test("uses GitHub step markers when second-precision timestamps collapse a failed step", () => {
  const steps = [
    step(1, "Set up job", "2026-08-13T19:06:32Z", "2026-08-13T19:06:33Z"),
    step(2, "Check out project", "2026-08-13T19:06:33Z", "2026-08-13T19:06:38Z"),
    step(3, "Set up Bun", "2026-08-13T19:06:38Z", "2026-08-13T19:06:42Z"),
    { ...step(4, "Install dependencies", "2026-08-13T19:06:42Z", "2026-08-13T19:06:42Z"), conclusion: "failure" },
    step(18, "Post Check out project", "2026-08-13T19:06:42Z", "2026-08-13T19:06:43Z"),
    step(19, "Complete job", "2026-08-13T19:06:43Z", "2026-08-13T19:06:43Z"),
  ];
  const result = attributeGithubJobLog([
    "2026-08-13T19:06:32.100Z runner setup",
    "2026-08-13T19:06:33.100Z ##[group]Run actions/checkout@v4",
    "2026-08-13T19:06:38.100Z ##[group]Run oven-sh/setup-bun@v2",
    "2026-08-13T19:06:42.401Z ##[group]Run bun install --frozen-lockfile",
    "2026-08-13T19:06:42.477Z ##[error]Process completed with exit code 1.",
    "2026-08-13T19:06:42.508Z Post job cleanup.",
    "2026-08-13T19:06:43.444Z Cleaning up orphan processes",
  ].join("\n"), steps);

  expect(result.steps.get(4)).toContain("Process completed with exit code 1");
  expect(result.steps.get(18)).toContain("Post job cleanup");
  expect(result.steps.get(19)).toContain("Cleaning up orphan processes");
});