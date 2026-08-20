import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const read = (path: string) => readFile(join(root, path), "utf8");

test("production Compose pins the image by digest and resolves files beside the compose file", async () => {
  const compose = await read("deploy/control-plane/compose.yaml");
  expect(compose).toContain("ghcr.io/whitesmith/control-plane@${WHITESMITH_RELEASE_DIGEST");
  expect(compose).not.toContain("ghcr.io/whitesmith/control-plane:${WHITESMITH_RELEASE_DIGEST");
  expect(compose).toContain("file: ./app_master_key");
  expect(compose).toContain("file: ./tunnel_token");
  expect(compose).toContain("./cloudflared-wrapper.sh:/run/whitesmith/cloudflared-wrapper.sh:ro");
  expect(compose).not.toContain("./deploy/control-plane/");
});

test("deployment template documents every required Compose variable without credentials", async () => {
  const compose = await read("deploy/control-plane/compose.yaml");
  const envExample = await read(".env.example");
  const variables = [...compose.matchAll(/\$\{([A-Z0-9_]+)(?::[^}]*)?\}/g)].map((match) => match[1]);
  for (const variable of new Set(variables)) expect(envExample).toContain(`${variable}=`);
  expect(envExample).not.toMatch(/(ghp_|github_pat_|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/i);
});

test("Unraid documentation covers operations and keeps Cloudflare optional", async () => {
  const readme = await read("deploy/control-plane/README.md");
  for (const phrase of [
    "docker compose",
    "/api/livez",
    "/api/readyz",
    "WebSocket",
    "backup",
    "rollback",
    "APP_MASTER_KEY",
    "Cloudflare Tunnel",
    "optional",
  ]) expect(readme).toContain(phrase);
});
