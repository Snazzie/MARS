import { expect, test } from "bun:test";
import { GithubRateLimitError, GithubRateLimitGate } from "./github-rate-limit.ts";

const RESET_SECONDS = 1_776_223_272;
const RESET_MS = RESET_SECONDS * 1_000;

test("blocks installation requests until GitHub's reset time", async () => {
  let now = RESET_MS - 60_000;
  let networkCalls = 0;
  const gate = new GithubRateLimitGate({ now: () => now, log: () => {} });
  const fetcher = gate.scopedFetch(42, "dispatch", async () => {
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
  const exhausted = gate.scopedFetch(42, "dispatch", async () => new Response(null, { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_SECONDS) } }));
  const healthy = gate.scopedFetch(43, "dispatch", async () => { installation43Calls += 1; return Response.json({ ok: true }); });

  await expect(exhausted("https://api.github.test")).rejects.toBeInstanceOf(GithubRateLimitError);
  expect((await healthy("https://api.github.test")).status).toBe(200);
  expect(installation43Calls).toBe(1);
});

test("returns a successful final response then blocks subsequent requests", async () => {
  let calls = 0;
  const gate = new GithubRateLimitGate({ now: () => RESET_MS - 1_000, log: () => {} });
  const fetcher = gate.scopedFetch(42, "dispatch", async () => {
    calls += 1;
    return Response.json({ ok: true }, { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_SECONDS) } });
  });

  expect((await fetcher("https://api.github.test")).status).toBe(200);
  await expect(fetcher("https://api.github.test")).rejects.toBeInstanceOf(GithubRateLimitError);
  expect(calls).toBe(1);
});

test("does not classify permission failures as rate limits", async () => {
  const gate = new GithubRateLimitGate({ now: () => RESET_MS - 1_000, log: () => {} });
  const response = await gate.scopedFetch(42, "dispatch", async () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }))("https://api.github.test");
  expect(response.status).toBe(403);
});

test("uses Retry-After for secondary limits without borrowing the primary reset", async () => {
  let now = RESET_MS;
  let calls = 0;
  const logs: string[] = [];
  const gate = new GithubRateLimitGate({ now: () => now, log: message => logs.push(message) });
  const fetcher = gate.scopedFetch(42, "dispatch", async () => {
    calls += 1;
    if (calls === 1) return Response.json({ message: "You have exceeded a secondary rate limit" }, { status: 403, headers: { "x-ratelimit-remaining": "10", "x-ratelimit-reset": String(RESET_SECONDS + 3600), "retry-after": "30" } });
    return Response.json({ ok: true });
  });

  await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ kind: "secondary", resetAt: RESET_MS + 30_000 });
  await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ kind: "secondary", resetAt: RESET_MS + 30_000 });
  expect(calls).toBe(1);
  expect(logs.some(message => message.includes("kind=secondary"))).toBe(true);

  now += 30_000;
  expect((await fetcher("https://api.github.test")).status).toBe(200);
  expect(calls).toBe(2);
});

test("classifies every 429 as rate limited and uses the secondary fallback", async () => {
  const now = RESET_MS;
  const gate = new GithubRateLimitGate({ now: () => now, log: () => {} });
  const fetcher = gate.scopedFetch(42, "dispatch", async () => new Response(null, {
    status: 429,
    headers: { "x-ratelimit-remaining": "10", "x-ratelimit-reset": String(RESET_SECONDS + 3600) },
  }));

  await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ kind: "secondary", resetAt: now + 60_000 });
});

test("falls back to a future primary cooldown when reset is absent or stale", async () => {
  let now = RESET_MS;
  const gate = new GithubRateLimitGate({ now: () => now, log: () => {} });
  const fetcher = gate.scopedFetch(42, "dispatch", async () => new Response(null, {
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_SECONDS - 3600) },
  }));

  await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ kind: "primary", resetAt: now + 1_000 });
  now += 1_000;
  await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ kind: "primary" });
});

test("falls back for an unrepresentable secondary Retry-After deadline", async () => {
  const now = RESET_MS;
  const gate = new GithubRateLimitGate({ now: () => now, log: () => {} });
  const fetcher = gate.scopedFetch(42, "dispatch", async () => new Response(null, {
    status: 429,
    headers: { "x-ratelimit-remaining": "10", "retry-after": "100000000000000000000" },
  }));

  await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ kind: "secondary", resetAt: now + 60_000 });
});

