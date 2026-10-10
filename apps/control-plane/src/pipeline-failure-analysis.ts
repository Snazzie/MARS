import { and, asc, eq, exists, sql } from "drizzle-orm";
import { defineQueries, schema, type DatabaseClient } from "@mars/db";
import { alias } from "drizzle-orm/pg-core";
import type { SecretBox } from "./auth.ts";
import { GithubJobsClient } from "./github-jobs.ts";
import { attributeGithubJobLog } from "./github-job-logs.ts";
import type { GithubJobSnapshot, GithubRunSnapshot } from "./runs.ts";
import { sanitizeProviderText, type LlmProviderConfig, type PipelineAnalysisContext, type PipelineAnalysisResult, type PipelineAnalysisUsage } from "./llm-providers.ts";

const MAX_TOTAL_CONTEXT = 64 * 1024;
const MAX_JOB_CONTEXT = 8 * 1024;
const queries = defineQueries(db => {
  const a = schema.pipelineFailureAnalyses, c = schema.pipelineAnalysisComments;
  const r = schema.dashboardRuns, repo = schema.dashboardRepositories, settings = schema.repositoryFailureAnalysisSettings;
  const jobs = schema.dashboardJobs, steps = schema.dashboardJobSteps;
  const p = sql.placeholder;
  const globalSettings = schema.globalFailureAnalysisSettings;
  const enableAll = sql<boolean>`COALESCE((SELECT ${globalSettings.enableAll} FROM ${globalSettings} WHERE ${globalSettings.singleton}=true), false)`;
  const enabled = sql<boolean>`(${enableAll} OR COALESCE(${settings.enabled}, false))`;
  const providerId = sql<string | null>`CASE WHEN ${enableAll} THEN (SELECT ${globalSettings.providerId} FROM ${globalSettings} WHERE ${globalSettings.singleton}=true) ELSE ${settings.providerId} END`;
  const enabledSince = sql<string | null>`CASE WHEN ${enableAll} THEN LEAST(CASE WHEN ${settings.enabled} THEN ${settings.enabledSince} END, (SELECT ${globalSettings.enabledSince} FROM ${globalSettings} WHERE ${globalSettings.singleton}=true)) ELSE ${settings.enabledSince} END`;
  const newer = alias(r, "newer_analysis_run");
  const superseded = exists(db.select({ id: newer.id }).from(newer).where(and(
    eq(newer.organizationId, a.organizationId), eq(newer.repositoryId, a.repositoryId),
    eq(newer.githubRunId, a.githubRunId), sql`${newer.runAttempt} > ${a.runAttempt}`,
  )));
  return {
    enqueueContext: db.select({ runId: r.id, workflowName: r.workflowName, runNumber: r.runNumber, event: r.event, branch: r.branch, commitSha: r.commitSha, actorLogin: r.actorLogin, queuedAt: r.queuedAt, startedAt: r.startedAt, completedAt: r.completedAt, installationId: repo.installationId, githubRepositoryId: repo.githubRepositoryId, fullName: repo.fullName, available: repo.available, installState: schema.dashboardInstallations.state, enabled, enabledSince, providerId: schema.llmProviders.id, providerName: schema.llmProviders.name, providerKind: schema.llmProviders.kind, model: schema.llmProviders.model, providerBaseUrl: schema.llmProviders.baseUrl, inputUsdPerMillionTokens: schema.llmProviders.inputUsdPerMillionTokens, outputUsdPerMillionTokens: schema.llmProviders.outputUsdPerMillionTokens })
      .from(r).innerJoin(repo, and(eq(repo.id, r.repositoryId), eq(repo.organizationId, r.organizationId))).innerJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.id, repo.installationId), eq(schema.dashboardInstallations.organizationId, repo.organizationId)))
      .leftJoin(settings, and(eq(settings.organizationId, r.organizationId), eq(settings.repositoryId, repo.id))).leftJoin(schema.llmProviders, eq(schema.llmProviders.id, providerId))
      .where(and(eq(r.organizationId, p("organizationId")), eq(r.repositoryId, p("repositoryId")), eq(r.githubRunId, p("githubRunId")), eq(r.runAttempt, p("runAttempt")))).limit(1).prepare("pipeline_analysis_enqueue_context"),
    insert: db.insert(a).values({ organizationId: p("organizationId"), repositoryId: p("repositoryId"), runId: p("runId"), githubRunId: p("githubRunId"), runAttempt: p("runAttempt"), providerId: p("providerId"), providerKind: p("providerKind"), providerName: p("providerName"), model: p("model"), inputUsdPerMillionTokens: p("inputUsdPerMillionTokens"), outputUsdPerMillionTokens: p("outputUsdPerMillionTokens"), source: p("source"), state: p("state"), errorCode: p("errorCode") }).onConflictDoNothing().returning({ id: a.id }).prepare("pipeline_analysis_enqueue"),
    finalize: db.update(a).set({ source: p("source"), state: sql`${p("state")}`, errorCode: sql`${p("errorCode")}`, updatedAt: sql`now()` }).where(and(eq(a.organizationId, p("organizationId")), eq(a.repositoryId, p("repositoryId")), eq(a.githubRunId, p("githubRunId")), eq(a.runAttempt, p("runAttempt")), eq(a.state, "pending"))).prepare("pipeline_analysis_finalize"),
    cancelSuperseded: db.update(a).set({ state: "skipped", errorCode: "analysis_superseded", finishedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(a.state, "pending"), superseded)).prepare("pipeline_analysis_cancel_superseded"),
    superseded: db.select({ id: a.id }).from(a).where(and(eq(a.id, p("id")), superseded)).limit(1).prepare("pipeline_analysis_superseded"),
    cancelNonfailed: db.update(a).set({ state: "skipped", errorCode: "analysis_run_not_failed", finishedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(a.state, "pending"), exists(db.select({ id: r.id }).from(r).where(and(eq(r.id, a.runId), eq(r.runAttempt, a.runAttempt), eq(r.status, "completed"), sql`${r.conclusion} NOT IN ('failure','timed_out')`))))).prepare("pipeline_analysis_cancel_nonfailed"),
    stale: db.update(a).set({ state: "failed", errorCode: "analysis_interrupted", finishedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(a.state, "running"), sql`${a.startedAt} < now()-interval '15 minutes'`)).prepare("pipeline_analysis_stale"),
    claim: db.select({ id: a.id }).from(a).where(and(eq(a.state, "pending"), sql`(${a.source}->>'ready') IS DISTINCT FROM 'false'`, sql`NOT ${superseded}`)).orderBy(asc(a.createdAt)).limit(1).for("update", { skipLocked: true }).prepare("pipeline_analysis_claim"),
    claimUpdate: db.update(a).set({ state: "running", startedAt: sql`now()`, updatedAt: sql`now()`, errorCode: null }).where(and(eq(a.id, p("id")), eq(a.state, "pending"))).returning({ id: a.id }).prepare("pipeline_analysis_claim_update"),
    analysis: db.select({ id: a.id, organizationId: a.organizationId, repositoryId: a.repositoryId, runId: a.runId, githubRunId: a.githubRunId, runAttempt: a.runAttempt, providerId: a.providerId, providerKind: a.providerKind, providerName: a.providerName, model: a.model, source: a.source, state: a.state, result: a.result, installationId: schema.dashboardInstallations.githubInstallationId, githubRepositoryId: repo.githubRepositoryId, fullName: repo.fullName, available: repo.available, installState: schema.dashboardInstallations.state, enabled, providerIdCurrent: schema.llmProviders.id, providerKindCurrent: schema.llmProviders.kind, providerBaseUrl: schema.llmProviders.baseUrl, encryptedApiKey: schema.llmProviders.encryptedApiKey })
      .from(a).innerJoin(repo, and(eq(repo.id, a.repositoryId), eq(repo.organizationId, a.organizationId))).innerJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.id, repo.installationId), eq(schema.dashboardInstallations.organizationId, repo.organizationId))).leftJoin(settings, and(eq(settings.organizationId, a.organizationId), eq(settings.repositoryId, repo.id))).leftJoin(schema.llmProviders, eq(schema.llmProviders.id, providerId))
      .where(eq(a.id, p("id"))).limit(1).prepare("pipeline_analysis_load"),
    localJobs: db.select({ id: jobs.id, githubJobId: jobs.githubJobId, runAttempt: jobs.runAttempt, name: jobs.name, logsState: jobs.logsState, logsVersion: jobs.logsVersion, conclusion: jobs.conclusion }).from(jobs).where(and(eq(jobs.organizationId, p("organizationId")), eq(jobs.runId, p("runId")), eq(jobs.runAttempt, p("runAttempt")), eq(jobs.githubJobId, p("jobId")))).limit(1).prepare("pipeline_analysis_local_job"),
    localSteps: db.select({ number: steps.number, name: steps.name, conclusion: steps.conclusion, status: steps.status, content: schema.dashboardStepLogChunks.content, sequence: schema.dashboardStepLogChunks.sequence }).from(steps).innerJoin(schema.dashboardStepLogChunks, and(eq(schema.dashboardStepLogChunks.organizationId, steps.organizationId), eq(schema.dashboardStepLogChunks.runId, steps.runId), eq(schema.dashboardStepLogChunks.jobId, steps.jobId), eq(schema.dashboardStepLogChunks.stepId, steps.id))).where(and(eq(steps.organizationId, p("organizationId")), eq(steps.runId, p("runId")), eq(steps.jobId, p("jobId")))).orderBy(asc(steps.number), asc(schema.dashboardStepLogChunks.sequence)).prepare("pipeline_analysis_local_steps"),
    localJobLogs: db.select({ content: schema.dashboardLogChunks.content, sequence: schema.dashboardLogChunks.sequence }).from(schema.dashboardLogChunks).where(and(eq(schema.dashboardLogChunks.organizationId, p("organizationId")), eq(schema.dashboardLogChunks.runId, p("runId")), eq(schema.dashboardLogChunks.jobId, p("jobId")))).orderBy(asc(schema.dashboardLogChunks.sequence)).prepare("pipeline_analysis_local_job_logs"),
    recordUsage: db.update(a).set({ inputTokens: sql`${p("inputTokens")}`, outputTokens: sql`${p("outputTokens")}`, tokensPerSecond: sql`${p("tokensPerSecond")}`, updatedAt: sql`now()` }).where(eq(a.id, p("id"))).prepare("pipeline_analysis_record_usage"),
    markCall: db.update(a).set({ providerCalledAt: sql`now()`, updatedAt: sql`now()` }).where(eq(a.id, p("id"))).prepare("pipeline_analysis_mark_call"),
    complete: db.update(a).set({ state: "completed", result: p("result"), errorCode: null, finishedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(a.id, p("id")), eq(a.state, "running"))).prepare("pipeline_analysis_complete"),
    fail: db.update(a).set({ state: "failed", errorCode: sql`${p("errorCode")}`, finishedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(a.id, p("id")), eq(a.state, "running"))).prepare("pipeline_analysis_fail"),
    skip: db.update(a).set({ state: "skipped", errorCode: sql`${p("errorCode")}`, finishedAt: sql`now()`, updatedAt: sql`now()` }).where(and(eq(a.id, p("id")), eq(a.state, "running"))).prepare("pipeline_analysis_skip"),
    comments: db.select({ prNumber: c.prNumber, state: c.state }).from(c).where(eq(c.analysisId, p("analysisId"))).orderBy(asc(c.prNumber)).prepare("pipeline_analysis_comments_list"),
    addComment: db.insert(c).values({ analysisId: p("analysisId"), prNumber: p("prNumber"), state: "pending" }).onConflictDoNothing().prepare("pipeline_analysis_comment_insert"),
    claimComment: db.update(c).set({ state: "publishing", errorCode: null, updatedAt: sql`now()` }).where(and(eq(c.analysisId, p("analysisId")), eq(c.prNumber, p("prNumber")), eq(c.state, "pending"))).returning({ prNumber: c.prNumber }).prepare("pipeline_analysis_comment_claim"),
    commentState: db.update(c).set({ state: sql`${p("state")}`, commentId: sql`${p("commentId")}`, commentUrl: sql`${p("commentUrl")}`, commentBody: sql`${p("commentBody")}`, errorCode: sql`${p("errorCode")}`, updatedAt: sql`now()` }).where(and(eq(c.analysisId, p("analysisId")), eq(c.prNumber, p("prNumber")), eq(c.state, p("expectedState")))).prepare("pipeline_analysis_comment_state"),
    unknownComments: db.update(c).set({ state: "unknown", errorCode: "github_post_outcome_unknown", updatedAt: sql`now()` }).where(and(eq(c.state, "publishing"), sql`${c.updatedAt} < now()-interval '5 minutes'`)).prepare("pipeline_analysis_comments_interrupted"),
    unknownCommentRows: db.select({ analysisId: a.id, prNumber: c.prNumber, githubRunId: a.githubRunId, runAttempt: a.runAttempt, source: a.source, fullName: repo.fullName, installationId: schema.dashboardInstallations.githubInstallationId, available: repo.available, enabled, installState: schema.dashboardInstallations.state }).from(c).innerJoin(a, eq(a.id, c.analysisId)).innerJoin(repo, and(eq(repo.id, a.repositoryId), eq(repo.organizationId, a.organizationId))).innerJoin(schema.dashboardInstallations, and(eq(schema.dashboardInstallations.id, repo.installationId), eq(schema.dashboardInstallations.organizationId, repo.organizationId))).leftJoin(settings, and(eq(settings.organizationId, a.organizationId), eq(settings.repositoryId, repo.id))).where(and(eq(a.state, "completed"), eq(c.state, "unknown"))).prepare("pipeline_analysis_unknown_comments"),
    adoptUnknown: db.update(c).set({ state: "published", commentId: sql`${p("commentId")}`, commentUrl: sql`${p("commentUrl")}`, commentBody: sql`${p("commentBody")}`, errorCode: null, updatedAt: sql`now()` }).where(and(eq(c.analysisId, p("analysisId")), eq(c.prNumber, p("prNumber")), eq(c.state, "unknown"))).prepare("pipeline_analysis_adopt_unknown"),
  };
});

