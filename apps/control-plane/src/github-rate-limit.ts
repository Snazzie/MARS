type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type GithubRateLimitRequestClass = "background" | "dispatch";
type RateLimitKind = "primary" | "secondary";
type GateOptions = { now?: () => number; log?: (message: string) => void };

export class GithubRateLimitError extends Error {
  readonly code = "github_rate_limited";

  constructor(readonly installationId: number, readonly resetAt: number, readonly kind: RateLimitKind | "reserved" = "primary") {
    super("github_rate_limited");
    this.name = "GithubRateLimitError";
  }
}

export function isGithubRateLimitError(value: unknown): value is GithubRateLimitError {
  return value instanceof GithubRateLimitError || Boolean(value && typeof value === "object" && (value as { code?: unknown }).code === "github_rate_limited");
}

type Cooldown = { resetAt: number; kind: RateLimitKind };
type Budget = { remaining: number; resetAt: number };

export class GithubRateLimitGate {
  private readonly cooldowns = new Map<number, Cooldown>();
  private readonly budgets = new Map<number, Budget>();
  private readonly inFlight = new Map<number, number>();
  private readonly reserveLogs = new Map<number, number>();
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(options: GateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? console.warn;
  }

  scopedFetch(installationId: number, requestClass: GithubRateLimitRequestClass, fetcher: Fetcher = fetch): Fetcher {
    return async (input, init) => {
      const current = this.now();
      const cooldown = this.cooldowns.get(installationId);
      if (cooldown !== undefined) {
        if (current < cooldown.resetAt) throw new GithubRateLimitError(installationId, cooldown.resetAt, cooldown.kind);
        this.cooldowns.delete(installationId);
        this.log(`GitHub rate limit recovered: installation=${installationId}`);
      }
      const budget = this.activeBudget(installationId, current);
      if (requestClass === "background" && budget !== undefined && this.reserveBlocks(installationId, budget)) {
        throw new GithubRateLimitError(installationId, budget.resetAt, "reserved");
      }
      this.inFlight.set(installationId, (this.inFlight.get(installationId) ?? 0) + 1);
      try {
        const response = await fetcher(input, init);
        const responseNow = this.now();
        const remaining = finiteHeader(response.headers.get("x-ratelimit-remaining"));
        const resetSeconds = finiteHeader(response.headers.get("x-ratelimit-reset"));
        const existing = this.activeBudget(installationId, responseNow);
        const headerResetAt = resetSeconds === null ? null : resetSeconds * 1_000;
        const resetAt = headerResetAt !== null && validTimestamp(headerResetAt) && headerResetAt > responseNow ? headerResetAt : existing?.resetAt;
        if (remaining !== null && resetAt !== undefined && resetAt > responseNow) {
          this.budgets.set(installationId, { remaining, resetAt });
        } else if (existing !== undefined && remaining !== null) {
          existing.remaining = remaining;
        } else if (existing !== undefined && resetAt !== undefined) {
          existing.resetAt = resetAt;
        }
        const rateLimited = response.status === 429
          || (response.status === 403 && (remaining === 0 || await hasRateLimitMessage(response)));
        const kind: RateLimitKind = remaining === 0 ? "primary" : "secondary";
        const limitResetAt = kind === "primary"
          ? primaryResetAt(responseNow, resetSeconds)
          : secondaryResetAt(responseNow, response.headers.get("retry-after"));
        if (remaining === 0 || rateLimited) this.enterCooldown(installationId, limitResetAt, kind);
        if (rateLimited) throw new GithubRateLimitError(installationId, limitResetAt, kind);
        return response;
      } finally {
        const remainingInFlight = (this.inFlight.get(installationId) ?? 1) - 1;
        if (remainingInFlight === 0) this.inFlight.delete(installationId);
        else this.inFlight.set(installationId, remainingInFlight);
      }
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
  isBackgroundBlocked(installationId: number): boolean {
    if (this.isCoolingDown(installationId)) return true;
    const budget = this.activeBudget(installationId, this.now());
    return budget !== undefined && this.reserveBlocks(installationId, budget);
  }
  private activeBudget(installationId: number, current: number): Budget | undefined {
    const budget = this.budgets.get(installationId);
    if (budget === undefined || current < budget.resetAt) return budget;
    this.budgets.delete(installationId);
    if (this.reserveLogs.get(installationId) === budget.resetAt) this.reserveLogs.delete(installationId);
    return undefined;
  }
  private reserveBlocks(installationId: number, budget: Budget): boolean {
    const inFlight = this.inFlight.get(installationId) ?? 0;
    if (budget.remaining - inFlight > 100) return false;
    if (this.reserveLogs.get(installationId) !== budget.resetAt) {
      this.reserveLogs.set(installationId, budget.resetAt);
      this.log(`GitHub rate limit reserve: installation=${installationId} remaining=${budget.remaining} inFlight=${inFlight} reset=${new Date(budget.resetAt).toISOString()}`);
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
