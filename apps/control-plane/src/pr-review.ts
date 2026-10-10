import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
import { PrReviewResult } from "@mars/contracts";
import type { SecretBox } from "./auth.ts";
import { GithubPrReviewClient } from "./github-pr-review.ts";
import { parsePrReviewEvent } from "./pr-review-webhook.ts";
import { collectPrReviewContext, renderPrReview, validatePrReviewFindings, PrReviewRulesError, type PrReviewContext } from "./pr-review-context.ts";
import { generatePrReview, type LlmProviderConfig, type PipelineAnalysisUsage } from "./llm-providers.ts";

const queries = defineQueries(db => {
  const a = schema.prReviews, r = schema.dashboardRepositories, i = schema.dashboardInstallations;
  const s = schema.repositoryPrReviewSettings, p = schema.llmProviders, placeholder = sql.placeholder;
  const g = schema.globalPrReviewSettings;
  const providerId = sql<string | null>`CASE WHEN ${g.enableAll} THEN ${g.providerId} ELSE ${s.providerId} END`;
  const fields = { repositoryId: r.id, organizationId: r.organizationId, githubRepositoryId: r.githubRepositoryId, fullName: r.fullName, available: r.available, installationId: i.githubInstallationId, installState: i.state,
    enabled: sql<boolean>`COALESCE(${g.enableAll}, false) OR COALESCE(${s.enabled}, false)`, providerId,
    enabledSince: sql<string | null>`CASE WHEN ${g.enableAll} THEN LEAST(CASE WHEN ${s.enabled} THEN ${s.enabledSince} END, ${g.enabledSince}) ELSE ${s.enabledSince} END`,
    settingsUpdatedAt: sql<string | null>`CASE WHEN ${g.enableAll} THEN ${g.updatedAt} ELSE ${s.updatedAt} END`, provider: p };
  const repository = () => db.select(fields).from(r)
    .innerJoin(i, and(eq(i.id, r.installationId), eq(i.organizationId, r.organizationId)))
    .leftJoin(s, and(eq(s.repositoryId, r.id), eq(s.organizationId, r.organizationId)))
    .leftJoin(g, eq(g.singleton, true)).leftJoin(p, eq(p.id, providerId));
  return {
    delivery: db.select({ receivedAt: schema.webhookDeliveries.receivedAt }).from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.deliveryId, placeholder("deliveryId"))).limit(1).prepare("pr_review_delivery"),
    repository: repository().where(and(eq(r.githubRepositoryId, placeholder("githubRepositoryId")), eq(i.githubInstallationId, placeholder("installationId")))).limit(1).prepare("pr_review_repository"),
    repositoryById: repository().where(eq(r.id, placeholder("repositoryId"))).limit(1).prepare("pr_review_repository_by_id"),
    lockRepository: db.select({ id: r.id }).from(r).where(eq(r.id, placeholder("repositoryId"))).for("update").prepare("pr_review_lock_repository"),
    command: db.insert(schema.prReviewCommands).values({ organizationId: placeholder("organizationId"), repositoryId: placeholder("repositoryId"), commentId: placeholder("commentId"), requester: placeholder("requester") }).onConflictDoNothing().returning({ commentId: schema.prReviewCommands.commentId }).prepare("pr_review_command"),
    enqueue: db.insert(a).values({ organizationId: placeholder("organizationId"), repositoryId: placeholder("repositoryId"), prNumber: placeholder("prNumber"), baseSha: placeholder("baseSha"), headSha: placeholder("headSha"), trigger: placeholder("trigger"), commentId: placeholder("commentId"), requester: placeholder("requester"), providerId: placeholder("providerId"), providerSnapshot: placeholder("providerSnapshot"), settingsUpdatedAt: placeholder("settingsUpdatedAt"), analysisState: "pending", publicationState: "pending", source: placeholder("source") }).onConflictDoNothing().returning({ id: a.id }).prepare("pr_review_enqueue"),
    retry: db.update(a).set({ analysisState: "pending", createdAt: sql`now()`, trigger: sql`${placeholder("trigger")}`, commentId: sql`${placeholder("commentId")}`, requester: sql`${placeholder("requester")}`, providerId: sql`${placeholder("providerId")}`, providerSnapshot: sql`${placeholder("retryProviderSnapshot")}::jsonb`, settingsUpdatedAt: sql`${placeholder("settingsUpdatedAt")}`, source: sql`${placeholder("retrySource")}::jsonb`, result: null, errorCode: null, startedAt: null, completedAt: null, providerCalledAt: null, inputTokens: null, outputTokens: null, tokensPerSecond: null, estimatedCostUsd: null }).where(and(eq(a.organizationId, placeholder("organizationId")), eq(a.repositoryId, placeholder("repositoryId")), eq(a.prNumber, placeholder("prNumber")), eq(a.baseSha, placeholder("baseSha")), eq(a.headSha, placeholder("headSha")), inArray(a.analysisState, ["failed", "skipped", "superseded"]), eq(a.publicationState, "pending"))).returning({ id: a.id }).prepare("pr_review_retry"),
    supersede: db.update(a).set({ analysisState: "superseded", errorCode: "pr_review_superseded", completedAt: sql`now()` }).where(and(eq(a.repositoryId, placeholder("repositoryId")), eq(a.prNumber, placeholder("prNumber")), inArray(a.analysisState, ["pending", "running"]), or(ne(a.baseSha, placeholder("baseSha")), ne(a.headSha, placeholder("headSha"))))).prepare("pr_review_supersede"),
    invalidate: db.update(a).set({ analysisState: "skipped", errorCode: "pr_review_closed_or_draft", completedAt: sql`now()` }).where(and(eq(a.repositoryId, placeholder("repositoryId")), eq(a.prNumber, placeholder("prNumber")), inArray(a.analysisState, ["pending", "running"]))).prepare("pr_review_invalidate"),
    interruptedAnalysis: db.update(a).set({ analysisState: "failed", errorCode: "pr_review_interrupted", completedAt: sql`now()` }).where(and(eq(a.analysisState, "running"), sql`${a.startedAt}<now()-interval '15 minutes'`)).prepare("pr_review_interrupted_analysis"),
    interruptedPublication: db.update(a).set({ publicationState: "unknown", errorCode: "github_post_outcome_unknown" }).where(and(eq(a.publicationState, "publishing"), sql`${a.publicationStartedAt}<now()-interval '5 minutes'`)).prepare("pr_review_interrupted_publication"),
    claim: db.select().from(a).where(eq(a.analysisState, "pending")).orderBy(asc(a.createdAt)).limit(1).for("update", { skipLocked: true }).prepare("pr_review_claim"),
    start: db.update(a).set({ analysisState: "running", startedAt: sql`now()` }).where(and(eq(a.id, placeholder("id")), eq(a.analysisState, "pending"))).returning().prepare("pr_review_start"),
    load: db.select().from(a).where(eq(a.id, placeholder("id"))).limit(1).prepare("pr_review_load"),
    source: db.update(a).set({ source: placeholder("source") }).where(and(eq(a.id, placeholder("id")), eq(a.analysisState, "running"))).prepare("pr_review_source"),
    called: db.update(a).set({ providerCalledAt: sql`now()` }).where(and(eq(a.id, placeholder("id")), eq(a.analysisState, "running"))).prepare("pr_review_called"),
    usage: db.update(a).set({ inputTokens: sql`${placeholder("inputTokens")}`, outputTokens: sql`${placeholder("outputTokens")}`, tokensPerSecond: sql`${placeholder("tokensPerSecond")}`, estimatedCostUsd: sql`${placeholder("estimatedCostUsd")}` }).where(eq(a.id, placeholder("id"))).prepare("pr_review_usage"),
    complete: db.update(a).set({ analysisState: "completed", result: placeholder("result"), completedAt: sql`now()`, errorCode: null }).where(and(eq(a.id, placeholder("id")), eq(a.analysisState, "running"))).returning().prepare("pr_review_complete"),
    finish: db.update(a).set({ analysisState: sql`${placeholder("state")}`, errorCode: sql`${placeholder("errorCode")}`, completedAt: sql`now()` }).where(and(eq(a.id, placeholder("id")), eq(a.analysisState, "running"))).prepare("pr_review_finish"),
    readyPublication: db.select().from(a).where(and(eq(a.analysisState, "completed"), eq(a.publicationState, "pending"))).orderBy(asc(a.createdAt)).limit(10).prepare("pr_review_ready_publication"),
    claimPublication: db.update(a).set({ publicationState: "publishing", publicationStartedAt: sql`now()` }).where(and(eq(a.id, placeholder("id")), eq(a.analysisState, "completed"), eq(a.publicationState, "pending"))).returning().prepare("pr_review_claim_publication"),
    publication: db.update(a).set({ publicationState: sql`${placeholder("state")}`, reviewId: sql`${placeholder("reviewId")}`, reviewUrl: sql`${placeholder("reviewUrl")}`, errorCode: sql`${placeholder("errorCode")}` }).where(and(eq(a.id, placeholder("id")), eq(a.publicationState, placeholder("expectedState")))).prepare("pr_review_publication"),
    unknown: db.select().from(a).where(eq(a.publicationState, "unknown")).orderBy(asc(a.createdAt)).limit(10).prepare("pr_review_unknown"),
  };
});

