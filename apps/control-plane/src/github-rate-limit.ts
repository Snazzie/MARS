type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type GateOptions = { now?: () => number; log?: (message: string) => void };

export class GithubRateLimitError extends Error {
  readonly code = "github_rate_limited";

  constructor(readonly installationId: number, readonly resetAt: number) {
    super("github_rate_limited");
    this.name = "GithubRateLimitError";
  }
}

export function isGithubRateLimitError(value: unknown): value is GithubRateLimitError {
  return value instanceof GithubRateLimitError || Boolean(value && typeof value === "object" && (value as { code?: unknown }).code === "github_rate_limited");
}

export class GithubRateLimitGate {
  private readonly cooldowns = new Map<number, number>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(options: GateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.warn;
  }

  scopedFetch(installationId: number, fetcher: Fetcher = fetch): Fetcher {
    return async (input, init) => {
      const current = this.now();
      const cooldown = this.cooldowns.get(installationId);
      if (cooldown !== undefined) {
        if (current < cooldown) throw new GithubRateLimitError(installationId, cooldown);
        this.cooldowns.delete(installationId);
        this.log(`GitHub rate limit recovered: installation=${installationId}`);
      }

      const response = await fetcher(input, init);
      const remaining = finiteHeader(response.headers.get("x-ratelimit-remaining"));
      const resetSeconds = finiteHeader(response.headers.get("x-ratelimit-reset"));
      const resetAt = resetSeconds === null ? current + 60_000 : Math.max(resetSeconds * 1_000, current + 1_000);
      const rateLimited = (response.status === 403 || response.status === 429)
        && (remaining === 0 || await hasRateLimitMessage(response));

      if (remaining === 0 || rateLimited) this.enterCooldown(installationId, resetAt);
      if (rateLimited) throw new GithubRateLimitError(installationId, resetAt);
      return response;
    };
  }
  isCoolingDown(installationId: number): boolean {
    const cooldown = this.cooldowns.get(installationId);
    if (cooldown === undefined) return false;
    if (this.now() >= cooldown) {
      this.cooldowns.delete(installationId);
      return false;
    }
    return true;
  }

  private enterCooldown(installationId: number, resetAt: number): void {
    if (this.cooldowns.get(installationId) === resetAt) return;
    this.cooldowns.set(installationId, resetAt);
    this.log(`GitHub rate limit cooldown: installation=${installationId} reset=${new Date(resetAt).toISOString()}`);
  }
}

function finiteHeader(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function hasRateLimitMessage(response: Response): Promise<boolean> {
  try {
    const value: unknown = await response.clone().json();
    return Boolean(value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string" && /rate limit/i.test((value as { message: string }).message));
  } catch {
    return false;
  }
}
