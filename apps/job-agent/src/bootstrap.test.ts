import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliArgument, consumeGuestJitConfig, runGuestService, runOneTimeJitBootstrap, runnerCommandForPlatform, waitForGuestBootstrap } from "./bootstrap.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("starts run.sh from the supplied Actions Runner root", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "whitesmith-job-agent-"));
  roots.push(root);
  const configPath = join(root, "jit-config");
  const outputPath = join(root, "received-config");
  await writeFile(configPath, "encoded-jit-config\n", { mode: 0o600 });
  await writeFile(join(root, "run.sh"), `#!/bin/sh\nprintf '%s' "$ACTIONS_RUNNER_INPUT_JITCONFIG" > '${outputPath}'\nprintf 'runner-output\\n'\n`, { mode: 0o700 });
  await chmod(join(root, "run.sh"), 0o700);

  await runOneTimeJitBootstrap(configPath, root);

  expect(await Bun.file(outputPath).text()).toBe("encoded-jit-config");
  expect(await Bun.file(configPath).exists()).toBe(false);
});

test("waits for the host to copy the guest bootstrap after startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitesmith-job-agent-"));
  roots.push(root);
  const bootstrapPath = join(root, "bootstrap.json");
  let copied = false;
  const raw = await waitForGuestBootstrap(bootstrapPath, 1_000, 10, async () => {
    if (copied) return;
    copied = true;
    await writeFile(bootstrapPath, JSON.stringify({ version: 1, leaseId: "lease", nonce: "nonce", encodedJitConfig: "jit" }));
  });
  expect(JSON.parse(raw)).toMatchObject({ leaseId: "lease", encodedJitConfig: "jit" });
});

test("launches the Windows runner batch file through cmd.exe", () => {
  expect(runnerCommandForPlatform("windows-x64")).toEqual(["cmd.exe", "/c", "run.cmd"]);
  expect(runnerCommandForPlatform("linux-x64")).toEqual(["./run.sh"]);
});
test("container completion exits instead of shutting down a guest", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitesmith-job-agent-"));
  roots.push(root);
  const bootstrapPath = join(root, "bootstrap.json");
  await writeFile(bootstrapPath, JSON.stringify({ version: 1, leaseId: "lease", nonce: "nonce", encodedJitConfig: "jit" }));
  let shutdowns = 0;
  if (process.platform === "win32") {
    await writeFile(join(root, "run.cmd"), "@echo off\r\nexit /b 0\r\n");
    await runGuestService("windows-x64", bootstrapPath, root, "exit", async () => { shutdowns++; });
  } else {
    await writeFile(join(root, "run.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await runGuestService("linux-x64", bootstrapPath, root, "exit", async () => { shutdowns++; });
  }
  expect(shutdowns).toBe(0);
});
test("returns the runner process failure code to the container entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "whitesmith-job-agent-"));
  roots.push(root);
  if (process.platform === "win32") {
    await writeFile(join(root, "run.cmd"), "@echo off\r\nexit /b 17\r\n");
  } else {
    await writeFile(join(root, "run.sh"), "#!/bin/sh\nexit 17\n", { mode: 0o700 });
  }
  expect(await consumeGuestJitConfig("synthetic-jit-config", root, process.platform === "win32" ? "windows-x64" : "linux-x64")).toBe(17);
});


test("executes a supplied Windows runner command and passes its JIT config", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(join(tmpdir(), "whitesmith-job-agent-"));
  roots.push(root);
  const outputPath = join(root, "result.txt");
  await writeFile(join(root, "run.cmd"), `@echo off\r\n>\"${outputPath}\" echo %ACTIONS_RUNNER_INPUT_JITCONFIG%\r\nexit /b 0\r\n`, { mode: 0o700 });
  expect(await consumeGuestJitConfig("synthetic-jit-config", root, "windows-x64")).toBe(0);
  expect((await Bun.file(outputPath).text()).trim()).toBe("synthetic-jit-config");
});

test("does not treat the executable path as a missing optional argument", () => {
  const argv = ["C:\\ProgramData\\Whitesmith\\whitesmith-job-agent.exe", "guest-service", "--platform", "windows-x64"];
  expect(cliArgument(argv, "--runner-root")).toBeUndefined();
  expect(cliArgument(argv, "--platform")).toBe("windows-x64");
});