type ReviewRow = typeof schema.prReviews.$inferSelect;
interface Repository {
  repositoryId: string;
  organizationId: string;
  githubRepositoryId: number;
  fullName: string;
  available: boolean;
  installationId: number;
  installState: string;
  enabled: boolean | null;
  providerId: string | null;
  enabledSince: string | null;
  settingsUpdatedAt: string | null;
  provider: typeof schema.llmProviders.$inferSelect | null;
}
type ProviderSnapshot = Pick<typeof schema.llmProviders.$inferSelect, "id" | "name" | "kind" | "baseUrl" | "model" | "inputUsdPerMillionTokens" | "outputUsdPerMillionTokens" | "updatedAt">;
export interface PrReviewWebhookDeps {
  db: DatabaseClient;
  installationToken(installationId: number): Promise<string>;
  providerConfig(id: string): Promise<LlmProviderConfig>;
  githubFetch?: typeof fetch;
}
export interface PrReviewDeps extends PrReviewWebhookDeps {
  secretBox: SecretBox;
  githubAppId?: number;
  githubAppSlug?: string;
  githubFetchForInstallation?(installationId: number): typeof fetch;
  installationBlocked?(installationId: number): boolean;
  generate?: typeof generatePrReview;
}
function safeError(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (/^llm_(timeout|auth_failed|rate_limited|unavailable|invalid_response|model_not_found|model_load_failed)$/.test(code)) return code;
  if (/^(pr_review_|rules_)[a-z_]+$/.test(code)) return code;
  if (code === "github_403" || code === "github_401" || code === "github_app_permissions_missing") return "github_app_permissions_missing";
  if (/^github_(404|410|422|429)$/.test(code)) return code;
  return "pr_review_unavailable";
}
function snapshot(provider: NonNullable<Repository["provider"]>) {
  return { id: provider.id, name: provider.name, kind: provider.kind, baseUrl: provider.baseUrl, model: provider.model, inputUsdPerMillionTokens: provider.inputUsdPerMillionTokens, outputUsdPerMillionTokens: provider.outputUsdPerMillionTokens, updatedAt: provider.updatedAt };
}
function eligible(repository: Repository | undefined): repository is Repository & { provider: NonNullable<Repository["provider"]>; settingsUpdatedAt: string } {
  return Boolean(repository?.available && repository.installState === "approved" && repository.enabled && repository.provider && repository.settingsUpdatedAt);
}
function clientFor(deps: PrReviewWebhookDeps & Partial<PrReviewDeps>, repository: Repository) {
  return new GithubPrReviewClient(() => deps.installationToken(repository.installationId), deps.githubFetchForInstallation?.(repository.installationId) ?? deps.githubFetch ?? fetch);
}
function parts(repository: Repository): [string, string] {
  const parts = repository.fullName.split("/");
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_.-]+$/.test(part))) throw new Error("pr_review_repository_invalid");
  return parts as [string, string];
}

