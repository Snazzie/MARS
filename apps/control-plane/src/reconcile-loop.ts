export interface ReconciliationScheduler {
  stop(): void;
  trigger(): Promise<void>;
  status(): { running: boolean; pending: boolean; nextTickAt: number | null; intervalMs: number };
}

export function startReconciliationScheduler(run: () => Promise<void>, intervalMs = 5_000, runImmediately = true): ReconciliationScheduler {
  let stopped = false;
  let running = false;
  let rerun = false;
  let waiters: (() => void)[] = [];
  let nextTickAt = Date.now() + intervalMs;
  const tick = async (waitForRerun = false) => {
    if (stopped) return;
    if (running) {
      rerun = true;
      if (waitForRerun) await new Promise<void>((resolve) => waiters.push(resolve));
      return;
    }
    running = true;
    try { await run(); } finally {
      running = false;
      if (rerun) {
        rerun = false;
        const pending = waiters;
        waiters = [];
        void tick().finally(() => { for (const resolve of pending) resolve(); });
      }
    }
  };
  const timer = setInterval(() => { nextTickAt = Date.now() + intervalMs; void tick(); }, intervalMs);
  if (runImmediately) void tick();
  return { stop() { stopped = true; clearInterval(timer); nextTickAt = 0; }, trigger: () => tick(true),
    status: () => ({ running, pending: rerun, nextTickAt: stopped ? null : nextTickAt, intervalMs }) };
}