export interface PipelineFailureAnalysisDeps {
  db: DatabaseClient;
  secretBox: SecretBox;
  generatePipelineAnalysis(input: { provider: LlmProviderConfig; context: PipelineAnalysisContext; secretBox: SecretBox; onRequest?: () => void | Promise<void>; onUsage?: (usage: PipelineAnalysisUsage | null) => void | Promise<void> }): Promise<PipelineAnalysisResult>;
  installationToken(installationId: number): Promise<string>;
  githubFetchForInstallation(installationId: number): typeof fetch;
  installationBlocked?(installationId: number): boolean;
  githubAppId?: number;
  now?: () => number;
  onUsageUpdated?(organizationId: string, id: string, usage: PipelineAnalysisUsage): void;
}

function safeErrorCode(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (["llm_timeout", "llm_auth_failed", "llm_rate_limited", "llm_unavailable", "llm_invalid_response", "llm_model_not_found", "llm_model_load_failed"].includes(code)) return code;
  if (code === "analysis_logs_unavailable" || code === "analysis_no_failed_jobs" || code === "analysis_interrupted") return code;
  if (/^github_403$/.test(code)) return "github_app_permissions_missing";
  if (/^github_(?:401|404|410|422)$/.test(code)) return code;
  return "llm_unavailable";
}

