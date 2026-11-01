import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeAgents } from "../../runner/access";
import {
  AGENT_USERS_FILE,
  AgentUsers,
  adbServerPort,
  agentGid,
  agentUserName,
  readAgentUsers,
  systemLauncher,
} from "../../runner/agent-users";
import { agentCategorySlice, agentSlice, type RunCommand } from "../../runner/service";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const RANGE: [number, number] = [21000, 21099];
const ANA = { id: "A1B2C3D4-0000-4000-8000-000000000001", handle: "ana", name: "Ana Ção" };
const BIA = { id: "b2c3d4e5-0000-4000-8000-000000000002", handle: "bia", name: "Bia" };

interface OsUser {
  name: string;
  uid: number;
  comment: string;
}

/** passwd in memory; useradd and usermod fail the way the real ones do (9: the name exists, 4: the uid is taken). */
function fakeOs(users: OsUser[] = [{ name: "root", uid: 0, comment: "root" }]) {
  const calls: string[] = [];
  const fails = new Map<string, number>();
  const run: RunCommand = (file, args) => {
    calls.push([file, ...args].join(" "));
    const failure = fails.get(file);
    if (failure !== undefined) {
      fails.delete(file);
      return { code: failure, output: `${file}: cannot lock /etc/passwd` };
    }
    const name = args.at(-1) ?? "";
    if (file === "getent") {
      return {
        code: 0,
        output: users.map((u) => `${u.name}:x:${u.uid}:${u.uid}:${u.comment}:/home/${u.name}:/bin/bash`).join("\n"),
      };
    }
    if (file === "useradd") {
      const uid = Number(args[args.indexOf("--uid") + 1]);
      if (users.some((u) => u.name === name)) return { code: 9, output: `useradd: user '${name}' already exists` };
      if (users.some((u) => u.uid === uid)) return { code: 4, output: `useradd: UID ${uid} is not unique` };
      users.push({ name, uid, comment: args[args.indexOf("--comment") + 1] ?? "" });
      return { code: 0, output: "" };
    }
    if (file === "usermod") {
      const u = users.find((x) => x.name === name);
      if (!u) return { code: 6, output: `usermod: user '${name}' does not exist` };
      u.comment = args[1] ?? "";
      return { code: 0, output: "" };
    }
    return { code: 0, output: "" };
  };
  return { run, calls, users, failNext: (file: string, code: number) => fails.set(file, code) };
}

function setup(users?: OsUser[]) {
  const home = tempDir("agent-users-");
  dirs.push(home);
  const os = fakeOs(users);
  return { home, os, users: new AgentUsers({ home, range: RANGE, run: os.run, etc: home }) };
}

const listed = (home: string) => JSON.parse(readFileSync(path.join(home, AGENT_USERS_FILE), "utf8")) as unknown;

test("an agent's first request makes its user with the lowest free uid, listed in agents.json", () => {
  const { home, os, users } = setup([
    { name: "root", uid: 0, comment: "root" },
    { name: "maria", uid: 1000, comment: "Maria" },
    { name: "someone", uid: 21000, comment: "" },
    { name: "other", uid: 21001, comment: "" },
  ]);
  // A listed uid whose user is gone is still never handed out again.
  writeFileSync(
    path.join(home, AGENT_USERS_FILE),
    JSON.stringify([{ id: "gone-0001", user: "ag-gone0001", uid: 21002 }]),
  );

  expect(users.ensure(ANA)).toEqual({ id: ANA.id, user: "ag-a1b2c3d4", uid: 21003 });
  expect(os.calls).toEqual([
    "getent passwd",
    "useradd --uid 21003 --user-group --create-home --home-dir /home/ag-a1b2c3d4 --shell /bin/bash --comment Ana Ção ag-a1b2c3d4",
    "chmod 0700 /home/ag-a1b2c3d4",
  ]);
  expect(listed(home)).toEqual([
    { id: "gone-0001", user: "ag-gone0001", uid: 21002 },
    { id: ANA.id, user: "ag-a1b2c3d4", uid: 21003 },
  ]);
  if (process.platform !== "win32") expect(statSync(path.join(home, AGENT_USERS_FILE)).mode & 0o777).toBe(0o600);

  expect(users.ensure(BIA)).toEqual({ id: BIA.id, user: "ag-b2c3d4e5", uid: 21004 });
});

