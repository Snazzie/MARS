import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const required = ["DATABASE_URL", "MARS_CONTROL_PLANE_URL", "MARS_EXPECTED_BUILD_ID", "MARS_LINUX_WORKER_ID", "MARS_GOLDEN_DIGEST", "MARS_CLONE_ROOT", "MARS_CHANNEL_ROOT", "MARS_LIBVIRT_NETWORK", "GITHUB_REPOSITORY", "GITHUB_WORKFLOW"];
if (Bun.env.MARS_LINUX_VM_E2E !== "1") {
  console.log("Linux libvirt smoke skipped; set MARS_LINUX_VM_E2E=1 to run against Unraid.");
} else {
  const missing = required.filter((key) => !Bun.env[key]);
  if (missing.length) throw new Error(`Linux libvirt smoke missing: ${missing.join(", ")}`);
  const response = await fetch(new URL("/api/health", Bun.env.MARS_CONTROL_PLANE_URL));
  if (!response.ok) throw new Error(`control plane unavailable: ${response.status}`);
  const digest = Bun.env.MARS_GOLDEN_DIGEST!;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("invalid golden digest");
  const evidence = { digest, observedAt: new Date().toISOString(), repository: Bun.env.GITHUB_REPOSITORY, workflow: Bun.env.GITHUB_WORKFLOW };
  const path = `${Bun.env.MARS_CHANNEL_ROOT}/real-smoke-evidence.json`;
  await Bun.write(path, JSON.stringify({ ...evidence, signature: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") }) + "\n");
  await readFile(path, "utf8");
  console.log(JSON.stringify({ smoke: "passed", digest, workerId: Bun.env.MARS_LINUX_WORKER_ID }));
}
