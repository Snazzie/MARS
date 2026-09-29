export type DispatchPoolDetail = { poolId: string; poolName: string; platform: string; workerId?: string; workerName?: string; reason: string };
export type DispatchDecision = { organizationId: string; jobId: number; code: string; labels?: string[]; pools?: DispatchPoolDetail[]; repository?: string; githubRunId?: string; jobName?: string };
export type DispatchHealthSnapshot = {
  state: "starting" | "healthy" | "degraded";
  lastReconciledAt: string | null;
  queued: number;
  reserved: number;
  reasons: Array<{ code: string; count: number }>;
  healthReason?: "reconciliation_failed" | "reconciliation_stale";
  inProgressSince?: string;
  failureCode?: string;
  blockedJobs?: Array<{ jobId: number; code: string; labels: string[]; pools?: DispatchPoolDetail[]; repository?: string; githubRunId?: string; jobName?: string }>;
};

export class DispatchHealthMonitor {
  private lastSuccessAt: number | null = null;
  private failed = false;
  private inProgressAt: number | null = null;
  private failureCode: string | null = null;
  private decisions = new Map<string, DispatchDecision>();

  constructor(private readonly intervalMs: number, private readonly startedAt = Date.now()) {}

  markStarted(at = Date.now()): void { this.inProgressAt = at; }

  markSuccess(decisions: readonly DispatchDecision[], at = Date.now()): void {
    const next = new Map(decisions.map(decision => [`${decision.organizationId}:${decision.jobId}`, decision]));
    for (const [key, decision] of next) {
      const previous = this.decisions.get(key);
      if ((previous?.code !== decision.code || JSON.stringify(previous?.labels) !== JSON.stringify(decision.labels) || JSON.stringify(previous?.pools) !== JSON.stringify(decision.pools)) && decision.code !== "dispatched") {
        console.log("Job dispatch blocked", { organizationId: decision.organizationId, jobId: decision.jobId, reason: decision.code, ...(decision.labels ? { labels: decision.labels } : {}), ...(decision.pools ? { pools: decision.pools } : {}) });
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
    this.inProgressAt = null;
    this.failureCode = null;
  }

  markFailure(error?: unknown): void {
    this.failed = true;
    this.inProgressAt = null;
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    this.failureCode = typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? `SQLSTATE ${code}` : error instanceof TypeError ? "network_error" : "unexpected_error";
  }

  snapshot(organizationIds: readonly string[] | null, at = Date.now()): DispatchHealthSnapshot {
    const allowed = organizationIds === null ? null : new Set(organizationIds);
    const decisions = [...this.decisions.values()].filter(decision => allowed === null || allowed.has(decision.organizationId));
    const counts = new Map<string, number>();
    for (const decision of decisions) {
      if (decision.code !== "dispatched") counts.set(decision.code, (counts.get(decision.code) ?? 0) + 1);
    }
    const healthReason = this.failed ? "reconciliation_failed" : at - (this.lastSuccessAt ?? this.startedAt) > this.intervalMs * 3 ? "reconciliation_stale" : undefined;
    return {
      state: healthReason ? "degraded" : this.lastSuccessAt === null ? "starting" : "healthy",
      lastReconciledAt: this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
      queued: decisions.length,
      reserved: decisions.filter(decision => decision.code === "dispatched").length,
      reasons: [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
      ...(healthReason ? { healthReason } : {}),
      ...(this.inProgressAt === null ? {} : { inProgressSince: new Date(this.inProgressAt).toISOString() }),
      ...(healthReason === "reconciliation_failed" && this.failureCode ? { failureCode: this.failureCode } : {}),
      blockedJobs: decisions.filter(decision => decision.code !== "dispatched").map(({ jobId, code, labels, pools, repository, githubRunId, jobName }) => ({ jobId, code, labels: labels ?? [], ...(pools?.length ? { pools } : {}), ...(repository && githubRunId && jobName ? { repository, githubRunId, jobName } : {}) })),
    };
  }
}
