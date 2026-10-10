import { expect, spyOn, test } from "bun:test";
import { createDb, getAiTokenUsage, schema, type DatabaseClient } from "@mars/db";
import { eq } from "drizzle-orm";
import { SecretBox } from "./auth.ts";
import { handlePrReviewWebhook, processPrReviews, type PrReviewDeps } from "./pr-review.ts";
import { collectPrReviewContext } from "./pr-review-context.ts";
import { GithubPrReviewClient } from "./github-pr-review.ts";
import { createControlPlaneApp } from "./http/app.ts";
import { fakeHttpDeps } from "./http/test-deps.ts";

const integration = Bun.env.MARS_E2E_DATABASE_URL ? test : test.skip;
const organizationId = "11000000-0000-4000-8000-000000000001";
const repositoryId = "22000000-0000-4000-8000-000000000001";
const installationId = "33000000-0000-4000-8000-000000000001";
const providerId = "44000000-0000-4000-8000-000000000001";
const base = "a".repeat(40), head = "b".repeat(40);
async function fixture(work: (db: DatabaseClient) => Promise<void>) {
  const db = createDb(Bun.env.MARS_E2E_DATABASE_URL!);
  try {
    await db.transaction(async tx => {
      for (const table of ["dashboard_installations", "dashboard_repositories", "llm_providers", "repository_pr_review_settings", "pr_reviews", "pr_review_commands", "pipeline_failure_analyses"]) await tx.$client.unsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING INDEXES INCLUDING CONSTRAINTS) ON COMMIT DROP`);
      await tx.insert(schema.dashboardInstallations).values({ id: installationId, organizationId, githubInstallationId: 99, state: "approved" });
      await tx.insert(schema.dashboardRepositories).values({ id: repositoryId, organizationId, installationId, githubRepositoryId: 88, name: "repo", fullName: "acme/repo", available: true });
      await tx.insert(schema.llmProviders).values({ id: providerId, name: "review", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "test", inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 });
      await tx.insert(schema.repositoryPrReviewSettings).values({ organizationId, repositoryId, providerId, enabled: true, enabledSince: "2026-10-09T00:00:00Z" });
      await work(tx);
    });
  } finally { await db.$client.end({ timeout: 1 }); }
}
function scenario(db: DatabaseClient) {
  const observed = { modelCalls: 0, posts: [] as Record<string, unknown>[], remote: [] as Record<string, unknown>[], head, base, draft: false, state: "open", permission: "write", loseResponse: false };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/permission")) return Response.json({ permission: observed.permission });
    if (url.pathname.endsWith("/pulls/7")) return Response.json({ number: 7, state: observed.state, draft: observed.draft, title: "Fix division", body: "Untrusted PR text", changed_files: 1, base: { sha: observed.base }, head: { sha: observed.head } });
    if (url.pathname.endsWith("/files")) return Response.json([{ filename: "calc.ts", status: "modified", patch: "@@ -1 +1 @@\n-return n / d;\n+return n / 0;" }]);
    if (url.pathname.includes("/contents/")) {
      if (url.pathname.endsWith("/.mars/pr-rules.md")) { expect(url.searchParams.get("ref")).toBe(observed.base); return new Response(null, { status: 404 }); }
      return Response.json({ type: "file", encoding: "base64", sha: "c".repeat(40), content: Buffer.from("return n / 0;\n").toString("base64") });
    }
    if (url.pathname.endsWith("/reviews")) {
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body)); observed.posts.push(payload);
        observed.remote.push({ id: 123, body: payload.body, commit_id: payload.commit_id, performed_via_github_app: { id: 42 }, html_url: "https://github.com/acme/repo/pull/7#pullrequestreview-123" });
        if (observed.loseResponse) throw new Error("lost response");
        return Response.json(observed.remote[0]);
      }
      return Response.json(observed.remote);
    }
    throw new Error(`Unexpected GitHub route ${url.pathname}`);
  }) as typeof fetch;
  const deps: PrReviewDeps = {
    db, githubAppId: 42, secretBox: new SecretBox(Buffer.alloc(32, 5).toString("base64")), installationToken: async () => "installation-token", githubFetch: fetcher,
    providerConfig: async () => ({ id: providerId, name: "review", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "test" }),
    generate: async () => {
      observed.modelCalls++;
      return { findings: [{ path: "calc.ts", line: 1, endLine: null, severity: "High", confidencePercent: 85, evidence: "return n / 0;", impact: "Every call divides by zero instead of the denominator.", correction: "Use d as denominator.", suggestion: { startLine: 1, endLine: 1, originalText: "return n / 0;", replacementText: "return n / d;", rationale: "Uses the caller denominator." } }] };
    },
  };
  const event = { action: "created", installation: { id: 99 }, repository: { id: 88 }, issue: { number: 7, pull_request: { url: "ignored" } }, comment: { id: 50, body: " /review\n", user: { login: "writer", type: "User" } }, sender: { login: "writer", type: "User" } };
  return { observed, deps, event };
}

integration("authorized commands reuse current revision and publish one pinned native batch", () => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  await handlePrReviewWebhook(deps, "issue_comment", event, "first");
  await handlePrReviewWebhook(deps, "issue_comment", event, "replay");
  await handlePrReviewWebhook(deps, "issue_comment", { ...event, comment: { ...event.comment, id: 51 } }, "second");
  expect(await db.select().from(schema.prReviews)).toHaveLength(1);
  await processPrReviews(deps);
  await handlePrReviewWebhook(deps, "issue_comment", { ...event, comment: { ...event.comment, id: 52 } }, "third");
  await processPrReviews(deps);
  expect(observed.modelCalls).toBe(1);
  expect(observed.posts).toHaveLength(1);
  expect(observed.posts[0]).toMatchObject({ event: "COMMENT", commit_id: head, comments: [{ path: "calc.ts", line: 1, side: "RIGHT" }] });
  expect(JSON.stringify(observed.posts[0])).toContain("85% confidence");
  expect(JSON.stringify(observed.posts[0])).toContain("suggestion");
  const [row] = await db.select().from(schema.prReviews);
  expect(row).toMatchObject({ analysisState: "completed", publicationState: "published", headSha: head });
}));

integration.each(["disabled", "unavailable", "unapproved", "draft", "closed", "unauthorized"])("%s commands cannot call provider or publish", mode => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  if (mode === "disabled") await db.update(schema.repositoryPrReviewSettings).set({ enabled: false });
  if (mode === "unavailable") await db.update(schema.dashboardRepositories).set({ available: false });
  if (mode === "unapproved") await db.update(schema.dashboardInstallations).set({ state: "pending" });
  if (mode === "draft") observed.draft = true;
  if (mode === "closed") observed.state = "closed";
  if (mode === "unauthorized") observed.permission = "read";
  await handlePrReviewWebhook(deps, "issue_comment", event, mode);
  await processPrReviews(deps);
  expect(observed.modelCalls).toBe(0); expect(observed.posts).toEqual([]);
}));

integration.each(["push", "base", "draft", "close", "disable", "provider"])("%s during generation prevents stale publication", mode => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  await handlePrReviewWebhook(deps, "issue_comment", event, "initial");
  const generate = deps.generate!;
  deps.generate = async (...args) => {
    const result = await generate(...args);
    if (mode === "push") observed.head = "d".repeat(40);
    if (mode === "base") observed.base = "e".repeat(40);
    if (mode === "draft") observed.draft = true;
    if (mode === "close") observed.state = "closed";
    if (mode === "disable") await db.update(schema.repositoryPrReviewSettings).set({ enabled: false });
    if (mode === "provider") await db.update(schema.llmProviders).set({ model: "new-model" });
    return result;
  };
  await processPrReviews(deps);
  expect(observed.modelCalls).toBe(1); expect(observed.posts).toEqual([]);
  const [row] = await db.select().from(schema.prReviews);
  expect(["skipped", "superseded"]).toContain(row.analysisState);
}));

integration("lost publication response reconciles app marker without another POST or model call", () => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  observed.loseResponse = true;
  await handlePrReviewWebhook(deps, "issue_comment", event, "initial");
  await processPrReviews(deps);
  expect((await db.select().from(schema.prReviews))[0].publicationState).toBe("unknown");
  await processPrReviews(deps);
  expect((await db.select().from(schema.prReviews))[0].publicationState).toBe("published");
  expect(observed.modelCalls).toBe(1); expect(observed.posts).toHaveLength(1);
}));

integration("failed publication state writes retain unknown outcome and recover without reposting", () => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  await handlePrReviewWebhook(deps, "issue_comment", event, "initial");
  const unsafe = db.$client.unsafe.bind(db.$client);
  let failedWrites = 0;
  const writes = spyOn(db.$client, "unsafe").mockImplementation((query, parameters, options) => {
    if (query.startsWith('update "pr_reviews"') && query.includes('"review_id"') && (parameters?.includes("published") || parameters?.includes("unknown")) && failedWrites < 2) {
      failedWrites++;
      throw new Error("publication state write unavailable");
    }
    return unsafe(query, parameters, options);
  });
  try {
    await processPrReviews(deps);
    expect((await db.select().from(schema.prReviews))[0]).toMatchObject({ publicationState: "unknown", errorCode: "github_post_outcome_unknown" });
    await processPrReviews(deps);
    expect((await db.select().from(schema.prReviews))[0].publicationState).toBe("published");
    expect(observed.modelCalls).toBe(1);
    expect(observed.posts).toHaveLength(1);
  } finally { writes.mockRestore(); }
}));

integration("out-of-order event payload cannot resurrect an older head and command replay cannot review a new revision", () => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  await handlePrReviewWebhook(deps, "issue_comment", event, "initial");
  observed.head = "d".repeat(40);
  const push = { action: "synchronize", installation: event.installation, repository: event.repository, number: 7, pull_request: { number: 7, head: { sha: head }, base: { sha: base } } };
  await handlePrReviewWebhook(deps, "pull_request", push, "older-payload");
  await handlePrReviewWebhook(deps, "issue_comment", event, "command-replay");
  const rows = await db.select().from(schema.prReviews);
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.headSha === head)?.analysisState).toBe("superseded");
  expect(rows.find(row => row.headSha === observed.head)?.analysisState).toBe("pending");
  await processPrReviews(deps);
  expect(observed.modelCalls).toBe(1); expect(observed.posts[0].commit_id).toBe(observed.head);
}));

integration("interrupted analysis fails visibly without model spend", () => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  await handlePrReviewWebhook(deps, "issue_comment", event, "initial");
  await db.update(schema.prReviews).set({ analysisState: "running", startedAt: "2020-01-01T00:00:00Z" });
  await processPrReviews(deps);
  expect((await db.select().from(schema.prReviews))[0]).toMatchObject({ analysisState: "failed", errorCode: "pr_review_interrupted" });
  expect(observed.modelCalls).toBe(0); expect(observed.posts).toEqual([]);
}));

integration("persisted generated results recover publication without another provider request", () => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  await handlePrReviewWebhook(deps, "issue_comment", event, "initial");
  const client = new GithubPrReviewClient(() => deps.installationToken(99), deps.githubFetch);
  const pr = await client.getPullRequest("acme", "repo", 7);
  const context = await collectPrReviewContext(client, "acme", "repo", pr);
  const result = await deps.generate!({ provider: await deps.providerConfig(providerId), context });
  await db.update(schema.prReviews).set({ source: context, result, analysisState: "completed", completedAt: new Date().toISOString() });
  await processPrReviews(deps);
  expect(observed.modelCalls).toBe(1); expect(observed.posts).toHaveLength(1);
  expect((await db.select().from(schema.prReviews))[0].publicationState).toBe("published");
}));

integration("provider failures remain failures, never clean reviews", () => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  await handlePrReviewWebhook(deps, "issue_comment", event, "initial");
  deps.generate = async () => { throw new Error("llm_auth_failed"); };
  await processPrReviews(deps);
  expect(observed.posts).toEqual([]);
  expect((await db.select().from(schema.prReviews))[0]).toMatchObject({ analysisState: "failed", errorCode: "llm_auth_failed", result: null });
}));

integration("rules-loading errors retain failed provenance and never call provider", () => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  const fetcher = deps.githubFetch!;
  deps.githubFetch = (async (input, init) => new URL(String(input)).pathname.endsWith("/.mars/pr-rules.md") ? new Response(null, { status: 403 }) : fetcher(input, init)) as typeof fetch;
  await handlePrReviewWebhook(deps, "issue_comment", event, "initial");
  await processPrReviews(deps);
  expect(observed.modelCalls).toBe(0); expect(observed.posts).toEqual([]);
  expect((await db.select().from(schema.prReviews))[0]).toMatchObject({ analysisState: "failed", errorCode: "github_app_permissions_missing", source: { rules: { status: "failed", baseSha: base } } });
}));

integration("reconciliation ignores copied markers from another App or commit", () => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  observed.loseResponse = true;
  await handlePrReviewWebhook(deps, "issue_comment", event, "initial");
  await processPrReviews(deps);
  observed.remote[0].performed_via_github_app = { id: 777 };
  await processPrReviews(deps);
  expect((await db.select().from(schema.prReviews))[0].publicationState).toBe("unknown");
  observed.remote[0].performed_via_github_app = { id: 42 };
  observed.remote[0].commit_id = "f".repeat(40);
  await processPrReviews(deps);
  expect((await db.select().from(schema.prReviews))[0].publicationState).toBe("unknown");
  expect(observed.modelCalls).toBe(1); expect(observed.posts).toHaveLength(1);
}));

integration("independent PostgreSQL connections claim one revision once", async () => {
  const db = createDb(Bun.env.MARS_E2E_DATABASE_URL!), other = createDb(Bun.env.MARS_E2E_DATABASE_URL!);
  const orgId = crypto.randomUUID(), repoId = crypto.randomUUID(), installId = crypto.randomUUID(), profileId = crypto.randomUUID();
  const githubId = Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000;
  let ownsOrganization = false, ownsProvider = false;
  try {
    await db.insert(schema.organizations).values({ id: orgId, githubOrgId: githubId, login: `pr-review-test-${orgId}` });
    ownsOrganization = true;
    await db.insert(schema.dashboardInstallations).values({ id: installId, organizationId: orgId, githubInstallationId: githubId, state: "approved" });
    await db.insert(schema.dashboardRepositories).values({ id: repoId, organizationId: orgId, installationId: installId, githubRepositoryId: githubId, name: "repo", fullName: "acme/repo", available: true });
    await db.insert(schema.llmProviders).values({ id: profileId, name: "concurrency", kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "test" });
    ownsProvider = true;
    await db.insert(schema.repositoryPrReviewSettings).values({ organizationId: orgId, repositoryId: repoId, providerId: profileId, enabled: true, enabledSince: "2026-10-09T00:00:00Z" });
    const { deps, observed, event } = scenario(db);
    const command = { ...event, installation: { id: githubId }, repository: { id: githubId } };
    await Promise.all([
      handlePrReviewWebhook(deps, "issue_comment", command, "concurrent-delivery-a"),
      handlePrReviewWebhook({ ...deps, db: other }, "issue_comment", command, "concurrent-delivery-b"),
    ]);
    expect(await db.select().from(schema.prReviews).where(eq(schema.prReviews.repositoryId, repoId))).toHaveLength(1);
    await Promise.all([processPrReviews(deps), processPrReviews({ ...deps, db: other })]);
    expect(observed.modelCalls).toBe(1); expect(observed.posts).toHaveLength(1);
    expect((await db.select().from(schema.prReviews).where(eq(schema.prReviews.repositoryId, repoId)))[0].publicationState).toBe("published");
  } finally {
    if (ownsOrganization) await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
    if (ownsProvider) await db.delete(schema.llmProviders).where(eq(schema.llmProviders.id, profileId));
    await db.$client.end({ timeout: 1 }); await other.$client.end({ timeout: 1 });
  }
});

integration("native user-only review responses reconcile using verified App bot identity", () => fixture(async db => {
  const { deps, observed, event } = scenario(db);
  deps.githubAppSlug = "mars";
  const fetcher = deps.githubFetch!;
  deps.githubFetch = (async (input, init) => String(input).includes("/users/") ? Response.json({ id: 42, login: "mars[bot]", type: "Bot" }) : fetcher(input, init)) as typeof fetch;
  observed.loseResponse = true;
  await handlePrReviewWebhook(deps, "issue_comment", event, "initial");
  await processPrReviews(deps);
  delete observed.remote[0].performed_via_github_app;
  observed.remote[0].user = { id: 42, login: "mars[bot]", type: "Bot" };
  await processPrReviews(deps);
  expect((await db.select().from(schema.prReviews))[0].publicationState).toBe("published");
  expect(observed.modelCalls).toBe(1); expect(observed.posts).toHaveLength(1);
}));

integration("settings and review results enforce repository ownership in PostgreSQL", () => fixture(async db => {
  const endpoint = createControlPlaneApp(fakeHttpDeps({ db, currentUser: async () => ({ id: "admin", githubUserId: 1, login: "admin", isGlobalAdmin: true }) }));
  const owned = `/api/organizations/${organizationId}/repositories/${repositoryId}/pr-review`;
  const foreign = `/api/organizations/11000000-0000-4000-8000-000000000099/repositories/${repositoryId}/pr-review`;
  expect((await endpoint.request(owned)).status).toBe(200);
  expect((await endpoint.request(foreign)).status).toBe(404);
  expect((await endpoint.request(`${foreign}/latest`)).status).toBe(404);
  expect((await endpoint.request(foreign, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false, providerId: null }) })).status).toBe(404);
  const saved = await endpoint.request(owned, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false, providerId }) });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ organizationId, repositoryId, enabled: false, providerId });
  expect((await db.select().from(schema.repositoryPrReviewSettings))[0].enabled).toBe(false);
}));

integration("historical PR and CI usage share the inclusive 30-day UTC window", () => fixture(async db => {
  const now = new Date("2026-10-07T15:00:00Z");
  await db.insert(schema.pipelineFailureAnalyses).values({
    organizationId, repositoryId, runId: repositoryId, githubRunId: 812, runAttempt: 1,
    providerId, providerKind: "openai-compatible", providerName: "review", model: "test",
    source: {}, state: "failed", providerCalledAt: "2026-09-08T00:00:00Z",
    inputTokens: 1_000_000, outputTokens: 100_000, inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 10,
  });
  await db.insert(schema.prReviews).values([
    { organizationId, repositoryId, prNumber: 7, baseSha: base, headSha: head, trigger: "opened", providerSnapshot: {}, source: {}, settingsUpdatedAt: "2026-09-01T00:00:00Z", analysisState: "failed", providerCalledAt: "2026-09-08T00:00:00Z", inputTokens: 1_000_000, outputTokens: 1_000_000, estimatedCostUsd: 3 },
    { organizationId, repositoryId, prNumber: 8, baseSha: base, headSha: head, trigger: "opened", providerSnapshot: {}, source: {}, settingsUpdatedAt: "2026-09-01T00:00:00Z", analysisState: "failed", providerCalledAt: "2026-09-07T23:59:59Z", inputTokens: 1_000_000, outputTokens: 1_000_000, estimatedCostUsd: 999 },
  ]);
  const usage = await getAiTokenUsage(db, now);
  expect(usage).toMatchObject({ inputTokens: 2_000_000, outputTokens: 1_100_000, reportedRequests: 2, unreportedRequests: 0, estimatedCostUsd: 6 });
  expect(usage.points[0]).toEqual({ date: "2026-09-08", inputTokens: 2_000_000, outputTokens: 1_100_000, estimatedCostUsd: 6 });
  expect(usage.points.at(-1)).toEqual({ date: "2026-10-07", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
}));