test("idempotent: the same agent again runs nothing; a new process only looks it up", () => {
  const { home, os, users } = setup();
  const first = users.ensure(ANA);
  os.calls.length = 0;
  expect(users.ensure(ANA)).toEqual(first);
  expect(users.ensure({ id: ANA.id, handle: ANA.handle })).toEqual(first);
  expect(os.calls).toEqual([]);

  const before = readFileSync(path.join(home, AGENT_USERS_FILE), "utf8");
  const again = new AgentUsers({ home, range: RANGE, run: os.run, etc: home });
  expect(again.ensure(ANA)).toEqual(first);
  expect(os.calls).toEqual(["getent passwd"]);
  expect(readFileSync(path.join(home, AGENT_USERS_FILE), "utf8")).toBe(before);
});

test("a rename changes the user's comment (usermod -c); a request without a name changes nothing", () => {
  const { os, users } = setup();
  users.ensure(ANA);
  os.calls.length = 0;
  users.ensure({ ...ANA, name: "Ana Nova" });
  expect(os.calls).toEqual(["getent passwd", "usermod --comment Ana Nova ag-a1b2c3d4"]);
  expect(os.users.find((u) => u.name === "ag-a1b2c3d4")?.comment).toBe("Ana Nova");
  os.calls.length = 0;
  users.ensure({ id: ANA.id, handle: ANA.handle });
  users.ensure({ ...ANA, name: "Ana Nova" });
  expect(os.calls).toEqual([]);
});

test("name rules: ag- and the id's first 8 letters and digits; comments useradd accepts", () => {
  expect(agentUserName(ANA.id)).toBe("ag-a1b2c3d4");
  expect(agentUserName("0123abcd")).toBe("ag-0123abcd");
  for (const bad of ["", "abc", "a-b-c-d-e-f-g", "--------"]) expect(() => agentUserName(bad)).toThrow();

  const { os, users } = setup();
  users.ensure({ ...ANA, name: "Ana: dev\nops\t1 " });
  users.ensure({ id: BIA.id, handle: "bia" });
  const added = os.users.slice(1);
  expect(added.map((u) => u.comment)).toEqual(["Ana dev ops 1", "bia"]);
});

test("a bad id or a user name another listed agent has is refused, and nothing is made", async () => {
  const { home, os, users } = setup();
  expect(await errorCode(() => users.ensure({ id: "short", handle: "x" }))).toBe("bad_request");
  expect(os.calls).toEqual([]);
  users.ensure(ANA);
  os.calls.length = 0;
  // Same first 8 of the id, another agent.
  const twin = { id: "a1b2c3d4-ffff-4fff-8fff-ffffffffffff", handle: "twin", name: "Twin" };
  expect(await errorCode(() => users.ensure(twin))).toBe("internal");
  expect(os.calls).toEqual(["getent passwd"]);
  expect(readAgentUsers(home).map((r) => r.id)).toEqual([ANA.id]);
});

test("a listed user whose uid changed on the computer is refused", async () => {
  const { os, users, home } = setup();
  users.ensure(ANA);
  const u = os.users.find((x) => x.name === "ag-a1b2c3d4");
  if (u) u.uid = 21050;
  const again = new AgentUsers({ home, range: RANGE, run: os.run, etc: home });
  expect(await errorCode(() => again.ensure(ANA))).toBe("internal");
});

test("agents.json lost: the agent's existing user is listed again with its own uid; one outside the range isn't", async () => {
  const { home, os, users } = setup([
    { name: "root", uid: 0, comment: "root" },
    { name: "ag-a1b2c3d4", uid: 21007, comment: "Ana Ção" },
    { name: "ag-b2c3d4e5", uid: 1001, comment: "Bia" },
  ]);
  expect(users.ensure(ANA)).toEqual({ id: ANA.id, user: "ag-a1b2c3d4", uid: 21007 });
  expect(os.calls).toEqual(["getent passwd"]);
  expect(await errorCode(() => users.ensure(BIA))).toBe("internal");
  expect(readAgentUsers(home)).toEqual([{ id: ANA.id, user: "ag-a1b2c3d4", uid: 21007 }]);
});

test("a useradd that fails keeps the uid listed: the next request makes the user with it", async () => {
  const { home, os, users } = setup();
  os.failNext("useradd", 10);
  expect(await errorCode(() => users.ensure(ANA))).toBe("internal");
  expect(readAgentUsers(home)).toEqual([{ id: ANA.id, user: "ag-a1b2c3d4", uid: 21000 }]);
  expect(users.ensure(BIA).uid).toBe(21001);
  os.calls.length = 0;
  expect(users.ensure(ANA).uid).toBe(21000);
  expect(os.calls[1]).toStartWith("useradd --uid 21000 ");
});

