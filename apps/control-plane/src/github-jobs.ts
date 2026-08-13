import { RunnerJitConfig } from "@whitesmith/contracts";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type GithubJobsClientOptions = { token: () => Promise<string>; fetch?: Fetcher; apiBase?: string };
export type GenerateJitConfigInput = { owner: string; repo: string; runnerName: string; runnerGroupId?: number; workFolder: string; labels: string[] };
export type QueuedGithubJob = { id: number; runId: number; name: string; labels: string[]; status: "queued" | "in_progress" | "completed"; repository: string };

export class GithubJobsClient {
  private readonly token: () => Promise<string>;
  private readonly fetcher: Fetcher;
  private readonly apiBase: string;
  constructor(options: GithubJobsClientOptions) {
    this.token = options.token;
    this.fetcher = options.fetch ?? fetch;
    this.apiBase = options.apiBase ?? "https://api.github.com";
  }
  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json");
    headers.set("content-type", "application/json");
    headers.set("x-github-api-version", "2026-03-10");
    headers.set("authorization", `Bearer ${await this.token()}`);
    const response = await this.fetcher(`${this.apiBase}${path}`, { ...init, headers });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error("github_installation_token_lacks_administration_write");
      throw new Error(`github_${response.status}`);
    }
    const value: unknown = response.status === 204 ? {} : await response.json();
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  }
  async generateJitConfig(input: GenerateJitConfigInput): Promise<RunnerJitConfig> {
    if (!input.labels.length) throw new Error("github_jit_labels_missing");
    const result = await this.request(`/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/actions/runners/generate-jitconfig`, {
      method: "POST",
      body: JSON.stringify({ name: input.runnerName, runner_group_id: input.runnerGroupId ?? 1, work_folder: input.workFolder, labels: input.labels }),
    });
    const config = RunnerJitConfig.safeParse({ encodedJitConfig: result.encoded_jit_config, runnerName: input.runnerName, labels: input.labels, expiresAt: new Date(Date.now() + 55 * 60_000).toISOString() });
    if (!config.success) throw new Error("github_jit_config_missing");
    return config.data;
  }
}
