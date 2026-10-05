import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeControlPlaneSetup, loadOrCreateMasterKey } from "./control-plane-setup.ts";
import { getOnboardingStatus } from "@mars/db";
import { preparedTestDatabase } from "../../../packages/db/src/prepared-test-fixture.ts";

 describe("control-plane secret files", () => {
  test("creates a durable 0600 master key and reuses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-setup-"));
    const first = await loadOrCreateMasterKey(root);
    const second = await loadOrCreateMasterKey(root);
    expect(first).toHaveLength(44);
    expect(second).toBe(first);
    if (process.platform !== "win32") expect((await stat(join(root, "app_master_key"))).mode & 0o777).toBe(0o600);
  });
  test("does not replace a malformed existing key", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-setup-"));
    const path = join(root, "app_master_key");
    await writeFile(path, "not-a-key", { mode: 0o600 });
    await expect(loadOrCreateMasterKey(root)).rejects.toThrow("invalid key");
    expect(await readFile(path, "utf8")).toBe("not-a-key");
  });
});

function setupDb(responses: Record<string, unknown> = {}) {
  return preparedTestDatabase((name) => responses[name] ?? []);
}
const emptyConfig = { publicBaseUrl: null, setupCompletedAt: null };

test("normalizes and synchronizes an environment-managed origin over the persisted value", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-"));
  const db = setupDb({ setup_read_config: [{ publicBaseUrl: "https://db.example", setupCompletedAt: null }] });
  const { setup } = await initializeControlPlaneSetup(db, root, " https://control.example.com/ ");
  expect(setup.publicOrigin()).toBe("https://control.example.com");
  expect(setup.publicOriginManaged()).toBe(true);
});

test("rejects malformed configured origins", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-invalid-origin"));
  await expect(initializeControlPlaneSetup(setupDb(), root, "not-an-origin")).rejects.toThrow("PUBLIC_BASE_URL must be an absolute HTTP(S) origin");
});

test("rejects an environment origin mismatch without changing the cached origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-"));
  const { setup } = await initializeControlPlaneSetup(setupDb({ setup_read_config: [emptyConfig] }), root, "https://control.example.com");
  await expect(setup.configure("https://other.example.com")).rejects.toThrow("configured_origin_mismatch");
  expect(setup.publicOrigin()).toBe("https://control.example.com");
});

test("does not drift the cached origin after a guarded update affects zero rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-"));
  const { setup } = await initializeControlPlaneSetup(setupDb({ setup_read_config: [emptyConfig], setup_configure_origin: [] }), root);
  await expect(setup.configure("https://candidate.example")).rejects.toThrow("setup_state_expired");
  expect(setup.publicOrigin()).toBeNull();
});

test("caches normalized DB-managed origin only after a successful update", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-"));
  const { setup } = await initializeControlPlaneSetup(setupDb({ setup_read_config: [emptyConfig], setup_configure_origin: [{ publicBaseUrl: "https://candidate.example" }] }), root);
  await expect(setup.configure("https://candidate.example/")).resolves.toBe("https://candidate.example");
  expect(setup.publicOrigin()).toBe("https://candidate.example");
});

test("claims first administration during authentication under the setup lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-auth-"));
  const db = setupDb({ setup_read_config: [emptyConfig], setup_known_user: [], setup_installed_org: [], setup_lock_config: [{ setupCompletedAt: null }], setup_administrator: [], setup_authorized_organizations: [], setup_upsert_user: [{ id: "user-1" }], setup_lock_onboarding: [{ adminUserId: null }] });
  const { setup } = await initializeControlPlaneSetup(db, root);
  await expect(setup.authenticate({ id: 7, login: "first-admin", accessToken: "token" })).resolves.toEqual({ userId: "user-1", firstAdmin: true });
});

test("authenticates returning users without granting administration after setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-returning-"));
  const now = new Date();
  const db = setupDb({ setup_read_config: [{ publicBaseUrl: "https://control.example", setupCompletedAt: now }], setup_known_user: [], setup_installed_org: [], setup_lock_config: [{ setupCompletedAt: now }], setup_administrator: [{ id: "user-2" }], setup_authorized_organizations: [{ id: "organization-1" }], setup_upsert_user: [{ id: "user-2" }] });
  const { setup } = await initializeControlPlaneSetup(db, root);
  await expect(setup.authenticate({ id: 8, login: "returning-user", accessToken: "token" })).resolves.toEqual({ userId: "user-2", firstAdmin: false });
});

test("refuses unrelated users before persisting an account after setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-denied-"));
  const now = new Date();
  const db = setupDb({ setup_read_config: [{ publicBaseUrl: "https://control.example", setupCompletedAt: now }], setup_known_user: [], setup_installed_org: [], setup_lock_config: [{ setupCompletedAt: now }], setup_administrator: [], setup_authorized_organizations: [] });
  const { setup } = await initializeControlPlaneSetup(db, root);
  await expect(setup.authenticate({ id: 99, login: "outsider", accessToken: "token" })).rejects.toThrow("account_not_authorized");
});

test("seeds onboarding before status reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-onboarding-"));
  const status = { adminUserId: null, workerId: null, organizationId: null, completedAt: null, publicBaseUrl: "https://control.example.com", originConfigured: true, githubAppConfigured: false };
  const db = setupDb({ setup_read_config: [emptyConfig], onboarding_status: [status] });
  await initializeControlPlaneSetup(db, root, "https://control.example.com");
  const { setup } = await initializeControlPlaneSetup(db, root, "https://control.example.com");
  await expect(getOnboardingStatus(db, {}, { publicBaseUrlManaged: setup.publicOriginManaged() })).resolves.toMatchObject({ publicBaseUrl: "https://control.example.com", publicBaseUrlManaged: true });
});
