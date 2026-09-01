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

test("Compose renders loopback service and tunnel profile with HTTPS fixture", async () => {
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

test("production Compose requires external database and origins", async () => {
  const compose = await read("deploy/control-plane/compose.yaml");
  const rootCompose = await read("compose.yaml");
  expect(compose).toContain("DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL}");
  expect(compose).toContain("DATA_ROOT: /var/lib/mars");
  expect(compose).toContain("PUBLIC_BASE_URL: ${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}");
  expect(compose).toContain("GITHUB_WEBHOOK_URL: ${GITHUB_WEBHOOK_URL:?set GITHUB_WEBHOOK_URL}");
  expect(compose).toContain("WORKER_BASE_URL: ${WORKER_BASE_URL:-}");
  expect(compose).toContain("mars-data:/var/lib/mars");
  expect(compose).toContain("127.0.0.1:3000:3000");
  expect(compose).not.toContain("MARS_WORKER_RELEASE_MANIFEST_URL");
  expect(compose).not.toContain("MARS_WORKER_CONTRACT_VERSION");
  expect(compose).not.toContain("postgres:");
  expect(compose).not.toContain("POSTGRES_PASSWORD");
  expect(rootCompose).toContain("DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL}");
  expect(rootCompose).toContain("127.0.0.1:3000:3000");
});

test("Unraid template keeps operator inputs and external database boundary", async () => {
  const template = await read("deploy/unraid/mars-control-plane.xml");
  expect(template).toContain("<WebUI>http://[IP]:[PORT:3000]/</WebUI>");
  expect(template).toContain("<Repository>ghcr.io/snazzie/mars/control-plane:latest</Repository>");
  expect(template).toContain("<Network>bridge</Network>");
  expect(template).toContain("Linux/amd64");
  expect(template).toContain("external PostgreSQL 17");
  for (const target of ["DATABASE_URL", "3000", "/var/lib/mars", "PUBLIC_BASE_URL", "GITHUB_WEBHOOK_URL", "WORKER_BASE_URL"])
    expect(template).toContain(`Target=\"${target}\"`);
  expect(template).not.toContain("MARS_WORKER_RELEASE_MANIFEST_URL");
  expect(template).not.toContain("MARS_WORKER_CONTRACT_VERSION");
  expect(template).not.toContain("/releases/latest/download");
  expect(template).toContain("public HTTPS");
  expect(template).toContain("app_master_key");
  expect(template).not.toContain("/run/secrets/app_master_key");
});

test("control-plane image is slim, immutable-contract aware, and healthy", async () => {
  const dockerfile = await read("deploy/control-plane/Dockerfile");
  expect(dockerfile).toContain("FROM oven/bun:1.4.0-slim");
  expect(dockerfile).toContain("ARG MARS_BUILD_ID=unknown");
  expect(dockerfile).toContain("ARG MARS_WORKER_RELEASE_MANIFEST_URL");
  expect(dockerfile).toContain("ARG MARS_WORKER_CONTRACT_VERSION");
  expect(dockerfile).toContain("ENV MARS_WORKER_RELEASE_MANIFEST_URL=$MARS_WORKER_RELEASE_MANIFEST_URL");
  expect(dockerfile).toContain("ENV MARS_WORKER_CONTRACT_VERSION=$MARS_WORKER_CONTRACT_VERSION");
  expect(dockerfile).toContain("apt-get install --no-install-recommends -y gosu");
  expect(dockerfile).toContain("COPY deploy/control-plane/entrypoint.sh /usr/local/bin/mars-control-plane-entrypoint");
  expect(dockerfile).toContain("HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=6");
  expect(dockerfile).toContain("http://127.0.0.1:3000/api/readyz");
  expect(dockerfile).toContain("EXPOSE 3000");
  expect(dockerfile).toContain("ENV DATA_ROOT=/var/lib/mars");
  expect(dockerfile).toContain("ENTRYPOINT [\"/usr/local/bin/mars-control-plane-entrypoint\"]");
  expect(dockerfile).toContain("COPY --from=build /app/apps/control-plane/dist/index.js ./index.js");
  expect(dockerfile).toContain("COPY --from=build /app/packages/db/src/migrations ./migrations");
  expect(dockerfile).toContain("COPY --from=build /app/apps/web/dist/index.html /app/web/index.html");
  expect(dockerfile).not.toContain("/app/workers");
  expect(dockerfile).not.toContain("release-manifest.json");
  expect(dockerfile).not.toContain("USER bun");
});

test("entrypoint repairs only data root before dropping privileges", async () => {
  const entrypoint = await read("deploy/control-plane/entrypoint.sh");
  expect(entrypoint).toContain("set -eu");
  expect(entrypoint).toContain('mkdir -p \"$data_root\"');
  expect(entrypoint).toContain('chown bun:bun \"$data_root\"');
  expect(entrypoint).toContain('chmod 700 \"$data_root\"');
  expect(entrypoint).toContain("exec gosu bun:bun bun run index.js");
  expect(entrypoint).not.toMatch(/chown[^\n]*-R/);
  expect(entrypoint).not.toContain("USER root");
});

test("deployment guide documents image-owned worker contract and operations", async () => {
  const readme = await read("deploy/control-plane/README.md");
  for (const phrase of [
    "Linux/amd64", "external PostgreSQL 17", "maintenance database `postgres`", "create the target database",
    "applies pending migrations", "publicly readable", "anonymously", "worker-v<worker-version>",
    "worker-release-manifest.json", "image owns", "127.0.0.1:3000", "LAN-published", "bridge mode",
    "/api/livez", "/api/readyz", "/api/healthz", "healthcheck", "pin", "roll back", "app_master_key",
    "pg_dump", "coordinated pair", "/onboarding", "WebSocket", "Cloudflare named tunnel",
    "CLOUDFLARE_TUNNEL_TOKEN", "/api/github/webhooks", "WORKER_BASE_URL", "/api/browser/invalidations",
    "/api/v1/workers/connect", "identity challenges", "Tailscale Serve", "Tailscale Funnel",
    "/api/auth/github/callback", "/api/github/app/setup", "online pending worker", "fingerprint",
    "/var/log/mars/install.log", "ProgramData", "Library/Application Support/Mars/install.log",
  ]) expect(readme).toContain(phrase);
  expect(readme).toContain("docker compose --env-file .env -f deploy/control-plane/compose.yaml ps -q control-plane");
  expect(readme).toContain("<container-id-or-name>");
  expect(readme).not.toContain("docker logs mars-control-plane");
  expect(readme).not.toContain("releases/latest/download");
  expect(readme).not.toContain("MARS_WORKER_RELEASE_MANIFEST_URL=");
  expect(readme).not.toContain("MARS_WORKER_CONTRACT_VERSION=");
});

test("schema-3 release fixture keeps unavailable platforms explicit", async () => {
  const manifest = JSON.parse(await read("deploy/control-plane/release-manifest.json"));
  expect(manifest).toMatchObject({
    schemaVersion: 3,
    contractVersion: "0.1.0",
    platforms: { "linux-x64": null, "windows-x64": null, "macos-arm64": null },
  });
  expect(manifest).not.toHaveProperty("windowsContainerBuild");
});

test("single release train separates app and worker versions and uses canonical images", async () => {
  const workflow = await read(".github/workflows/release-mars.yml");
  expect(workflow).toContain("name: Release Mars");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("app_version:");
  expect(workflow).toContain("worker_version:");
  expect(workflow).toContain("APP_IMAGE: ghcr.io/snazzie/mars/control-plane");
  expect(workflow).toContain("BROKER_IMAGE: ghcr.io/snazzie/mars/linux-broker");
  expect(workflow).toContain("--platform linux/amd64");
  expect(workflow).toContain("worker-v$WORKER_VERSION");
  expect(workflow).toContain("$APP_IMAGE:v$APP_VERSION");
  expect(workflow).toContain("worker-release-manifest.json");
  expect(workflow).toContain("schemaVersion:3");
  expect(workflow).not.toContain("releases/latest/download");
  expect(workflow).not.toContain("MARS_LINUX_BROKER_REPOSITORY");
  expect(workflow).not.toMatch(/MARS_WINDOWS_(?:VHDX|VM_TEMPLATE)/);
});

test("baked worker manifest examples use the exact canonical release path", async () => {
  const [workflow, ci, readme] = await Promise.all([
    read(".github/workflows/release-mars.yml"),
    read(".github/workflows/ci.yml"),
    read("deploy/control-plane/README.md"),
  ]);
  const canonical = "https://github.com/Snazzie/MARS/releases/download/";
  expect(workflow).toContain(canonical);
  expect(ci).toContain(`${canonical}worker-v0.1.1/worker-release-manifest.json`);
  expect(readme).toContain(`${canonical}worker-v<worker-version>/worker-release-manifest.json`);
  expect(ci).not.toContain("github.com/Snazzie/Mars/releases/download");
  expect(readme).not.toContain("github.com/Snazzie/Mars/releases/download");
});

test("release train observes immutable assets before ordered latest promotion", async () => {
  const workflow = await read(".github/workflows/release-mars.yml");
  const worker = workflow.indexOf("name: Validate and publish worker prerelease");
  const observe = workflow.indexOf("Gate anonymous worker asset observability");
  const image = workflow.indexOf("name: Build and smoke-test control-plane candidate");
  const remoteSmoke = workflow.indexOf("Smoke test with baked remote worker manifest");
  const candidateObserve = workflow.indexOf("Gate anonymous GHCR candidate manifests");
  const promote = workflow.indexOf("name: Promote verified Mars release");
  const brokerLatest = workflow.lastIndexOf('imagetools create --tag "$BROKER_IMAGE:latest"');
  const appLatest = workflow.lastIndexOf('imagetools create --tag "$APP_IMAGE:latest"');
  const finalWorker = workflow.lastIndexOf('gh release edit "worker-v$WORKER_VERSION"');
  const appDraft = workflow.indexOf('gh release create "v$APP_VERSION"');
  const appUpload = workflow.indexOf('gh release upload "v$APP_VERSION"');
  const appFinalize = workflow.indexOf('gh release edit "v$APP_VERSION" --repo "$GITHUB_REPOSITORY" --draft=false --latest=true');
  expect(worker).toBeGreaterThanOrEqual(0);
  expect(observe).toBeGreaterThan(worker);
  expect(image).toBeGreaterThan(observe);
  expect(remoteSmoke).toBeGreaterThan(image);
  expect(candidateObserve).toBeGreaterThan(remoteSmoke);
  expect(promote).toBeGreaterThan(candidateObserve);
  expect(appDraft).toBeGreaterThan(promote);
  expect(appUpload).toBeGreaterThan(appDraft);
  expect(brokerLatest).toBeGreaterThan(appUpload);
  expect(appLatest).toBeGreaterThan(brokerLatest);
  expect(appFinalize).toBeGreaterThan(appLatest);
  expect(finalWorker).toBeGreaterThan(appFinalize);
  expect(workflow).toContain("trap rollback ERR");
  expect(workflow).not.toContain("imagetools rm");
  expect(workflow).toContain("tag does not exist; aborting before promotion");
  expect(workflow).toContain("--clobber");
  expect(workflow).toContain("--latest=false");
  expect(workflow).toContain("@sha256:");
  expect(workflow).toContain('[[ "$promoted_broker_digest" == "$broker_digest" ]]');
  expect(workflow).toContain('[[ "$app_digest" == "$APP_DIGEST" ]]');
});

test("active runtime uses Mars identifiers and no packaged workers", async () => {
  const controlPlanePackage = await read("apps/control-plane/package.json");
  const orchestratorPackage = await read("apps/orchestrator/package.json");
  const compose = await read("compose.yaml");
  const serviceInstaller = await read("deploy/workers/install-worker.ps1");
  const source = await read("apps/control-plane/src/index.ts");
  expect(controlPlanePackage).toContain('"name": "@mars/control-plane"');
  expect(orchestratorPackage).toContain('"name": "@mars/orchestrator"');
  expect(compose).toContain("container_name: mars-postgres-local");
  expect(compose).toContain("name: mars-postgres-data");
  expect(compose).toContain("name: mars-control-plane-data");
  expect(serviceInstaller).toContain("'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\MarsWorker'");
  expect(serviceInstaller).toContain("sc.exe failure MarsWorker");
  expect(source).toContain("MARS_WORKER_RELEASE_MANIFEST_URL");
  expect(source).toContain("MARS_WORKER_CONTRACT_VERSION");
  expect(source).not.toContain('required("WORKER_INSTALLER_ROOT")');
});

test("image smoke asserts runtime files and excludes worker payload", async () => {
  const smoke = await read("tests/control-plane-image-smoke.sh");
  for (const artifact of [
    "/app/index.js", "/app/web/index.html", "/app/web/index.js", "/app/web/index.css",
    "/app/migrations/0000_mars_baseline.sql", "/app/migrations/meta/_journal.json",
  ]) expect(smoke).toContain(artifact);
  expect(smoke).toContain("worker assets must not be packaged");
  expect(smoke).not.toContain("/app/workers/");
});
