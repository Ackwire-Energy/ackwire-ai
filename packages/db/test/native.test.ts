import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/client";
import {
  dumpPglite,
  FOLDER_FILE,
  folderVersion,
  openPglite,
  PG_MAJOR,
  PGLITE_VERSION,
  PgMajorMismatchError,
  restorePglite,
} from "../src/pglite";
import { users } from "../src/schema";

let root = "";
let db = "";
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "agentes-native-db-"));
  db = join(root, "db");
  // One migrated folder for the whole file: migrating it is the slow part.
  const first = createDatabase({ url: `pglite://${db}`, poolMax: 1 });
  await first.migrate();
  await first.db.insert(users).values({ id: "u1", name: "Ana", email: "ana@example.com" });
  await first.close();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a folder keeps its data across a reopen and records what wrote it", async () => {
  expect(folderVersion(db)).toEqual({ pglite: PGLITE_VERSION, pgMajor: PG_MAJOR });
  const again = createDatabase({ url: `pglite://${db}`, poolMax: 1 });
  // Already migrated: the guard passes and nothing new runs.
  await again.migrate();
  await again.ping();
  expect(await again.db.select({ name: users.name }).from(users).where(eq(users.id, "u1"))).toEqual([{ name: "Ana" }]);
  await again.close();
});

test("a folder written by another Postgres major is refused before anything opens it", () => {
  const old = join(root, "old");
  mkdirSync(old);
  writeFileSync(join(old, FOLDER_FILE), JSON.stringify({ pglite: "0.3.0", pgMajor: PG_MAJOR - 1 }));
  expect(() => createDatabase({ url: `pglite://${old}`, poolMax: 1 })).toThrow(PgMajorMismatchError);
  // Without our file, Postgres's own says the major.
  const bare = join(root, "bare");
  mkdirSync(bare);
  writeFileSync(join(bare, "PG_VERSION"), `${PG_MAJOR - 1}\n`);
  expect(folderVersion(bare)).toEqual({ pglite: "", pgMajor: PG_MAJOR - 1 });
  expect(() => openPglite(bare)).toThrow(PgMajorMismatchError);
});

test("the pinned versions are the ones that run", async () => {
  const pg = new PGlite();
  const { rows } = await pg.query<{ v: string }>("select current_setting('server_version_num') as v");
  await pg.close();
  expect(Math.floor(Number(rows[0]?.v) / 10000)).toBe(PG_MAJOR);
  const pkg = join(dirname(Bun.resolveSync("@electric-sql/pglite", import.meta.dir)), "..", "package.json");
  expect(JSON.parse(readFileSync(pkg, "utf8")).version).toBe(PGLITE_VERSION);
});

test("a dump restores into a new folder, data and migrations included, and never over a database", async () => {
  const dump = await dumpPglite(db);
  expect(dump).toContain("CREATE EXTENSION IF NOT EXISTS vector");
  expect(dump).not.toContain("COPY ");
  const copy = join(root, "copy");
  await restorePglite(copy, dump);
  const restored = createDatabase({ url: `pglite://${copy}`, poolMax: 1 });
  await restored.migrate();
  expect(await restored.db.select({ email: users.email }).from(users)).toEqual([{ email: "ana@example.com" }]);
  await restored.close();
  expect(folderVersion(copy)?.pgMajor).toBe(PG_MAJOR);
  await expect(restorePglite(copy, dump)).rejects.toThrow(/already holds a database/);
});

test("back-to-back queries leave room for timers", async () => {
  const { pg, ready } = openPglite(db);
  await ready;
  let outside = false;
  setTimeout(() => {
    outside = true;
  }, 0);
  for (let i = 0; i < 200 && !outside; i++) await pg.query("select 1");
  let inside = false;
  await pg.transaction(async (tx) => {
    setTimeout(() => {
      inside = true;
    }, 0);
    for (let i = 0; i < 200 && !inside; i++) await tx.query("select 1");
  });
  await pg.close();
  expect([outside, inside]).toEqual([true, true]);
});
