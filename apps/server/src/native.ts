/**
 * `agentes-server`: agentes.chat with nothing else to install (native mode, ADR 0060 §2). One program
 * whose database is built in (PGlite: `DATABASE_URL=pglite:///<folder>`), keeping everything in one
 * folder, `--data` (`~/.agentes` by default):
 *
 *   .env             the settings, mode 600; variables already in the environment win over it
 *   db/              the database
 *   files/           uploaded files (FILES_DIR)
 *   logs/server.log  the log, 5 MB × 3
 *   server.lock      the pid of the one process using the folder
 *   server.json      written once it listens, removed when it stops
 *   backups/         what an upgrade's restore moved aside
 *
 * It listens on 127.0.0.1 only and answers only its own addresses (`ownHostsOnly`).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { format, parseArgs } from "node:util";
import {
  createDatabase,
  dumpPglite,
  folderVersion,
  isEmptyFolder,
  openPglite,
  PG_MAJOR,
  PGLITE_VERSION,
  PgMajorMismatchError,
  restorePglite,
} from "@agenteschat/db";
import { envEntries, upsertEnv } from "@agenteschat/setup/src/lib";
import { expandHome } from "../runner/config";
import { acquireLock, type LockResult } from "../runner/lock";
import { RotatingFile } from "../runner/logfile";
import {
  removeUserService,
  type ServiceDefinition,
  startLaunchAgent,
  startUserUnit,
  systemdUnitText,
  systemdUserAvailable,
  userServiceStatus,
} from "../runner/service";
import { createLogger } from "./logger";
import { prepareDatabase, startServer } from "./start";
import { version } from "./version";

export const EXIT = { ok: 0, error: 1, locked: 3, upgrade: 4, port: 5 } as const;
/** The ports a new folder may take, first free one first; not 3000, which the Docker install and dev tools use. */
export const NATIVE_PORTS = { first: 4310, last: 4329 } as const;
const LOCK_FILE = "server.lock";

/**
 * The installed package around this file: `<package>/server/lib/native.js` once bundled, next to
 * `<package>/web` and `<package>/bin/agentes-server` (`scripts/native-package.ts`).
 */
const PACKAGE = resolve(import.meta.dir, "..", "..");

const USAGE = `agentes-server ${version}: agentes.chat on this computer, with its database built in.

Usage:
  agentes-server [--data <folder>]
      Runs agentes.chat until it's stopped (Ctrl-C). The folder (default ~/.agentes) keeps
      everything; a new one gets its settings, in .env, the first time.
  agentes-server migrate [--data <folder>]
      Updates the database to this version, then exits.
  agentes-server db dump [--data <folder>] [--out <file>]
      The whole database as SQL (to the screen without --out). psql restores it into the
      Postgres of the Docker install.
  agentes-server db restore [--data <folder>] --in <file>
      Puts a dump into a folder with no database yet, or with one this version can't open (an
      upgrade: that one moves to backups/).
  agentes-server db check [--data <folder>]
      Opens the database and prints what wrote it.
  agentes-server version
  agentes-server service install|uninstall|status [--data <folder>]
      Starts it with this computer: at login on macOS, and from boot on Linux.

Exit codes: 0 stopped, 1 an error, 3 another agentes-server uses the folder, 4 the database needs
an upgrade (db dump with the previous version, then db restore with this one), 5 the port is taken.`;

/** What a data folder holds. */
export function nativeFiles(dir: string) {
  return {
    env: join(dir, ".env"),
    db: join(dir, "db"),
    files: join(dir, "files"),
    log: join(dir, "logs", "server.log"),
    ready: join(dir, "server.json"),
    backups: join(dir, "backups"),
  };
}

const ENV_HEADER = `# agentes.chat on this computer, with its database built in (agentes-server). Every value is
# explained in SELF_HOSTING.md. AGENTES_SECRET encrypts the keys stored in the database: it travels
# with the folder in a backup, and changing it makes them unreadable.
`;

