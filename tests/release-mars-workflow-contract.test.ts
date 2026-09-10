import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const read = (path: string) => readFile(join(root, path), "utf8");

type ReleaseWorkflow = {
  on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } };
  permissions?: Record<string, string>;
  jobs: Record<string, { if?: string; needs?: string[]; permissions?: Record<string, string> }>;
};

const parseWorkflow = (source: string) => Bun.YAML.parse(source) as ReleaseWorkflow;

test("Release Mars is the sole manually dispatched publisher", async () => {
  const workflow = parseWorkflow(await read(".github/workflows/release-mars.yml"));
  expect(workflow.on?.workflow_dispatch?.inputs).toMatchObject({ app_version: { required: true, type: "string" }, worker_release_mode: { required: true, type: "choice" }, worker_version: { required: false, type: "string" }, worker_manifest_url: { required: false, type: "string" } });
  expect(workflow.permissions).toMatchObject({ contents: "read", packages: "read" });
  await expect(access(join(root, ".github/workflows/release-workers.yml"))).rejects.toThrow();
  await expect(access(join(root, ".github/workflows/release-control-plane.yml"))).rejects.toThrow();
});

test("build mode retains all worker platforms while reuse skips them", async () => {
  const source = await read(".github/workflows/release-mars.yml");
  const workflow = parseWorkflow(source);
  for (const name of ["linux", "windows", "macos", "worker-release"]) expect(workflow.jobs[name].if).toContain("worker_release_mode == 'build'");
  expect(workflow.jobs["worker-release"].needs).toEqual(["validate-inputs", "linux", "windows", "macos"]);
  expect(workflow.jobs["worker-binding"].needs).toEqual(["validate-inputs", "worker-release"]);
  expect(workflow.jobs["control-plane"].needs).toEqual(["validate-inputs", "worker-binding"]);
  expect(source).toContain("if: always() && needs.validate-inputs.result == 'success' && (inputs.worker_release_mode == 'reuse' || needs.worker-release.result == 'success')");
  expect(source).toContain("verify-worker-release.ts");
  expect(source).not.toContain("MARS_WORKER_RELEASE_MANIFEST_URL:");
  expect(source).not.toContain("MARS_WORKER_CONTRACT_VERSION:");
});

test("exact SHA CI and immutable worker assets are required", async () => {
  const source = await read(".github/workflows/release-mars.yml");
  expect(source).toContain("GITHUB_REF\" == refs/heads/main");
  expect(source).toContain("head_sha == env.GITHUB_SHA");
  expect(source).toContain("worker-v<semver>");
  expect(source).toContain("docker manifest inspect");
  expect(source).toContain("DOCKER_CONFIG");
  expect(source).toContain("schemaVersion:3");
  expect(source).toContain("--platform linux/amd64");
});

test("candidate, recovery, evidence, and staging gates precede promotion", async () => {
  const source = await read(".github/workflows/release-mars.yml");
  const workflow = parseWorkflow(source);
  expect(workflow.jobs["candidate-compose-smoke"].needs).toContain("control-plane");
  expect(workflow.jobs["upgrade-recovery"].needs).toContain("candidate-compose-smoke");
  expect(workflow.jobs["release-evidence"].needs).toContain("upgrade-recovery");
  expect(workflow.jobs["release-evidence"].permissions).toMatchObject({ "id-token": "write", attestations: "write" });
  expect(workflow.jobs.staging.needs).toEqual(["release-evidence"]);
  expect(workflow.jobs.promote.needs).toContain("staging");
  expect(source.indexOf("gh release create \"v$APP_VERSION\"" )).toBeLessThan(source.indexOf("environment: control-plane-staging"));
  expect(source).toContain("actions/attest@v4");
  expect(source).toContain("subject-name: ghcr.io/snazzie/mars/control-plane");
  expect(source).toContain("subject-digest:");
  expect(source).toContain("create-storage-record: false");
  expect(source).toContain("sbom_url");
  expect(source).toContain("sbom_sha256");
  expect(source).toContain("provenance_attestation_url");
  expect(source).toContain("sbom_attestation_url");
});

test("reuse promotion mutates only the control-plane digest", async () => {
  const source = await read(".github/workflows/release-mars.yml");
  expect(source).toContain("if [[ \"$WORKER_MODE\" == build ]]; then docker buildx imagetools create --tag \"$BROKER_IMAGE:latest\"");
  expect(source).toContain("if [[ \"$WORKER_MODE\" == build ]]; then gh release edit \"worker-v$WORKER_VERSION\"");
  expect(source).toContain("PREVIOUS_IMAGE");
  expect(source).toContain("CANDIDATE_IMAGE");
  expect(source).toContain("release rollback did not fully restore state");
  expect(source).not.toContain("imagetools rm");
});