function compact(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return { text: bytes.toString("utf8", start), truncated: true };
}
function sourceObject(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export async function enqueuePipelineFailureAnalysis(input: { db: DatabaseClient; organizationId: string; repositoryId: string; run: GithubRunSnapshot; jobs: GithubJobSnapshot[]; completeSnapshot?: boolean }): Promise<void> {
  const failedJobs = input.jobs.filter(job => job.status === "completed" && (job.conclusion === "failure" || job.conclusion === "timed_out"));
  const ready = input.completeSnapshot !== false && input.run.status === "completed" && ["failure", "timed_out"].includes(String(input.run.conclusion));
  if (!ready && (failedJobs.length === 0 || input.run.status === "completed" && !["failure", "timed_out"].includes(String(input.run.conclusion)))) return;
  if (input.jobs.some(job => job.runId !== input.run.id || job.runAttempt !== input.run.runAttempt)) throw new Error("pipeline_analysis_attempt_mismatch");
  const [context] = await queries(input.db).enqueueContext.execute({ organizationId: input.organizationId, repositoryId: input.repositoryId, githubRunId: input.run.id, runAttempt: input.run.runAttempt });
  if (!context || !context.enabled || !context.available || context.installState !== "approved" || !context.providerId || !context.providerName || !context.providerKind || !context.model) return;
  if (context.enabledSince) {
    const observedAt = ready ? input.run.completedAt : failedJobs.reduce<string | null>((latest, job) => job.completedAt && (!latest || job.completedAt > latest) ? job.completedAt : latest, null);
    if (!observedAt || !Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) < Date.parse(context.enabledSince)) return;
  }
  const source = {
    ready,
    run: { id: input.run.id, attempt: input.run.runAttempt, number: input.run.runNumber, workflowName: input.run.workflowName, workflowPath: input.run.workflowPath ?? null, event: input.run.event, branch: input.run.branch, commitSha: input.run.commitSha, actorLogin: input.run.actorLogin, conclusion: input.run.conclusion, queuedAt: input.run.queuedAt, startedAt: input.run.startedAt, completedAt: input.run.completedAt, repositoryFullName: context.fullName, githubRepositoryId: Number(context.githubRepositoryId) },
    failedJobs: failedJobs.map(job => ({ jobId: job.id, runId: job.runId, runAttempt: job.runAttempt, name: job.name, conclusion: job.conclusion, completedAt: job.completedAt, steps: job.steps.filter(step => step.status === "completed" && (step.conclusion === "failure" || step.conclusion === "timed_out")).map(step => ({ stepNumber: step.number, name: step.name, conclusion: step.conclusion, status: step.status })) })),
  };
  const localProvider = context.providerKind === "openai-compatible" && context.providerBaseUrl && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(String(context.providerBaseUrl)).hostname);
  await queries(input.db).insert.execute({ organizationId: input.organizationId, repositoryId: input.repositoryId, runId: String(context.runId), githubRunId: input.run.id, runAttempt: input.run.runAttempt, providerId: String(context.providerId), providerKind: String(context.providerKind), providerName: String(context.providerName), model: String(context.model), inputUsdPerMillionTokens: localProvider ? 0 : context.inputUsdPerMillionTokens, outputUsdPerMillionTokens: localProvider ? 0 : context.outputUsdPerMillionTokens, source, state: failedJobs.length ? "pending" : "skipped", errorCode: failedJobs.length ? null : "analysis_no_failed_jobs" });
  if (ready) await queries(input.db).finalize.execute({ organizationId: input.organizationId, repositoryId: input.repositoryId, githubRunId: input.run.id, runAttempt: input.run.runAttempt, source, state: failedJobs.length ? "pending" : "skipped", errorCode: failedJobs.length ? null : "analysis_no_failed_jobs" });
}

