import { watch, type FSWatcher } from "node:fs";

const childCommand = ["bun", "--watch", "run", "apps/control-plane/src/index.ts"];
let child: Bun.Subprocess | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restarting = false;
let stopping = false;
let envWatcher: FSWatcher | null = null;

const loadDotEnv = async () => {
  const values: Record<string, string> = {};
  const text = await Bun.file(".env").text();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    const value = match[2].trim();
    values[match[1]] = value.replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
};

const launch = async () => {
  const env = { ...process.env, ...(await loadDotEnv()) } as Record<string, string>;
  child = Bun.spawn(childCommand, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  void child.exited.then((exitCode) => {
    child = null;
    if (stopping) {
      process.exit(exitCode);
    }
    if (restarting) {
      restarting = false;
      void launch();
      return;
    }
    process.exit(exitCode);
  });
};

const restart = () => {
  if (stopping || restarting) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    restarting = true;
    child?.kill();
  }, 100);
};

envWatcher = watch(".env", restart);

envWatcher.on("error", (error) => {
  console.error(".env watcher failed", error);
  stopping = true;
  child?.kill();
  process.exitCode = 1;
});

const stop = () => {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  envWatcher?.close();
  child?.kill();
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

void launch();

