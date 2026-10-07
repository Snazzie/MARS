import { expect, test } from "bun:test";
import { enqueuePipelineFailureAnalysis } from "./pipeline-failure-analysis.ts";
import { renderComment } from "./pipeline-failure-analysis.ts";
import type { PipelineAnalysisResult } from "./llm-providers.ts";
import type { GithubRunSnapshot, GithubJobSnapshot } from "./runs.ts";

const run = (overrides: Partial<GithubRunSnapshot> = {}): GithubRunSnapshot => ({
  id: 812, runAttempt: 2, runNumber: 7, workflowName: "ci", workflowPath: ".github/workflows/ci.yml", event: "push", branch: "main", commitSha: "abcdef1234567", actorLogin: "mars", status: "completed", conclusion: "failure", queuedAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:01:00.000Z", completedAt: "2026-01-01T00:02:00.000Z", ...overrides,
});
const job = (overrides: Partial<GithubJobSnapshot> = {}): GithubJobSnapshot => ({ id: 9001, runId: 812, runAttempt: 1, name: "test", status: "completed", conclusion: "failure", labels: [], runnerName: null, queuedAt: "2026-01-01T00:00:00.000Z", startedAt: null, completedAt: null, steps: [], ...overrides });

test("does not query or enqueue a successful run", async () => {
  const db = { select: () => { throw new Error("unexpected database query"); } } as never;
  await expect(enqueuePipelineFailureAnalysis({ db, organizationId: "org", repositoryId: "repo", run: run({ conclusion: "success" }), jobs: [] })).resolves.toBeUndefined();
});

test("rejects jobs captured from a different run attempt before writing", async () => {
  const db = { select: () => { throw new Error("unexpected database query"); } } as never;
  await expect(enqueuePipelineFailureAnalysis({ db, organizationId: "org", repositoryId: "repo", run: run(), jobs: [job()] })).rejects.toThrow("pipeline_analysis_attempt_mismatch");
});

test("renders safe bounded PR feedback and keeps evidence after the explanation budget", () => {
  const result: PipelineAnalysisResult = {
    summary: "See https://evil.test @team",
    failures: Array.from({ length: 20 }, (_, index) => ({
      jobId: index + 1, stepNumber: null, explanation: "Explanation ".repeat(150), evidence: ["log excerpt ".repeat(40), "line 2", "line 3"], suggestedFix: "Fix ".repeat(150),
    })),
  };
  const body = renderComment(result, { run: { id: 812, attempt: 2, number: 7, workflowName: "ci", repositoryFullName: "acme/repo" }, failedJobs: [] }, "mars-failure-analysis:8:812:2");
  expect(Buffer.byteLength(body)).toBeLessThan(50_000);
  expect(body).toContain("<!-- mars-failure-analysis:8:812:2 -->");
  expect(body).toContain("AI-generated suggestions; verify before applying.");
  expect(body).toContain("https&#58;//evil.test");
  expect(body).not.toContain("@team");
});