async function hasNewerGithubRun(client: GithubJobsClient, owner: string, repo: string, analysis: Record<string, unknown>): Promise<boolean> {
  const captured = sourceObject(sourceObject(analysis.source).run);
  const capturedTime = Date.parse(String(captured.queuedAt));
  for (let page = 1; ; page++) {
    const listing = await client.listRuns(owner, repo, undefined, page);
    for (const run of listing.runs) {
      if (run.id === Number(analysis.githubRunId) && run.runAttempt > Number(analysis.runAttempt)) return true;
      const sameWorkflow = captured.workflowPath && run.workflowPath ? captured.workflowPath === run.workflowPath : captured.workflowName === run.workflowName;
      if (sameWorkflow && run.branch === captured.branch && run.runNumber > Number(captured.number)) return true;
    }
    if (listing.runs.length < 100 || listing.runs.some(run => Date.parse(run.queuedAt) < capturedTime)) return false;
  }
}

async function capturedContext(db: DatabaseClient, analysis: Record<string, unknown>, deps: PipelineFailureAnalysisDeps, client: GithubJobsClient, owner: string, repoName: string): Promise<PipelineAnalysisContext> {
  const source = sourceObject(analysis.source), run = sourceObject(source.run);
  const capturedJobs = Array.isArray(source.failedJobs) ? source.failedJobs.map(sourceObject) : [];
  const resultJobs: PipelineAnalysisContext["failedJobs"] = [];
  let totalBytes = 0, hasUsableLogs = false;
  for (const captured of capturedJobs.sort((x, y) => Number(x.jobId) - Number(y.jobId))) {
    const jobId = Number(captured.jobId);
    if (!Number.isSafeInteger(jobId) || jobId <= 0 || Number(captured.runId) !== Number(analysis.githubRunId) || Number(captured.runAttempt) !== Number(analysis.runAttempt)) continue;
    const [local] = await queries(db).localJobs.execute({ organizationId: String(analysis.organizationId), runId: String(analysis.runId), runAttempt: Number(analysis.runAttempt), jobId });
    const matched = local && Number(local.runAttempt) === Number(analysis.runAttempt) && Number(local.githubJobId) === jobId;
    let stepLogs: Array<{ number: number; name: string; conclusion: string | null; content: string }> = [];
    let jobLogs = "";
    if (matched && local.logsState === "ingested") {
      const [steps, chunks] = await Promise.all([queries(db).localSteps.execute({ organizationId: String(analysis.organizationId), runId: String(analysis.runId), jobId: String(local.id) }), queries(db).localJobLogs.execute({ organizationId: String(analysis.organizationId), runId: String(analysis.runId), jobId: String(local.id) })]);
      const byStep = new Map<number, typeof stepLogs[number]>();
      for (const row of steps) { const item = byStep.get(Number(row.number)) ?? { number: Number(row.number), name: String(row.name), conclusion: row.conclusion, content: "" }; item.content += String(row.content); byStep.set(item.number, item); }
      stepLogs = [...byStep.values()]; jobLogs = chunks.map(row => String(row.content)).join("");
    } else {
      try {
        const verified = await client.getJob(owner, repoName, jobId);
        if (verified.runId !== Number(analysis.githubRunId) || verified.runAttempt !== Number(analysis.runAttempt) || verified.status !== "completed" || !["failure", "timed_out"].includes(String(verified.conclusion))) continue;
        const text = await client.getJobLogs(owner, repoName, jobId);
        const attributed = attributeGithubJobLog(text, verified.steps);
        stepLogs = [...attributed.steps].map(([number, content]) => ({ number, name: verified.steps.find(step => step.number === number)?.name ?? `step ${number}`, conclusion: verified.steps.find(step => step.number === number)?.conclusion ?? null, content }));
        jobLogs = attributed.unattributed;
      } catch {
        continue;
      }
    }
    const selected = stepLogs.filter(step => (step.conclusion === "failure" || step.conclusion === "timed_out") && step.content).sort((x, y) => x.number - y.number);
    const job: PipelineAnalysisContext["failedJobs"][number] = { jobId, name: String(captured.name ?? `job ${jobId}`), conclusion: String(captured.conclusion ?? "failure") };
    let jobBytes = 0;
    if (selected.length) {
      job.steps = selected.map(step => ({ stepNumber: step.number, name: step.name, conclusion: step.conclusion ?? undefined, excerpt: "" }));
      for (const step of selected) {
        const remaining = Math.min(MAX_JOB_CONTEXT - jobBytes, MAX_TOTAL_CONTEXT - totalBytes);
        if (remaining <= 0) break;
        const excerpt = compact(sanitizeProviderText(step.content), remaining);
        const item = job.steps.find(candidate => candidate.stepNumber === step.number)!;
        item.excerpt = `${excerpt.text}${excerpt.truncated ? "\n[truncated]" : ""}`;
        jobBytes += Buffer.byteLength(excerpt.text);
        totalBytes += Buffer.byteLength(excerpt.text);
      }
    } else if (jobLogs) {
      const remaining = Math.min(MAX_JOB_CONTEXT, MAX_TOTAL_CONTEXT - totalBytes);
      if (remaining > 0) { const excerpt = compact(sanitizeProviderText(jobLogs), remaining); job.excerpt = `${excerpt.text}${excerpt.truncated ? "\n[truncated]" : ""}`; totalBytes += Buffer.byteLength(excerpt.text); }
    }
    const hasJobLogs = Boolean(job.excerpt || job.steps?.some(step => step.excerpt));
    hasUsableLogs ||= hasJobLogs;
    if (!hasJobLogs) job.logNotice = "No usable log excerpt was available for this failed job.";
    resultJobs.push(job);
  }
  if (!hasUsableLogs) throw new Error("analysis_logs_unavailable");
  return { run, failedJobs: resultJobs };
}

