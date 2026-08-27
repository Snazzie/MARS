import { createHash } from "node:crypto";
import { cliArgument, runGuestService, runOneTimeJitBootstrap } from "./bootstrap.ts";
import { runLinuxVirtioGuest } from "./linux-guest.ts";
function hash(value:Buffer):string{return createHash("sha256").update(value).digest("hex");}
if (Bun.argv[2] === "bootstrap") {
  const configPath = cliArgument(Bun.argv, "--config-file");
  const runnerRoot = cliArgument(Bun.argv, "--runner-root") ?? "/opt/actions-runner";
  if (!configPath) throw new Error("usage: mars-job-agent bootstrap --config-file PATH [--runner-root PATH]");
  await runOneTimeJitBootstrap(configPath, runnerRoot);
} else if (Bun.argv[2] === "guest-service") {
  const platform = cliArgument(Bun.argv, "--platform") as "windows-x64" | "linux-x64";
  const bootstrapPath = cliArgument(Bun.argv, "--bootstrap-file");
  const runnerRoot = cliArgument(Bun.argv, "--runner-root") ?? (platform === "windows-x64" ? "C:\\actions-runner" : "/opt/actions-runner");
  const completionMode = cliArgument(Bun.argv, "--completion-mode") ?? "shutdown";
  if (!["windows-x64", "linux-x64"].includes(platform) || !["shutdown", "exit"].includes(completionMode) || (platform === "windows-x64" && !bootstrapPath) || (platform === "linux-x64" && bootstrapPath)) throw new Error("usage: mars-job-agent guest-service --platform windows-x64|linux-x64 --completion-mode shutdown|exit [--bootstrap-file PATH]");
  if (platform === "linux-x64") await runLinuxVirtioGuest(undefined, runnerRoot);
  else await runGuestService(platform, bootstrapPath!, runnerRoot, completionMode as "shutdown" | "exit");
} else {
  if (Bun.argv[2] !== "accept-claim" || !Bun.argv.includes("--stdin")) throw new Error("usage: mars-job-agent accept-claim --stdin");
  const claim=Buffer.from(await Bun.stdin.bytes()); if(claim.length < 32) throw new Error("claim missing");
  console.log(JSON.stringify({accepted:true,claimHash:hash(claim)})); claim.fill(0);
}
