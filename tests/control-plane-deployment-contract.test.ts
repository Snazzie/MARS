import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const read = (path: string) => readFile(join(root, path), "utf8");

test("production Compose requires only DATABASE_URL and keeps the data volume", async () => {
  const compose = await read("deploy/control-plane/compose.yaml");
  expect(compose).toContain("DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL}");
  expect(compose).toContain("DATA_ROOT: /var/lib/mars");
  expect(compose).toContain("mars-data:/var/lib/mars");
  expect(compose).not.toContain("postgres:");
  expect(compose).not.toContain("secrets:");
  expect(compose).toContain("profiles: [tunnel]");
  expect(compose).toContain("CLOUDFLARE_TUNNEL_TOKEN");
  expect(compose).not.toContain("POSTGRES_PASSWORD");
});

test("deployment template documents the required database variable without secrets", async () => {
  const compose = await read("deploy/control-plane/compose.yaml");
  const envExample = await read(".env.example");
  const variables = [...compose.matchAll(/\$\{([A-Z0-9_]+)(?::[^}]*)?\}/g)].map((match) => match[1]);
  for (const variable of new Set(variables)) expect(envExample).toContain(`${variable}=`);
  expect(envExample).not.toMatch(/(ghp_|github_pat_|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/i);
});

test("Unraid exposes only database, port, and persistent data inputs", async () => {
  const template = await read("deploy/unraid/mars-control-plane.xml");
  expect(template).toContain("Target=\"DATABASE_URL\"");
  expect(template).toContain("Target=\"3000\"");
  expect(template).toContain("Target=\"/var/lib/mars\"");
  expect(template).not.toContain("/run/secrets/app_master_key");
  expect(template).not.toContain("GITHUB_");
});

test("image persists production data-root contract", async () => {
  const dockerfile = await read("deploy/control-plane/Dockerfile");
  expect(dockerfile).toContain("ARG MARS_BUILD_ID=unknown");
  expect(dockerfile).toContain("ENV NODE_ENV=production");
  expect(dockerfile).toContain("ENV DATA_ROOT=/var/lib/mars");
  expect(dockerfile).toContain("chmod 700 /var/lib/mars");
});

test("deployment guide documents first-run persistence and incomplete worker gates", async () => {
  const readme = await read("deploy/control-plane/README.md");
  for (const phrase of ["DATABASE_URL", "/onboarding", "/api/livez", "/api/readyz", "WebSocket", "Cloudflare Tunnel", "CLOUDFLARE_TUNNEL_TOKEN", "/api/github/webhooks", "back up", "linux/amd64", "worker execution"]) expect(readme).toContain(phrase);
});

test("schema-2 release fixture keeps unavailable platforms explicit", async () => {
  const manifest = JSON.parse(await read("deploy/control-plane/release-manifest.json"));
  expect(manifest).toMatchObject({
    schemaVersion: 2,
    platforms: { "linux-x64": null, "windows-x64": null, "macos-arm64": null },
  });
  expect(manifest).not.toHaveProperty("windowsContainerBuild");
});

test("control-plane image packages every platform's small worker artifact", async () => {
  const dockerfile = await read("deploy/control-plane/Dockerfile");
  for (const artifact of [
    "install-worker.sh", "install-worker.ps1", "install-worker-macos.sh",
    "linux-broker-compose.yaml", "worker-domain.xml",
    "mars-orchestrator-linux-x64", "mars-orchestrator-windows-x64.exe",
    "mars-orchestrator-macos-arm64", "mars-service-host.exe",
    "build-windows-container-image-local.ps1", "verify-runtime.ps1",
    "Containerfile", "entrypoint.ps1", "mars-job-agent.exe",
    "release-manifest.json",
  ]) expect(dockerfile).toContain(artifact);
  expect(dockerfile).toContain("--target=bun-linux-x64");
  expect(dockerfile).toContain("--target=bun-windows-x64");
  expect(dockerfile).toContain("--target=bun-darwin-arm64");
});

test("worker release workflow gates aggregate publication on all platforms", async () => {
  const workflow = await read(".github/workflows/release-workers.yml");
  expect(workflow).toContain("tags: ['worker-*']");
  expect(workflow).toContain("needs: [linux, windows, macos]");
  expect(workflow).toContain("schemaVersion:2");
  expect(workflow).toContain("cosign sign-blob");
  expect(workflow).toContain("worker-release-manifest.json");
  expect(workflow).not.toContain("windows-worker-*");
});

