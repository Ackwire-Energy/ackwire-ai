import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { type AgentUser, AgentUsers, readAgentUsers, systemLauncher } from "../../runner/agent-users";
import { ensureBrowserBindPolicy } from "../../runner/browser-bind-policy";
import { browserPortsForUid } from "../../runner/browser-ports";
import { LoopbackGuard, RUNNER_NFT_TABLE } from "../../runner/loopback-guard";
import { agentSlice, runSync } from "../../runner/service";

/**
 * System mode's isolation on a real Linux computer, as root: real agent users and slices, the runner's loopback
 * table and bind policy, and what each agent's processes reach, on 127.0.0.1 and ::1. It changes the computer it
 * runs on (users, slices, nftables), so it runs only with AGENTES_ROOT_TESTS=1: in CI's isolation-root job, or on
 * a disposable VM. AGENTES_TEST_RUNNER is the runner bundle the agents' bind check runs.
 */
const ROOT = process.platform === "linux" && process.getuid?.() === 0 && process.env.AGENTES_ROOT_TESTS === "1";

setDefaultTimeout(120_000);

/** The Cloud's range: its browser pairs are ports 10000-11999. */
const RANGE: [number, number] = [20000, 20999];
const HOME = "/var/lib/agentes-isolation-test";
/** Where the agents' users can run Bun and the runner bundle from (a CI checkout's home isn't theirs to read). */
const OPT = "/opt/agentes-isolation-test";
const RUNNER = [path.join(OPT, "bun"), path.join(OPT, "agentes-runner.mjs")];
const PYTHON = "/usr/bin/python3";
const HOSTS = ["127.0.0.1", "::1"];

/** One socket operation, as whoever runs it; prints its outcome (an errno's name on failure). */
const PY = `
import errno, os, socket, sys
def err(e):
    return errno.errorcode.get(e.errno, type(e).__name__) if isinstance(e, OSError) and e.errno else type(e).__name__
mode = sys.argv[1]
if mode in ("connect", "bind", "listen", "udp-listen", "udp-send"):
    host, port = sys.argv[2], int(sys.argv[3])
    fam = socket.AF_INET6 if ":" in host else socket.AF_INET
if mode == "connect":
    s = socket.socket(fam, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect((host, port))
        print("connected")
    except socket.timeout:
        print("timeout")
    except OSError as e:
        print(err(e))
elif mode == "bind":
    s = socket.socket(fam, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
        print("bound", s.getsockname()[1])
    except OSError as e:
        print(err(e))
elif mode == "listen":
    s = socket.socket(fam, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
        s.listen(64)
    except OSError as e:
        print(err(e), flush=True)
        sys.exit(1)
    print(s.getsockname()[1], flush=True)
    while True:
        c, _ = s.accept()
        c.close()
elif mode == "udp-listen":
    s = socket.socket(fam, socket.SOCK_DGRAM)
    s.bind((host, port))
    print(s.getsockname()[1], flush=True)
    while True:
        data, _ = s.recvfrom(256)
        print(data.decode(), flush=True)
elif mode == "udp-send":
    s = socket.socket(fam, socket.SOCK_DGRAM)
    try:
        s.sendto(sys.argv[4].encode(), (host, port))
        print("sent")
    except OSError as e:
        print(err(e))
elif mode == "unix-listen":
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(sys.argv[2])
    os.chmod(sys.argv[2], 0o777)
    s.listen(8)
    print(0, flush=True)
    while True:
        c, _ = s.accept()
        c.close()
elif mode == "unix-connect":
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(sys.argv[2])
        print("connected")
    except OSError as e:
        print(err(e))
`;

/** systemd here can enforce the bind policy (`SocketBindDeny=`); Ubuntu's can't. */
const BPF = ROOT && /\+BPF_FRAMEWORK/.test(runSync("systemctl", ["--version"]).output);

let A: AgentUser;
let B: AgentUser;
let guard: LoopbackGuard;
const running: ChildProcess[] = [];

/** `argv` as `user` through its launcher (its slice, its user, its environment), or as root here (null). */
function launch(user: AgentUser | null, argv: string[]) {
  if (!user) return { argv, env: { ...process.env } as Record<string, string> };
  const l = systemLauncher(user);
  return { argv: [...l.prefix, ...argv], env: l.env };
}

/** A probe's outcome: the last line it printed. */
function probe(user: AgentUser | null, ...args: string[]): string {
  const { argv, env } = launch(user, [PYTHON, "-c", PY, ...args]);
  const r = spawnSync(argv[0] as string, argv.slice(1), { env, encoding: "utf8", timeout: 30_000 });
  return (r.stdout ?? "").trim().split("\n").at(-1) || `nothing (${(r.stderr ?? "").trim().slice(0, 300)})`;
}

