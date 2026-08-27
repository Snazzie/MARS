import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/drizzle-schema.ts",
  out: "./src/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost/mars" },
  migrations: { table: "__drizzle_migrations", schema: "drizzle" },
});
