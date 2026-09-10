import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const read = (path: string) => readFile(join(root, path), "utf8");

type ReleaseWorkflow = {
  on?: { workflow_dispatch?: { inputs?: Record<string, { required?: boolean; type?: string; options?: string[] }> } };
  jobs: Record<string, { if?: string; needs?: string[]; permissions?: Record<string, string>; outputs?: Record<string, string> }>;
};

const parseWorkflow = (source: string) => Bun.YAML.parse(source) as ReleaseWorkflow;
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

test("Compose renders immutable loopback service and tunnel profile with HTTPS fixture", async () => {
  const fixture = parseEnv(await read("tests/fixtures/control-plane-deployment.env"));
  expect(fixture.MARS_CONTROL_PLANE_IMAGE).toMatch(/^ghcr\.io\/snazzie\/mars\/control-plane@sha256:[0-9a-f]{64}$/);
  const rendered = renderCompose(await read("deploy/control-plane/compose.yaml"), fixture);
  const compose = Bun.YAML.parse(rendered) as { services: Record<string, { image?: string; read_only?: boolean; ports?: string[]; environment?: Record<string, string>; profiles?: string[] }> };
  const control = compose.services["control-plane"];
  expect(control.image).toBe(fixture.MARS_CONTROL_PLANE_IMAGE);
  expect(control.read_only).toBe(true);
  expect(control.ports).toContain("127.0.0.1:3000:3000");
  expect(control.environment).toMatchObject({ PUBLIC_BASE_URL: fixture.PUBLIC_BASE_URL, GITHUB_WEBHOOK_URL: fixture.GITHUB_WEBHOOK_URL, WORKER_BASE_URL: fixture.WORKER_BASE_URL });
  expect(compose.services.cloudflared.profiles).toContain("tunnel");
});

test("production Compose requires immutable image, external database, and origins", async () => {
  const composeText = await read("deploy/control-plane/compose.yaml");
  const compose = Bun.YAML.parse(composeText) as { services: Record<string, { image?: string; read_only?: boolean; tmpfs?: string[]; environment?: Record<string, string>; volumes?: string[] }> };
  const control = compose.services["control-plane"];
  expect(control.image).toBe("${MARS_CONTROL_PLANE_IMAGE:?set MARS_CONTROL_PLANE_IMAGE to a v<semver> tag or repository@sha256 digest}");
  expect(control.read_only).toBe(true);
  expect(control.tmpfs).toContain("/tmp:rw,noexec,nosuid,size=64m");
  expect(control.environment).toMatchObject({
    DATABASE_URL: "${DATABASE_URL:?set DATABASE_URL}",
    DATA_ROOT: "/var/lib/mars",
    PUBLIC_BASE_URL: "${PUBLIC_BASE_URL:?set PUBLIC_BASE_URL}",
    GITHUB_WEBHOOK_URL: "${GITHUB_WEBHOOK_URL:?set GITHUB_WEBHOOK_URL}",
    WORKER_BASE_URL: "${WORKER_BASE_URL:-}",
  });
  expect(control.volumes).toEqual(["mars-data:/var/lib/mars"]);
  expect(compose.services).not.toHaveProperty("postgres");
  expect(composeText).not.toContain("MARS_WORKER_RELEASE_MANIFEST_URL");
  expect(composeText).not.toContain("MARS_WORKER_CONTRACT_VERSION");
});

test("Unraid source template requires release rendering", async () => {
  const template = await read("deploy/unraid/mars-control-plane.template.xml");
  expect(template).toContain("<WebUI>http://[IP]:[PORT:3000]/</WebUI>");
  expect(template).toContain("<Repository>__MARS_CONTROL_PLANE_IMAGE__</Repository>");
  expect(template).toContain("<Network>bridge</Network>");
  expect(template).toContain("Linux/amd64");
  expect(template).toContain("external PostgreSQL 17");
  for (const target of ["DATABASE_URL", "3000", "/var/lib/mars", "PUBLIC_BASE_URL", "GITHUB_WEBHOOK_URL", "WORKER_BASE_URL"])
    expect(template).toContain(`Target=\"${target}\"`);
  expect(template).not.toContain("MARS_WORKER_RELEASE_MANIFEST_URL");
  expect(template).not.toContain("MARS_WORKER_CONTRACT_VERSION");
  expect(template).not.toContain(":latest");
  expect(template).toContain("public HTTPS");
  expect(template).toContain("app_master_key");
  expect(template).not.toContain("/run/secrets/app_master_key");
});