test("no uid left in the range: refused", async () => {
  const home = tempDir("agent-users-");
  dirs.push(home);
  const os = fakeOs([
    { name: "a", uid: 21000, comment: "" },
    { name: "b", uid: 21001, comment: "" },
  ]);
  const users = new AgentUsers({ home, range: [21000, 21001], run: os.run, etc: home });
  expect(await errorCode(() => users.ensure(ANA))).toBe("internal");
  expect(readAgentUsers(home)).toEqual([]);
});

test("agents.json: only well-formed rows count, and the server's agent list never lands in it", () => {
  const home = tempDir("agent-users-");
  dirs.push(home);
  const file = path.join(home, AGENT_USERS_FILE);
  writeFileSync(
    file,
    JSON.stringify([
      { id: "x", handle: "dev", name: "Dev" },
      { id: "y", user: "root", uid: 0 },
      { id: "z", user: "ag-zzzzzzzz", uid: 999 },
      { id: "w", user: "ag-wwwwwwww", uid: 21050, extra: true },
    ]),
  );
  expect(readAgentUsers(home)).toEqual([{ id: "w", user: "ag-wwwwwwww", uid: 21050 }]);
  writeFileSync(file, "not json");
  expect(readAgentUsers(home)).toEqual([]);

  writeFileSync(file, JSON.stringify([{ id: "w", user: "ag-wwwwwwww", uid: 21050 }]));
  writeAgents(home, [{ id: "w", handle: "dev", name: "Dev" }]);
  expect(readAgentUsers(home)).toEqual([{ id: "w", user: "ag-wwwwwwww", uid: 21050 }]);
});

test("the launcher: the agent's slice, its own temporary folders, its user, absolute paths, a fixed environment", () => {
  const user = { id: ANA.id, user: "ag-a1b2c3d4", uid: 21003 };
  const env = {
    HOME: "/home/ag-a1b2c3d4",
    USER: "ag-a1b2c3d4",
    LOGNAME: "ag-a1b2c3d4",
    SHELL: "/bin/bash",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    ANDROID_ADB_SERVER_PORT: "31627",
  };
  const launcher = systemLauncher(user, true);
  const p = launcher.prefix;
  expect(p.slice(0, 8)).toEqual([
    "/usr/bin/systemd-run",
    "--quiet",
    "--scope",
    "--collect",
    "--slice=agents-21003.slice",
    "--",
    "/bin/sh",
    "-c",
  ]);
  expect(p.slice(9, 18)).toEqual([
    "sh",
    "21003",
    "/usr/bin/unshare",
    "--mount",
    "--propagation",
    "slave",
    "--",
    "/bin/sh",
    "-c",
  ]);
  expect(p.slice(19)).toEqual(["sh", "21003", "/usr/sbin/runuser", "-u", "ag-a1b2c3d4", "--"]);
  expect(launcher).toMatchObject({ env, home: "/home/ag-a1b2c3d4", tmp: "/run/agentes-runner-tmp/21003/tmp" });
  // Root on the computer: the agent's own tmpfs, mounted once (a lock, so two first launches don't stack two).
  expect((p[8] ?? "").split("\n")).toEqual([
    "set -e",
    "r=/run/agentes-runner-tmp",
    'mkdir -p "$r"',
    'chmod 0700 "$r"',
    'd="$r/$1"',
    "shift",
    'mkdir -p "$d"',
    `flock "$r/.lock" sh -c 'mountpoint -q "$1" || mount -t tmpfs -o mode=0700,size=50%,nr_inodes=1m agentes-runner-tmp "$1"' sh "$d"`,
    'exec "$@"',
  ]);
  // Root, in the agent's own mount namespace, before it becomes the agent: its folders under root-only ones, bound
  // over the shared ones (/tmp, /dev/shm and /run/lock from its tmpfs, /var/tmp from the disk); in its own /tmp only
  // mkdir, never a chmod an agent's link could aim.
  expect((p[18] ?? "").split("\n")).toEqual([
    "set -e",
    "m=/run/agentes-runner-tmp/$1",
    "r=/var/lib/agentes-runner-tmp",
    'mkdir -p "$r"',
    'chmod 0700 "$r"',
    'd="$r/$1"',
    "shift",
    'mkdir -p "$d"',
    'chmod 0700 "$d"',
    'mkdir -p "$d/var-tmp"',
    'chmod 1777 "$d/var-tmp"',
    'for f in tmp shm lock; do mkdir -p "$m/$f"; chmod 1777 "$m/$f"; done',
    'mount --bind "$m/tmp" /tmp',
    'mount --bind "$d/var-tmp" /var/tmp',
    'mount --bind "$m/shm" /dev/shm',
    'if [ "$(stat -c %a /run/lock 2>/dev/null)" = 1777 ]; then mount --bind "$m/lock" /run/lock; fi',
    "mkdir -m 1777 /tmp/.X11-unix 2>/dev/null || :",
    "mkdir -m 1777 /tmp/.ICE-unix 2>/dev/null || :",
    'exec "$@"',
  ]);
  // No systemd as PID 1 (a container): runuser alone.
  expect(systemLauncher(user, false)).toEqual({
    prefix: ["/usr/sbin/runuser", "-u", "ag-a1b2c3d4", "--"],
    env,
    home: "/home/ag-a1b2c3d4",
  });
});

