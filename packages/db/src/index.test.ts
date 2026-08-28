import { expect, test } from "bun:test";
import { ensureDatabase, type RawDatabaseClient } from "./index.ts";

type FakeSql = RawDatabaseClient & { statements: string[]; unsafeStatements: string[]; ended: boolean; connectedUrl: string };

function fakeDatabase(rows: unknown[], connectedUrl: string): FakeSql {
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    sql.statements.push(strings.reduce((text, part, index) => `${text}${part}${index < values.length ? `$${index + 1}` : ""}`, ""));
    return rows;
  }) as FakeSql;
  sql.statements = [];
  sql.unsafeStatements = [];
  sql.ended = false;
  sql.connectedUrl = connectedUrl;
  sql.unsafe = (async (statement: string) => { sql.unsafeStatements.push(statement); return []; }) as never;
  sql.end = async () => { sql.ended = true; };
  return sql;
}

test("creates a missing database through the postgres maintenance database", async () => {
  let connection: FakeSql | undefined;
  await ensureDatabase("postgresql://alice:p%40ss@example.test:5433/mars?sslmode=require", {
    connect: url => connection = fakeDatabase([], url),
  });

  expect(connection?.connectedUrl).toBe("postgresql://alice:p%40ss@example.test:5433/postgres?sslmode=require");
  expect(connection?.statements).toEqual(["select datname from pg_database where datname=$1"]);
  expect(connection?.unsafeStatements).toEqual(['CREATE DATABASE "mars"']);
  expect(connection?.ended).toBe(true);
});
test("creates a missing database with a hyphenated identifier", async () => {
  let connection: FakeSql | undefined;
  await ensureDatabase("postgresql://alice:secret@example.test/mars-prod", {
    connect: url => connection = fakeDatabase([], url),
  });

  expect(connection?.unsafeStatements).toEqual(['CREATE DATABASE "mars-prod"']);
  expect(connection?.ended).toBe(true);
});

test("treats an existing database as a successful no-op", async () => {
  let connection: FakeSql | undefined;
  await ensureDatabase("postgres://alice:secret@example.test/mars", {
    connect: url => connection = fakeDatabase([{ exists: 1 }], url),
  });

  expect(connection?.unsafeStatements).toEqual([]);
  expect(connection?.ended).toBe(true);
});

test("rejects an unsafe database identifier before connecting", async () => {
  let connected = false;
  await expect(ensureDatabase("postgres://alice:secret@example.test/mars%22%3Bdrop%20database%20mars", {
    connect: () => { connected = true; return fakeDatabase([], ""); },
  })).rejects.toThrow("DATABASE_URL contains an invalid database identifier");
  expect(connected).toBe(false);
});
