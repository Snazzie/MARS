import { devPorts, killDevPortListeners, parseDevOptions } from "./dev-ports.ts";

const options = parseDevOptions(Bun.argv.slice(2));
if (options.kill) await killDevPortListeners(devPorts(Bun.env));

const build = Bun.spawn(["bun", "run", "build:windows-worker"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const buildExit = await build.exited;
if (buildExit !== 0) process.exit(buildExit);

const dev = Bun.spawn([
  "bun",
  "x",
  "concurrently",
  "--kill-others",
  "--names",
  "control-plane,web",
  "bun --env-file=.env run --filter @whitesmith/control-plane dev",
  "bun run --filter @whitesmith/web dev",
], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });

process.exit(await dev.exited);
