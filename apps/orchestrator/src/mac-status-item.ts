export interface StatusItemProcess {
  readonly exited: Promise<number>;
  stdin: { end(): void };
  kill(signal?: number): void;
}
export type SpawnStatusItem = (executable: string, stateFile: string) => StatusItemProcess;

const defaultSpawn: SpawnStatusItem = (executable, stateFile) => {
  const child = Bun.spawn([executable, "--state-file", stateFile], { stdin: "pipe", stdout: "ignore", stderr: "inherit" });
  return { exited: child.exited, stdin: child.stdin, kill: signal => child.kill(signal) };
};

export class MacStatusItemSupervisor {
  private closing = false;
  private process: StatusItemProcess | undefined;
  private readonly executable: string;
  private readonly stateFile: string;
  private readonly spawn: SpawnStatusItem;
  constructor(executable: string, stateFile: string, spawn: SpawnStatusItem = defaultSpawn) {
    if (!executable || !stateFile.startsWith("/")) throw new Error("status item configuration invalid");
    this.executable = executable; this.stateFile = stateFile; this.spawn = spawn;
  }
  async run(): Promise<void> {
    while (!this.closing) {
      this.process = this.spawn(this.executable, this.stateFile);
      await this.process.exited;
      this.process = undefined;
      if (!this.closing) await Bun.sleep(1_000);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    const process = this.process;
    if (!process) return;
    process.stdin.end();
    await process.exited;
    this.process = undefined;
  }
}

export function statusItemExecutable(): string {
  const value = Bun.env.MARS_MACOS_STATUS_ITEM_EXECUTABLE;
  if (!value) throw new Error("MARS_MACOS_STATUS_ITEM_EXECUTABLE is required");
  return value;
}
