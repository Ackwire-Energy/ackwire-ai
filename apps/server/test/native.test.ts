import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { FOLDER_FILE, PG_MAJOR, PGLITE_VERSION } from "@agenteschat/db";

/**
 * `agentes-server` as people run it: a real process on a folder of its own, its database built in.
 * Each start migrates the folder on PGlite, so the steps share one folder and run in order.
 */

const NATIVE = join(import.meta.dir, "../src/native.ts");
let root = "";
let data = "";
let port = 0;
let url = "";
beforeAll(() => {
  root = mkdtempSync(join(os.tmpdir(), "agentes-native-"));
  data = join(root, "data");
  port = freePort();
  url = `http://127.0.0.1:${port}`;
});
const children: Bun.Subprocess[] = [];
afterAll(async () => {
  for (const child of children) child.kill("SIGKILL");
  await Promise.all(children.map((child) => child.exited));
  rmSync(root, { recursive: true, force: true });
});

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const found = probe.port ?? 0;
  void probe.stop(true);
  return found;
}

function start(dir = data, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, NATIVE, "--data", dir], {
    env: { ...process.env, PORT: String(port), WEB_DIR: join(root, "no-web"), ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  children.push(child);
  return { child, stderr: () => new Response(child.stderr).text() };
}

async function healthy(base = url, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await fetch(`${base}/api/health`).catch(() => null);
    if (res?.ok) return (await res.json()) as { status: string; database: string };
    await Bun.sleep(250);
  }
  throw new Error("the server didn't answer /api/health");
}

async function stop(child: ReturnType<typeof start>["child"]) {
  child.kill("SIGTERM");
  return child.exited;
}

/** The status line's code for a request with this Host, over a plain socket (fetch sets its own Host). */
async function statusWithHost(host: string): Promise<number> {
  let text = "";
  const done = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_s, chunk) {
        text += Buffer.from(chunk).toString();
        if (text.includes("\r\n")) done.resolve();
      },
      close: () => done.resolve(),
    },
  });
  socket.write(`GET /api/health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  await done.promise;
  socket.end();
  return Number(text.split(" ")[1]);
}

let cookie = "";
const call = async (path: string, init: { json?: unknown } = {}) => {
  const headers = new Headers({ origin: url });
  if (cookie) headers.set("cookie", cookie);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(`${url}${path}`, {
    method: init.json === undefined ? "GET" : "POST",
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (set.length > 0) cookie = set.join("; ");
  return res;
};

test("a new folder: it starts, migrates and answers only on its own loopback address", async () => {
  const server = start();
  const health = await healthy();
  expect(health).toMatchObject({ status: "ok", database: "ok" });
  // The folder it made: private, its settings generated once, and what wrote the database.
  expect(statSync(data).mode & 0o777).toBe(0o700);
  expect(statSync(join(data, ".env")).mode & 0o777).toBe(0o600);
  const env = readFileSync(join(data, ".env"), "utf8");
  expect(env).toMatch(/^AGENTES_SECRET=\S{40,}$/m);
  expect(env).toContain(`PORT=${port}`);
  expect(JSON.parse(readFileSync(join(data, "db", FOLDER_FILE), "utf8"))).toEqual({
    pglite: PGLITE_VERSION,
    pgMajor: PG_MAJOR,
  });
  expect(JSON.parse(readFileSync(join(data, "server.json"), "utf8"))).toMatchObject({
    pid: server.child.pid,
    url,
    publicUrl: url,
    pglite: PGLITE_VERSION,
    pgMajor: PG_MAJOR,
  });
  expect(readFileSync(join(data, "logs", "server.log"), "utf8")).toContain('"msg":"listening"');

  expect(await statusWithHost(`127.0.0.1:${port}`)).toBe(200);
  expect(await statusWithHost(`localhost:${port}`)).toBe(200);
  // A web page whose own name points at 127.0.0.1 (DNS rebinding) gets nothing.
  expect(await statusWithHost(`attacker.example:${port}`)).toBe(421);
  // Only loopback listens: this computer's other addresses refuse the connection.
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal);
  if (lan) expect(await fetch(`http://${lan.address}:${port}/api/health`).catch(() => null)).toBeNull();

  // The first account owns the installation; its workspace is in the folder's database.
  const signUp = await call("/api/auth/sign-up/email", {
    json: { name: "Ana", email: "ana@example.com", password: "correct horse battery" },
  });
  expect(signUp.status).toBe(200);
  const org = await call("/api/app/organizations", { json: { name: "Acme" } });
  expect(org.status).toBe(201);

  // One server per folder: a second one says who holds it and exits 3.
  const second = start();
  expect(await second.child.exited).toBe(3);
  expect(await second.stderr()).toContain(`pid ${server.child.pid}`);

  expect(await stop(server.child)).toBe(0);
  expect(existsSync(join(data, "server.json"))).toBe(false);
  expect(existsSync(join(data, "server.lock"))).toBe(false);
}, 120_000);

