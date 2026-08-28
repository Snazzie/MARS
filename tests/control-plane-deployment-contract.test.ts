import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const read = (path: string) => readFile(join(root, path), "utf8");
const parseEnv = (contents: string) =>
  Object.fromEntries(
    contents
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );

const renderCompose = (contents: string, env: Record<string, string>) =>
  contents.replace(/\$\{([A-Z0-9_]+)(?::(?:-|\?)[^}]*)?\}/g, (_, name: string) => env[name] ?? "");

test("Compose renders base and tunnel profiles with HTTPS deployment fixture", async () => {
  const fixture = parseEnv(await read("tests/fixtures/control-plane-deployment.env"));
  expect(fixture).toMatchObject({
    DATABASE_URL: "postgres://mars:test-password@db.example.test:5432/mars",
    PUBLIC_BASE_URL: "https://control.example.test",
    CONTROL_PLANE_ADAPTER_URLS: "https://worker.example.test",
    CLOUDFLARE_TUNNEL_TOKEN: "test-token",
  });

  const compose = renderCompose(await read("deploy/control-plane/compose.yaml"), fixture);
  expect(compose).toContain("PUBLIC_BASE_URL: https://control.example.test");
  expect(compose).toContain("CONTROL_PLANE_ADAPTER_URLS: https://worker.example.test");
  expect(compose).toContain('ports: ["127.0.0.1:3000:3000"]');
  expect(compose).toContain("profiles: [tunnel]");
  expect(compose).toContain("TUNNEL_TOKEN: test-token");
  expect(compose).toContain("CLOUDFLARE_TUNNEL_TOKEN is required");
});

test("production Compose requires DATABASE_URL, optional origins, and keeps the data volume", async () => {
  const compose = await read("deploy/control-plane/compose.yaml");
  const rootCompose = await read("compose.yaml");
  expect(compose).toContain("DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL}");
  expect(compose).toContain("DATA_ROOT: /var/lib/mars");
  expect(compose).toContain("PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-}");
  expect(compose).toContain("CONTROL_PLANE_ADAPTER_URLS: ${CONTROL_PLANE_ADAPTER_URLS:-}");
  expect(compose).toContain("mars-data:/var/lib/mars");
  expect(compose).not.toContain("postgres:");
  expect(compose).not.toContain("secrets:");
  expect(compose).toContain("profiles: [tunnel]");
  expect(compose).toContain("CLOUDFLARE_TUNNEL_TOKEN");
  expect(compose).not.toContain("POSTGRES_PASSWORD");
  expect(rootCompose).toContain("PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:-}");
  expect(rootCompose).toContain("CONTROL_PLANE_ADAPTER_URLS: ${CONTROL_PLANE_ADAPTER_URLS:-}");
  expect(rootCompose).toContain("127.0.0.1:3000:3000");
});

