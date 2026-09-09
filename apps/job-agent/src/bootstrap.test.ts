import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliArgument, consumeGuestJitConfig, consumeGuestJitConfigWithWorkerCache, mergeBunInstallCa, runGuestService, runOneTimeJitBootstrap, runnerCommandForPlatform, waitForGuestBootstrap } from "./bootstrap.ts";

const roots: string[] = [];
const workerCache = {
  proxyUrl: "http://lease-user:lease-secret@127.0.0.1:3128",
  cacheBaseUrl: "https://127.0.0.1:8443",
  caCertificatePem: "-----BEGIN CERTIFICATE-----\nworker-ca\n-----END CERTIFICATE-----\n",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  registrationUrl: "https://127.0.0.1:8443/_mars/register",
  registrationChallenge: "c".repeat(32),
};
const writeWorkerCacheCapability = (root: string) => writeFile(join(root, ".mars-capabilities.json"), JSON.stringify({ schemaVersion: 1, capabilities: ["mars-worker-cache-registration-v1"] }));


afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
test("merges a temporary Bun install CA without retaining conflicting CA settings", () => {
  const merged = mergeBunInstallCa("[install]\nregistry = \"https://registry.npmjs.org\"\nca = \"old\"\ncafile = \"old.pem\"\n[run]\nshell = \"system\"\n", "C:\\cache\\combined-ca.pem");
  expect(merged).toContain("[install]\ncafile = \"C:/cache/combined-ca.pem\"\nregistry = \"https://registry.npmjs.org\"");
  expect(merged).not.toContain("ca = \"old\"");
  expect(merged).not.toContain("cafile = \"old.pem\"");
  expect(merged).toContain("[run]\nshell = \"system\"");
});

test("rejects an unpatched runner before installing guest trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-job-agent-"));
  roots.push(root);
  await expect(consumeGuestJitConfigWithWorkerCache("encoded-jit-config", root, "linux-x64", workerCache)).rejects.toThrow("mars-worker-cache-registration-v1");
});


test("starts run.sh from the supplied Actions Runner root", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "mars-job-agent-"));
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

