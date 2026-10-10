import type { PrReviewResult } from "@mars/contracts";
import { expect, test } from "bun:test";
import { collectPrReviewContext, fitPrReviewContext, renderPrReview, validatePrReviewFindings, type PrReviewContextClient, type PrReviewPullRequest } from "./pr-review-context.ts";

const pr: PrReviewPullRequest = { number: 9, state: "open", draft: false, baseSha: "base-sha", headSha: "head-sha", title: "Example", body: "description", changedFiles: 1 };
const client: PrReviewContextClient = {
  files: async () => [{ filename: "src/example.ts", status: "modified", patch: "@@ -1,2 +1,2 @@\n const value = 1;\n+throw new Error('broken');\n", previousFilename: null }],
  source: async (_owner, _repo, path, sha) => path === "src/example.ts" && sha === "head-sha" ? { text: "const value = 1;\nthrow new Error('broken');\n", sha: "blob-head" } : null,
  getContent: async (_owner, _repo, path, sha) => path === ".mars/pr-rules.md" && sha === "base-sha" ? { text: "Prefer explicit errors.", sha: "rules-blob" } : null,
};
const finding = (overrides: Partial<PrReviewResult["findings"][number]> = {}): PrReviewResult["findings"][number] => ({ path: "src/example.ts", line: 2, endLine: null, severity: "High", confidencePercent: 60, evidence: "throw new Error", impact: "The operation always fails.", correction: "Return a valid result.", suggestion: { startLine: 2, endLine: 2, originalText: "throw new Error('broken');", replacementText: "return value;", rationale: "Preserves the successful result." }, ...overrides });

test("collects only immutable head source and base-commit repository rules", async () => {
  const context = await collectPrReviewContext(client, "acme", "repo", pr);
  expect(context.files[0]).toMatchObject({ path: "src/example.ts", coverage: "reviewable", headSource: "const value = 1;\nthrow new Error('broken');\n" });
  expect(context.rules).toEqual({ path: ".mars/pr-rules.md", baseSha: "base-sha", blobSha: "rules-blob", status: "present", text: "Prefer explicit errors." });
  expect(context.coverage.complete).toBe(true);
});

test("treats missing base rules as valid and non-missing/oversized failures as visible errors", async () => {
  const missing = await collectPrReviewContext({ ...client, getContent: async () => null }, "acme", "repo", pr);
  expect(missing.rules.status).toBe("missing");
  await expect(collectPrReviewContext({ ...client, getContent: async () => { throw new Error("github_500"); } }, "acme", "repo", pr)).rejects.toMatchObject({ message: "pr_review_rules_unavailable", rules: { status: "failed" } });
  await expect(collectPrReviewContext({ ...client, getContent: async () => ({ text: "x".repeat(8193), sha: "blob" }) }, "acme", "repo", pr)).rejects.toMatchObject({ message: "pr_review_rules_too_large", rules: { status: "failed", blobSha: "blob" } });
  await expect(collectPrReviewContext({ ...client, getContent: async () => ({ text: "rules\u0000binary", sha: "unsupported" }) }, "acme", "repo", pr)).rejects.toMatchObject({ message: "pr_review_rules_unsupported", rules: { status: "failed", blobSha: "unsupported" } });
});

test("filters low-confidence and unsupported findings, and emits one safe RIGHT-side suggestion", async () => {
  const context = await collectPrReviewContext(client, "acme", "repo", pr);
  const result = validatePrReviewFindings({ findings: [finding(), finding({ confidencePercent: 59 }), finding({ path: "../../other.ts" })] }, context);
  expect(result.findings).toHaveLength(1);
  const rendered = renderPrReview(result, context, "mars-pr-review:2:9:base:head");
  expect(rendered.body).toContain("<!-- mars-pr-review:2:9:base:head -->");
  expect(rendered.comments[0]!.body).toContain("60% confidence");
  expect(rendered.comments).toEqual([{ path: "src/example.ts", line: 2, side: "RIGHT", body: expect.stringContaining("```suggestion\nreturn value;\n```") }]);
  expect(rendered.comments[0]!.body).not.toContain("@team");
});