/** Webhook ingestion captures durable work and acknowledges accepted commands; model work is asynchronous. */
export async function handlePrReviewWebhook(deps: PrReviewWebhookDeps, event: string, payload: unknown, _deliveryId: string): Promise<void> {
  const trigger = parsePrReviewEvent(event, payload);
  if (!trigger) return;
  const [initial] = await queries(deps.db).repository.execute(trigger);
  if (!initial) return;
  // Serializing by base repository and reading GitHub inside the lock prevents older payloads
  // from superseding newer work. Payload SHAs are deliberately never used.
  await deps.db.transaction(async tx => {
    const q = queries(tx);
    await q.lockRepository.execute({ repositoryId: initial.repositoryId });
    const [repository] = await q.repositoryById.execute({ repositoryId: initial.repositoryId });
    if (!eligible(repository)) return;
    const [delivery] = await q.delivery.execute({ deliveryId: _deliveryId });
    if (delivery && repository.enabledSince && new Date(delivery.receivedAt).getTime() < new Date(repository.enabledSince).getTime()) return;
    const client = clientFor(deps, repository), [owner, repo] = parts(repository);
    if (trigger.trigger === "review_command") {
      const permission = await client.permission(owner, repo, trigger.requester!);
      if (!["write", "maintain", "admin"].includes(permission)) return;
      const inserted = await q.command.execute({ organizationId: repository.organizationId, repositoryId: repository.repositoryId, commentId: trigger.commentId!, requester: trigger.requester! });
      if (!inserted.length) return;
    }
    const pr = await client.getPullRequest(owner, repo, trigger.prNumber);
    if (pr.state !== "open" || pr.draft) {
      await q.invalidate.execute({ repositoryId: repository.repositoryId, prNumber: pr.number });
      return;
    }
    // Invalidation payloads cannot generate work, even when a later reopen already occurred.
    if (trigger.trigger === "closed" || trigger.trigger === "converted_to_draft") return;
    await deps.providerConfig(repository.provider.id);
    await q.supersede.execute({ repositoryId: repository.repositoryId, prNumber: pr.number, baseSha: pr.baseSha, headSha: pr.headSha });
    const review = { organizationId: repository.organizationId, repositoryId: repository.repositoryId, prNumber: pr.number, baseSha: pr.baseSha, headSha: pr.headSha, trigger: trigger.trigger, commentId: trigger.commentId ?? null, requester: trigger.requester ?? null, providerId: repository.provider.id, providerSnapshot: snapshot(repository.provider), settingsUpdatedAt: repository.settingsUpdatedAt };
    const retried = trigger.trigger === "review_command" ? await q.retry.execute({ organizationId: review.organizationId, repositoryId: review.repositoryId, prNumber: review.prNumber, baseSha: review.baseSha, headSha: review.headSha, trigger: review.trigger, commentId: review.commentId, requester: review.requester, providerId: review.providerId, retryProviderSnapshot: JSON.stringify(review.providerSnapshot), settingsUpdatedAt: review.settingsUpdatedAt, retrySource: JSON.stringify({ trigger: trigger.trigger, deliveryId: _deliveryId }) }) : [];
    if (!retried.length) await q.enqueue.execute({ ...review, source: { trigger: trigger.trigger, deliveryId: _deliveryId } });
    if (trigger.trigger === "review_command") await client.acknowledgeComment(owner, repo, trigger.commentId!);
  });
}