export function escapeMarkdown(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll("(", "\\(").replaceAll(")", "\\)")
    .replaceAll("@", "@​").replaceAll("`", "\\`").replace(/https?:\/\//gi, match => match.replace(":", "&#58;"));
}
export function renderComment(result: PipelineAnalysisResult, source: Record<string, unknown>, marker: string): string {
  const run = sourceObject(source.run), fullName = String(run.repositoryFullName ?? ""), runId = Number(run.id), attempt = Number(run.attempt), workflow = escapeMarkdown(String(run.workflowName ?? "workflow"));
  const link = `https://github.com/${fullName}/actions/runs/${runId}/attempts/${attempt}`;
  const parts = [`<!-- ${marker} -->`, "## MARS pipeline failure analysis", `**${workflow}** — run [#${escapeMarkdown(String(run.number ?? runId))}](${link}), attempt ${attempt}`, "", escapeMarkdown(result.summary), ""];
  const evidenceBlocks: string[] = [];
  for (const failure of result.failures) {
    const job = sourceObject((Array.isArray(source.failedJobs) ? source.failedJobs : []).map(sourceObject).find(item => Number(item.jobId) === failure.jobId));
    parts.push(`### ${escapeMarkdown(String(job.name ?? `Job ${failure.jobId}`))}${failure.stepNumber === null ? "" : ` — step ${failure.stepNumber}`}`, escapeMarkdown(failure.explanation));
    if (failure.evidence.length) {
      const evidence = failure.evidence.map(item => item.replaceAll("```", "``\\`")).join("\n");
      evidenceBlocks.push(["Evidence:", "```text", evidence, "```", ""].join("\n"));
    }
    parts.push("Suggested fix:", escapeMarkdown(failure.suggestedFix), "");
  }
  parts.push("AI-generated suggestions; verify before applying.");
  const disclaimer = parts.pop()!;
  let primary = parts.join("\n");
  const maxBytes = 49_000;
  const primaryLimit = maxBytes - Buffer.byteLength(disclaimer) - 2;
  const prefix = (value: string, bytes: number) => Buffer.from(value, "utf8").subarray(0, Math.max(0, bytes)).toString("utf8");
  if (Buffer.byteLength(primary) > primaryLimit) primary = prefix(primary, primaryLimit);
  let body = primary;
  let remaining = maxBytes - Buffer.byteLength(primary) - Buffer.byteLength(disclaimer) - 2;
  for (const block of evidenceBlocks) {
    if (remaining <= 0) break;
    const bounded = prefix(block, remaining);
    const truncated = Buffer.byteLength(bounded) < Buffer.byteLength(block);
    const rendered = truncated ? `${prefix(block, Math.max(0, remaining - 5))}\n\`\`\`` : bounded;
    body += `\n${rendered}`;
    remaining -= Buffer.byteLength(rendered) + 1;
  }
  return `${body}\n${disclaimer}`;
}

async function publish(deps: PipelineFailureAnalysisDeps, analysis: Record<string, unknown>, client: GithubJobsClient, fullName: string, result: PipelineAnalysisResult): Promise<void> {
  const [owner, repo] = fullName.split("/", 2); if (!owner || !repo) return;
  const source = sourceObject(analysis.source), run = sourceObject(source.run);
  const marker = `mars-failure-analysis:${Number(run.githubRepositoryId)}:${Number(analysis.githubRunId)}:${Number(analysis.runAttempt)}`;
  const prs = await client.listRunPullRequests(owner, repo, Number(analysis.githubRunId));
  for (const pr of prs) await queries(deps.db).addComment.execute({ analysisId: String(analysis.id), prNumber: pr.number });
  for (const pr of prs) {
    const [comment] = await queries(deps.db).claimComment.execute({ analysisId: String(analysis.id), prNumber: pr.number });
    if (!comment) continue;
    try {
      let page = 1, found: { id: number; url: string; body: string } | null = null;
      for (;;) {
        const comments = await client.listPullRequestComments(owner, repo, pr.number, page++);
        const match = comments.find(item => item.body.includes(`<!-- ${marker} -->`) && item.appId === deps.githubAppId);
        if (match) { found = { id: match.id, url: match.url, body: match.body }; break; }
        if (comments.length < 100) break;
      }
      if (found) { await queries(deps.db).commentState.execute({ analysisId: String(analysis.id), prNumber: pr.number, expectedState: "publishing", state: "published", commentId: found.id, commentUrl: found.url, commentBody: found.body, errorCode: null }); continue; }
      if ((await queries(deps.db).superseded.execute({ id: String(analysis.id) })).length || await hasNewerGithubRun(client, owner, repo, analysis)) {
        await queries(deps.db).commentState.execute({ analysisId: String(analysis.id), prNumber: pr.number, expectedState: "publishing", state: "failed", commentId: null, commentUrl: null, commentBody: null, errorCode: "analysis_superseded" });
        continue;
      }
      const body = renderComment(result, source, marker);
      try {
        const created = await client.createPullRequestComment(owner, repo, pr.number, body);
        await queries(deps.db).commentState.execute({ analysisId: String(analysis.id), prNumber: pr.number, expectedState: "publishing", state: "published", commentId: created.id, commentUrl: created.url, commentBody: body, errorCode: null });
      } catch (error) {
        const code = safeErrorCode(error), ambiguous = !(error instanceof Error && /^github_(?:401|403|404|410|422|429)$/.test(error.message));
        await queries(deps.db).commentState.execute({ analysisId: String(analysis.id), prNumber: pr.number, expectedState: "publishing", state: ambiguous ? "unknown" : "failed", commentId: null, commentUrl: null, commentBody: body, errorCode: ambiguous ? "github_post_outcome_unknown" : code });
      }
    } catch (error) {
      await queries(deps.db).commentState.execute({ analysisId: String(analysis.id), prNumber: pr.number, expectedState: "publishing", state: "failed", commentId: null, commentUrl: null, commentBody: null, errorCode: safeErrorCode(error) });
    }
  }
}

async function adoptUnknownComments(deps: PipelineFailureAnalysisDeps): Promise<void> {
  if (deps.githubAppId === undefined) return;
  for (const row of await queries(deps.db).unknownCommentRows.execute({})) {
    const installationId = Number(row.installationId);
    if (!row.enabled || !row.available || row.installState !== "approved" || deps.installationBlocked?.(installationId)) continue;
    const [owner, repo] = String(row.fullName).split("/", 2);
    if (!owner || !repo) continue;
    const source = sourceObject(row.source), run = sourceObject(source.run);
    const marker = `mars-failure-analysis:${Number(run.githubRepositoryId)}:${Number(row.githubRunId)}:${Number(row.runAttempt)}`;
    const client = new GithubJobsClient({ token: () => deps.installationToken(installationId), fetch: deps.githubFetchForInstallation(installationId) });
    try {
      let page = 1;
      for (;;) {
        const comments = await client.listPullRequestComments(owner, repo, Number(row.prNumber), page++);
        const match = comments.find(comment => comment.body.includes(`<!-- ${marker} -->`) && comment.appId === deps.githubAppId);
        if (match) {
          await queries(deps.db).adoptUnknown.execute({ analysisId: String(row.analysisId), prNumber: Number(row.prNumber), commentId: match.id, commentUrl: match.url, commentBody: match.body });
          break;
        }
        if (comments.length < 100) break;
      }
    } catch {
      // An unknown POST is only reconciled by finding the app-owned marker; it is never reposted.
    }
  }
}

async function processClaimedAnalysis(deps: PipelineFailureAnalysisDeps, id: string): Promise<void> {
  const statements = queries(deps.db);
  const [analysis] = await statements.analysis.execute({ id });
  if (!analysis) return;
  const installationId = Number(analysis.installationId);
  if (!analysis.enabled || !analysis.available || analysis.installState !== "approved") { await statements.skip.execute({ id, errorCode: "analysis_disabled_or_unavailable" }); return; }
  if (deps.installationBlocked?.(installationId)) { await statements.skip.execute({ id, errorCode: "analysis_installation_unavailable" }); return; }
  if (!analysis.providerId || !analysis.providerIdCurrent || String(analysis.providerIdCurrent) !== String(analysis.providerId) || String(analysis.providerKindCurrent) !== String(analysis.providerKind)) { await statements.skip.execute({ id, errorCode: "analysis_provider_changed" }); return; }
  const provider: LlmProviderConfig = { id: String(analysis.providerId), name: String(analysis.providerName), kind: String(analysis.providerKind) as LlmProviderConfig["kind"], baseUrl: String(analysis.providerBaseUrl ?? ""), model: String(analysis.model), encryptedApiKey: analysis.encryptedApiKey == null ? null : String(analysis.encryptedApiKey) };
  if (!provider.baseUrl || !provider.model) { await statements.skip.execute({ id, errorCode: "analysis_provider_unavailable" }); return; }
  const fullName = String(analysis.fullName ?? ""), [owner, repoName] = fullName.split("/", 2);
  if (!owner || !repoName) { await statements.fail.execute({ id, errorCode: "analysis_repository_invalid" }); return; }
  const client = new GithubJobsClient({ token: () => deps.installationToken(installationId), fetch: deps.githubFetchForInstallation(installationId) });
  try {
    if ((await statements.superseded.execute({ id })).length || await hasNewerGithubRun(client, owner, repoName, analysis as Record<string, unknown>)) { await statements.skip.execute({ id, errorCode: "analysis_superseded" }); return; }
    const context = await capturedContext(deps.db, analysis as Record<string, unknown>, deps, client, owner, repoName);
    if ((await statements.superseded.execute({ id })).length) { await statements.skip.execute({ id, errorCode: "analysis_superseded" }); return; }
    const result = await deps.generatePipelineAnalysis({
      provider, context, secretBox: deps.secretBox,
      onRequest: async () => { await statements.markCall.execute({ id }); },
      onUsage: async usage => {
        if (usage) {
          await statements.recordUsage.execute({ id, ...usage });
          deps.onUsageUpdated?.(String(analysis.organizationId), id, usage);
        }
      },
    });
    if ((await statements.superseded.execute({ id })).length || await hasNewerGithubRun(client, owner, repoName, analysis as Record<string, unknown>)) { await statements.skip.execute({ id, errorCode: "analysis_superseded" }); return; }
    await statements.complete.execute({ id, result });
    await publish(deps, analysis as Record<string, unknown>, client, fullName, result);
  } catch (error) {
    const code = safeErrorCode(error);
    if (code === "analysis_logs_unavailable") await statements.fail.execute({ id, errorCode: code });
    else await statements.fail.execute({ id, errorCode: code });
  }
}

export async function processPipelineFailureAnalyses(deps: PipelineFailureAnalysisDeps): Promise<void> {
  const statements = queries(deps.db);
  await statements.stale.execute({});
  await statements.cancelSuperseded.execute({});
  await statements.cancelNonfailed.execute({});
  await statements.unknownComments.execute({});
  await adoptUnknownComments(deps);
  for (;;) {
    const id = await deps.db.transaction(async tx => {
      const q = queries(tx as unknown as DatabaseClient);
      const [candidate] = await q.claim.execute({});
      if (!candidate) return null;
      const [claimed] = await q.claimUpdate.execute({ id: candidate.id });
      return claimed?.id ?? null;
    });
    if (!id) return;
    await processClaimedAnalysis(deps, String(id));
  }
}
