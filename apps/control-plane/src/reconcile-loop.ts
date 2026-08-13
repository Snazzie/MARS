export interface ReconciliationScheduler {
  stop(): void;
}

export function startReconciliationScheduler(run: () => Promise<void>, intervalMs = 5_000): ReconciliationScheduler {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try { await run(); } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  void tick();
  return { stop() { stopped = true; clearInterval(timer); } };
}
