import {
  acquireDevLock,
  devPorts,
  killDevPortListeners,
  killRecordedDevSupervisor,
  parseDevOptions,
} from "./dev-ports.ts";

const options = parseDevOptions(Bun.argv.slice(2));
const ports = devPorts(Bun.env);
if (options.kill) {
  await killRecordedDevSupervisor();
  await killDevPortListeners(ports);
}

const lock = acquireDevLock();
let stopping = false;
const release = () => {
  if (stopping) return;
  stopping = true;
  lock.release();
};
process.once("SIGINT", release);
process.once("SIGTERM", release);

try {
  const build = Bun.spawn(["bun", "run", "build:windows-worker"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const buildExit = await build.exited;
  if (buildExit !== 0) process.exitCode = buildExit;
  else {
    const dev = Bun.spawn([
      "bun",
      "x",
      "concurrently",
      "--kill-others-on-fail",
      "--names",
      "control-plane,web",
      "bun run scripts/control-plane-dev.ts",
      "bun run --filter @mars/web dev",
    ], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exitCode = await dev.exited;
  }
} finally {
  release();
}
