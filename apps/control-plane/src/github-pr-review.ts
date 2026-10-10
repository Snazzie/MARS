type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const API_BASE = "https://api.github.com";
const isGitSha = (value: string) => /^[a-f0-9]{40,64}$/i.test(value);
const positiveInteger = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("github_payload_invalid");
  return value;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("github_payload_invalid");
  return value as Record<string, unknown>;
};
const requiredString = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("github_payload_invalid");
  return value;
};
const nullableString = (value: unknown): string | null => value === null || value === undefined ? null : requiredString(value);
const pathFor = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
export type GithubPullRequest = { number: number; state: string; draft: boolean; baseSha: string; headSha: string; title: string; body: string | null; changedFiles: number };
export type GithubPullRequestFile = { filename: string; status: string; patch: string | null; previousFilename: string | null };
export type GithubPrSource = { text: string; sha: string };
export type GithubPrReview = { id: number; body: string | null; commitId: string | null; appId: number | null; userId: number | null; userLogin: string | null };
export type GithubPrPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none";
export type GithubAppBotIdentity = { id: number; login: string };
export type GithubPrReviewComment = { path: string; line: number; start_line?: number; side: "RIGHT"; start_side?: "RIGHT"; body: string };
export type GithubPrReviewInput = { commit_id: string; body: string; event: "COMMENT"; comments: GithubPrReviewComment[] };