test("production startup checks every packaged Windows container input", async () => {
  const source = await read("apps/control-plane/src/index.ts");
  for (const artifact of [
    "windowsContainerBuilder", "windowsContainerVerifier", "windowsContainerfile",
    "windowsContainerEntrypoint", "windowsContainerJobAgent",
  ]) expect(source).toContain(artifact);
});

test("aggregate release validation installs locked dependencies before importing contracts", async () => {
  const workflow = await read(".github/workflows/release-workers.yml");
  const aggregate = workflow.slice(workflow.indexOf("\n  aggregate:"));
  const install = aggregate.indexOf("bun install --frozen-lockfile");
  const validation = aggregate.indexOf("WorkerReleaseManifest");
  expect(install).toBeGreaterThanOrEqual(0);
  expect(validation).toBeGreaterThan(install);
});

test("release workflow acquires and signs immutable large worker assets", async () => {
  const workflow = await read(".github/workflows/release-workers.yml");
  for (const requirement of [
    "MARS_LINUX_GOLDEN_IMAGE_SOURCE_URL",
    'curl --fail --location --retry 3 --proto "=https" --tlsv1.2 "$GOLDEN_IMAGE_SOURCE_URL"',
    "mars-worker-golden.qcow2",
    "mars-worker-golden.qcow2.bundle",
    "MARS_WINDOWS_VM_TEMPLATE_SOURCE_URL",
    'Invoke-WebRequest -Uri $env:VM_TEMPLATE_SOURCE_URL -OutFile $vmTemplatePath',
    "mars-worker-template.vhdx",
    "mars-worker-template.vhdx.bundle",
    "MARS_MACOS_TART_SOURCE_IMAGE", "tart pull \"$TART_SOURCE_IMAGE\"",
    "prepare-macos-job-image.sh", "tart push \"$TARGET\" \"$PUBLISHED_REF\"",
    "imagetools inspect", "tart clone \"$TART_IMAGE\"",
    "TART_IMAGE_DIGEST", 'cosign sign --yes "$TART_IMAGE"',
    "cosign sign-blob", "gh release create",
  ]) expect(workflow).toContain(requirement);
  expect(workflow).not.toContain("MARS_LINUX_GOLDEN_IMAGE_PATH");
  expect(workflow).not.toContain("MARS_WINDOWS_VM_TEMPLATE_PATH");
  expect(workflow).toMatch(/mars-worker-golden\.qcow2(?:\\|\s|,)/);
  expect(workflow).toMatch(/mars-worker-template\.vhdx(?:\\|\s|,)/);
  expect(workflow).toContain("@sha256:");

  const linux = workflow.slice(workflow.indexOf("\n  linux:"));
  expect(linux.indexOf('curl --fail --location --retry 3 --proto "=https" --tlsv1.2 "$GOLDEN_IMAGE_SOURCE_URL"')).toBeGreaterThanOrEqual(0);
  expect(linux.indexOf('curl --fail --location --retry 3 --proto "=https" --tlsv1.2 "$GOLDEN_IMAGE_SOURCE_URL"')).toBeLessThan(linux.indexOf('test -s "$GOLDEN_IMAGE_PATH"'));
  const windows = workflow.slice(workflow.indexOf("\n  windows:"));
  expect(windows.indexOf('Invoke-WebRequest -Uri $env:VM_TEMPLATE_SOURCE_URL -OutFile $vmTemplatePath')).toBeLessThan(windows.indexOf('Test-Path -LiteralPath $vmTemplatePath -PathType Leaf'));
});

test("image smoke asserts complete runtime metadata and Windows container inputs", async () => {
  const smoke = await read("tests/control-plane-image-smoke.sh");
  for (const artifact of [
    "/app/workers/build-windows-container-image-local.ps1",
    "/app/workers/verify-runtime.ps1", "/app/workers/Containerfile",
    "/app/workers/entrypoint.ps1", "/app/workers/mars-job-agent.exe",
  ]) expect(smoke).toContain(artifact);
  for (const field of [
    "goldenImageUrl", "goldenCosignBundleUrl", "vmTemplateUrl",
    "asset.url", "asset.sha256", "vcRuntime", "tartImageDigest",
    "__PLACEHOLDER__",
  ]) expect(smoke).toContain(field);
});
