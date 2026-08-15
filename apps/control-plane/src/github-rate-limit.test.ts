import { expect, test } from "bun:test";
import { GithubRateLimitError, GithubRateLimitGate } from "./github-rate-limit.ts";

const RESET_SECONDS = 1_776_223_272;
const RESET_MS = RESET_SECONDS * 1_000;

test("blocks installation requests until GitHub's reset time", async () => {
  let now = RESET_MS - 60_000;
  let networkCalls = 0;
  const gate = new GithubRateLimitGate({ now: () => now, log: () => {} });
  const fetcher = gate.scopedFetch(42, async () => {
    networkCalls += 1;
    return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_SECONDS) } });
  });

  await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ code: "github_rate_limited", installationId: 42, resetAt: RESET_MS });
  await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ code: "github_rate_limited" });
  expect(networkCalls).toBe(1);

  now = RESET_MS;
  await expect(fetcher("https://api.github.test")).rejects.toBeInstanceOf(GithubRateLimitError);
  expect(networkCalls).toBe(2);
});

test("keeps installation cooldowns independent", async () => {
  const gate = new GithubRateLimitGate({ now: () => RESET_MS - 1_000, log: () => {} });
  let installation43Calls = 0;
  const exhausted = gate.scopedFetch(42, async () => new Response(null, { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_SECONDS) } }));
  const healthy = gate.scopedFetch(43, async () => { installation43Calls += 1; return Response.json({ ok: true }); });

  await expect(exhausted("https://api.github.test")).rejects.toBeInstanceOf(GithubRateLimitError);
  expect((await healthy("https://api.github.test")).status).toBe(200);
  expect(installation43Calls).toBe(1);
});

test("returns a successful final response then blocks subsequent requests", async () => {
  let calls = 0;
  const gate = new GithubRateLimitGate({ now: () => RESET_MS - 1_000, log: () => {} });
  const fetcher = gate.scopedFetch(42, async () => {
    calls += 1;
    return Response.json({ ok: true }, { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_SECONDS) } });
  });

  expect((await fetcher("https://api.github.test")).status).toBe(200);
  await expect(fetcher("https://api.github.test")).rejects.toBeInstanceOf(GithubRateLimitError);
  expect(calls).toBe(1);
});

test("does not classify permission failures as rate limits", async () => {
  const gate = new GithubRateLimitGate({ now: () => RESET_MS - 1_000, log: () => {} });
  const response = await gate.scopedFetch(42, async () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }))("https://api.github.test");
  expect(response.status).toBe(403);
});