/** Installation-authenticated, narrowly scoped PR review API. */
export class GithubPrReviewClient {
  private readonly token: () => Promise<string>;
  private readonly fetcher: Fetcher;
  constructor(token: () => Promise<string>, fetcher: Fetcher = fetch) {
    this.token = token;
    this.fetcher = fetcher;
  }
  private async response(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json");
    headers.set("x-github-api-version", "2022-11-28");
    headers.set("authorization", `Bearer ${await this.token()}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.fetcher(`${API_BASE}${path}`, { ...init, headers, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`github_${response.status}`);
    return response;
  }
  private async parseJson(response: Response): Promise<unknown> {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_JSON_BYTES) throw new Error("github_response_too_large");
    if (!response.body) throw new Error("github_payload_invalid");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error("github_response_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  private async json(path: string): Promise<unknown> {
    return this.parseJson(await this.response(path));
  }
  async getPullRequest(owner: string, repo: string, number: number): Promise<GithubPullRequest> {
    const item = object(await this.json(`${pathFor(owner, repo)}/pulls/${positiveInteger(number)}`));
    const base = object(item.base), head = object(item.head);
    const baseSha = requiredString(base.sha), headSha = requiredString(head.sha);
    if (!isGitSha(baseSha) || !isGitSha(headSha)) throw new Error("github_payload_invalid");
    return {
      number: positiveInteger(item.number), state: requiredString(item.state), draft: typeof item.draft === "boolean" ? item.draft : (() => { throw new Error("github_payload_invalid"); })(),
      baseSha, headSha, title: requiredString(item.title), body: nullableString(item.body), changedFiles: typeof item.changed_files === "number" && Number.isSafeInteger(item.changed_files) && item.changed_files >= 0 ? item.changed_files : (() => { throw new Error("github_payload_invalid"); })(),
    };
  }
  async files(owner: string, repo: string, number: number): Promise<GithubPullRequestFile[]> {
    const value = await this.json(`${pathFor(owner, repo)}/pulls/${positiveInteger(number)}/files?per_page=100&page=1`);
    if (!Array.isArray(value)) throw new Error("github_payload_invalid");
    return value.map(raw => {
      const item = object(raw);
      return { filename: requiredString(item.filename), status: requiredString(item.status), patch: nullableString(item.patch), previousFilename: nullableString(item.previous_filename) };
    });
  }
  async source(owner: string, repo: string, path: string, sha: string): Promise<GithubPrSource | null> {
    return this.getContent(owner, repo, path, sha);
  }
  async getContent(owner: string, repo: string, path: string, sha: string): Promise<GithubPrSource | null> {
    const segments = path.split("/");
    if (!path || path.startsWith("/") || segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))) throw new Error("github_path_invalid");
    if (!isGitSha(sha)) throw new Error("github_sha_invalid");
    const encodedPath = segments.map(encodeURIComponent).join("/");
    const response = await this.fetcher(`${API_BASE}${pathFor(owner, repo)}/contents/${encodedPath}?ref=${encodeURIComponent(sha)}`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${await this.token()}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`github_${response.status}`);
    const item = object(await this.parseJson(response));
    if (item.type !== "file" || item.encoding !== "base64") throw new Error("github_content_unsupported");
    const encoded = requiredString(item.content).replace(/\s/g, "");
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.byteLength > MAX_SOURCE_BYTES) throw new Error("github_source_too_large");
    if (decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new Error("github_payload_invalid");
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(decoded), sha: requiredString(item.sha) };
  }
  async reviews(owner: string, repo: string, number: number): Promise<GithubPrReview[]> {
    const all: GithubPrReview[] = [];
    for (let page = 1; page <= 100; page++) {
      const value = await this.json(`${pathFor(owner, repo)}/pulls/${positiveInteger(number)}/reviews?per_page=100&page=${page}`);
      if (!Array.isArray(value)) throw new Error("github_payload_invalid");
      for (const raw of value) {
        const item = object(raw);
        const app = item.performed_via_github_app == null ? null : object(item.performed_via_github_app);
        const user = item.user == null ? null : object(item.user);
        const userId = user?.id == null ? null : positiveInteger(user.id);
        all.push({ id: positiveInteger(item.id), body: nullableString(item.body), commitId: nullableString(item.commit_id), appId: app ? positiveInteger(app.id) : null, userId, userLogin: user ? nullableString(user.login) : null });
      }
      if (value.length < 100) return all;
    }
    throw new Error("github_reviews_too_many");
  }
  async getAppBotIdentity(slug: string): Promise<GithubAppBotIdentity> {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(slug)) throw new Error("github_app_slug_invalid");
    const appSlug = slug.toLowerCase();
    const item = object(await this.json(`/users/${encodeURIComponent(`${appSlug}[bot]`)}`));
    const login = requiredString(item.login);
    if (item.type !== "Bot" || login.toLowerCase() !== `${appSlug}[bot]`) throw new Error("github_payload_invalid");
    return { id: positiveInteger(item.id), login };
  }
  async permission(owner: string, repo: string, login: string): Promise<GithubPrPermission> {
    try {
      const item = object(await this.json(`${pathFor(owner, repo)}/collaborators/${encodeURIComponent(login)}/permission`));
      const permission = requiredString(item.permission);
      if (["admin", "maintain", "write", "triage", "read", "none"].includes(permission)) return permission as GithubPrPermission;
      throw new Error("github_payload_invalid");
    } catch (error) {
      if (error instanceof Error && error.message === "github_404") return "none";
      throw error;
    }
  }
  async acknowledgeComment(owner: string, repo: string, commentId: number): Promise<void> {
    await this.response(`${pathFor(owner, repo)}/issues/comments/${positiveInteger(commentId)}/reactions`, { method: "POST", body: JSON.stringify({ content: "+1" }) });
  }
  async publish(owner: string, repo: string, number: number, input: GithubPrReviewInput): Promise<{ id: number; url: string }> {
    if (input.event !== "COMMENT" || !isGitSha(input.commit_id)) throw new Error("github_pr_review_input_invalid");
    const item = object(await this.parseJson(await this.response(`${pathFor(owner, repo)}/pulls/${positiveInteger(number)}/reviews`, { method: "POST", body: JSON.stringify(input) })));
    return { id: positiveInteger(item.id), url: requiredString(item.html_url) };
  }
}
