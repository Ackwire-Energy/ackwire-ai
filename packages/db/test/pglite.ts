import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { type Database, migrationsFolder } from "../src/client";
import * as schema from "../src/schema";
import { tracingLogger } from "../src/trace";

/**
 * Fresh database with all migrations applied, for tests.
 *
 * - Default: in-memory PGlite (with pgvector) inside the test process; nothing to install.
 * - With `TEST_DATABASE_URL` set: a throw-away database on a real PostgreSQL
 *   server, created per call and dropped on close (docs/adr/0003-testing-with-pglite.md).
 *
 * `pglite` is exposed for tests that exercise LISTEN/NOTIFY directly.
 */
export async function createTestDatabase(): Promise<{ db: Database; close: () => Promise<void>; pglite?: PGlite }> {
  const serverUrl = process.env.TEST_DATABASE_URL;
  if (serverUrl) return createOnServer(serverUrl);

  const client = new PGlite({ extensions: { vector }, loadDataDir: await migratedTemplate() });
  const db = drizzlePglite(client, { schema, casing: "snake_case", logger: tracingLogger });
  return { db: db as unknown as Database, close: () => client.close(), pglite: client };
}

/**
 * Migrations run once per test process into a template database whose data
 * directory is then loaded by every fresh database (much faster than
 * migrating each time).
 */
let template: Promise<Blob> | undefined;
function migratedTemplate(): Promise<Blob> {
  template ??= (async () => {
    const client = new PGlite({ extensions: { vector } });
    await migratePglite(drizzlePglite(client, { schema, casing: "snake_case" }), { migrationsFolder });
    const dump = await client.dumpDataDir("none");
    await client.close();
    return dump;
  })();
  return template;
}

async function createOnServer(serverUrl: string) {
  const name = `agenteschat_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = postgres(serverUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const client = postgres(url.toString(), { max: 5, onnotice: () => {} });
  const db = drizzlePostgres(client, { schema, casing: "snake_case", logger: tracingLogger });
  await migratePostgres(db, { migrationsFolder });

  return {
    db: db as unknown as Database,
    close: async () => {
      await client.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
    },
  };
}