test("rejects mismatched replacement text and excludes deleted, generated, and unpatched sources", async () => {
  const excludedClient: PrReviewContextClient = {
    ...client,
    files: async () => [
      { filename: "src/example.ts", status: "modified", patch: null, previousFilename: null },
      { filename: "dist/generated.js", status: "modified", patch: "@@ -0,0 +1 @@\n+bad()", previousFilename: null },
      { filename: "old.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-old()", previousFilename: null },
    ],
  };
  const context = await collectPrReviewContext(excludedClient, "acme", "repo", { ...pr, changedFiles: 3 });
  expect(context.coverage.reviewableFiles).toBe(0);
  const replacement = finding({ suggestion: { startLine: 2, endLine: 2, originalText: "not the source", replacementText: "bad", rationale: "bad" } });
  expect(validatePrReviewFindings({ findings: [replacement] }, await collectPrReviewContext(client, "acme", "repo", pr)).findings[0]!.suggestion).toBeNull();
  const malformedFence = finding({ suggestion: { startLine: 2, endLine: 2, originalText: "throw new Error('broken');", replacementText: "```unexpected", rationale: "not a safe suggestion fence" } });
  expect(validatePrReviewFindings({ findings: [malformedFence] }, await collectPrReviewContext(client, "acme", "repo", pr)).findings[0]!.suggestion).toBeNull();
});
test("keeps validated evidence as summary-only when inline locations are unsupported", async () => {
  const context = await collectPrReviewContext(client, "acme", "repo", pr);
  const invalidLocation = finding({ line: 99, endLine: null });
  const summary = validatePrReviewFindings({ findings: [invalidLocation] }, context);
  expect(summary.findings).toHaveLength(1);
  expect(summary.findings[0]!.suggestion).toBeNull();
  const rendered = renderPrReview(summary, context, "marker");
  expect(rendered.comments).toEqual([]);
  expect(rendered.body).toContain("`src/example.ts`");
  expect(rendered.body).not.toContain("src/example.ts:99");
});

test("deleted-file evidence remains explanation-only and overlapping suggestions are both rejected", async () => {
  const deletedClient: PrReviewContextClient = {
    ...client,
    files: async () => [{ filename: "old.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-throw new Error('broken');", previousFilename: null }],
    source: async () => null,
  };
  const deletedContext = await collectPrReviewContext(deletedClient, "acme", "repo", { ...pr, changedFiles: 1 });
  const deletedFinding = finding({ path: "old.ts" });
  const summary = validatePrReviewFindings({ findings: [deletedFinding] }, deletedContext);
  expect(summary.findings).toHaveLength(1);
  expect(summary.findings[0]!.suggestion).toBeNull();
  expect(renderPrReview(summary, deletedContext, "marker").comments).toEqual([]);

  const context = await collectPrReviewContext(client, "acme", "repo", pr);
  const overlapping = validatePrReviewFindings({ findings: [
    finding({ impact: "First consequence." }),
    finding({ impact: "Second consequence." }),
  ] }, context);
  expect(overlapping.findings).toHaveLength(2);
  expect(overlapping.findings.map(item => item.suggestion)).toEqual([null, null]);
});
test("supports native multiline RIGHT comments and exact same-hunk suggestions", async () => {
  const multilineClient: PrReviewContextClient = {
    ...client,
    files: async () => [{ filename: "src/example.ts", status: "modified", previousFilename: null, patch: "@@ -0,0 +1,2 @@\n+const value = 1;\n+throw new Error('broken');" }],
    source: async () => ({ text: "const value = 1;\nthrow new Error('broken');\n", sha: "blob-head" }),
  };
  const context = await collectPrReviewContext(multilineClient, "acme", "repo", pr);
  const replacement = finding({
    line: 2,
    endLine: null,
    suggestion: { startLine: 1, endLine: 2, originalText: "const value = 1;\nthrow new Error('broken');", replacementText: "const value = 1;\nreturn value;", rationale: "Avoids throwing after computing the value." },
  });
  const rendered = renderPrReview({ findings: [replacement] }, context, "marker");
  expect(rendered.comments[0]).toMatchObject({ path: "src/example.ts", line: 2, start_line: 1, start_side: "RIGHT", side: "RIGHT" });
  expect(rendered.comments[0]!.body).toContain("```suggestion\nconst value = 1;\nreturn value;\n```");
});
test("bounds file count and per-file source context without claiming complete coverage", async () => {
  const files = Array.from({ length: 41 }, (_, index) => ({ filename: `src/file-${index}.ts`, status: "modified", patch: null, previousFilename: null }));
  const manyFiles: PrReviewContextClient = { ...client, files: async () => files };
  const bounded = await collectPrReviewContext(manyFiles, "acme", "repo", { ...pr, changedFiles: 41 });
  expect(bounded.files).toHaveLength(40);
  expect(bounded.coverage.omittedFiles).toBe(1);
  expect(bounded.coverage.complete).toBe(false);

  const oversizedSource: PrReviewContextClient = {
    ...client,
    files: async () => [{ filename: "src/example.ts", status: "modified", patch: "@@ -0,0 +1 @@\n+const value = 1;", previousFilename: null }],
    source: async () => ({ text: "x".repeat(32 * 1024 + 1), sha: "oversized" }),
  };
  const sourceLimited = await collectPrReviewContext(oversizedSource, "acme", "repo", pr);
  expect(sourceLimited.files[0]).toMatchObject({ coverage: "limited", headSource: null });
  expect(sourceLimited.coverage.complete).toBe(false);
});

