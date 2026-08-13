export type DiscoveryHealthSnapshot = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  stale: boolean;
  staleAfterMs: number;
};
export function isDiscoveryCycleSuccessful(report: { repositories: number; failed: number }): boolean {
  return report.repositories === 0 || report.failed < report.repositories;
}


export class DiscoveryHealthMonitor {
  private readonly staleAfterMs: number;
  private readonly startedAt: number;
  private lastAttemptAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private staleAlerted = false;

  constructor(intervalMs: number, startedAt = Date.now()) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("discovery_interval_invalid");
    this.staleAfterMs = intervalMs * 2;
    this.startedAt = startedAt;
  }

  markAttempt(at = Date.now()): void {
    this.lastAttemptAt = at;
  }

  markSuccess(at = Date.now()): void {
    this.lastSuccessAt = at;
    this.staleAlerted = false;
  }

  snapshot(at = Date.now()): DiscoveryHealthSnapshot {
    const freshnessAnchor = this.lastSuccessAt ?? this.startedAt;
    return {
      lastAttemptAt: this.lastAttemptAt === null ? null : new Date(this.lastAttemptAt).toISOString(),
      lastSuccessAt: this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
      stale: at - freshnessAnchor >= this.staleAfterMs,
      staleAfterMs: this.staleAfterMs,
    };
  }

  consumeStaleAlert(at = Date.now()): boolean {
    if (!this.snapshot(at).stale || this.staleAlerted) return false;
    this.staleAlerted = true;
    return true;
  }
}