/** Whether something already answers on 127.0.0.1:<port>. */
async function portTaken(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

async function firstFreePort(): Promise<number> {
  for (let port = NATIVE_PORTS.first; port <= NATIVE_PORTS.last; port++) if (!(await portTaken(port))) return port;
  return NATIVE_PORTS.first;
}

/**
 * The settings of the folder: its `.env` (made the first time, with a new secret and a free port),
 * under whatever the environment already sets, then what native mode is: the database and the files
 * in the folder, and only this computer's loopback.
 */
async function nativeEnv(dir: string, env: NodeJS.ProcessEnv = process.env) {
  const files = nativeFiles(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (!existsSync(files.env)) {
    const entries = {
      AGENTES_SECRET: randomBytes(48).toString("base64"),
      PORT: env.PORT ?? String(await firstFreePort()),
    };
    writeFileSync(files.env, upsertEnv(ENV_HEADER, entries), { mode: 0o600, flag: "wx" });
  }
  for (const [key, value] of envEntries(readFileSync(files.env, "utf8"))) env[key] ??= value;
  env.PORT ??= String(NATIVE_PORTS.first);
  env.PUBLIC_URL ??= `http://127.0.0.1:${env.PORT}`;
  env.WEB_DIR ??= join(PACKAGE, "web");
  env.DATABASE_URL = `pglite://${files.db}`;
  env.FILES_DIR = files.files;
  env.HOST = "127.0.0.1";
  env.NODE_ENV = "production";
  return { port: Number(env.PORT), publicUrl: env.PUBLIC_URL };
}

/** Everything the console prints also goes to `logs/server.log`. */
function teeLogs(file: string) {
  const log = new RotatingFile(file);
  for (const name of ["log", "info", "warn", "error", "debug"] as const) {
    const print = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      print(...args);
      try {
        log.append(`${format(...args)}\n`);
      } catch {
        // a full disk never stops the server
      }
    };
  }
}

function writeAtomic(file: string, text: string) {
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

const fail = (code: number, message: string) => {
  console.error(message);
  return code;
};

/** One process per folder; released when this one exits. */
function lockFolder(dir: string): LockResult {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = acquireLock(dir, "server", { file: LOCK_FILE });
  if (lock.ok) process.once("exit", lock.release);
  return lock;
}

const lockedMessage = (dir: string, pid: number) =>
  `Another agentes-server is using ${dir} (pid ${pid}). Stop it first, or use another folder (--data).`;

/** `agentes-server [--data <dir>]`: runs until SIGTERM or SIGINT (`startServer` drains and exits). */
async function run(dir: string): Promise<number> {
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  const files = nativeFiles(dir);
  const { port, publicUrl } = await nativeEnv(dir);
  if (Number.isInteger(port) && (await portTaken(port))) {
    return fail(EXIT.port, `Port ${port} is taken on this computer. Set another PORT in ${files.env}.`);
  }
  teeLogs(files.log);
  process.once("exit", () => rmSync(files.ready, { force: true }));
  try {
    await startServer({ edition: "selfhost", ownHostsOnly: true });
  } catch (error) {
    if (error instanceof PgMajorMismatchError) return fail(EXIT.upgrade, error.message);
    if ((error as { code?: string }).code === "EADDRINUSE") return fail(EXIT.port, `Port ${port} is taken.`);
    return fail(EXIT.error, `agentes.chat didn't start: ${error instanceof Error ? error.message : String(error)}`);
  }
  writeAtomic(
    files.ready,
    `${JSON.stringify({
      pid: process.pid,
      version,
      url: `http://127.0.0.1:${port}`,
      publicUrl,
      startedAt: new Date().toISOString(),
      pglite: PGLITE_VERSION,
      pgMajor: PG_MAJOR,
    })}\n`,
  );
  // Until a signal: startServer stops the server and exits.
  return new Promise<number>(() => {});
}

async function migrate(dir: string): Promise<number> {
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  await nativeEnv(dir);
  const database = createDatabase({ url: process.env.DATABASE_URL ?? "", poolMax: 1 });
  try {
    await prepareDatabase(database, createLogger("warn"));
  } finally {
    await database.close();
  }
  return EXIT.ok;
}

async function dump(dir: string, out: string | undefined): Promise<number> {
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  const { db } = nativeFiles(dir);
  if (isEmptyFolder(db)) return fail(EXIT.error, `There is no database in ${dir} yet.`);
  const text = await dumpPglite(db);
  if (out) writeFileSync(resolve(out), text, { mode: 0o600 });
  else await Bun.write(Bun.stdout, text);
  return EXIT.ok;
}

/**
 * Into a folder with no database yet; or, when its database is another Postgres major's (an upgrade),
 * into `db.new`, which then takes the place of `db` (moved to `backups/`). A database this version can
 * open is never written over.
 */
async function restore(dir: string, input: string): Promise<number> {
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  const files = nativeFiles(dir);
  const text = readFileSync(resolve(input), "utf8");
  if (isEmptyFolder(files.db)) {
    await restorePglite(files.db, text);
    return EXIT.ok;
  }
  const old = folderVersion(files.db);
  if (!old || old.pgMajor === PG_MAJOR) {
    return fail(EXIT.error, `${files.db} already holds a database. Restore into a new folder (--data) instead.`);
  }
  const next = `${files.db}.new`;
  // A restore that stopped halfway left only its own copy here.
  rmSync(next, { recursive: true, force: true });
  await restorePglite(next, text);
  mkdirSync(files.backups, { recursive: true, mode: 0o700 });
  const aside = join(files.backups, `db-pg${old.pgMajor}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  renameSync(files.db, aside);
  renameSync(next, files.db);
  console.error(`Restored. The previous database is in ${aside}.`);
  return EXIT.ok;
}

