import { RunnerJitConfig } from "@mars/contracts";
import type { GithubJobSnapshot, GithubRunSnapshot, GithubStepSnapshot } from "./runs.ts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type GithubJobsClientOptions = { token: () => Promise<string>; fetch?: Fetcher; apiBase?: string };
export type GenerateJitConfigInput = { owner: string; repo: string; runnerName: string; runnerGroupId?: number; workFolder: string; labels: string[] };
export type QueuedGithubJob = { id: number; runId: number; name: string; labels: string[]; status: "queued" | "in_progress" | "completed"; repository: string };

const runStatus = (value: unknown): GithubRunSnapshot["status"] => value === "completed" ? "completed" : value === "in_progress" ? "in_progress" : "queued";
const jobStatus = (value: unknown): GithubJobSnapshot["status"] => value === "completed" ? "completed" : value === "in_progress" ? "in_progress" : "queued";
const stringValue = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const nullableString = (value: unknown) => typeof value === "string" ? value : null;
const positiveSafeInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("github_payload_invalid");
  return value;
};
const labelsValue = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const parseSteps = (value: unknown, fallbackQueuedAt: string): GithubStepSnapshot[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("github_payload_invalid");
  return value.map((raw): GithubStepSnapshot => {
    if (!raw || typeof raw !== "object") throw new Error("github_payload_invalid");
    const item = raw as Record<string, unknown>;
    if (typeof item.number !== "number" || !Number.isSafeInteger(item.number) || item.number <= 0) throw new Error("github_payload_invalid");
    const number = item.number;
    const rawStatus = item.status;
    const status = rawStatus === "queued" || rawStatus === "requested" || rawStatus === "waiting" || rawStatus === "pending" ? "queued" : rawStatus === "in_progress" ? "in_progress" : rawStatus === "completed" ? "completed" : null;
    if (!status) throw new Error("github_payload_invalid");
    const queuedAt = nullableString(item.created_at) ?? fallbackQueuedAt;
    const startedAt = status === "queued" ? null : nullableString(item.started_at);
    const completedAt = status === "completed" ? nullableString(item.completed_at) : null;
    const startMs = startedAt ? Date.parse(startedAt) : NaN, endMs = completedAt ? Date.parse(completedAt) : NaN;
    return { id: item.id === undefined || item.id === null ? null : String(item.id), number, name: stringValue(item.name, `step-${number}`), status, conclusion: nullableString(item.conclusion), queuedAt, startedAt, completedAt, durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0 };
  });
};

