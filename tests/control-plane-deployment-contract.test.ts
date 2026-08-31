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
    GITHUB_WEBHOOK_URL: "https://hooks.example.test",
    WORKER_BASE_URL: "https://worker.example.test",
    CLOUDFLARE_TUNNEL_TOKEN: "test-token",
  });

  const compose = renderCompose(await read("deploy/control-plane/compose.yaml"), fixture);
  expect(compose).toContain("PUBLIC_BASE_URL: https://control.example.test");
  expect(compose).toContain("GITHUB_WEBHOOK_URL: https://hooks.example.test");
  expect(compose).toContain("WORKER_BASE_URL: https://worker.example.test");
  expect(compose).toContain('ports: ["127.0.0.1:3000:3000"]');
  expect(compose).toContain("profiles: [tunnel]");
  expect(compose).toContain("TUNNEL_TOKEN: test-token");
  expect(compose).toContain("CLOUDFLARE_TUNNEL_TOKEN is required");
});


test("production Compose requires database, browser, and webhook origins, with optional worker origin", async () => {
  const compose = await read("deploy/control-plane/compose.yaml");
  const rootCompose = await read("compose.yaml");
  expect(compose).toContain("DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL}");
  expect(compose).toContain("DATA_ROOT: /var/lib/mars");
  expect(compose).toContain("PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}");
  expect(compose).toContain("GITHUB_WEBHOOK_URL: ${GITHUB_WEBHOOK_URL:?set GITHUB_WEBHOOK_URL}");
  expect(compose).toContain("WORKER_BASE_URL: ${WORKER_BASE_URL:-}");
  expect(compose).toContain("mars-data:/var/lib/mars");
  expect(compose).not.toContain("postgres:");
  expect(compose).not.toContain("secrets:");
  expect(compose).toContain("profiles: [tunnel]");
  expect(compose).toContain("CLOUDFLARE_TUNNEL_TOKEN");
  expect(compose).not.toContain("POSTGRES_PASSWORD");
  expect(rootCompose).toContain("DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL}");
  expect(rootCompose).toContain("PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}");
  expect(rootCompose).toContain("GITHUB_WEBHOOK_URL: ${GITHUB_WEBHOOK_URL:?set GITHUB_WEBHOOK_URL}");
  expect(rootCompose).toContain("WORKER_BASE_URL: ${WORKER_BASE_URL:-}");
  expect(rootCompose).toContain("127.0.0.1:3000:3000");
});


