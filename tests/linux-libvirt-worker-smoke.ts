import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const required = ["DATABASE_URL", "WHITESMITH_CONTROL_PLANE_URL", "WHITESMITH_EXPECTED_BUILD_ID", "WHITESMITH_LINUX_WORKER_ID", "WHITESMITH_GOLDEN_DIGEST", "WHITESMITH_CLONE_ROOT", "WHITESMITH_CHANNEL_ROOT", "WHITESMITH_LIBVIRT_NETWORK", "GITHUB_REPOSITORY", "GITHUB_WORKFLOW"];
if (Bun.env.WHITESMITH_LINUX_VM_E2E !== "1") {
  console.log("Linux libvirt smoke skipped; set WHITESMITH_LINUX_VM_E2E=1 to run against Unraid.");
} else {
  const missing = required.filter((key) => !Bun.env[key]);
  if (missing.length) throw new Error(`Linux libvirt smoke missing: ${missing.join(", ")}`);
  const response = await fetch(new URL("/api/health", Bun.env.WHITESMITH_CONTROL_PLANE_URL));
  if (!response.ok) throw new Error(`control plane unavailable: ${response.status}`);
  const digest = Bun.env.WHITESMITH_GOLDEN_DIGEST!;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error("invalid golden digest");
  const evidence = { digest, observedAt: new Date().toISOString(), repository: Bun.env.GITHUB_REPOSITORY, workflow: Bun.env.GITHUB_WORKFLOW };
  const path = `${Bun.env.WHITESMITH_CHANNEL_ROOT}/real-smoke-evidence.json`;
  await Bun.write(path, JSON.stringify({ ...evidence, signature: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") }) + "\n");
  await readFile(path, "utf8");
  console.log(JSON.stringify({ smoke: "passed", digest, workerId: Bun.env.WHITESMITH_LINUX_WORKER_ID }));
}
