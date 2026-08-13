import { createHash } from "node:crypto";
import { runOneTimeJitBootstrap } from "./bootstrap.ts";
function hash(value:Buffer):string{return createHash("sha256").update(value).digest("hex");}
if (Bun.argv[2] === "bootstrap") {
  const configPath = Bun.argv[Bun.argv.indexOf("--config-file") + 1];
  const runnerRoot = Bun.argv[Bun.argv.indexOf("--runner-root") + 1] ?? "/opt/actions-runner";
  if (!configPath) throw new Error("usage: whitesmith-job-agent bootstrap --config-file PATH [--runner-root PATH]");
  await runOneTimeJitBootstrap(configPath, runnerRoot);
} else {
  if (Bun.argv[2] !== "accept-claim" || !Bun.argv.includes("--stdin")) throw new Error("usage: whitesmith-job-agent accept-claim --stdin");
  const claim=Buffer.from(await Bun.stdin.bytes()); if(claim.length < 32) throw new Error("claim missing");
  console.log(JSON.stringify({accepted:true,claimHash:hash(claim)})); claim.fill(0);
}
