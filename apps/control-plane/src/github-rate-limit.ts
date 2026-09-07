type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RateLimitKind = "primary" | "secondary";
type GateOptions = { now?: () => number; log?: (message: string) => void };

export class GithubRateLimitError extends Error {
  readonly code = "github_rate_limited";

  constructor(readonly installationId: number, readonly resetAt: number, readonly kind: RateLimitKind = "primary") {
    super("github_rate_limited");
    this.name = "GithubRateLimitError";
  }
}

export function isGithubRateLimitError(value: unknown): value is GithubRateLimitError {
  return value instanceof GithubRateLimitError || Boolean(value && typeof value === "object" && (value as { code?: unknown }).code === "github_rate_limited");
}

type Cooldown = { resetAt: number; kind: RateLimitKind };

export class GithubRateLimitGate {
  private readonly cooldowns = new Map<number, Cooldown>();
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
        if (current < cooldown.resetAt) throw new GithubRateLimitError(installationId, cooldown.resetAt, cooldown.kind);
        this.cooldowns.delete(installationId);
        this.log(`GitHub rate limit recovered: installation=${installationId}`);
      }

      const response = await fetcher(input, init);
      const responseNow = this.now();
      const remaining = finiteHeader(response.headers.get("x-ratelimit-remaining"));
      const rateLimited = response.status === 429
        || (response.status === 403 && (remaining === 0 || await hasRateLimitMessage(response)));
      const kind: RateLimitKind = remaining === 0 ? "primary" : "secondary";
      const resetAt = kind === "primary"
        ? primaryResetAt(responseNow, finiteHeader(response.headers.get("x-ratelimit-reset")))
        : secondaryResetAt(responseNow, response.headers.get("retry-after"));

      if (remaining === 0 || rateLimited) this.enterCooldown(installationId, resetAt, kind);
      if (rateLimited) throw new GithubRateLimitError(installationId, resetAt, kind);
      return response;
    };
  }
  isCoolingDown(installationId: number): boolean {
    const cooldown = this.cooldowns.get(installationId);
    if (cooldown === undefined) return false;
    if (this.now() >= cooldown.resetAt) {
      this.cooldowns.delete(installationId);
      return false;
    }
    return true;
  }

  private enterCooldown(installationId: number, resetAt: number, kind: RateLimitKind): void {
    const existing = this.cooldowns.get(installationId);
    if (existing?.resetAt === resetAt && existing.kind === kind) return;
    this.cooldowns.set(installationId, { resetAt, kind });
    this.log(`GitHub rate limit cooldown: installation=${installationId} kind=${kind} reset=${new Date(resetAt).toISOString()}`);
  }
}

function finiteHeader(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const MAX_DATE_MS = 8_640_000_000_000_000;

function primaryResetAt(current: number, resetSeconds: number | null): number {
  if (resetSeconds === null) return current + 60_000;
  const resetAt = resetSeconds * 1_000;
  return validTimestamp(resetAt) ? Math.max(resetAt, current + 1_000) : current + 60_000;
}

function secondaryResetAt(current: number, retryAfter: string | null): number {
  const seconds = finiteHeader(retryAfter);
  const resetAt = seconds === null ? Number.NaN : current + seconds * 1_000;
  return validTimestamp(resetAt) ? resetAt : current + 60_000;
}

function validTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= -MAX_DATE_MS && value <= MAX_DATE_MS;
}

async function hasRateLimitMessage(response: Response): Promise<boolean> {
  try {
    const value: unknown = await response.clone().json();
    return Boolean(value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string" && /rate limit/i.test((value as { message: string }).message));
  } catch {
    return false;
  }
}