async function check(dir: string): Promise<number> {
  const lock = lockFolder(dir);
  if (!lock.ok) return fail(EXIT.locked, lockedMessage(dir, lock.holder.pid));
  const { db } = nativeFiles(dir);
  const found = folderVersion(db);
  if (isEmptyFolder(db) || !found) {
    console.log(JSON.stringify({ ok: false, error: `There is no database in ${dir} yet.` }));
    return EXIT.error;
  }
  if (found.pgMajor !== PG_MAJOR) {
    console.log(JSON.stringify({ ok: false, pgMajor: found.pgMajor, pglite: found.pglite }));
    return EXIT.upgrade;
  }
  const { pg, ready } = openPglite(db);
  try {
    await ready;
    await pg.query("select 1");
  } finally {
    await pg.close();
  }
  console.log(JSON.stringify({ ok: true, pgMajor: PG_MAJOR, pglite: PGLITE_VERSION }));
  return EXIT.ok;
}

/** The server as a background service of the person's own account (never root). */
function serviceDefinition(dir: string): ServiceDefinition {
  return {
    unit: "agentes-server",
    label: "chat.agentes.server",
    description: "agentes.chat",
    program: [join(PACKAGE, "bin", "agentes-server")],
    args: ["--data", dir],
    env: [],
    // Stopped on purpose, or a database that needs its upgrade: starting again can't help.
    finalExits: [EXIT.ok, EXIT.upgrade],
  };
}

function service(action: string | undefined, dir: string): number {
  const d = serviceDefinition(dir);
  const print = (line: string) => console.log(line);
  if (process.platform !== "linux" && process.platform !== "darwin") {
    return fail(EXIT.error, "agentes-server runs as a service on macOS and Linux.");
  }
  if (action === "status") {
    print(userServiceStatus(d) ?? "Not installed.");
    return EXIT.ok;
  }
  if (action === "uninstall") {
    print(`Removed ${removeUserService(d)}.`);
    return EXIT.ok;
  }
  if (action !== "install") return fail(EXIT.error, USAGE);
  const [launcher = ""] = d.program;
  if (!existsSync(launcher)) return fail(EXIT.error, `Install agentes.chat first: ${launcher} isn't there.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "darwin") {
    if (!startLaunchAgent(d, { print })) return EXIT.error;
    print(`agentes.chat starts at login now. Its log: ${nativeFiles(dir).log}`);
    return EXIT.ok;
  }
  if (!systemdUserAvailable()) {
    return fail(EXIT.error, `systemd's user manager isn't running here. Start it yourself: ${launcher} --data ${dir}`);
  }
  if (!startUserUnit(d.unit, systemdUnitText(d, "default.target"), { print })) return EXIT.error;
  // Without it, systemd stops the person's services when they log out, and starts them only at their login.
  const user = os.userInfo().username;
  const linger = Bun.spawnSync(["loginctl", "enable-linger", user], { stdout: "ignore", stderr: "ignore" });
  print(`agentes.chat starts with this computer now. Its log: ${nativeFiles(dir).log}`);
  if (linger.exitCode !== 0) print(`To keep it running after you log out, run as root: loginctl enable-linger ${user}`);
  return EXIT.ok;
}

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCommand>;
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    return fail(EXIT.error, `${(error as Error).message}\n\n${USAGE}`);
  }
  const { command, values } = parsed;
  const dir = expandHome(values.data ?? "~/.agentes");
  try {
    switch (command.join(" ")) {
      case "":
        return await run(dir);
      case "migrate":
        return await migrate(dir);
      case "db dump":
        return await dump(dir, values.out);
      case "db restore":
        return values.in ? await restore(dir, values.in) : fail(EXIT.error, "db restore needs --in <file>.");
      case "db check":
        return await check(dir);
      case "version":
        console.log(JSON.stringify({ version, pgMajor: PG_MAJOR, pglite: PGLITE_VERSION }));
        return EXIT.ok;
      case "help":
        console.log(USAGE);
        return EXIT.ok;
      default:
        if (command[0] === "service" && command.length <= 2) return service(command[1], dir);
        return fail(EXIT.error, USAGE);
    }
  } catch (error) {
    if (error instanceof PgMajorMismatchError) return fail(EXIT.upgrade, error.message);
    return fail(EXIT.error, error instanceof Error ? error.message : String(error));
  }
}

function parseCommand(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      data: { type: "string" },
      out: { type: "string" },
      in: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  return { command: values.help ? ["help"] : positionals, values };
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
