import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite, type QueryOptions, type Results, type Transaction } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";

/**
 * The database built into the server (native mode, ADR 0060 §2): PGlite, Postgres compiled to
 * WebAssembly (the engine the tests run on), with pgvector, keeping its files in one folder.
 */

/** The PGlite this build runs (pinned exactly in package.json) and the Postgres major of the files it writes. */
export const PGLITE_VERSION = "0.5.8";
export const PG_MAJOR = 18;

/** `pglite:///absolute/folder`: the folder, as written (no percent-encoding). */
const PGLITE_URL = /^pglite:\/\/(\/.*)$/;

/** Next to the database's own files: the PGlite and the Postgres major that wrote them. */
export const FOLDER_FILE = "agentes.json";

export interface FolderVersion {
  pglite: string;
  pgMajor: number;
}

/** The folder of a `pglite:///…` database URL; null for any other URL. */
export function pgliteFolder(url: string): string | null {
  return PGLITE_URL.exec(url)?.[1] ?? null;
}

/** The folder holds another Postgres major's files: it opens only after a dump and a restore. */
export class PgMajorMismatchError extends Error {
  constructor(
    readonly folder: string,
    readonly folderMajor: number,
  ) {
    super(
      `The database in ${folder} was written by Postgres ${folderMajor}, and this version runs Postgres ${PG_MAJOR}: it needs a dump with the previous version and a restore with this one.`,
    );
    this.name = "PgMajorMismatchError";
  }
}

/** What wrote the files in `folder`: its `agentes.json`, else Postgres's own `PG_VERSION`; null for a new folder. */
export function folderVersion(folder: string): FolderVersion | null {
  try {
    const v = JSON.parse(readFileSync(join(folder, FOLDER_FILE), "utf8")) as Partial<FolderVersion>;
    if (typeof v.pgMajor === "number") return { pglite: String(v.pglite ?? ""), pgMajor: v.pgMajor };
  } catch {
    // not there, or not ours: Postgres's own file says the major
  }
  try {
    const major = Number.parseInt(readFileSync(join(folder, "PG_VERSION"), "utf8"), 10);
    if (Number.isInteger(major)) return { pglite: "", pgMajor: major };
  } catch {
    // a new folder
  }
  return null;
}

/** Whether `folder` holds no database yet (missing, or empty). */
export function isEmptyFolder(folder: string): boolean {
  try {
    return readdirSync(folder).length === 0;
  } catch {
    return !existsSync(folder);
  }
}

function recordFolder(folder: string) {
  const current = folderVersion(folder);
  if (current?.pglite === PGLITE_VERSION && current.pgMajor === PG_MAJOR) return;
  const file = join(folder, FOLDER_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ pglite: PGLITE_VERSION, pgMajor: PG_MAJOR })}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function thenYield<T>(answer: Promise<T>): Promise<T> {
  try {
    return await answer;
  } finally {
    await nextTurn();
  }
}

/**
 * PGlite answers within the same turn of the event loop, so back-to-back queries (a migration, a busy
 * worker) would hold timers and sockets back until they all end: every query yields a turn once it is
 * done, inside transactions too.
 */
class YieldingPGlite extends PGlite {
  override query<T>(query: string, params?: unknown[], options?: QueryOptions): Promise<Results<T>> {
    return thenYield(super.query<T>(query, params, options));
  }

  override exec(query: string, options?: QueryOptions): Promise<Results[]> {
    return thenYield(super.exec(query, options));
  }

  override transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    // The transaction's other members (rollback, closed) stay its own, through the prototype.
    return super.transaction((tx) =>
      callback(
        Object.create(tx, {
          query: { value: <R>(q: string, p?: unknown[], o?: QueryOptions) => thenYield(tx.query<R>(q, p, o)) },
          exec: { value: (q: string, o?: QueryOptions) => thenYield(tx.exec(q, o)) },
        }) as Transaction,
      ),
    );
  }
}

/**
 * Opens the database in `folder`, creating it when the folder is new. Throws `PgMajorMismatchError`
 * before touching anything when the folder holds another Postgres major's files. `ready` resolves
 * once PGlite has started and the folder records what wrote it.
 */
export function openPglite(folder: string): { pg: PGlite; ready: Promise<void> } {
  const found = folderVersion(folder);
  if (found && found.pgMajor !== PG_MAJOR) throw new PgMajorMismatchError(folder, found.pgMajor);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const pg = new YieldingPGlite(folder, { extensions: { vector } });
  return { pg, ready: pg.waitReady.then(() => recordFolder(folder)) };
}

/**
 * The whole database as plain SQL, with INSERTs instead of COPY: `restorePglite` and `psql` both run it,
 * so it also moves the data to a Postgres server (the Docker install's). No owners or grants, which name
 * roles that only exist where the dump was made.
 */
export async function dumpPglite(folder: string): Promise<string> {
  const { pg, ready } = openPglite(folder);
  try {
    await ready;
    const file = await pgDump({ pg, args: ["--rows-per-insert=100", "--no-owner", "--no-privileges"] });
    return await file.text();
  } finally {
    await pg.close();
  }
}

/** Runs a dump (`dumpPglite`, or `pg_dump --inserts` of a Postgres server) into a new database in `folder`. */
export async function restorePglite(folder: string, dump: string): Promise<void> {
  if (!isEmptyFolder(folder)) throw new Error(`${folder} already holds a database`);
  const { pg, ready } = openPglite(folder);
  try {
    await ready;
    // The \restrict and \unrestrict lines a Postgres server's pg_dump writes are psql's, not SQL.
    await pg.exec(dump.replace(/^\\(?:un)?restrict [A-Za-z0-9]+$/gm, ""));
  } finally {
    await pg.close();
  }
}
