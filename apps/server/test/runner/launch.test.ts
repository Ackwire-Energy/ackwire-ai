import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isBunfsPath, isCompiled, selfCommand } from "../../runner/launch";
import { acquireLock, LOCK_FILE, readLock } from "../../runner/lock";
import { launchdPlist, systemdUnit, windowsTaskCommand } from "../../runner/service";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const same = (p: string) => p;

test("compiled: the entry is in Bun's embedded file system, missing, or the executable itself", () => {
  expect(isBunfsPath("/$bunfs/root/agentes-runner")).toBe(true);
  expect(isBunfsPath("B:/~BUN/root/agentes-runner.exe")).toBe(true);
  expect(isBunfsPath("B:\\~BUN\\root\\agentes-runner.exe")).toBe(true);
  expect(isBunfsPath("/home/me/.agentes-runner/agentes-runner.mjs")).toBe(false);
  expect(isBunfsPath(undefined)).toBe(false);

  const app = "/Applications/agentes.app/Contents/MacOS/agentes-runner";
  expect(isCompiled({ execPath: app, argv1: "/$bunfs/root/agentes-runner" }, same)).toBe(true);
  expect(isCompiled({ execPath: app, bunMain: "/$bunfs/root/main.js", argv1: "/whatever" }, same)).toBe(true);
  expect(isCompiled({ execPath: app }, same)).toBe(true);
  expect(isCompiled({ execPath: app, argv1: app }, same)).toBe(true);
  expect(selfCommand({ execPath: app, argv1: "/$bunfs/root/agentes-runner" }, same)).toEqual([app]);
});

test("bundled: the runtime plus the script (real path)", () => {
  const node = "/usr/bin/node";
  const script = "/home/me/.agentes-runner/agentes-runner.mjs";
  expect(isCompiled({ execPath: node, argv1: script }, same)).toBe(false);
  expect(selfCommand({ execPath: node, argv1: script }, same)).toEqual([node, script]);
  // A symlinked launcher resolves to the script it points at.
  const resolve = (p: string) => (p === "/usr/local/bin/agentes-runner.mjs" ? script : p);
  expect(selfCommand({ execPath: node, argv1: "/usr/local/bin/agentes-runner.mjs" }, resolve)).toEqual([node, script]);
  expect(selfCommand({ execPath: "/home/me/.bun/bin/bun", bunMain: script, argv1: script }, same)).toEqual([
    "/home/me/.bun/bin/bun",
    script,
  ]);
});

test("service files for a compiled runner name the executable alone", () => {
  const launch = { runtime: "/opt/agentes/agentes-runner", home: "/home/me/.agentes-runner" };
  expect(systemdUnit(launch)).toContain('ExecStart="/opt/agentes/agentes-runner" start\n');
  const plist = launchdPlist(launch);
  expect(plist).toContain(
    "<array>\n    <string>/opt/agentes/agentes-runner</string>\n    <string>start</string>\n  </array>",
  );
  expect(plist).not.toContain("<string></string>");
  expect(windowsTaskCommand({ ...launch, runtime: "C:\\agentes\\agentes-runner.exe" }).install).toContain(
    '/TR "\\"C:\\agentes\\agentes-runner.exe\\" start"',
  );
});

test("lock: one runner per home; a second one is refused, a stale lock is taken over", () => {
  const home = tempDir("home-");
  dirs.push(home);
  const first = acquireLock(home, "app");
  expect(first.ok).toBe(true);
  expect(readLock(home)).toMatchObject({ pid: process.pid, mode: "app" });

  // Another process (another pid) finds ours alive.
  const second = acquireLock(home, "start", { pid: process.pid + 100_000, alive: () => true });
  expect(second).toMatchObject({ ok: false, holder: { pid: process.pid, mode: "app" } });

  // Released: the file goes, and anyone can take it.
  if (first.ok) first.release();
  expect(existsSync(path.join(home, LOCK_FILE))).toBe(false);

  // A lock left by a process that is gone is stale.
  writeFileSync(path.join(home, LOCK_FILE), JSON.stringify({ pid: 4_000_000, mode: "start", startedAt: "x" }));
  const taken = acquireLock(home, "start", { alive: (pid) => pid === process.pid });
  expect(taken.ok).toBe(true);
  expect(JSON.parse(readFileSync(path.join(home, LOCK_FILE), "utf8")).pid).toBe(process.pid);

  // Releasing never removes a lock someone else took over meanwhile.
  writeFileSync(path.join(home, LOCK_FILE), JSON.stringify({ pid: 4_000_001, mode: "app", startedAt: "x" }));
  if (taken.ok) taken.release();
  expect(existsSync(path.join(home, LOCK_FILE))).toBe(true);
});
