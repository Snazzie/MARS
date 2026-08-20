import { createDb, migrateDatabase } from "./index.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const db = createDb(databaseUrl);
try {
  await migrateDatabase(db);
} finally {
  await db.end({ timeout: 5 });
}