test("deployment template documents required and optional variables without secrets", async () => {
  const compose = await read("deploy/control-plane/compose.yaml");
  const envExample = await read(".env.example");
  const variables = [...compose.matchAll(/\$\{([A-Z0-9_]+)(?::[^}]*)?\}/g)].map((match) => match[1]);
  for (const variable of new Set(variables)) expect(envExample).toContain(`${variable}=`);
  expect(envExample).toContain("PUBLIC_BASE_URL=https://control.example.com");
  expect(envExample).toContain("CONTROL_PLANE_ADAPTER_URLS=https://worker.example.com");
  expect(envExample).not.toMatch(/(ghp_|github_pat_|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/i);
});
test("Unraid exposes origin, database, port, and persistent data inputs", async () => {
  const template = await read("deploy/unraid/mars-control-plane.xml");
  expect(template).toContain("<WebUI>http://[IP]:[PORT:3000]/</WebUI>");
  expect(template).toContain("Target=\"DATABASE_URL\"");
  expect(template).toContain("Target=\"3000\"");
  expect(template).toContain("Target=\"/var/lib/mars\"");
  expect(template).toContain("Target=\"PUBLIC_BASE_URL\"");
  expect(template).toContain("Target=\"CONTROL_PLANE_ADAPTER_URLS\"");
  expect(template).toContain("Default=\"https://control.example.com\"");
  expect(template).toContain("Default=\"\"");
  expect(template).toContain("Public HTTPS");
  expect(template).toContain("worker-only");
  expect(template).toContain("app_master_key");
  expect(template).toContain("PostgreSQL");
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

test("deployment guide documents operational routing, onboarding, persistence, and platform gates", async () => {
  const readme = await read("deploy/control-plane/README.md");
  for (const phrase of [
    "DATABASE_URL", "/onboarding", "/api/livez", "/api/readyz", "WebSocket",
    "Cloudflare named tunnel", "CLOUDFLARE_TUNNEL_TOKEN", "/api/github/webhooks",
    "back up", "linux/amd64", "worker execution", "PUBLIC_BASE_URL",
    "CONTROL_PLANE_ADAPTER_URLS", "preserve the original webhook headers",
    "/api/browser/invalidations", "/api/v1/workers/connect", "identity challenges",
    "Tailscale Serve", "Tailscale Funnel", "example-name.ts.net", "control.example.com",
    "same maintenance window", "/api/auth/github/callback", "/api/github/app/setup",
    "online pending worker", "fingerprint", "/var/log/mars/install.log",
    "C:\\\\ProgramData\\\\Mars\\\\install.log", "Library/Application Support/Mars/install.log",
    "app_master_key", "PostgreSQL", "Linux x64", "Windows", "Apple-Silicon",
  ]) expect(readme).toContain(phrase);
  expect(readme).toContain("Do not run a privileged Tailscale container");
  expect(readme).toContain("127.0.0.1:3000");
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
  expect(dockerfile).toContain("MARS_RELEASE_MANIFEST=deploy/control-plane/release-manifest.json");
  expect(dockerfile).toContain("does not match packaged");
  expect(dockerfile).toContain("createHash(\"sha256\")");
  expect(dockerfile).toContain("--target=bun-linux-x64");
  expect(dockerfile).toContain("--target=bun-windows-x64");
  expect(dockerfile).toContain("--target=bun-darwin-arm64");
});
test("control-plane image packages the exact Windows service-host release artifact", async () => {
  const dockerfile = await read("deploy/control-plane/Dockerfile");
  const workflow = await read(".github/workflows/release-workers.yml");
  expect(dockerfile).toContain("ARG MARS_WINDOWS_SERVICE_HOST_ARTIFACT=");
  expect(dockerfile).toContain("RUN --mount=type=bind,target=/release-context,readonly");
  expect(dockerfile).toContain("MARS_WINDOWS_SERVICE_HOST_ARTIFACT is required");
  expect(dockerfile).toContain("release artifact is unavailable: /release-context/$MARS_WINDOWS_SERVICE_HOST_ARTIFACT");
  expect(dockerfile).toContain('cp "/release-context/$MARS_WINDOWS_SERVICE_HOST_ARTIFACT" /artifacts/mars-service-host.exe');
  expect(dockerfile).toContain("COPY --from=build /artifacts/mars-service-host.exe /app/workers/mars-service-host.exe");
  expect(dockerfile).not.toContain("FROM rust:");
  expect(dockerfile).not.toContain("cargo build --manifest-path apps/windows-service-host/Cargo.toml");
  expect(workflow).toContain('--build-arg MARS_WINDOWS_SERVICE_HOST_ARTIFACT="dist/worker-windows-${{ github.sha }}/mars-service-host.exe"');
  expect(workflow).toContain("Get-FileHash dist/windows/mars-service-host.exe");
  expect(workflow).toContain("path: dist/windows");
});
test("CI builds and passes a real Windows service-host artifact explicitly", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const artifactBuild = workflow.indexOf("Build Windows service-host artifact for CI image");
  const imageBuild = workflow.indexOf("Build immutable control-plane image");
  expect(artifactBuild).toBeGreaterThanOrEqual(0);
  expect(imageBuild).toBeGreaterThan(artifactBuild);
  for (const requirement of [
    "sudo apt-get install --no-install-recommends -y mingw-w64",
    "rustup target add x86_64-pc-windows-gnu",
    "cargo build --manifest-path apps/windows-service-host/Cargo.toml --release --target x86_64-pc-windows-gnu",
    "dist/worker-windows-ci/mars-service-host.exe",
    "--build-arg MARS_WINDOWS_SERVICE_HOST_ARTIFACT=dist/worker-windows-ci/mars-service-host.exe",
  ]) expect(workflow).toContain(requirement);
  expect(workflow).not.toContain("MARS_WINDOWS_SERVICE_HOST_ARTIFACT=development");
});


test("worker release workflow gates unsigned aggregate publication on all platforms", async () => {
  const workflow = await read(".github/workflows/release-workers.yml");
  expect(workflow).toContain("tags: ['worker-*']");
  expect(workflow).toContain("needs: [linux, windows, macos]");
  expect(workflow).toContain("schemaVersion:2");
  expect(workflow).toContain("worker-release-manifest.json");
  expect(workflow).toContain("Publish complete unsigned worker release");
  expect(workflow).not.toMatch(/cosign|signature|\.bundle/);
  expect(workflow).not.toContain("windows-worker-*");
  for (const installer of [
    "install-worker-linux-x64.sh",
    "install-worker-windows-x64.ps1",
    "install-worker-macos-arm64.sh",
  ]) expect(workflow).toContain(installer);
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

test("release workflow validates SHA-256/HTTPS assets and publishes fixed release URLs", async () => {
  const workflow = await read(".github/workflows/release-workers.yml");
  for (const requirement of [
    "MARS_LINUX_GOLDEN_IMAGE_SOURCE_URL",
    'curl --fail --location --retry 3 --proto "=https" --tlsv1.2 "$GOLDEN_IMAGE_SOURCE_URL"',
    "mars-worker-golden.qcow2",
    "MARS_WINDOWS_VM_TEMPLATE_SOURCE_URL",
    'curl.exe --fail --location --retry 3 --proto "=https" --proto-redir "=https" --tlsv1.2 --output $vmTemplatePath $env:VM_TEMPLATE_SOURCE_URL',
    "mars-worker-template.vhdx",
    "MARS_MACOS_TART_SOURCE_IMAGE", "TART_SOURCE_REGISTRY_HOSTNAME", "docker login \"$TART_REGISTRY_HOSTNAME\"", "tart pull \"$TART_SOURCE_IMAGE\"",
    "prepare-macos-job-image.sh", "tart push \"$TARGET\" \"$PUBLISHED_REF\"",
    "imagetools inspect", "TART_IMAGE_DIGEST",
    "https://github.com/$env:GITHUB_REPOSITORY/releases/download/worker-v0.1.0",
    "https://github.com/${GITHUB_REPOSITORY}/releases/download/worker-v0.1.0",
    "gh release create",
  ]) expect(workflow).toContain(requirement);
  expect(workflow).not.toContain("MARS_LINUX_GOLDEN_IMAGE_PATH");
  expect(workflow).not.toContain("MARS_WINDOWS_VM_TEMPLATE_PATH");
  expect(workflow).not.toContain("Invoke-WebRequest");
  expect(workflow).not.toMatch(/cosign|signature|\.bundle/);
  for (const asset of [
    "install-worker-linux-x64.sh", "install-worker-windows-x64.ps1", "install-worker-macos-arm64.sh",
    "worker-release-manifest.json", "linux-broker-compose.yaml", "worker-domain.xml",
    "mars-orchestrator-linux-x64", "mars-orchestrator-windows-x64.exe", "mars-orchestrator-macos-arm64",
    "mars-job-agent.exe", "mars-job-agent-linux-x64", "mars-job-agent-macos-arm64", "mars-service-host.exe",
    "mars-worker-golden.qcow2", "mars-worker-template.vhdx",
    "mars-windows-runner.zip", "mars-windows-git.zip", "mars-windows-vc-runtime.exe",
  ]) expect(workflow).toContain(`dist/release/${asset}`);
  expect(workflow).toContain("@sha256:");
});

test("image smoke asserts complete unsigned runtime metadata and Windows container inputs", async () => {
  const smoke = await read("tests/control-plane-image-smoke.sh");
  for (const artifact of [
    "/app/workers/build-windows-container-image-local.ps1",
    "/app/workers/verify-runtime.ps1", "/app/workers/Containerfile",
    "/app/workers/entrypoint.ps1", "/app/workers/mars-job-agent.exe",
  ]) expect(smoke).toContain(artifact);
  for (const field of [
    "goldenImageUrl", "goldenImageSha256", "vmTemplateUrl",
    "serviceHostSha256", "packagedServiceHost", "asset.url", "asset.sha256",
    "vcRuntime", "tartImageDigest", "__PLACEHOLDER__",
  ]) expect(smoke).toContain(field);
  expect(smoke).not.toMatch(/cosign|goldenCosignBundleUrl|\.bundle/);
});