async function current(deps: PrReviewDeps, row: ReviewRow) {
  const [repository] = await queries(deps.db).repositoryById.execute({ repositoryId: row.repositoryId });
  if (!eligible(repository) || deps.installationBlocked?.(repository.installationId)) throw new Error("pr_review_disabled_or_unavailable");
  const configured = snapshot(repository.provider), captured = row.providerSnapshot as ProviderSnapshot;
  const providerChanged = (Object.keys(configured) as Array<keyof ProviderSnapshot>).some(key => configured[key] !== captured[key]);
  if (repository.organizationId !== row.organizationId || repository.provider.id !== row.providerId || new Date(repository.settingsUpdatedAt).getTime() !== new Date(row.settingsUpdatedAt).getTime() || providerChanged) throw new Error("pr_review_settings_or_provider_changed");
  const provider = await deps.providerConfig(repository.provider.id);
  const client = clientFor(deps, repository), [owner, repo] = parts(repository);
  const pr = await client.getPullRequest(owner, repo, row.prNumber);
  if (pr.state !== "open" || pr.draft) throw new Error("pr_review_closed_or_draft");
  if (pr.baseSha !== row.baseSha || pr.headSha !== row.headSha) throw new Error("pr_review_superseded");
  return { repository, provider, client, owner, repo, pr };
}
function marker(row: ReviewRow): string { return `mars-pr-review:${row.repositoryId}:${row.prNumber}:${row.baseSha}:${row.headSha}`; }
async function publicationState(deps: PrReviewDeps, row: ReviewRow, expectedState: string, state: string, errorCode: string | null, review?: { id: number; url: string }) {
  await queries(deps.db).publication.execute({ id: row.id, expectedState, state, errorCode, reviewId: review?.id ?? null, reviewUrl: review?.url ?? null });
}
async function reconcile(deps: PrReviewDeps, row: ReviewRow, expectedState: "publishing" | "unknown"): Promise<boolean> {
  if (deps.githubAppId === undefined) throw new Error("pr_review_app_identity_unavailable");
  const [repository] = await queries(deps.db).repositoryById.execute({ repositoryId: row.repositoryId });
  if (!repository || repository.installState !== "approved") return false;
  const [owner, repo] = parts(repository), client = clientFor(deps, repository);
  const reviews = await client.reviews(owner, repo, row.prNumber);
  const candidates = reviews.filter(review => review.commitId === row.headSha && review.body?.includes(`<!-- ${marker(row)} -->`));
  const bot = deps.githubAppSlug && candidates.some(review => review.appId === null) ? await client.getAppBotIdentity(deps.githubAppSlug) : null;
  const match = candidates.find(review => review.appId !== null ? review.appId === deps.githubAppId : bot !== null && review.userId === bot.id);
  if (!match) return false;
  await publicationState(deps, row, expectedState, "published", null, { id: match.id, url: `https://github.com/${owner}/${repo}/pull/${row.prNumber}#pullrequestreview-${match.id}` });
  return true;
}
async function publish(deps: PrReviewDeps, candidate: ReviewRow) {
  const [row] = await queries(deps.db).claimPublication.execute({ id: candidate.id });
  if (!row) return;
  let postAttempted = false;
  try {
    if (await reconcile(deps, row, "publishing")) return;
    const { client, owner, repo } = await current(deps, row);
    const context = row.source as PrReviewContext;
    const result = PrReviewResult.parse(row.result);
    const rendered = renderPrReview(result, context, marker(row));
    // Last check is intentionally after rendering and reconciliation. GitHub has no atomic
    // head guard: the batch remains pinned to the captured commit and labels its coverage.
    await current(deps, row);
    try {
      postAttempted = true;
      const created = await client.publish(owner, repo, row.prNumber, { commit_id: row.headSha, event: "COMMENT", ...rendered });
      await publicationState(deps, row, "publishing", "published", null, created);
    } catch (error) {
      const definitive = error instanceof Error && /^github_(401|403|404|410|422|429)$/.test(error.message);
      await publicationState(deps, row, "publishing", definitive ? "failed" : "unknown", definitive ? safeError(error) : "github_post_outcome_unknown");
    }
  } catch (error) {
    await publicationState(deps, row, "publishing", postAttempted ? "unknown" : "failed", postAttempted ? "github_post_outcome_unknown" : safeError(error));
  }
}