test("official runner receives worker cache proxy variables and a temporary CA", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "mars-job-agent-"));
  roots.push(root);
  await writeWorkerCacheCapability(root);
  const outputPath = join(root, "cache-env");
  await writeFile(join(root, "run.sh"), `#!/bin/sh
printf '%s\n%s\n%s\n%s\n' "$HTTP_PROXY" "$http_proxy" "$HTTPS_PROXY" "$https_proxy" > '${outputPath}'
printf '%s\n' "$NO_PROXY" "$no_proxy" >> '${outputPath}'
printf '%s\n' "$NODE_EXTRA_CA_CERTS" "$node_extra_ca_certs" >> '${outputPath}'
printf '%s\n' "$GIT_SSL_BACKEND" "$GIT_SSL_CAINFO" >> '${outputPath}'
test -s "$NODE_EXTRA_CA_CERTS"
cat "$NODE_EXTRA_CA_CERTS" >> '${outputPath}'
`, { mode: 0o700 });
  await chmod(join(root, "run.sh"), 0o700);

  await consumeGuestJitConfigWithWorkerCache("encoded-jit-config", root, "linux-x64", workerCache);

  const output = await Bun.file(outputPath).text();
  expect(output).toContain(`${workerCache.proxyUrl}\n${workerCache.proxyUrl}\n${workerCache.proxyUrl}\n${workerCache.proxyUrl}\n`);
  expect(new URL(workerCache.proxyUrl).username).not.toBe("");
  expect(new URL(workerCache.proxyUrl).password).not.toBe("");
  expect(output).toContain(`${workerCache.caCertificatePem}`);
  expect(output).toContain("openssl\n");
  const caPath = output.split("\n")[6];
  expect(caPath).toBeTruthy();
  expect(await Bun.file(caPath).exists()).toBe(false);
});
test("Windows run.cmd descendant receives worker cache environment", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(join(tmpdir(), "mars-job-agent-"));
  roots.push(root);
  await writeWorkerCacheCapability(root);
  const outputPath = join(root, "cache-env.txt");
  await writeFile(join(root, "run.cmd"), `@echo off
>"${outputPath}" echo(%HTTP_PROXY%
>>"${outputPath}" echo(%http_proxy%
>>"${outputPath}" echo(%HTTPS_PROXY%
>>"${outputPath}" echo(%https_proxy%
>>"${outputPath}" echo(%NO_PROXY%
>>"${outputPath}" echo(%no_proxy%
>>"${outputPath}" echo(%NODE_EXTRA_CA_CERTS%
>>"${outputPath}" echo(%node_extra_ca_certs%
>>"${outputPath}" echo(%GIT_SSL_BACKEND%
>>"${outputPath}" echo(%GIT_SSL_CAINFO%
>>"${outputPath}" echo(%GIT_CONFIG_COUNT%
>>"${outputPath}" echo(%GIT_CONFIG_KEY_0%
>>"${outputPath}" echo(%GIT_CONFIG_VALUE_0%
>>"${outputPath}" echo(%GIT_CONFIG_KEY_1%
>>"${outputPath}" echo(%GIT_CONFIG_VALUE_1%
>>"${outputPath}" echo(%GIT_CONFIG_KEY_2%
>>"${outputPath}" echo(%GIT_CONFIG_VALUE_2%
>>"${outputPath}" echo(%MARS_WORKER_CACHE_REGISTRATION_URL%
>>"${outputPath}" echo(%MARS_WORKER_CACHE_REGISTRATION_CHALLENGE%
if exist "%NODE_EXTRA_CA_CERTS%" (
  >>"${outputPath}" echo readable
) else (
  >>"${outputPath}" echo unreadable
)
>>"${outputPath}" type "%NODE_EXTRA_CA_CERTS%"
exit /b 0
`, { mode: 0o700 });
  const trustCalls: string[] = [];
  const trust = {
    addRoot: async (path: string) => {
      trustCalls.push(`add:${path}`);
      return { thumbprint: "worker-thumbprint", added: true };
    },
    removeRoot: async (thumbprint: string) => {
      trustCalls.push(`remove:${thumbprint}`);
    },
  };
  expect(await consumeGuestJitConfigWithWorkerCache("encoded-jit-config", root, "windows-x64", workerCache, trust)).toBe(0);

  const lines = (await Bun.file(outputPath).text()).split(/\r?\n/);
  expect(lines.slice(0, 4)).toEqual(Array(4).fill(workerCache.proxyUrl));
  expect(lines.slice(4, 6)).toEqual(["127.0.0.1,::1", "127.0.0.1,::1"]);
  expect(lines[8]).toBe("openssl");
  expect(lines[9]).toBe(lines[6]);
  expect(lines.slice(10, 18)).toEqual(["3", "http.sslBackend", "openssl", "http.sslVerify", "true", "http.sslCAInfo", lines[6], workerCache.registrationUrl]);
  expect(lines[18]).toBe(workerCache.registrationChallenge);
  expect(lines[19]).toBe("readable");
  expect(lines.slice(20).join("\n")).toContain(workerCache.caCertificatePem.trim());
  expect(await Bun.file(lines[6]).exists()).toBe(false);
  expect(trustCalls).toEqual([expect.stringMatching(/^add:.*worker-ca\.pem$/), "remove:worker-thumbprint"]);
});
test("removes temporary trust files when Windows root rollback fails", async () => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(join(tmpdir(), "mars-job-agent-"));
  roots.push(root);
  await writeWorkerCacheCapability(root);
  const outputPath = join(root, "ca-path.txt");
  await writeFile(join(root, "run.cmd"), `@echo off
>"${outputPath}" echo(%NODE_EXTRA_CA_CERTS%
exit /b 0
`, { mode: 0o700 });
  const trust = {
    addRoot: async () => ({ thumbprint: "worker-thumbprint", added: true }),
    removeRoot: async () => { throw new Error("certificate rollback failed"); },
  };
  await expect(consumeGuestJitConfigWithWorkerCache("encoded-jit-config", root, "windows-x64", workerCache, trust)).rejects.toThrow("certificate rollback failed");
  const caPath = (await Bun.file(outputPath).text()).trim();
  expect(await Bun.file(caPath).exists()).toBe(false);
});


test("waits for the host to copy the guest bootstrap after startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-job-agent-"));
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

test("launches the runner with self-updates disabled", () => {
  expect(runnerCommandForPlatform("windows-x64")).toEqual(["cmd.exe", "/c", "run.cmd", "--disableupdate"]);
  expect(runnerCommandForPlatform("linux-x64")).toEqual(["./run.sh", "--disableupdate"]);
});
test("container completion exits instead of shutting down a guest", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-job-agent-"));
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
  const root = await mkdtemp(join(tmpdir(), "mars-job-agent-"));
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
  const root = await mkdtemp(join(tmpdir(), "mars-job-agent-"));
  roots.push(root);
  const outputPath = join(root, "result.txt");
  await writeFile(join(root, "run.cmd"), `@echo off\r\n>\"${outputPath}\" echo %ACTIONS_RUNNER_INPUT_JITCONFIG%\r\nexit /b 0\r\n`, { mode: 0o700 });
  expect(await consumeGuestJitConfig("synthetic-jit-config", root, "windows-x64")).toBe(0);
  expect((await Bun.file(outputPath).text()).trim()).toBe("synthetic-jit-config");
});

test("does not treat the executable path as a missing optional argument", () => {
  const argv = ["C:\\ProgramData\\Mars\\mars-job-agent.exe", "guest-service", "--platform", "windows-x64"];
  expect(cliArgument(argv, "--runner-root")).toBeUndefined();
  expect(cliArgument(argv, "--platform")).toBe("windows-x64");
});
