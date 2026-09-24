export type DispatchDecision = { organizationId: string; jobId: number; code: string; labels?: string[] };
export type DispatchHealthSnapshot = {
  state: "starting" | "healthy" | "degraded";
  lastReconciledAt: string | null;
  queued: number;
  reserved: number;
  reasons: Array<{ code: string; count: number }>;
};

export class DispatchHealthMonitor {
  private lastSuccessAt: number | null = null;
  private failed = false;
  private decisions = new Map<string, DispatchDecision>();

  constructor(private readonly intervalMs: number, private readonly startedAt = Date.now()) {}

  markSuccess(decisions: readonly DispatchDecision[], at = Date.now()): void {
    const next = new Map(decisions.map(decision => [`${decision.organizationId}:${decision.jobId}`, decision]));
    for (const [key, decision] of next) {
      const previous = this.decisions.get(key);
      if ((previous?.code !== decision.code || (decision.code === "no_matching_labels" && JSON.stringify(previous?.labels) !== JSON.stringify(decision.labels))) && decision.code !== "dispatched") {
        console.log("Job dispatch blocked", { organizationId: decision.organizationId, jobId: decision.jobId, reason: decision.code, ...(decision.code === "no_matching_labels" ? { labels: decision.labels } : {}) });
      }
    }
    for (const [key, previous] of this.decisions) {
      if (previous.code !== "dispatched" && (!next.has(key) || next.get(key)?.code === "dispatched")) {
        console.log("Job dispatch blocker cleared", { organizationId: previous.organizationId, jobId: previous.jobId, priorReason: previous.code });
      }
    }
    this.decisions = next;
    this.lastSuccessAt = at;
    this.failed = false;
  }

  markFailure(): void { this.failed = true; }

  snapshot(organizationIds: readonly string[] | null, at = Date.now()): DispatchHealthSnapshot {
    const allowed = organizationIds === null ? null : new Set(organizationIds);
    const decisions = [...this.decisions.values()].filter(decision => allowed === null || allowed.has(decision.organizationId));
    const counts = new Map<string, number>();
    for (const decision of decisions) {
      if (decision.code !== "dispatched") counts.set(decision.code, (counts.get(decision.code) ?? 0) + 1);
    }
    return {
      state: this.failed || at - (this.lastSuccessAt ?? this.startedAt) > this.intervalMs * 3 ? "degraded" : this.lastSuccessAt === null ? "starting" : "healthy",
      lastReconciledAt: this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
      queued: decisions.length,
      reserved: decisions.filter(decision => decision.code === "dispatched").length,
      reasons: [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    };
  }
}