/** As `runuser -u <name>` alone: outside every agent's slice. */
function probeOutside(name: string, ...args: string[]): string {
  const r = spawnSync("/usr/sbin/runuser", ["-u", name, "--", PYTHON, "-c", PY, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return (r.stdout ?? "").trim().split("\n").at(-1) || `nothing (${(r.stderr ?? "").trim().slice(0, 300)})`;
}

async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

/** A listener held by a process of `user`'s (null: root's), and what it printed after its port. */
async function serve(user: AgentUser | null, ...args: string[]): Promise<{ port: number; lines: string[] }> {
  const { argv, env } = launch(user, [PYTHON, "-u", "-c", PY, ...args]);
  const child = spawn(argv[0] as string, argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
  running.push(child);
  const lines: string[] = [];
  let rest = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    lines.push(...parts);
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => process.stderr.write(chunk));
  await until(() => lines.length > 0, 20_000);
  const port = Number(lines[0]);
  if (!Number.isInteger(port)) throw new Error(`no listener for ${args.join(" ")}: ${lines[0]}`);
  return { port, lines };
}

const must = (file: string, args: string[]) => {
  const r = runSync(file, args);
  if (r.code !== 0) throw new Error(`${file} ${args.join(" ")}: ${r.output}`);
  return r.output;
};

describe.if(ROOT)("the agents' isolation on this computer, as root", () => {
  beforeAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    mkdirSync(OPT, { recursive: true, mode: 0o755 });
    chmodSync(OPT, 0o755);
    copyFileSync(realpathSync(process.execPath), RUNNER[0] as string);
    chmodSync(RUNNER[0] as string, 0o755);
    copyFileSync(process.env.AGENTES_TEST_RUNNER ?? "", RUNNER[1] as string);
    chmodSync(RUNNER[1] as string, 0o644);
    const users = new AgentUsers({ home: HOME, range: RANGE });
    A = users.ensure({ id: "a0000000-0000-4000-8000-000000000001", handle: "a", name: "Agent A" });
    B = users.ensure({ id: "b0000000-0000-4000-8000-000000000002", handle: "b", name: "Agent B" });
    must("systemctl", ["start", "agents.slice", agentSlice(A.uid), agentSlice(B.uid)]);
    guard = new LoopbackGuard({
      home: HOME,
      agentUids: () => readAgentUsers(HOME).map((u) => u.uid),
      uidRange: RANGE,
      log: (line) => console.log(`guard: ${line}`),
    });
    guard.start();
    // Each case says when the guard looks again.
    guard.stop();
    if (BPF) for (const u of [A, B]) ensureBrowserBindPolicy(u, RUNNER);
    console.log(`agents ${A.uid} and ${B.uid}; bind policy ${BPF ? "on" : "not enforced by this systemd"}`);
  });

  afterAll(() => {
    for (const child of running) child.kill("SIGTERM");
    guard?.stop();
    runSync("nft", ["delete", "table", "inet", RUNNER_NFT_TABLE]);
    for (const u of [A, B]) {
      if (!u) continue;
      runSync("systemctl", ["stop", agentSlice(u.uid)]);
      runSync("userdel", ["-r", u.user]);
    }
    rmSync(HOME, { recursive: true, force: true });
    rmSync(OPT, { recursive: true, force: true });
    rmSync("/tmp/agentes-isolation-a.sock", { force: true });
  });

  test("1. an agent's listen(0)", () => {
    for (const host of HOSTS) expect(probe(A, "bind", host, "0")).toStartWith(BPF ? "EPERM" : "bound");
  });

  test("2. a new listener: anyone until the guard's scan, then its owner only", async () => {
    for (const host of HOSTS) {
      const own = await serve(A, "listen", host, "45000");
      expect(probe(A, "connect", host, String(own.port))).toBe("connected");
      expect(probe(B, "connect", host, String(own.port))).toBe("connected");
    }
    guard.reconcile();
    for (const host of HOSTS) {
      expect(probe(A, "connect", host, "45000")).toBe("connected");
      expect(probe(B, "connect", host, "45000")).toBe("ECONNREFUSED");
    }
  });

  test("5. an agent's browser port: root gets in, another agent doesn't", async () => {
    const { cdp } = browserPortsForUid(A.uid);
    await serve(A, "listen", "127.0.0.1", String(cdp));
    expect(probe(B, "connect", "127.0.0.1", String(cdp))).toBe("ECONNREFUSED");
    expect(probe(null, "connect", "127.0.0.1", String(cdp))).toBe("connected");
  });

  test("6. root's own listener: agents get in; another local user stays out of an agent's", async () => {
    const root = await serve(null, "listen", "127.0.0.1", "0");
    expect(probe(A, "connect", "127.0.0.1", String(root.port))).toBe("connected");
    expect(probeOutside("nobody", "connect", "127.0.0.1", "45000")).toBe("ECONNREFUSED");
  });

  test("8. UDP: every agent's datagrams reach an agent's socket", async () => {
    const own = await serve(A, "udp-listen", "127.0.0.1", "0");
    expect(probe(B, "udp-send", "127.0.0.1", String(own.port), "from-b")).toBe("sent");
    expect(probe(A, "udp-send", "127.0.0.1", String(own.port), "from-a")).toBe("sent");
    await Bun.sleep(300);
    expect(own.lines.slice(1).sort()).toEqual(["from-a", "from-b"]);
  });

  test("9. a setuid-root program an agent runs counts as root", async () => {
    const suid = path.join(OPT, "python3-suid");
    copyFileSync(realpathSync(PYTHON), suid);
    chmodSync(suid, 0o4755);
    const other = await serve(B, "listen", "127.0.0.1", "45001");
    guard.reconcile();
    const { argv, env } = launch(A, [suid, "-c", PY, "connect", "127.0.0.1", String(other.port)]);
    const r = spawnSync(argv[0] as string, argv.slice(1), { env, encoding: "utf8", timeout: 30_000 });
    expect((r.stdout ?? "").trim()).toBe("connected");
  });

  test("10. an agent's user outside its slice still reaches its own listener", () => {
    expect(probeOutside(A.user, "connect", "127.0.0.1", "45000")).toBe("connected");
  });

  test.if(BPF)("16. the bind check passes for both agents", () => {
    for (const u of [A, B]) expect(() => ensureBrowserBindPolicy(u, RUNNER)).not.toThrow();
  });

  test("17. a Unix socket in /tmp is every agent's", async () => {
    await serve(A, "unix-listen", "/tmp/agentes-isolation-a.sock");
    expect(probe(B, "unix-connect", "/tmp/agentes-isolation-a.sock")).toBe("connected");
  });
});
