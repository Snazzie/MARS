import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeControlPlaneSetup, loadOrCreateMasterKey } from "./control-plane-setup.ts";
import { getOnboardingStatus } from "@mars/db";

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

type SetupDbOptions = { config?: { publicBaseUrl: string | null; setupCompletedAt: Date | string | null }; updateRows?: unknown[] };
function setupDb(options: SetupDbOptions = {}) {
  const queries: string[] = [];
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    queries.push(query);
    if (query.includes("select public_base_url")) return [options.config ?? { publicBaseUrl: null, setupCompletedAt: null }];
    if (query.includes("returning public_base_url")) return options.updateRows ?? [{ publicBaseUrl: "https://candidate.example" }];
    return [];
  }) as never;
  return { db, queries };
}

test("normalizes and synchronizes an environment-managed origin over the persisted value", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-"));
  const { db, queries } = setupDb({ config: { publicBaseUrl: "https://db.example", setupCompletedAt: null } });
  const { setup } = await initializeControlPlaneSetup(db, root, " https://control.example.com/ ");
  expect(setup.publicOrigin()).toBe("https://control.example.com");
  expect(setup.publicOriginManaged()).toBe(true);
  expect(queries.some((query) => query.includes("on conflict (singleton) do update set public_base_url"))).toBe(true);
});

test("rejects malformed configured origins before touching the database", async () => {
  let calls = 0;
  const db = (async () => { calls += 1; return []; }) as never;
  await expect(initializeControlPlaneSetup(db, join(tmpdir(), "mars-invalid-origin"), "not-an-origin")).rejects.toThrow("PUBLIC_BASE_URL must be an absolute HTTP(S) origin");
  expect(calls).toBe(0);
});

test("rejects an environment origin mismatch without attempting a database update", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-"));
  const { db, queries } = setupDb({ config: { publicBaseUrl: null, setupCompletedAt: null } });
  const { setup } = await initializeControlPlaneSetup(db, root, "https://control.example.com");
  await expect(setup.configure("https://other.example.com")).rejects.toThrow("configured_origin_mismatch");
  expect(queries.filter((query) => query.includes("returning public_base_url"))).toHaveLength(0);
});

test("does not drift the cached DB-managed origin after a guarded update affects zero rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-"));
  const { db } = setupDb({ config: { publicBaseUrl: null, setupCompletedAt: null }, updateRows: [] });
  const { setup } = await initializeControlPlaneSetup(db, root);
  await expect(setup.configure("https://candidate.example")).rejects.toThrow("setup_state_expired");
  expect(setup.publicOrigin()).toBeNull();
});

test("caches the normalized DB-managed origin only after a guarded update returns one row", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-"));
  const { db } = setupDb({ config: { publicBaseUrl: null, setupCompletedAt: null }, updateRows: [{ publicBaseUrl: "https://candidate.example" }] });
  const { setup } = await initializeControlPlaneSetup(db, root);
  await expect(setup.configure("https://candidate.example/")).resolves.toBe("https://candidate.example");
  expect(setup.publicOrigin()).toBe("https://candidate.example");
});
test("claims first administration during authentication under the setup lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-auth-"));
  const queries: string[] = [];
  const db = Object.assign((async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    queries.push(query);
    if (query.includes("select public_base_url")) return [{ publicBaseUrl: null, setupCompletedAt: null }];
    if (query.includes("select setup_completed_at")) return [{ setupCompletedAt: null }];
    if (query.includes("insert into users")) return [{ id: "user-1" }];
    if (query.includes("select admin_user_id")) return [{ adminUserId: null }];
    return [];
  }) as never, {
    begin: async (callback: (tx: never) => Promise<unknown>) => callback(db),
  });
  const { setup } = await initializeControlPlaneSetup(db, root);
  await expect(setup.authenticate({ id: 7, login: "first-admin" })).resolves.toEqual({ userId: "user-1", firstAdmin: true });
  expect(queries.some((query) => query.includes("update users set is_global_admin=true"))).toBe(true);
  expect(queries.some((query) => query.includes("update control_plane_config set setup_completed_at"))).toBe(true);
});

test("upserts a returning GitHub user without granting administration after setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-returning-"));
  const queries: string[] = [];
  const db = Object.assign((async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    queries.push(query);
    if (query.includes("select public_base_url")) return [{ publicBaseUrl: "https://control.example", setupCompletedAt: new Date() }];
    if (query.includes("select setup_completed_at")) return [{ setupCompletedAt: new Date() }];
    if (query.includes("insert into users")) return [{ id: "user-2" }];
    return [];
  }) as never, {
    begin: async (callback: (tx: unknown) => Promise<unknown>) => callback(db),
  });
  const { setup } = await initializeControlPlaneSetup(db, root);
  await expect(setup.authenticate({ id: 8, login: "returning-user" })).resolves.toEqual({ userId: "user-2", firstAdmin: false });
  expect(queries.some((query) => query.includes("update users set is_global_admin=true"))).toBe(false);
  expect(queries.some((query) => query.includes("update system_onboarding"))).toBe(false);
});
test("seeds the system onboarding singleton idempotently before status reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-setup-onboarding-"));
  const queries: string[] = [];
  let onboardingExists = false;
  const db = (async (strings: TemplateStringsArray) => {
    const query = strings.join(" ").toLowerCase();
    queries.push(query);
    if (query.includes("select public_base_url")) {
      return [{ publicBaseUrl: "https://control.example.com", setupCompletedAt: null }];
    }
    if (query.includes("insert into system_onboarding")) {
      onboardingExists = true;
      return [];
    }
    if (query.includes("from system_onboarding")) {
      return onboardingExists
        ? [{ adminUserId: null, workerId: null, organizationId: null, completedAt: null, publicBaseUrl: "https://control.example.com", originConfigured: true, githubAppConfigured: false }]
        : [];
    }
    return [];
  }) as never;

  await initializeControlPlaneSetup(db, root, "https://control.example.com");
  const { setup } = await initializeControlPlaneSetup(db, root, "https://control.example.com");
  const inserts = queries.filter((query) => query.includes("insert into system_onboarding (singleton) values (true) on conflict (singleton) do nothing"));
  expect(inserts).toHaveLength(2);
  await expect(getOnboardingStatus(db, {}, { publicBaseUrlManaged: setup.publicOriginManaged() })).resolves.toMatchObject({
    publicBaseUrl: "https://control.example.com",
    publicBaseUrlManaged: true,
  });
});
