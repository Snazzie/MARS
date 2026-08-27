import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const read = (path: string) => readFile(join(root, path), "utf8");

test("production Compose requires only DATABASE_URL and keeps the data volume", async () => {
  const compose = await read("deploy/control-plane/compose.yaml");
  expect(compose).toContain("DATABASE_URL: ${DATABASE_URL:?set DATABASE_URL}");
  expect(compose).toContain("DATA_ROOT: /var/lib/mars");
  expect(compose).toContain("mars-data:/var/lib/mars");
  expect(compose).not.toContain("postgres:");
  expect(compose).not.toContain("secrets:");
  expect(compose).toContain("profiles: [tunnel]");
  expect(compose).toContain("CLOUDFLARE_TUNNEL_TOKEN");
  expect(compose).not.toContain("POSTGRES_PASSWORD");
});

test("deployment template documents the required database variable without secrets", async () => {
  const compose = await read("deploy/control-plane/compose.yaml");
  const envExample = await read(".env.example");
  const variables = [...compose.matchAll(/\$\{([A-Z0-9_]+)(?::[^}]*)?\}/g)].map((match) => match[1]);
  for (const variable of new Set(variables)) expect(envExample).toContain(`${variable}=`);
  expect(envExample).not.toMatch(/(ghp_|github_pat_|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/i);
});

test("Unraid exposes only database, port, and persistent data inputs", async () => {
  const template = await read("deploy/unraid/mars-control-plane.xml");
  expect(template).toContain("Target=\"DATABASE_URL\"");
  expect(template).toContain("Target=\"3000\"");
  expect(template).toContain("Target=\"/var/lib/mars\"");
  expect(template).not.toContain("/run/secrets/app_master_key");
  expect(template).not.toContain("GITHUB_");
});

test("image persists production data-root contract", async () => {
  const dockerfile = await read("deploy/control-plane/Dockerfile");
  expect(dockerfile).toContain("ARG MARS_BUILD_ID=unknown");
  expect(dockerfile).toContain("ENV NODE_ENV=production");
  expect(dockerfile).toContain("ENV DATA_ROOT=/var/lib/mars");
  expect(dockerfile).toContain("chmod 700 /var/lib/mars");
});

test("deployment guide documents first-run persistence and incomplete worker gates", async () => {
  const readme = await read("deploy/control-plane/README.md");
  for (const phrase of ["DATABASE_URL", "/onboarding", "/api/livez", "/api/readyz", "WebSocket", "Cloudflare Tunnel", "CLOUDFLARE_TUNNEL_TOKEN", "/api/github/webhooks", "back up", "linux/amd64", "worker execution"]) expect(readme).toContain(phrase);
});