export class GithubJobsClient {
  private readonly token: () => Promise<string>;
  private readonly fetcher: Fetcher;
  private readonly apiBase: string;
  constructor(options: GithubJobsClientOptions) { this.token = options.token; this.fetcher = options.fetch ?? fetch; this.apiBase = options.apiBase ?? "https://api.github.com"; }
  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json"); headers.set("content-type", "application/json"); headers.set("x-github-api-version", "2026-03-10"); headers.set("authorization", `Bearer ${await this.token()}`);
    const response = await this.fetcher(`${this.apiBase}${path}`, { ...init, headers });
    if (!response.ok) { console.error(`GitHub jobs request failed: ${response.status} ${path}`); throw new Error(`github_${response.status}`); }
    const value: unknown = response.status === 204 ? {} : await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }
  private async requestText(path: string, maxBytes: number): Promise<string> {
    const headers = new Headers();
    headers.set("accept", "application/vnd.github+json");
    headers.set("x-github-api-version", "2026-03-10");
    headers.set("authorization", `Bearer ${await this.token()}`);
    const response = await this.fetcher(`${this.apiBase}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      if (response.status !== 404) console.error(`GitHub jobs request failed: ${response.status} ${path}`);
      throw new Error(`github_${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("github_job_log_too_large");
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("github_job_log_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }
  private parseRun(value: Record<string, unknown>): GithubRunSnapshot {
    const id = positiveSafeInteger(value.id);
    const runAttempt = positiveSafeInteger(value.run_attempt);
    return { id, runAttempt, runNumber: Number(value.run_number) || id, workflowName: stringValue(value.name, stringValue(value.display_title, "workflow")), event: stringValue(value.event), branch: stringValue(value.head_branch), commitSha: stringValue(value.head_sha), actorLogin: stringValue((value.actor as Record<string, unknown> | undefined)?.login, "github"), status: runStatus(value.status), conclusion: nullableString(value.conclusion), queuedAt: stringValue(value.created_at, new Date().toISOString()), startedAt: nullableString(value.run_started_at), completedAt: nullableString(value.status === "completed" ? value.updated_at : null) };
  }
  private parseJob(value: Record<string, unknown>): GithubJobSnapshot {
    const id = positiveSafeInteger(value.id);
    const runId = positiveSafeInteger(value.run_id);
    const runAttempt = positiveSafeInteger(value.run_attempt);
    const status = jobStatus(value.status);
    return { id, runId, runAttempt, name: stringValue(value.name, "job"), status, conclusion: nullableString(value.conclusion), labels: labelsValue(value.labels), runnerName: nullableString(value.runner_name), queuedAt: stringValue(value.created_at, new Date().toISOString()), startedAt: status === "queued" ? null : nullableString(value.started_at), completedAt: status === "completed" ? nullableString(value.completed_at) : null, steps: parseSteps(value.steps, stringValue(value.created_at, new Date().toISOString())) };
  }
  async listRuns(owner: string, repo: string, status: "queued" | "pending" | "in_progress" | "completed" | undefined, page: number): Promise<{ totalCount: number; runs: GithubRunSnapshot[] }> {
    const statusQuery = status ? `status=${status}&` : "";
    const value = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs?${statusQuery}per_page=100&page=${page}`);
    const runs = Array.isArray(value.workflow_runs) ? value.workflow_runs.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object")).map(x => this.parseRun(x)) : [];
    return { totalCount: Number(value.total_count) || runs.length, runs };
  }
  async getRun(owner: string, repo: string, runId: number): Promise<GithubRunSnapshot> { return this.parseRun(await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}`)); }
  async getRunAttempt(owner: string, repo: string, runId: number, runAttempt: number): Promise<GithubRunSnapshot> {
    const run = this.parseRun(await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/attempts/${runAttempt}`));
    if (run.id !== runId || run.runAttempt !== runAttempt) throw new Error("github_payload_invalid");
    return run;
  }
  async getJob(owner: string, repo: string, jobId: number): Promise<GithubJobSnapshot> { return this.parseJob(await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}`)); }
  async listJobs(owner: string, repo: string, runId: number, runAttempt: number, page: number): Promise<{ totalCount: number; jobs: GithubJobSnapshot[] }> {
    const value = await this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}`);
    const jobs = Array.isArray(value.jobs) ? value.jobs.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object")).map(x => this.parseJob(x)) : [];
    if (jobs.some(job => job.runId !== runId || job.runAttempt !== runAttempt)) throw new Error("github_payload_invalid");
    return { totalCount: Number(value.total_count) || jobs.length, jobs };
  }
  async getJobLogs(owner: string, repo: string, jobId: number, maxBytes = 10 * 1024 * 1024): Promise<string> {
    return this.requestText(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}/logs`, maxBytes);
  }
  async generateJitConfig(input: GenerateJitConfigInput): Promise<RunnerJitConfig> {
    if (!input.labels.length) throw new Error("github_jit_labels_missing");
    const result = await this.request(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/runners/generate-jitconfig`, { method: "POST", body: JSON.stringify({ name: input.runnerName, runner_group_id: input.runnerGroupId ?? 1, work_folder: input.workFolder, labels: input.labels }) });
    const config = RunnerJitConfig.safeParse({ encodedJitConfig: result.encoded_jit_config, runnerName: input.runnerName, labels: input.labels, expiresAt: new Date(Date.now() + 55 * 60_000).toISOString() });
    if (!config.success) throw new Error("github_jit_config_missing");
    return config.data;
  }
}