test("starts secondary Retry-After cooldown when the response arrives", async () => {
  let now = RESET_MS;
  const gate = new GithubRateLimitGate({ now: () => now, log: () => {} });
  const fetcher = gate.scopedFetch(42, "dispatch", async () => {
    now += 5_000;
    return new Response(null, { status: 429, headers: { "x-ratelimit-remaining": "10", "retry-after": "30" } });
  });
  await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ kind: "secondary", resetAt: RESET_MS + 35_000 });
});
test("reserves the final 100 primary requests for dispatch", async () => {
  let now = RESET_MS - 60_000;
  let calls = 0;
  const gate = new GithubRateLimitGate({ now: () => now, log: () => {} });
  const fetcher = gate.scopedFetch(42, "background", async () => {
    calls += 1;
    return new Response(null, { headers: { "x-ratelimit-remaining": "100", "x-ratelimit-reset": String(RESET_SECONDS) } });
  });
  await fetcher("https://api.github.test");
  await expect(fetcher("https://api.github.test")).rejects.toMatchObject({ kind: "reserved", resetAt: RESET_MS });
  expect(calls).toBe(1);
  const dispatch = gate.scopedFetch(42, "dispatch", async () => { calls += 1; return new Response(null, { headers: { "x-ratelimit-remaining": "99", "x-ratelimit-reset": String(RESET_SECONDS) } }); });
  await dispatch("https://api.github.test");
  expect(calls).toBe(2);
  now = RESET_MS;
  await fetcher("https://api.github.test");
  expect(calls).toBe(3);
});

test("preserves the last valid budget when later headers are missing or malformed", async () => {
  const gate = new GithubRateLimitGate({ now: () => RESET_MS - 60_000, log: () => {} });
  let calls = 0;
  const network = async () => {
    calls += 1;
    if (calls === 1) return new Response(null, { headers: { "x-ratelimit-remaining": "100", "x-ratelimit-reset": String(RESET_SECONDS) } });
    if (calls === 2) return new Response(null);
    return new Response(null, { headers: { "x-ratelimit-remaining": "invalid", "x-ratelimit-reset": "invalid" } });
  };
  const background = gate.scopedFetch(42, "background", network);
  const dispatch = gate.scopedFetch(42, "dispatch", network);

  await background("https://api.github.test");
  await dispatch("https://api.github.test");
  await dispatch("https://api.github.test");
  await expect(background("https://api.github.test")).rejects.toMatchObject({ kind: "reserved", resetAt: RESET_MS });
  expect(calls).toBe(3);
});

test("counts requests that started before the installation budget was learned", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const gate = new GithubRateLimitGate({ now: () => RESET_MS - 60_000, log: () => {} });
  let calls = 0;
  const slow = gate.scopedFetch(42, "background", async () => {
    calls += 1;
    await pending;
    return new Response(null, { headers: { "x-ratelimit-remaining": "100", "x-ratelimit-reset": String(RESET_SECONDS) } });
  });
  const learning = gate.scopedFetch(42, "background", async () => {
    calls += 1;
    return new Response(null, { headers: { "x-ratelimit-remaining": "101", "x-ratelimit-reset": String(RESET_SECONDS) } });
  });
  const pendingRequest = slow("https://api.github.test");
  await Promise.resolve();
  await learning("https://api.github.test");
  await expect(learning("https://api.github.test")).rejects.toMatchObject({ kind: "reserved" });
  release();
  await pendingRequest;
  expect(calls).toBe(2);
});

test("logs reserve entry once per installation reset window", async () => {
  const logs: string[] = [];
  const gate = new GithubRateLimitGate({ now: () => RESET_MS - 60_000, log: message => logs.push(message) });
  const background = gate.scopedFetch(42, "background", async () => new Response(null, {
    headers: { "x-ratelimit-remaining": "100", "x-ratelimit-reset": String(RESET_SECONDS) },
  }));

  await background("https://api.github.test");
  expect(gate.isBackgroundBlocked(42)).toBe(true);
  expect(gate.isBackgroundBlocked(42)).toBe(true);
  await expect(background("https://api.github.test")).rejects.toMatchObject({ kind: "reserved" });
  expect(logs.filter(message => message.includes("rate limit reserve"))).toHaveLength(1);
});

test("zero remaining hard-blocks background and dispatch requests", async () => {
  const gate = new GithubRateLimitGate({ now: () => RESET_MS - 60_000, log: () => {} });
  const exhaust = gate.scopedFetch(42, "dispatch", async () => new Response(null, {
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET_SECONDS) },
  }));
  await exhaust("https://api.github.test");

  const unexpectedNetwork = async () => { throw new Error("unexpected_network_call"); };
  await expect(gate.scopedFetch(42, "background", unexpectedNetwork)("https://api.github.test")).rejects.toMatchObject({ kind: "primary" });
  await expect(gate.scopedFetch(42, "dispatch", unexpectedNetwork)("https://api.github.test")).rejects.toMatchObject({ kind: "primary" });
});
