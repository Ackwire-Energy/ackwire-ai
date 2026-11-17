import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentUser } from "../../runner/agent-users";
import { HOLDS_FILE, Holds, type HoldsSystem, keepScope, lockCommand, statStart } from "../../runner/holds";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

/**
 * `keep_running`'s holds on the computer (ADR 0176), with systemd-inhibit and the processes faked: each lock is a
 * fake process whose command line is kept, alive until the test ends it.
 */

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const AGENT = { id: "a1", handle: "desk" };
const USER: AgentUser = { id: "a1", user: "agent-desk", uid: 20001 };
const HOLD = "0193f6b4-1111-7000-8000-000000000001";
const OTHER = "0193f6b4-2222-7000-8000-000000000002";
const SLICE = "/agents.slice/agents-20001.slice";

/** Processes by pid: their owner, cgroup and start time; `spawn` makes one per lock. */
function fakeSystem(now = { ms: Date.parse("2026-11-12T12:00:00Z") }) {
  const procs = new Map<number, { uid: number; cgroup: string; started: string; argv?: string[] }>();
  const ran: string[][] = [];
  let next = 5000;
  const populated = new Set<string>();
  const system: HoldsSystem = {
    spawn(argv) {
      const pid = next++;
      procs.set(pid, { uid: 0, cgroup: `${SLICE}/x.scope`, started: String(pid * 10), argv });
      return pid;
    },
    started: (pid) => procs.get(pid)?.started ?? null,
    owner: (pid) => procs.get(pid) ?? null,
    populated: (cgroup) => populated.has(cgroup),
    async run(argv) {
      ran.push(argv);
      // Stopping a hold's scope ends its lock.
      if (argv[1] === "stop") {
        for (const [pid, p] of procs) if (p.argv && argv[2] === keepScope(holdOf(p.argv))) procs.delete(pid);
      }
      return 0;
    },
    now: () => now.ms,
  };
  const holdOf = (argv: string[]) =>
    /--unit=agentes-keep-(.+)$/.exec(argv.find((a) => a.startsWith("--unit=")) ?? "")?.[1] ?? "";
  const locks = () => [...procs.entries()].filter(([, p]) => p.argv);
  /** The command line of the `i`th lock still living. */
  const argv = (i = 0) => locks()[i]?.[1].argv ?? [];
  return { system, procs, ran, populated, now, locks, argv };
}

function setup(fake = fakeSystem()) {
  const home = tempDir("holds-");
  dirs.push(home);
  const ended: [string, string][] = [];
  const browsers: string[] = [];
  const closed: string[] = [];
  const make = () =>
    new Holds({
      home,
      log: () => {},
      system: fake.system,
      onEnded: (id, reason) => ended.push([id, reason]),
      onBrowser: (agentId) => browsers.push(agentId),
      closeBrowser: async (agent) => {
        closed.push(agent.id);
      },
      takeMs: 0,
    });
  return { home, holds: make(), make, ended, browsers, closed, ...fake };
}

test("a program's hold: systemd-inhibit's idle lock by root, in a scope in the agent's slice named after the hold", async () => {
  const t = setup();
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u7.scope`, started: "777" });
  expect(await t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, pid: 4242 })).toEqual({
    held: true,
  });
  // Never through the agent's launcher (its view may hide the system bus), and nothing as the agent's user.
  expect(t.argv().slice(0, 7)).toEqual([
    "/usr/bin/systemd-run",
    "--quiet",
    "--scope",
    "--collect",
    `--unit=agentes-keep-${HOLD}`,
    "--slice=agents-20001.slice",
    "--",
  ]);
  expect(t.argv().join(" ")).not.toMatch(/runuser|setpriv|unshare/);
  // No words of the agent's: every user can list the locks. It waits on the program by its start time.
  expect(t.argv().slice(7, 12)).toEqual([
    "/usr/bin/systemd-inhibit",
    "--what=idle",
    "--mode=block",
    "--who=agentes.chat",
    "--why=keep_running",
  ]);
  expect(t.argv().slice(12, 14)).toEqual(["/bin/sh", "-c"]);
  expect(t.argv().slice(15)).toEqual(["/proc/4242/stat", "777"]);
  expect(t.holds.report()).toEqual({ live: [HOLD], ended: [] });
  // The same hold again with the same bounds takes nothing new.
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, pid: 4242 });
  expect(t.locks()).toHaveLength(1);
});

test("only the agent's own programs, only living ones, and only what a hold can bind to", async () => {
  const t = setup();
  t.procs.set(10, { uid: 20002, cgroup: "/agents.slice/agents-20002.slice/run-u1.scope", started: "1" });
  t.procs.set(11, { uid: 20001, cgroup: "/system.slice/cron.service", started: "1" });
  const start = (req: Record<string, unknown>) =>
    errorCode(() => t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, ...req }));
  expect(await start({ pid: 10 })).toBe("not_allowed");
  expect(await start({ pid: 11 })).toBe("not_allowed");
  expect(await start({ pid: 999 })).toBe("not_found");
  expect(await start({})).toBe("bad_request");
  expect(await start({ until: "2026-11-12T11:00:00Z" })).toBe("bad_request");
  // A browser's hold must end (a Chrome held forever would never restart on a newer version).
  expect(await start({ browser: true })).toBe("bad_request");
  expect(await start({ browser: true, until: "2026-11-13T00:00:00Z" })).toBe("browser_closed");
  expect(
    await errorCode(() => t.holds.start(AGENT, USER, { op: "keep.start", holdId: "x", until: "2026-11-13T00:00:00Z" })),
  ).toBe("bad_request");
  expect(t.locks()).toHaveLength(0);
});

test("a program that exits ends its hold, reported once and listed as ended", async () => {
  const t = setup();
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u7.scope`, started: "777" });
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, pid: 4242 });
  // The program goes, and with it the lock that waited on it.
  t.procs.delete(4242);
  for (const [pid] of t.locks()) t.procs.delete(pid);
  t.holds.sweep();
  t.holds.sweep();
  expect(t.ended).toEqual([[HOLD, "exited"]]);
  expect(t.holds.report()).toEqual({ live: [], ended: [{ id: HOLD, reason: "exited" }] });
});