test("deployment template documents only operator inputs without secrets or release metadata", async () => {
  const compose = await read("deploy/control-plane/compose.yaml");
  const envExample = await read(".env.example");
  const variables = [...compose.matchAll(/\$\{([A-Z0-9_]+)(?::[^}]*)?\}/g)].map((match) => match[1]);
  for (const variable of new Set(variables)) expect(envExample).toContain(`${variable}=`);
  expect(envExample).toContain("PUBLIC_BASE_URL=http://localhost:3000");
  expect(envExample).toContain("WORKER_BASE_URL=");
  expect(envExample).toMatch(/^MARS_WINDOWS_CONTAINER_BASE_IMAGE=mcr\.microsoft\.com\/windows\/server:ltsc2025@sha256:[0-9a-f]{64}$/m);
  expect(envExample).not.toContain("CONTROL_PLANE_ADAPTER_URLS");
  expect(envExample).not.toMatch(/(DEFAULT_JOB_IMAGE|BROWSER_BASE_URL)/);
  expect(envExample).not.toMatch(/(ghp_|github_pat_|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/i);
});
test("Unraid exposes only database and origin inputs", async () => {
  const template = await read("deploy/unraid/mars-control-plane.xml");
  expect(template).toContain("<WebUI>http://[IP]:[PORT:3000]/</WebUI>");
  expect(template).toContain("<Repository>ghcr.io/snazzie/mars/control-plane:latest</Repository>");
  expect(template).not.toContain("control-plane:v0.1.0");
  expect(template).toContain("Target=\"DATABASE_URL\"");
  expect(template).toContain("Target=\"3000\"");
  expect(template).toContain("Target=\"PUBLIC_BASE_URL\"");
  expect(template).toContain("Target=\"/var/lib/mars\"");
  expect(template).toContain("Target=\"GITHUB_WEBHOOK_URL\"");
  expect(template).toContain("Target=\"WORKER_BASE_URL\"");
  expect(template).not.toContain("CONTROL_PLANE_ADAPTER_URLS");
  expect(template).toContain("Default=\"http://localhost:3000\"");
  expect(template).toContain("Default=\"https://control.example.com\"");
  expect(template).toContain("Default=\"\"");
  expect(template).toContain("public HTTPS");
  expect(template).toContain("worker");
  expect(template).toContain("app_master_key");
  expect(template).toContain("PostgreSQL");
  expect(template).not.toContain("/run/secrets/app_master_key");
});
test("image persists production data-root contract", async () => {
  const dockerfile = await read("deploy/control-plane/Dockerfile");
  expect(dockerfile).toContain("ARG MARS_BUILD_ID=unknown");
  expect(dockerfile).toContain("ENV NODE_ENV=production");
  expect(dockerfile).toContain("ENV DATA_ROOT=/var/lib/mars");
  expect(dockerfile).toContain("chmod 700 /var/lib/mars");
});
test("active runtime and deployment surfaces use Mars identifiers", async () => {
  const controlPlanePackage = await read("apps/control-plane/package.json");
  const orchestratorPackage = await read("apps/orchestrator/package.json");
  const compose = await read("compose.yaml");
  const serviceInstaller = await read("deploy/workers/install-worker.ps1");
  expect(controlPlanePackage).toContain('"name": "@mars/control-plane"');
  expect(orchestratorPackage).toContain('"name": "@mars/orchestrator"');
  expect(compose).toContain("container_name: mars-postgres-local");
  expect(compose).toContain("name: mars-postgres-data");
  expect(compose).toContain("name: mars-control-plane-data");
  expect(serviceInstaller).toContain("'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\MarsWorker'");
  expect(serviceInstaller).toContain("sc.exe failure MarsWorker");
});

test("deployment guide documents operational routing, onboarding, persistence, and platform gates", async () => {
  const readme = await read("deploy/control-plane/README.md");
  for (const phrase of [
    "DATABASE_URL", "/onboarding", "/api/livez", "/api/readyz", "WebSocket",
    "Cloudflare named tunnel", "CLOUDFLARE_TUNNEL_TOKEN", "/api/github/webhooks",
    "WORKER_BASE_URL", "Preserve webhook",
    "/api/browser/invalidations", "/api/v1/workers/connect", "identity challenges",
    "Tailscale Serve", "Tailscale Funnel", "example-name.ts.net", "control.example.com",
    "same maintenance window", "/api/auth/github/callback", "/api/github/app/setup",
    "online pending worker", "fingerprint", "/var/log/mars/install.log",
    "C:\\\\ProgramData\\\\Mars\\\\install.log", "Library/Application Support/Mars/install.log",
    "app_master_key", "PostgreSQL", "Linux x64", "Windows", "Apple-Silicon",
  ]) expect(readme).toContain(phrase);
  expect(readme).toContain("Do not run a privileged");
  expect(readme).toContain("127.0.0.1:3000");
  expect(readme).not.toContain("CONTROL_PLANE_ADAPTER_URLS");
  expect(readme).not.toMatch(/(?:DEFAULT_JOB_IMAGE|MARS_[A-Z0-9_]+)=/);
});
test("schema-2 release fixture keeps unavailable platforms explicit", async () => {
  const manifest = JSON.parse(await read("deploy/control-plane/release-manifest.json"));
  expect(manifest).toMatchObject({
    schemaVersion: 2,
    platforms: { "linux-x64": null, "windows-x64": null, "macos-arm64": null },
  });
  expect(manifest).not.toHaveProperty("windowsContainerBuild");
});

