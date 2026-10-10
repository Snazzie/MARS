import { expect, test } from "bun:test";
import { GithubPrReviewClient } from "./github-pr-review.ts";
import { parsePrReviewEvent } from "./pr-review-webhook.ts";


test("source fetch returns null only for missing content and bounds decoded bytes", async () => {
  const missing = new GithubPrReviewClient(async () => "token", async () => new Response(null, { status: 404 }));
  const sha = "a".repeat(40);
  await expect(missing.source("acme", "repo", "missing.ts", sha)).resolves.toBeNull();
  const oversized = new GithubPrReviewClient(async () => "token", async () => Response.json({ type: "file", encoding: "base64", content: Buffer.from("x".repeat(1024 * 1024 + 1)).toString("base64"), sha: "blob" }));
  await expect(oversized.source("acme", "repo", "large.ts", sha)).rejects.toThrow("github_source_too_large");
});

test("bounds GitHub JSON responses and treats missing collaborator permission as none", async () => {
  const oversized = new GithubPrReviewClient(async () => "token", async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { headers: { "content-length": String(2 * 1024 * 1024 + 1) } }));
  await expect(oversized.getPullRequest("acme", "repo", 3)).rejects.toThrow("github_response_too_large");
  const missing = new GithubPrReviewClient(async () => "token", async () => new Response(null, { status: 404 }));
  await expect(missing.permission("acme", "repo", "outsider")).resolves.toBe("none");
});

test("parses only exact standalone PR conversation /review commands from humans", () => {
  const base = { installation: { id: 5 }, repository: { id: 7 }, action: "created", issue: { number: 3, pull_request: { url: "https://api.github.com/repos/acme/repo/pulls/3" } }, comment: { id: 11, body: "  /review \n", user: { login: "octocat", type: "User" } } };
  expect(parsePrReviewEvent("issue_comment", base)).toEqual({ installationId: 5, githubRepositoryId: 7, prNumber: 3, trigger: "review_command", commentId: 11, requester: "octocat" });
  for (const body of ["Please /review", "`/review`", "/review now", "```\n/review\n```", ""]) expect(parsePrReviewEvent("issue_comment", { ...base, comment: { ...base.comment, body } })).toBeNull();
  expect(parsePrReviewEvent("issue_comment", { ...base, comment: { ...base.comment, user: { login: "mars[bot]", type: "Bot" } } })).toBeNull();
  expect(parsePrReviewEvent("issue_comment", { ...base, issue: { number: 3 } })).toBeNull();
});

test("parses only supported pull request trigger actions", () => {
  const payload = { installation: { id: 5 }, repository: { id: 7 }, action: "synchronize", pull_request: { number: 3 } };
  expect(parsePrReviewEvent("pull_request", payload)).toEqual({ installationId: 5, githubRepositoryId: 7, prNumber: 3, trigger: "synchronize" });
  expect(parsePrReviewEvent("pull_request", { ...payload, action: "edited" })).toBeNull();
});

test("recovers native reviews using the app bot user identity when app metadata is absent", async () => {
  const requests: Request[] = [];
  const client = new GithubPrReviewClient(async () => "installation-token", async (input, init) => {
    requests.push(new Request(input, init));
    if (String(input).endsWith("/users/mars%5Bbot%5D")) return Response.json({ id: 42, login: "mars[bot]", type: "Bot" });
    return Response.json([{ id: 18, body: "summary <!-- marker -->", commit_id: "a".repeat(40), user: { id: 42, login: "mars[bot]", type: "Bot" } }]);
  });
  await expect(client.getAppBotIdentity("mars")).resolves.toEqual({ id: 42, login: "mars[bot]" });
  await expect(client.reviews("acme", "repo", 3)).resolves.toEqual([{ id: 18, body: "summary <!-- marker -->", commitId: "a".repeat(40), appId: null, userId: 42, userLogin: "mars[bot]" }]);
  expect(requests).toHaveLength(2);
});