test("a time's hold sleeps until then and ends as expired; the runner ends it itself at its time", async () => {
  const t = setup();
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, until: "2026-11-12T14:00:00Z" });
  expect(t.argv().slice(-2)).toEqual(["/bin/sleep", "7200"]);
  t.now.ms = Date.parse("2026-11-12T14:00:01Z");
  t.holds.sweep();
  expect(t.ended).toEqual([[HOLD, "expired"]]);
  await waitFor(() => t.ran.some((a) => a[1] === "stop" && a[2] === keepScope(HOLD)));
});

test("the browser's hold waits on its slice, keeps it open meanwhile, and a person's Stop closes it", async () => {
  const t = setup();
  t.populated.add(`${SLICE}/agents-20001-browser.slice`);
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, browser: true, until: "2026-11-13T12:00:00Z" });
  expect(t.argv().at(-1)).toBe(`/sys/fs/cgroup${SLICE}/agents-20001-browser.slice/cgroup.events`);
  expect(t.holds.kept("a1")).toBe(true);
  expect(t.browsers).toEqual(["a1"]);
  expect(await t.holds.end({ op: "keep.end", holdId: HOLD, stop: true })).toEqual({ ended: true });
  expect(t.locks()).toHaveLength(0);
  expect(t.holds.kept("a1")).toBe(false);
  expect(t.closed).toEqual(["a1"]);
  // Ended on the server's word: nothing to report back.
  expect(t.ended).toEqual([]);
  expect(await t.holds.end({ op: "keep.end", holdId: HOLD })).toEqual({ ended: false });
});

test("a person's Stop signals the program, then SIGKILL, only while that same process is still there", async () => {
  const t = setup();
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u7.scope`, started: "777" });
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, pid: 4242 });
  await t.holds.end({ op: "keep.end", holdId: HOLD, stop: true });
  // By root: a `kill` as the agent would run outside its view.
  expect(t.ran[0]).toEqual(["/bin/kill", "-TERM", "4242"]);
  // Another process took the pid: nothing is signaled.
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u8.scope`, started: "999" });
  const before = t.ran.length;
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: OTHER, pid: 4242 });
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u9.scope`, started: "1000" });
  await t.holds.end({ op: "keep.end", holdId: OTHER, stop: true });
  expect(t.ran.slice(before).some((a) => a.includes("-TERM"))).toBe(false);
});

test("holds outlive the runner: one restarted goes on with those still living and reports those that ended", async () => {
  const t = setup();
  t.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u7.scope`, started: "777" });
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, pid: 4242 });
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: OTHER, until: "2026-11-13T12:00:00Z" });
  expect(JSON.parse(readFileSync(path.join(t.home, HOLDS_FILE), "utf8")).holds).toHaveLength(2);
  // While no runner ran, the program's lock went.
  t.procs.delete(t.locks()[0]?.[0] ?? 0);
  const again = t.make();
  expect(again.report()).toEqual({ live: [OTHER], ended: [{ id: HOLD, reason: "exited" }] });
});

test("after the computer restarts no hold is left, and none is reported ended: the server takes a time's again", async () => {
  const t = setup();
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, until: "2026-11-13T12:00:00Z" });
  const file = path.join(t.home, HOLDS_FILE);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), boot: "a-boot-before" }));
  expect(t.make().report()).toEqual({ live: [], ended: [] });
});