test("the data survives a restart, and a lock whose process is gone is taken over", async () => {
  // A crash leaves its lock behind: the pid of a process that has exited.
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  writeFileSync(join(data, "server.lock"), JSON.stringify({ pid: gone.pid, mode: "server", startedAt: "" }));
  const server = start();
  await healthy();
  const me = await call("/api/app/me");
  expect(me.status).toBe(200);
  const body = (await me.json()) as { user: { email: string }; organizations: { name: string }[] };
  expect(body.user.email).toBe("ana@example.com");
  expect(body.organizations.map((o) => o.name)).toEqual(["Acme"]);
  expect(await stop(server.child)).toBe(0);
}, 120_000);

test("a taken port exits 5, and a database of another Postgres major exits 4", async () => {
  const other = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("not agentes.chat") });
  try {
    const taken = start();
    expect(await taken.child.exited).toBe(5);
    expect(await taken.stderr()).toContain(`Port ${port} is taken`);
  } finally {
    await other.stop(true);
  }
  const old = join(root, "old");
  mkdirSync(join(old, "db"), { recursive: true });
  writeFileSync(join(old, "db", FOLDER_FILE), JSON.stringify({ pglite: "0.3.0", pgMajor: PG_MAJOR - 1 }));
  const upgrade = start(old);
  expect(await upgrade.child.exited).toBe(4);
  expect(await upgrade.stderr()).toContain(`Postgres ${PG_MAJOR - 1}`);
}, 60_000);

test("db check, dump, and an upgrade's restore, which keeps the previous database aside", async () => {
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, NATIVE, ...args, "--data", data], { stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return { code, out };
  };
  expect(JSON.parse((await run("db", "check")).out)).toEqual({ ok: true, pgMajor: PG_MAJOR, pglite: PGLITE_VERSION });
  const dumpFile = join(root, "dump.sql");
  expect((await run("db", "dump", "--out", dumpFile)).code).toBe(0);
  expect(readFileSync(dumpFile, "utf8")).toContain("ana@example.com");
  // This version can open it: a restore never writes over it.
  expect((await run("db", "restore", "--in", dumpFile)).code).toBe(1);

  // The folder as an older version left it (its Postgres major stubbed): it needs the upgrade.
  writeFileSync(join(data, "db", FOLDER_FILE), JSON.stringify({ pglite: "0.3.0", pgMajor: PG_MAJOR - 1 }));
  expect((await run("db", "check")).code).toBe(4);
  expect((await run("db", "restore", "--in", dumpFile)).code).toBe(0);
  expect((await run("db", "check")).code).toBe(0);
  expect(readdirSync(join(data, "backups")).filter((name) => name.startsWith(`db-pg${PG_MAJOR - 1}-`))).toHaveLength(1);

  const server = start();
  await healthy();
  const me = (await (await call("/api/app/me")).json()) as { organizations: { name: string }[] };
  expect(me.organizations.map((o) => o.name)).toEqual(["Acme"]);
  expect(await stop(server.child)).toBe(0);
}, 120_000);

test("version names what it runs", async () => {
  const child = Bun.spawn([process.execPath, NATIVE, "version"], { stdout: "pipe" });
  const out = JSON.parse(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  expect(out).toMatchObject({ pgMajor: PG_MAJOR, pglite: PGLITE_VERSION });
});