export async function processPrReviews(deps: PrReviewDeps): Promise<void> {
  const q = queries(deps.db);
  await q.interruptedAnalysis.execute({});
  await q.interruptedPublication.execute({});
  for (const row of await q.unknown.execute({})) {
    try { await reconcile(deps, row, "unknown"); } catch { /* Never repeat an uncertain POST. */ }
  }
  // Generated results are recoverable without another model call.
  for (const row of await q.readyPublication.execute({})) await publish(deps, row);
  while (true) {
    const row = await deps.db.transaction(async tx => {
      const statements = queries(tx), [candidate] = await statements.claim.execute({});
      if (!candidate) return null;
      return (await statements.start.execute({ id: candidate.id }))[0] ?? null;
    });
    if (!row) return;
    await processPrReview(deps, q, row);
  }
}

async function processPrReview(deps: PrReviewDeps, q: ReturnType<typeof queries>, row: ReviewRow): Promise<void> {
  try {
    const { client, owner, repo, pr } = await current(deps, row);
    let context = await collectPrReviewContext(client, owner, repo, pr);
    await q.source.execute({ id: row.id, source: context });
    if (context.coverage.reviewableFiles === 0) {
      await q.finish.execute({ id: row.id, state: "skipped", errorCode: "pr_review_no_reviewable_source" });
      return;
    }
    const { provider } = await current(deps, row);
    const [stillRunning] = await q.load.execute({ id: row.id });
    if (stillRunning?.analysisState !== "running") return;
    const result = await (deps.generate ?? generatePrReview)({ provider, context, secretBox: deps.secretBox,
      onContext: async fitted => {
        context = fitted;
        await q.source.execute({ id: row.id, source: fitted });
      },
      onRequest: async () => {
        await current(deps, row);
        const [active] = await q.load.execute({ id: row.id });
        if (active?.analysisState !== "running") throw new Error("pr_review_superseded");
        await q.called.execute({ id: row.id });
      },
      onUsage: async (usage: PipelineAnalysisUsage | null) => {
        if (!usage) return;
        const pricing = row.providerSnapshot as ProviderSnapshot;
        const estimatedCostUsd = pricing.inputUsdPerMillionTokens === null || pricing.outputUsdPerMillionTokens === null ? null : (usage.inputTokens * pricing.inputUsdPerMillionTokens + usage.outputTokens * pricing.outputUsdPerMillionTokens) / 1_000_000;
        await q.usage.execute({ id: row.id, ...usage, estimatedCostUsd });
      },
    });
    const parsed = PrReviewResult.safeParse(result);
    if (!parsed.success) throw new Error("llm_invalid_response");
    const accepted = validatePrReviewFindings(parsed.data, context);
    await current(deps, row);
    const [completed] = await q.complete.execute({ id: row.id, result: accepted });
    if (completed) await publish(deps, completed);
  } catch (error) {
    if (error instanceof PrReviewRulesError) await q.source.execute({ id: row.id, source: { rules: error.rules, coverage: { complete: false, limitations: ["Repository rules failed to load; no review generated."] } } });
    const code = safeError(error);
    const state = code === "pr_review_superseded" ? "superseded" : ["pr_review_closed_or_draft", "pr_review_disabled_or_unavailable", "pr_review_settings_or_provider_changed", "pr_review_no_reviewable_source"].includes(code) ? "skipped" : "failed";
    await q.finish.execute({ id: row.id, state, errorCode: code });
  }
}
