export type WindowsServiceState = "START_PENDING" | "RUNNING" | "STOP_PENDING" | "STOPPED";
export type WindowsServiceHooks = { report(state: WindowsServiceState): void };
type WorkerMain = (signal: AbortSignal) => Promise<never>;
export async function startWindowsService(main: WorkerMain, _serviceName: string, hooks: WindowsServiceHooks = { report: () => undefined }): Promise<never> {
  const controller = new AbortController();
  const stop = () => { if (!controller.signal.aborted) { hooks.report("STOP_PENDING"); controller.abort(); } };
  hooks.report("START_PENDING"); process.once("SIGINT", stop); process.once("SIGTERM", stop); hooks.report("RUNNING");
  try { return await main(controller.signal); } finally { hooks.report("STOPPED"); }
}