test("an agent's user can't schedule cron or at jobs, which would run outside its launcher", () => {
  const { home, users } = setup();
  const cron = path.join(home, "cron.deny");
  const at = path.join(home, "at.deny");
  // No at.deny: at takes root's jobs alone, so it isn't made.
  users.ensure(ANA);
  expect(readFileSync(cron, "utf8")).toBe("ag-a1b2c3d4\n");
  expect(statSync(cron).mode & 0o777).toBe(0o644);
  expect(existsSync(at)).toBe(false);
  // An at.deny of the distribution's, without a last newline; an agent already listed isn't again.
  writeFileSync(at, "daemon\nnobody");
  writeFileSync(cron, "ag-a1b2c3d4\n");
  users.ensure(BIA);
  expect(readFileSync(cron, "utf8")).toBe("ag-a1b2c3d4\nag-b2c3d4e5\n");
  expect(readFileSync(at, "utf8")).toBe("daemon\nnobody\nag-b2c3d4e5\n");
  // A new process looks again at its first request for each agent: one listed before this runner is too.
  writeFileSync(cron, "");
  const os = fakeOs([{ name: "ag-a1b2c3d4", uid: 21000, comment: "Ana Ção" }]);
  new AgentUsers({ home, range: RANGE, run: os.run, etc: home }).ensure(ANA);
  expect(os.calls).toEqual(["getent passwd"]);
  expect(readFileSync(cron, "utf8")).toBe("ag-a1b2c3d4\n");
});

test("adb's server port: one per agent, outside every band and Linux's ephemeral range", () => {
  expect(adbServerPort(20001)).toBe(30625);
  const ports = new Set<number>();
  for (let uid = 20000; uid <= 20999; uid++) ports.add(adbServerPort(uid));
  expect(ports.size).toBe(1000);
  for (let uid = 1000; uid <= 59999; uid += 7) {
    const port = adbServerPort(uid);
    expect(port >= 30000 && port <= 32767).toBe(true);
  }
});

test("inside the agent's slice, its Chrome and its AI CLIs each get one, named from its uid", () => {
  expect(agentSlice(21003)).toBe("agents-21003.slice");
  expect(agentCategorySlice(21003, "browser")).toBe("agents-21003-browser.slice");
  expect(agentCategorySlice(21003, "cli")).toBe("agents-21003-cli.slice");
});

test("an agent user's group, as the computer says it (`id -g`): never root's, never a guess", async () => {
  const calls: string[] = [];
  const answer =
    (code: number, output: string): RunCommand =>
    (file, args) => {
      calls.push([file, ...args].join(" "));
      return { code, output };
    };
  expect(agentGid("ag-a1b2c3d4", answer(0, "21007"))).toBe(21007);
  expect(calls).toEqual(["id -g ag-a1b2c3d4"]);
  expect(await errorCode(() => agentGid("ag-a1b2c3d4", answer(1, "id: 'ag-a1b2c3d4': no such user")))).toBe("internal");
  expect(await errorCode(() => agentGid("ag-a1b2c3d4", answer(0, "0")))).toBe("internal");
  expect(await errorCode(() => agentGid("ag-a1b2c3d4", answer(0, "21007 21008")))).toBe("internal");
});
