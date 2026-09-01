import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const read = (path: string) => readFile(join(root, path), "utf8");

test("Release Mars is the sole manually dispatched publisher", async () => {
  const workflow = await read(".github/workflows/release-mars.yml");
  expect(workflow).toContain("name: Release Mars");
  expect(workflow).toContain("workflow_dispatch:");
  expect(workflow).toContain("app_version:");
  expect(workflow).toContain("worker_version:");
  expect(workflow).toContain("type: string");
  expect(workflow).toContain("contents: write");
  expect(workflow).toContain("packages: write");
  expect(workflow).toContain("group: release-mars");
  expect(workflow).toContain("cancel-in-progress: false");
  expect(workflow).not.toContain("push:");
  await expect(access(join(root, ".github/workflows/release-workers.yml"))).rejects.toThrow();
  await expect(access(join(root, ".github/workflows/release-control-plane.yml"))).rejects.toThrow();
});

test("worker release is schema 3, immutable, and observable before promotion", async () => {
  const workflow = await read(".github/workflows/release-mars.yml");
  expect(workflow).toContain("schemaVersion:3");
  expect(workflow).toContain("worker-v$WORKER_VERSION");
  expect(workflow).toContain("worker-release-manifest.json");
  expect(workflow).toContain("WorkerReleaseManifest.parse");
  expect(workflow).toContain("Gate anonymous worker asset observability");
  expect(workflow).toContain("gh release create \"worker-v$WORKER_VERSION\"");
  expect(workflow).toContain("--prerelease");
  expect(workflow).toContain("--clobber");
  expect(workflow).toContain("@sha256:");
  expect(workflow).not.toContain("/releases/latest/download");
  expect(workflow).not.toMatch(/MARS_(?:LINUX_BROKER_REPOSITORY|WINDOWS_VM|MACOS_TART_IMAGE|RELEASE_MANIFEST)/);
  expect(workflow.indexOf("Gate anonymous worker asset observability")).toBeLessThan(workflow.indexOf("Build and smoke-test control-plane candidate"));
});

test("candidate images are anonymously observable before mutable promotion", async () => {
  const workflow = await read(".github/workflows/release-mars.yml");
  expect(workflow).toContain("Gate anonymous GHCR candidate manifests");
  expect(workflow).toContain("Pull and inspect candidate manifests anonymously");
  expect(workflow).toContain('"$APP_IMAGE:$APP_CANDIDATE_TAG"');
  expect(workflow).toContain('"$BROKER_IMAGE:$BROKER_CANDIDATE_TAG"');
  expect(workflow).toContain("docker buildx imagetools inspect");
  expect(workflow).toContain("docker manifest inspect");
  expect(workflow).toContain("DOCKER_CONFIG");
  expect(workflow.indexOf("Gate anonymous GHCR candidate manifests")).toBeLessThan(workflow.indexOf("Promote verified Mars release"));
});

test("stages releases and rolls back before finalizing after promotion", async () => {
  const workflow = await read(".github/workflows/release-mars.yml");
  const appDraft = workflow.indexOf('gh release create "v$APP_VERSION"');
  const appUpload = workflow.indexOf('gh release upload "v$APP_VERSION"');
  const brokerPromotion = workflow.lastIndexOf('docker buildx imagetools create --tag "$BROKER_IMAGE:latest"');
  const appPromotion = workflow.lastIndexOf('docker buildx imagetools create --tag "$APP_IMAGE:latest"');
  const appFinalize = workflow.indexOf('gh release edit "v$APP_VERSION" --repo "$GITHUB_REPOSITORY" --draft=false --latest=true');
  const workerFinalize = workflow.lastIndexOf('gh release edit "worker-v$WORKER_VERSION"');
  expect(workflow).toContain('--draft --latest=false --title "Mars v$APP_VERSION"');
  expect(workflow).toContain("trap rollback ERR");
  expect(workflow).toContain("previous_broker_digest");
  expect(workflow).not.toContain("imagetools rm");
  expect(workflow).toContain("rollback did not fully restore state");
  expect(workflow).toContain('exit "$failure_status"');
  expect(workflow).toContain("set -e");
  expect(workflow).not.toContain("latest promotion changed digest' >&2; exit 1");
  expect(appDraft).toBeGreaterThan(-1);
  expect(appUpload).toBeGreaterThan(appDraft);
  expect(brokerPromotion).toBeGreaterThan(appUpload);
  expect(appPromotion).toBeGreaterThan(brokerPromotion);
  expect(appFinalize).toBeGreaterThan(appPromotion);
  expect(workerFinalize).toBeGreaterThan(appFinalize);
});

test("aborts safely when prior mutable tags cannot be inspected", async () => {
  const workflow = await read(".github/workflows/release-mars.yml");
  expect(workflow).toContain("latest_digest()");
  expect(workflow).toContain("unable to determine existing");
  expect(workflow).toContain("MANIFEST_UNKNOWN");
  expect(workflow).toContain("tag does not exist; aborting before promotion");
  expect(workflow).not.toContain("2>/dev/null || true");
});

test("candidate images are explicit amd64 builds and promotions are gated", async () => {
  const workflow = await read(".github/workflows/release-mars.yml");
  expect(workflow).toContain('echo "digest=$digest" >> "$GITHUB_OUTPUT"');
  expect(workflow).toContain("MARS_WORKER_RELEASE_MANIFEST_URL");
  expect(workflow).toContain("MARS_WORKER_CONTRACT_VERSION");
  expect(workflow).toContain("SMOKE_MANIFEST_URL: ''");
  expect(workflow).toContain("SMOKE_NODE_ENV: development");
  expect(workflow).toContain("SMOKE_NODE_ENV: production");
  expect(workflow).toContain("rustup target add x86_64-pc-windows-gnu");
  expect(workflow).toContain('docker buildx imagetools create --tag "$BROKER_IMAGE:latest" "$BROKER_IMAGE@$broker_digest"');
  expect(workflow).toContain('docker buildx imagetools create --tag "$APP_IMAGE:latest" "$APP_IMAGE@$APP_DIGEST"');
  expect(workflow).toContain('--prerelease=false --latest=false');
  expect(workflow).toContain('--draft --latest=false');
  expect(workflow.indexOf("Promote verified Mars release")).toBeGreaterThan(workflow.indexOf("Smoke test with baked remote worker manifest"));
});


test("appliance builder verifies Noble checksums and injects offline assets", async () => {
  const builder = await read("images/worker-appliance/build.sh");
  expect(builder).toContain("noble-server-cloudimg-amd64.img");
  expect(builder).toContain("SHA256SUMS");
  expect(builder).toContain("virt-customize");
  expect(builder).toContain("mars-job-agent");
  expect(builder).toContain("actions-runner");
  expect(builder).toContain("baseSha256");
  expect(builder).toContain("outputSha256");
  expect(builder).not.toMatch(/cosign/i);
});
