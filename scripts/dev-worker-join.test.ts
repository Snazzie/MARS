import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renewRevokedDevWorker } from "./dev-worker-join.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mars-dev-worker-"));
  roots.push(root);
  const path = join(root, "worker-identity.json");
  const identity = { workerId: "00000000-0000-4000-8000-000000000001", privateKey: "key", machineUuid: "machine" };
  await writeFile(path, JSON.stringify(identity));
  return { path, identity };
}

test("revoked development worker archives its credentials so the launcher creates fresh keys", async () => {
  const { path, identity } = await fixture();
  const renewed = await renewRevokedDevWorker(path, identity.workerId, "https://control-plane.test", "secret", async (url, options) => {
    expect(String(url)).toBe(`https://control-plane.test/api/organizations/all/workers/${identity.workerId}`);
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer secret");
    return Response.json({ admissionState: "revoked" });
  });
  expect(renewed).toBe(true);
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(`${path}.revoked-${identity.workerId}`, "utf8"))).toEqual(identity);
});

test("active identity stays intact and failed admission checks do not re-enroll", async () => {
  const { path, identity } = await fixture();
  expect(await renewRevokedDevWorker(path, identity.workerId, "https://control-plane.test", "secret", async () => Response.json({ admissionState: "adopted" }))).toBe(false);
  await expect(renewRevokedDevWorker(path, identity.workerId, "https://control-plane.test", "secret", async () => Response.json({ code: "unauthorized" }, { status: 401 }))).rejects.toThrow("HTTP 401");
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(identity);
});