test("a hold changed while the sweep looks stays live, its old lock's end not reported", async () => {
  const fake = fakeSystem();
  const home = tempDir("holds-");
  dirs.push(home);
  const ended: [string, string][] = [];
  const holds = new Holds({
    home,
    log: () => {},
    system: fake.system,
    onEnded: (id, r) => ended.push([id, r]),
    takeMs: 300,
  });
  fake.procs.set(4242, { uid: 20001, cgroup: `${SLICE}/run-u7.scope`, started: "777" });
  await holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, pid: 4242 });
  // The same program with an end time: its lock is taken again, and the sweep fires while that waits.
  const changing = holds.start(AGENT, USER, {
    op: "keep.start",
    holdId: HOLD,
    pid: 4242,
    until: "2026-11-13T12:00:00Z",
  });
  await Bun.sleep(50);
  holds.sweep();
  expect(await changing).toEqual({ held: true });
  holds.sweep();
  expect(ended).toEqual([]);
  expect(holds.report()).toEqual({ live: [HOLD], ended: [] });
  expect(fake.locks()).toHaveLength(1);
});

test("a different time takes the lock again, the old one first", async () => {
  const t = setup();
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, until: "2026-11-12T14:00:00Z" });
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, until: "2026-11-12T16:00:00Z" });
  expect(t.locks()).toHaveLength(1);
  expect(t.argv().at(-1)).toBe("14400");
  expect(t.ran.some((a) => a[1] === "stop")).toBe(true);
});

test("another agent can't take or reach a hold", async () => {
  const t = setup();
  await t.holds.start(AGENT, USER, { op: "keep.start", holdId: HOLD, until: "2026-11-12T14:00:00Z" });
  const other = { id: "a2", user: "agent-ops", uid: 20002 };
  expect(
    await errorCode(() =>
      t.holds.start({ id: "a2", handle: "ops" }, other, {
        op: "keep.start",
        holdId: HOLD,
        until: "2026-11-12T15:00:00Z",
      }),
    ),
  ).toBe("not_allowed");
});

test("statStart reads the start time past a name with spaces and parentheses; a zombie has none", () => {
  // Field n holds `f<n>`: the pid is field 1, the name field 2, the state field 3.
  const rest = Array.from({ length: 40 }, (_, i) => `f${i + 4}`).join(" ");
  expect(statStart(`123 (my (odd) bot) S ${rest}`)).toBe("f22");
  expect(statStart(`123 (my (odd) bot) Z ${rest}`)).toBeNull();
});

// The lock's own commands, run for real (systemd-inhibit and the scope left out): each ends when what it holds does.
/**
 * A `/proc/<pid>/stat` line: a name its program chose to mislead a line-based reader (parentheses, a new line, a
 * false state, a glob), its state, and field 22 its start time.
 */
const stat = (state: string, started: string) =>
  `4242 (a (b)\n) Z * c) ${state} ${Array.from({ length: 18 }, (_, i) => i + 4).join(" ")} ${started} 23 24 25\n`;

/** Starts the program's wait on a stat file of the test's; `done()` says whether it ended. */
function programWait(file: string, started: string) {
  const wait = lockCommand({ uid: 1, pid: { pid: 4242, started } }, Date.now()).slice(5);
  expect(wait[3]).toBe("/proc/4242/stat");
  wait[3] = file;
  let ended = false;
  void Bun.spawn(wait).exited.then(() => {
    ended = true;
  });
  return () => ended;
}

test("the program's wait ends with the program: gone, a zombie, or its pid now another process's", async () => {
  const dir = tempDir("proc-");
  dirs.push(dir);
  const file = path.join(dir, "stat");
  for (const end of [
    () => writeFileSync(file, stat("S", "999")),
    () => writeFileSync(file, stat("Z", "777")),
    () => rmSync(file),
  ]) {
    writeFileSync(file, stat("S", "777"));
    const done = programWait(file, "777");
    await Bun.sleep(1500);
    expect(done()).toBe(false);
    end();
    await waitFor(done, 5000);
  }
});

test("the browser's wait ends a few looks after its slice is empty", async () => {
  const dir = tempDir("cg-");
  dirs.push(dir);
  const events = path.join(dir, "cgroup.events");
  writeFileSync(events, "populated 1\nfrozen 0\n");
  const wait = lockCommand({ uid: 1, browser: true }, Date.now()).slice(5);
  wait[3] = events;
  const waiting = Bun.spawn(wait);
  let done = false;
  void waiting.exited.then(() => {
    done = true;
  });
  await Bun.sleep(2500);
  expect(done).toBe(false);
  writeFileSync(events, "populated 0\nfrozen 0\n");
  await waitFor(() => done, 12_000);
});
