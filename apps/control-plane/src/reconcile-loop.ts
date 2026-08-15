export interface ReconciliationScheduler {
  stop(): void;
  trigger(): Promise<void>;
}

export function startReconciliationScheduler(run: () => Promise<void>, intervalMs = 5_000): ReconciliationScheduler {
  let stopped = false;
  let running = false;
  let rerun = false;
  let waiters: (() => void)[] = [];
  const tick = async () => {
    if (stopped) return;
    if (running) {
      rerun = true;
      await new Promise<void>((resolve) => waiters.push(resolve));
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
  const timer = setInterval(() => { void tick(); }, intervalMs);
  void tick();
  return { stop() { stopped = true; clearInterval(timer); }, trigger: tick };
}