test("control-plane image contains only control-plane runtime files", async () => {
  const dockerfile = await read("deploy/control-plane/Dockerfile");
  expect(dockerfile).toContain("COPY --from=build /app/apps/control-plane/dist/index.js ./index.js");
  expect(dockerfile).toContain("COPY --from=build /app/packages/db/src/migrations ./migrations");
  expect(dockerfile).toContain("COPY --from=build /app/apps/web/dist/index.html /app/web/index.html");
  expect(dockerfile).not.toContain("/app/workers");
  expect(dockerfile).not.toContain("MARS_WINDOWS_SERVICE_HOST_ARTIFACT");
  expect(dockerfile).not.toContain("mars-orchestrator");
  expect(dockerfile).not.toContain("install-worker");
  expect(dockerfile).not.toContain("release-manifest.json");
  expect(dockerfile).not.toContain("--target=bun-windows-x64");
  expect(dockerfile).not.toContain("--target=bun-darwin-arm64");
});
test("control-plane release workflow publishes verified Linux image", async () => {
  const workflow = await read(".github/workflows/release-control-plane.yml");
  expect(workflow).toContain("platforms: linux/amd64");
  expect(workflow).toContain("docker/build-push-action@v6");
  expect(workflow).toContain("docker buildx imagetools create --tag \"$IMAGE:latest\"");
  expect(workflow).toContain("test ! -e /app/workers");
  expect(workflow).not.toContain("MARS_WINDOWS_SERVICE_HOST_ARTIFACT");
  expect(workflow).not.toContain("MARS_RELEASE_MANIFEST");
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
test("worker release workflow publishes current-tag assets before promoting the exact image", async () => {
  const workflow = await read(".github/workflows/release-workers.yml");
  const aggregate = workflow.slice(workflow.indexOf("\n  aggregate:"));
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("tags: ['worker-*']");
  expect(workflow).toContain("RELEASE_TAG: ${{ github.ref_type == 'tag' && github.ref_name || format('worker-{0}', github.run_id) }}");
  expect(aggregate).toContain("REF_TYPE: ${{ github.ref_type }}");
  expect(aggregate).toContain("REF_NAME: ${{ github.ref_name }}");
  expect(aggregate).toContain('if [[ "$REF_TYPE" == tag ]]; then');
  expect(aggregate).toContain('releaseTag="$REF_NAME"');
  expect(aggregate).toContain('releaseTag="worker-$GITHUB_RUN_ID"');
  expect(aggregate).toContain('test "$releaseTag" = "$RELEASE_TAG"');
  expect(aggregate).toContain('gh release upload "$RELEASE_TAG"');
  expect(aggregate).toContain("--clobber");
  expect(aggregate).toContain('gh release create "$RELEASE_TAG"');
  expect(aggregate).toContain('--target "$GITHUB_SHA"');
  expect(aggregate).toContain('gh release edit "$RELEASE_TAG"');
  expect(aggregate).toContain("--latest");
  const image = aggregate.indexOf("name: Build control-plane image under immutable build tag");
  const immutableBuild = aggregate.indexOf('docker buildx build --push', image);
  const publication = aggregate.indexOf("name: Publish complete worker release");
  const latest = aggregate.indexOf('gh release edit "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --latest');
  const promotion = aggregate.indexOf("name: Promote exact control-plane image to latest");
  const promoteCommand = aggregate.indexOf('docker buildx imagetools create --tag "$CONTROL_PLANE_IMAGE:latest" "$CONTROL_PLANE_IMAGE@$IMAGE_DIGEST"');
  expect(image).toBeGreaterThanOrEqual(0);
  expect(immutableBuild).toBeGreaterThan(image);
  expect(publication).toBeGreaterThan(immutableBuild);
  expect(latest).toBeGreaterThan(publication);
  expect(promotion).toBeGreaterThan(latest);
  expect(promoteCommand).toBeGreaterThan(promotion);
  expect(aggregate).toContain("CONTROL_PLANE_IMAGE_TAG: cp-${{ github.run_id }}-${{ github.run_attempt }}");
  expect(aggregate).toContain('-t "$CONTROL_PLANE_IMAGE:$CONTROL_PLANE_IMAGE_TAG"');
  expect(aggregate).toContain('imagetools inspect "$CONTROL_PLANE_IMAGE:$CONTROL_PLANE_IMAGE_TAG"');
  expect(aggregate).not.toContain('-t "$CONTROL_PLANE_IMAGE:$BUILD_ID"');
  expect(aggregate).toContain('echo "digest=$imageDigest" >> "$GITHUB_OUTPUT"');
  expect(aggregate).toContain('test "$promotedDigest" = "$IMAGE_DIGEST"');
  expect(aggregate).not.toContain("if: startsWith(github.ref, 'refs/tags/')");
});
test("control-plane action run bumps from the latest tag or 0.0.0", async () => {
  const workflow = await read(".github/workflows/release-control-plane.yml");
  expect(workflow).toContain('bump:');
  expect(workflow).toContain('options:\n          - patch\n          - minor\n          - major');
  expect(workflow).toContain('current="0.0.0"');
  expect(workflow).toContain("git tag --list 'v*.*.*' --sort=-v:refname");
  expect(workflow).toContain('major) major=$((major + 1)); minor=0; patch=0');
  expect(workflow).toContain('minor) minor=$((minor + 1)); patch=0');
  expect(workflow).toContain('patch) patch=$((patch + 1))');
  expect(workflow).toContain('release tag already exists');
  expect(workflow).toContain("MARS_WORKER_CONTRACT_VERSION=${{ needs.compute-version.outputs.version }}");
  expect(workflow).toContain('gh release create "v$VERSION"');
});


test("production startup does not require packaged worker inputs", async () => {
  const source = await read("apps/control-plane/src/index.ts");
  expect(source).toContain("MARS_WORKER_RELEASE_MANIFEST_URL");
  expect(source).toContain("MARS_WORKER_CONTRACT_VERSION");
  expect(source).not.toContain('required("WORKER_INSTALLER_ROOT")');
});
test("aggregate release validation installs locked dependencies before importing contracts", async () => {
  const workflow = await read(".github/workflows/release-workers.yml");
  const aggregate = workflow.slice(workflow.indexOf("\n  aggregate:"));
  const install = aggregate.indexOf("bun install --frozen-lockfile");
  const validation = aggregate.indexOf("WorkerReleaseManifest");
  expect(install).toBeGreaterThanOrEqual(0);
  expect(validation).toBeGreaterThan(install);
});
test("release workflow validates SHA-256/HTTPS assets and binds manifest URLs to the current release tag", async () => {
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
    "https://github.com/$env:GITHUB_REPOSITORY/releases/download/$env:RELEASE_TAG",
    "https://github.com/${GITHUB_REPOSITORY}/releases/download/$RELEASE_TAG",
    "gh release create",
  ]) expect(workflow).toContain(requirement);
  expect(workflow).not.toContain("worker-v0.1.0");
  expect(workflow).toContain('docker buildx build --push');
  expect(workflow).toContain('docker buildx imagetools create --tag "$CONTROL_PLANE_IMAGE:latest"');
  expect(workflow).not.toContain("/releases/latest/download");
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

test("image smoke asserts control-plane files and excludes worker payload", async () => {
  const smoke = await read("tests/control-plane-image-smoke.sh");
  for (const artifact of [
    "/app/index.js", "/app/web/index.html", "/app/web/index.js",
    "/app/web/index.css", "/app/migrations/0000_mars_baseline.sql",
    "/app/migrations/meta/_journal.json",
  ]) expect(smoke).toContain(artifact);
  expect(smoke).toContain("worker assets must not be packaged");
  expect(smoke).not.toContain("/app/workers/");
});
