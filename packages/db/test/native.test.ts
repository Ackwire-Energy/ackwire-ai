import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/client";
import {
  DatabaseInUseError,
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

test("a query made while the database still starts waits for it, then answers", async () => {
  const { pg } = openPglite(db);
  try {
    expect((await pg.query<{ x: number }>("select 1 as x")).rows).toEqual([{ x: 1 }]);
  } finally {
    await pg.close();
  }
}, 15_000);

test("queries queued at once still leave room for timers between them", async () => {
  const { pg, ready } = openPglite(db);
  await ready;
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const seen: number[] = [];
  try {
    // A page's requests, the workers and a run's streaming, all querying at the same moment. Each answer then
    // holds the thread for 2 ms, past the timer's 1 ms, so the timer is due before the next query may start.
    await Promise.all(
      Array.from({ length: 100 }, () =>
        pg.query("select 1").then(() => {
          seen.push(ticks);
          Bun.sleepSync(2);
        }),
      ),
    );
  } finally {
    clearInterval(timer);
    await pg.close();
  }
  // The timer ran between every two answers: no two answers saw the same count.
  expect(new Set(seen).size).toBe(seen.length);
});

test("commits reach the disk: Postgres syncs, and its syncs reach the system", async () => {
  const { pg, ready } = openPglite(db);
  const sync = spyOn(fs, "fsyncSync");
  try {
    await ready;
    const { rows } = await pg.query<{ fsync: string; method: string }>(
      "select current_setting('fsync') as fsync, current_setting('wal_sync_method') as method",
    );
    expect(rows[0]).toEqual({ fsync: "on", method: "fsync" });
    sync.mockClear();
    await pg.query("update users set name = 'Ana' where id = 'u1'");
    expect(sync).toHaveBeenCalled();
  } finally {
    sync.mockRestore();
    await pg.close();
  }
});

/**
 * Runs `script` in another process, with `openPglite` imported, until it prints `signal`: this process must
 * be refused the folder while that one lives, and open it once that one is killed.
 */
async function heldByAnotherProcess(script: string, signal: string) {
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { openPglite } = await import(${JSON.stringify(join(import.meta.dir, "../src/pglite.ts"))});\n${script}`,
    ],
    { stdout: "pipe" },
  );
  let opened: ReturnType<typeof openPglite> | undefined;
  try {
    expect(new TextDecoder().decode((await holder.stdout.getReader().read()).value)).toContain(signal);
    expect(() => {
      opened = openPglite(db);
    }).toThrow(DatabaseInUseError);
  } finally {
    // Also after a failed check: left running, it would keep the folder, and the test run's output, open;
    // and a database this process opened anyway would keep the folder from the tests after this one.
    holder.kill("SIGKILL");
    await holder.exited;
    if (opened) await Promise.allSettled([opened.ready, opened.pg.close()]);
  }
  const after = openPglite(db);
  await after.ready;
  await after.pg.close();
}

test("one process at a time has a folder's database open, until it stops however it stops", async () => {
  const first = openPglite(db);
  await first.ready;
  // While held, the lock is one empty file beside the folder, and nothing else that a crash would leave.
  expect(readdirSync(root).filter((name) => name.startsWith("db."))).toEqual(["db.lock"]);
  expect(() => openPglite(db)).toThrow(DatabaseInUseError);
  await first.pg.close();

  // Another program holds it, then is killed: the system lets go of its lock with it.
  await heldByAnotherProcess(
    `const { pg, ready } = openPglite(${JSON.stringify(db)});
     await ready;
     console.log("open");
     setInterval(() => pg.query("select 1"), 1000);`,
    "open",
  );
}, 30_000);

test("a database dropped without being closed still holds its folder, until its process ends", async () => {
  await heldByAnotherProcess(
    `const folder = ${JSON.stringify(db)};
     // Opened and closed once first: while a process has opened only one database, the engine's compiled
     // code can keep that one reachable, and this process must let go of it.
     {
       const { pg, ready } = openPglite(folder);
       await ready;
       await pg.close();
     }
     let collected = false;
     const registry = new FinalizationRegistry(() => {
       collected = true;
     });
     await (async () => {
       const { pg, ready } = openPglite(folder);
       registry.register(pg, "");
       await ready;
     })();
     let rounds = 0;
     const collect = setInterval(() => {
       Bun.gc(true);
       if (collected || ++rounds === 300) {
         clearInterval(collect);
         console.log(collected ? "collected" : "still referenced");
       }
     }, 10);
     setInterval(() => {}, 1000);`,
    "collected",
  );
}, 30_000);