test("Mars PostgreSQL template initializes a persistent mars database", async () => {
  const template = await read("deploy/unraid/mars-postgres.xml");
  expect(template).toContain("<Repository>postgres:17</Repository>");
  expect(template).toContain("<Network>bridge</Network>");
  expect(template).toContain('Target="5432"');
  expect(template).toContain('Target="POSTGRES_USER"');
  expect(template).toContain('Target="POSTGRES_PASSWORD"');
  expect(template).toContain('Target="POSTGRES_DB"');
  expect(template).toContain(">postgres</Config>");
  expect(template).toContain(">mars</Config>");
  expect(template).toContain("/var/lib/postgresql/data");
  expect(template).toContain("/mnt/user/appdata/mars-postgres");

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
    "/api/livez", "/api/readyz", "/api/healthz", "healthcheck", "roll back", "app_master_key",
    "pg_dump", "coordinated pair", "/onboarding", "WebSocket", "Cloudflare named tunnel",
    "CLOUDFLARE_TUNNEL_TOKEN", "/api/github/webhooks", "WORKER_BASE_URL", "/api/browser/invalidations",
    "/api/v1/workers/connect", "identity challenges", "Tailscale Serve", "Tailscale Funnel",
    "/api/auth/github/callback", "/api/github/app/setup", "online pending worker", "fingerprint",
    "/var/log/mars/install.log", "ProgramData", "Library/Application Support/Mars/install.log",
  ]) expect(readme).toContain(phrase);
  expect(readme).toContain("repository@sha256:<digest>");
  expect(readme).toContain("exact previous control-plane digest");
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

test("release workflow encodes build/reuse DAG and evidence gates", async () => {
  const workflow = parseWorkflow(await read(".github/workflows/release-mars.yml"));
  const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
  expect(inputs.app_version).toMatchObject({ required: true, type: "string" });
  expect(inputs.worker_release_mode).toMatchObject({ required: true, type: "choice", options: ["build", "reuse"] });
  expect(inputs.worker_version).toMatchObject({ required: false, type: "string" });
  expect(inputs.worker_manifest_url).toMatchObject({ required: false, type: "string" });
  for (const job of ["linux", "windows", "macos", "worker-release"]) expect(workflow.jobs[job].if).toContain("worker_release_mode == 'build'");
  expect(workflow.jobs["worker-release"].needs).toEqual(["validate-inputs", "linux", "windows", "macos"]);
  expect(workflow.jobs["worker-binding"].needs).toEqual(["validate-inputs", "worker-release"]);
  expect(workflow.jobs["control-plane"].needs).toEqual(["validate-inputs", "worker-binding"]);
  expect(workflow.jobs["candidate-compose-smoke"].needs).toContain("control-plane");
  expect(workflow.jobs["release-evidence"].permissions).toMatchObject({ "id-token": "write", attestations: "write" });
  expect(workflow.jobs["staging"].needs).toEqual(["release-evidence"]);
  expect(workflow.jobs.promote.needs).toContain("staging");
  const source = await read(".github/workflows/release-mars.yml");
  expect(source).toContain("verify-worker-release.ts");
  expect(source).toContain("MARS_CONTROL_PLANE_IMAGE");
  expect(source).toContain("actions/attest@v4");
  expect(source).toContain("subject-name: ghcr.io/snazzie/mars/control-plane");
  expect(source).toContain("subject-digest:");
  expect(source).toContain("control-plane-sbom.spdx.json");
  expect(source).toContain("provenance_attestation_url");
  expect(source).toContain("sbom_attestation_url");
  expect(source).not.toContain("MARS_WORKER_RELEASE_MANIFEST_URL:");
  expect(source).not.toContain("MARS_WORKER_CONTRACT_VERSION:");
});

test("baked worker manifest examples use the exact canonical release path", async () => {
  const [workflow, ci, readme] = await Promise.all([
    read(".github/workflows/release-mars.yml"),
    read(".github/workflows/ci.yml"),
    read("deploy/control-plane/README.md"),
  ]);
  const canonical = "https://github.com/Snazzie/MARS/releases/download/";
  expect(workflow).toContain(canonical);
  expect(readme).toContain(`${canonical}worker-v<worker-version>/worker-release-manifest.json`);
  expect(ci).not.toContain("github.com/Snazzie/Mars/releases/download");
  expect(readme).not.toContain("github.com/Snazzie/Mars/releases/download");
});

test("release evidence and recovery scripts are immutable and secret-safe", async () => {
  const [workflow, composeSmoke, recovery, fixture] = await Promise.all([
    read(".github/workflows/release-mars.yml"),
    read("tests/control-plane-compose-smoke.sh"),
    read("tests/control-plane-upgrade-recovery-smoke.sh"),
    read("tests/control-plane-recovery-fixture.ts"),
  ]);
  expect(workflow).toContain("tests/control-plane-compose-smoke.sh");
  expect(workflow).toContain("control-plane-upgrade-recovery-smoke.sh");
  expect(composeSmoke).toContain("docker pull --platform linux/amd64");
  expect(composeSmoke).toContain("ReadonlyRootfs");
  expect(recovery).toContain("pg_dump --format=custom");
  expect(recovery).toContain("pre-upgrade-data.tar.gz");
  expect(fixture).toContain("SecretBox");
  expect(fixture).not.toContain("console.log(\"recovery-pem\")");
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
