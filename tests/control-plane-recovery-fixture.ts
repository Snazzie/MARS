import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "../packages/db/src/index.ts";
import { SecretBox } from "../apps/control-plane/src/auth.ts";

const databaseUrl = Bun.env.DATABASE_URL?.trim();
const dataRoot = Bun.env.DATA_ROOT?.trim() || "/var/lib/mars";
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const key = (await readFile(join(dataRoot, "app_master_key"), "utf8")).trim();
const box = new SecretBox(key);
const db = createDb(databaseUrl);
try {
  const mode = Bun.argv.includes("--read") ? "read" : Bun.argv.includes("--seed") ? "seed" : "";
  if (!mode) throw new Error("use --seed or --read");
  if (mode === "seed") {
    await db`INSERT INTO github_app_config (singleton,app_id,slug,client_id,encrypted_pem,encrypted_client_secret,encrypted_webhook_secret) VALUES (true,700000,'recovery-fixture','recovery-client',${box.encrypt('recovery-pem')},${box.encrypt('recovery-client-secret')},${box.encrypt('recovery-webhook-secret')}) ON CONFLICT (singleton) DO UPDATE SET app_id=excluded.app_id,slug=excluded.slug,client_id=excluded.client_id,encrypted_pem=excluded.encrypted_pem,encrypted_client_secret=excluded.encrypted_client_secret,encrypted_webhook_secret=excluded.encrypted_webhook_secret,updated_at=now()`;
    console.log("recovery fixture seeded (encrypted values withheld)");
  } else {
    const [row] = await db<{ encryptedPem: string; encryptedClientSecret: string; encryptedWebhookSecret: string }[]>`SELECT encrypted_pem AS "encryptedPem",encrypted_client_secret AS "encryptedClientSecret",encrypted_webhook_secret AS "encryptedWebhookSecret" FROM github_app_config WHERE singleton=true`;
    if (!row) throw new Error("github_app_config fixture is missing");
    for (const value of [row.encryptedPem, row.encryptedClientSecret, row.encryptedWebhookSecret]) box.decrypt(value);
    console.log("recovery fixture decrypted successfully (plaintext and ciphertext withheld)");
  }
} finally {
  await db.end({ timeout: 5 });
}