test("fits by dropping description and nonreviewable metadata before whole reviewable files", async () => {
  const context = await collectPrReviewContext({
    ...client,
    files: async () => [
      { filename: "src/one.ts", status: "modified", patch: "@@ -0,0 +1 @@\n+one", previousFilename: null },
      { filename: "src/two.ts", status: "modified", patch: "@@ -0,0 +1 @@\n+two", previousFilename: null },
      { filename: "image.png", status: "modified", patch: null, previousFilename: null },
    ],
    source: async (_owner, _repo, path) => ({ text: `${path}\n${"x".repeat(400)}`, sha: "head" }),
  }, "acme", "repo", { ...pr, body: "long description", changedFiles: 3 });
  const before = structuredClone(context);
  const maxFiles = 2;
  const fitted = await fitPrReviewContext(context, async candidate =>
    candidate.pullRequest.description === null && candidate.files.length <= maxFiles);

  expect(fitted.pullRequest.description).toBeNull();
  expect(fitted.files.map(file => file.path)).toEqual(["src/one.ts", "src/two.ts"]);
  expect(fitted.files.every(file => file.patch && file.headSource)).toBe(true);
  expect(fitted.coverage).toMatchObject({ consideredFiles: 2, reviewableFiles: 2, omittedFiles: 1, complete: false });
  expect(fitted.coverage.limitations).toEqual(expect.arrayContaining([
    expect.stringContaining("description omitted"),
    expect.stringContaining("image.png"),
  ]));
  expect(context).toEqual(before);
});

test("rejects fitting when rules or the sole reviewable file cannot fit", async () => {
  const context = await collectPrReviewContext(client, "acme", "repo", pr);
  const original = structuredClone(context);
  await expect(fitPrReviewContext(context, async () => false)).rejects.toThrow("pr_review_context_too_large");
  expect(context).toEqual(original);
  expect(context.rules).toEqual(original.rules);
});

test("an entirely low-confidence result publishes no rejected finding or suggestion", async () => {
  const context = await collectPrReviewContext(client, "acme", "repo", pr);
  const rendered = renderPrReview({ findings: [finding({ confidencePercent: 59 })] }, context, "marker");
  expect(rendered.comments).toEqual([]);
  expect(rendered.body).toContain("No actionable findings in the reviewed scope.");
  expect(rendered.body).not.toContain("59%");
  expect(rendered.body).not.toContain("The operation always fails");
  expect(rendered.body).not.toContain("```suggestion");
});
