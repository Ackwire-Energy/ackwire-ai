import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type AgentScope,
  type HoldEnd,
  isUuid,
  type MachineReplies,
  type MachineRequest,
  type RunnerHolds,
} from "@agenteschat/adapters/machine-protocol";
import type { AgentUser } from "./agent-users";
import { RunnerError } from "./errors";
import { readJson, writeJson } from "./json-file";
import { bootId } from "./lock";
import { agentCategorySlice, agentSlice } from "./service";

/**
 * `keep_running`'s holds (ADR 0176). Each is the computer's standard "don't go idle" lock, `systemd-inhibit
 * --what=idle --mode=block`, taken by root in a scope in the agent's slice named after the hold
 * (`agentes-keep-<id>.scope`), with no words of the agent's in it: every user can list the locks, so what a hold is for
 * stays on the server. Never through the agent's launcher: its view may hide the system bus the lock needs, and a
 * process of the agent's uid outside that view would show the agent the computer's own files (`/proc/<pid>/root`).
 * The lock's command waits on what it holds: the agent's program (`pid`, one of its own, by its start time), its
 * browser (its slice has processes) or a time. An operator's guard reads every lock the same way, whoever took it, and
 * ties ours to their records by the scope. The scopes outlive this process: `<home>/holds.json` keeps what each holds,
 * so a runner that restarts goes on with the ones still living.
 */

export const HOLDS_FILE = "holds.json";
const INHIBIT = "/usr/bin/systemd-inhibit";
const SYSTEMD_RUN = "/usr/bin/systemd-run";
/** How often the holds are looked at: a lock gone, a time past. */
const SWEEP_MS = 5_000;
/** A program a person stopped that is still there this long after SIGTERM gets SIGKILL, as a canceled task does. */
const KILL_AFTER_MS = 10_000;
/** A lock that hasn't taken by then (its scope couldn't start, or logind refused it) is a failure, not a hold. */
const TAKE_MS = 500;
/** Ended holds `hello` keeps listing, newest last: the server may have missed their `keep.ended` while away. */
const ENDED_KEPT = 50;
/** Holds on one computer at most (the server's own limit is 10 per agent). */
const MAX_HOLDS = 200;
/** Its browser's slice empty this many looks in a row (2 s apart): it closed, not moved between screens. */
const BROWSER_GONE_LOOKS = 3;

export const keepScope = (id: string) => `agentes-keep-${id}.scope`;
/**
 * Waits while the held program lives: its `/proc/<pid>/stat` ($0) is there, not a zombie, and has the start time it
 * had when held ($1, the 22nd field). The name before the fields is the program's own choice (spaces, parentheses,
 * new lines, `*`): everything up to the last `) ` goes, and nothing is globbed. Root may signal any process, so
 * `kill -0` would go on holding a pid used again by another one. Absolute paths: root never looks these up on a PATH.
 */
const PROGRAM_WAIT =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own expansion, not JavaScript's.
  'set -f; t=$1; while s=$(/bin/cat "$0" 2>/dev/null); do set -- ${s##*) }; [ "$1" != Z ] || exit 0; shift 19; [ "$1" = "$t" ] || exit 0; /bin/sleep 1; done';
const browserCgroup = (uid: number) => `/agents.slice/${agentSlice(uid)}/${agentCategorySlice(uid, "browser")}`;

interface Running {
  pid: number;
  /** `/proc/<pid>/stat`'s start time: a pid used again by another process isn't this one. */
  started: string;
}

interface Hold {
  id: string;
  agentId: string;
  uid: number;
  user: string;
  /** The agent's handle, as requests name it (a person's Stop closes its browser by it). */
  handle?: string;
  /** The lock's own process (systemd-run's, which becomes systemd-inhibit and lives as long as the lock). */
  lock: Running;
  pid?: Running;
  browser?: true;
  until?: string;
}

interface Stored {
  /** The computer's boot they were taken in: a restart ended them all, which the server reads from `hello` alone. */
  boot?: string;
  holds: Hold[];
  ended: { id: string; reason: HoldEnd }[];
}

/** What the holds need from the computer: `defaultSystem` on Linux, fakes in tests. */
export interface HoldsSystem {
  /** Starts a lock's command as root, detached; its pid, or null. */
  spawn(argv: string[]): number | null;
  /** The process's start time (`/proc/<pid>/stat`), or null when there is none. */
  started(pid: number): string | null;
  /** Its real uid and cgroup (v2), or null when there is no such process. */
  owner(pid: number): { uid: number; cgroup: string } | null;
  /** Whether that cgroup (a path under the cgroup root) has processes. */
  populated(cgroup: string): boolean;
  /** Runs a command as root and waits for its exit code. */
  run(argv: string[]): Promise<number>;
  now(): number;
}

export interface HoldsOptions {
  home: string;
  log: (line: string) => void;
  system?: HoldsSystem;
  /** A hold ended here by itself: the server hears it (`keep.ended`). */
  onEnded?: (id: string, reason: HoldEnd) => void;
  /** A browser hold started or ended: the agent's worker keeps its browser open meanwhile (`kept`). */
  onBrowser?: (agentId: string) => void;
  /** A person's Stop on a browser hold: the agent's browser closes. */
  closeBrowser?: (agent: AgentScope) => Promise<unknown>;
  inhibit?: string;
  /** Tests: how long a new lock gets to hold (`TAKE_MS`). */
  takeMs?: number;
}

/**
 * The 22nd field of `/proc/<pid>/stat` (after the parenthesized name, which may hold spaces); null for a zombie, which
 * has exited (a lock its parent hasn't reaped yet is gone all the same).
 */
export function statStart(stat: string): string | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[0] === "Z" ? null : (fields[19] ?? null);
}

export function defaultSystem(proc = "/proc", cgroupRoot = "/sys/fs/cgroup"): HoldsSystem {
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  return {
    spawn(argv) {
      const [file = "", ...args] = argv;
      try {
        const child = spawn(file, args, { cwd: "/", detached: true, stdio: "ignore" });
        (child as unknown as EventEmitter).on("error", () => {});
        child.unref();
        return child.pid ?? null;
      } catch {
        return null;
      }
    },
    started: (pid) => {
      const stat = read(path.join(proc, String(pid), "stat"));
      return stat ? statStart(stat) : null;
    },
    owner(pid) {
      const status = read(path.join(proc, String(pid), "status"));
      const uid = status && /^Uid:\s+(\d+)/m.exec(status)?.[1];
      const cgroup = /^0::(\/.*)$/m.exec(read(path.join(proc, String(pid), "cgroup")) ?? "")?.[1];
      return uid && cgroup ? { uid: Number(uid), cgroup } : null;
    },
    populated: (cgroup) => /^populated 1$/m.test(read(path.join(cgroupRoot, cgroup, "cgroup.events")) ?? ""),
    run: (argv) =>
      new Promise((resolve) => {
        const [file = "", ...args] = argv;
        const child = spawn(file, args, { stdio: "ignore" }) as unknown as EventEmitter;
        child.on("error", () => resolve(127));
        child.on("exit", (code: number | null) => resolve(code ?? 1));
      }),
    now: Date.now,
  };
}

/** The lock's command: systemd-inhibit around what waits on the hold's program, browser or time. */
export function lockCommand(
  hold: Pick<Hold, "uid" | "pid" | "browser" | "until">,
  now: number,
  inhibit = INHIBIT,
): string[] {
  const wait = hold.pid
    ? ["/bin/sh", "-c", PROGRAM_WAIT, `/proc/${hold.pid.pid}/stat`, hold.pid.started]
    : hold.browser
      ? [
          "/bin/sh",
          "-c",
          `n=0; while [ "$n" -lt ${BROWSER_GONE_LOOKS} ]; do if /usr/bin/grep -qs '^populated 1' "$0"; then n=0; else n=$((n+1)); fi; /bin/sleep 2; done`,
          `/sys/fs/cgroup${browserCgroup(hold.uid)}/cgroup.events`,
        ]
      : ["/bin/sleep", String(Math.max(1, Math.ceil((Date.parse(hold.until ?? "") - now) / 1000)))];
  return [inhibit, "--what=idle", "--mode=block", "--who=agentes.chat", "--why=keep_running", ...wait];
}

/** Root's scope for a lock: in the agent's slice, named after the hold, which is how a guard ties the two. */
const lockScope = (id: string, uid: number) => [
  SYSTEMD_RUN,
  "--quiet",
  "--scope",
  "--collect",
  `--unit=${keepScope(id).replace(/\.scope$/, "")}`,
  `--slice=${agentSlice(uid)}`,
  "--",
];

export class Holds {
  private readonly holds = new Map<string, Hold>();
  /** Holds whose lock `start` is taking again. */
  private readonly changing = new Set<string>();
  private ended: Stored["ended"] = [];
  private readonly system: HoldsSystem;
  private readonly file: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: HoldsOptions) {
    this.system = opts.system ?? defaultSystem();
    this.file = path.join(opts.home, HOLDS_FILE);
    const read = readJson<Stored>(this.file);
    // After a restart no lock is left: none is reported as ended either, so the server takes a time's hold again.
    const stored = read?.boot === bootId() ? read : null;
    this.ended = Array.isArray(stored?.ended) ? stored.ended.slice(-ENDED_KEPT) : [];
    for (const hold of Array.isArray(stored?.holds) ? stored.holds : []) {
      if (isUuid(hold?.id) && hold.lock && Number.isInteger(hold.lock.pid)) this.holds.set(hold.id, hold);
    }
    // What ended while no runner looked.
    this.sweep();
  }

  /** Looks at the holds every few seconds, until `close`. */
  watch() {
    this.timer ??= setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** What `hello` says. */
  report(): RunnerHolds {
    return { live: [...this.holds.keys()], ended: [...this.ended] };
  }

  /** The agent has a browser hold: its browser stays open while nobody uses it. */
  kept(agentId: string): boolean {
    return [...this.holds.values()].some((h) => h.agentId === agentId && h.browser);
  }

  /** `keep.start`: the hold, taken now, or again with new bounds (its old lock first: the scope's name is the hold's). */
  async start(
    agent: AgentScope,
    user: AgentUser,
    req: Extract<MachineRequest, { op: "keep.start" }>,
  ): Promise<MachineReplies["keep.start"]> {
    const { system } = this;
    if (!isUuid(req.holdId)) throw new RunnerError("bad_request", "A hold's id is a UUID");
    const browser = req.browser === true;
    const pid = req.pid;
    if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 2))
      throw new RunnerError("bad_request", "That isn't a process id");
    if (browser && pid !== undefined) throw new RunnerError("bad_request", "A hold is for one program or the browser");
    const until = req.until === undefined ? undefined : new Date(Date.parse(req.until));
    if (until && Number.isNaN(until.getTime())) throw new RunnerError("bad_request", "`until` is a date and time");
    if (until && until.getTime() <= system.now()) throw new RunnerError("bad_request", "That time has passed");
    // A browser held with no end would never restart on a newer Chrome.
    if (!until && pid === undefined) {
      throw new RunnerError(
        "bad_request",
        browser ? "A browser's hold needs an end time" : "A hold needs a program, the browser or an end time",
      );
    }
    const before = this.holds.get(req.holdId);
    if (before && before.agentId !== agent.id) throw new RunnerError("not_allowed", "That hold is another agent's");
    if (!before && this.holds.size >= MAX_HOLDS)
      throw new RunnerError("no_slot", "This computer keeps as much running as it can");
    let program: Running | undefined;
    if (pid !== undefined) {
      const owner = system.owner(pid);
      const started = system.started(pid);
      if (!owner || !started)
        throw new RunnerError("not_found", `No program with pid ${pid} is running on your computer`);
      if (owner.uid !== user.uid || !owner.cgroup.startsWith(`/agents.slice/${agentSlice(user.uid)}/`)) {
        throw new RunnerError("not_allowed", `Process ${pid} isn't one of your programs`);
      }
      program = { pid, started };
    }
    if (browser && !system.populated(browserCgroup(user.uid))) {
      throw new RunnerError("browser_closed", "Your browser isn't open now: open the page, then keep it running");
    }
    const bounds = { pid: program, ...(browser ? { browser: true as const } : {}), until: until?.toISOString() };
    if (
      before &&
      before.pid?.pid === bounds.pid?.pid &&
      before.pid?.started === bounds.pid?.started &&
      before.browser === bounds.browser &&
      before.until === bounds.until &&
      system.started(before.lock.pid) === before.lock.started
    ) {
      return { held: true };
    }
    const argv = [
      ...lockScope(req.holdId, user.uid),
      ...lockCommand({ uid: user.uid, ...bounds }, system.now(), this.opts.inhibit),
    ];
    // Meanwhile the sweep leaves it be: its old lock going is the hold changing, not ending (and its browser stays kept).
    this.changing.add(req.holdId);
    let lock: Running;
    try {
      if (before) await this.release(before);
      const lockPid = system.spawn(argv);
      const lockStarted = lockPid ? system.started(lockPid) : null;
      if (!lockPid || !lockStarted) throw new RunnerError("internal", "This computer couldn't take the lock");
      await new Promise((resolve) => setTimeout(resolve, this.opts.takeMs ?? TAKE_MS));
      if (system.started(lockPid) !== lockStarted) {
        throw new RunnerError("internal", "This computer refused the lock (systemd-inhibit didn't hold)");
      }
      lock = { pid: lockPid, started: lockStarted };
    } finally {
      this.changing.delete(req.holdId);
    }
    const hold: Hold = {
      id: req.holdId,
      agentId: agent.id,
      uid: user.uid,
      user: user.user,
      handle: agent.handle,
      lock,
      ...(program ? { pid: program } : {}),
      ...(browser ? { browser: true } : {}),
      ...(bounds.until ? { until: bounds.until } : {}),
    };
    this.holds.set(hold.id, hold);
    this.save();
    if (browser || before?.browser) this.opts.onBrowser?.(agent.id);
    return { held: true };
  }

  /** `keep.end`: the hold goes; with `stop`, what it holds too. False: no such hold lived here. */
  async end(req: Extract<MachineRequest, { op: "keep.end" }>): Promise<MachineReplies["keep.end"]> {
    const hold = this.holds.get(req.holdId);
    if (!hold) return { ended: false };
    if (req.stop && hold.pid) await this.stopProgram(hold.pid);
    await this.release(hold);
    this.holds.delete(hold.id);
    this.save();
    if (hold.browser) {
      this.opts.onBrowser?.(hold.agentId);
      if (req.stop)
        await this.opts.closeBrowser?.({ id: hold.agentId, handle: hold.handle ?? hold.user })?.catch(() => undefined);
    }
    return { ended: true };
  }

  /** Every hold: a lock gone ends it (its program or browser went away), and so does its time. */
  sweep() {
    const now = this.system.now();
    const count = this.holds.size;
    for (const hold of [...this.holds.values()]) {
      if (this.changing.has(hold.id)) continue;
      const past = hold.until !== undefined && Date.parse(hold.until) <= now;
      const gone = this.system.started(hold.lock.pid) !== hold.lock.started;
      if (!past && !gone) continue;
      if (!gone) void this.release(hold);
      this.holds.delete(hold.id);
      // A lock that went just before its time ran out (its own `sleep` ended first) expired all the same.
      const reason: HoldEnd =
        past || (hold.until !== undefined && Date.parse(hold.until) - now < SWEEP_MS) ? "expired" : "exited";
      this.ended = [...this.ended.filter((e) => e.id !== hold.id), { id: hold.id, reason }].slice(-ENDED_KEPT);
      this.opts.log(`[${hold.user}] hold ${hold.id} ended (${reason})`);
      this.opts.onEnded?.(hold.id, reason);
      if (hold.browser) this.opts.onBrowser?.(hold.agentId);
    }
    if (this.holds.size !== count) this.save();
  }

  /** The lock goes: its scope stops (systemd), or its process is told to. */
  private async release(hold: Hold) {
    if (this.system.started(hold.lock.pid) !== hold.lock.started) return;
    const code = await this.system.run(["/usr/bin/systemctl", "stop", keepScope(hold.id)]);
    if (code !== 0 && this.system.started(hold.lock.pid) === hold.lock.started) {
      await this.system.run(["/bin/kill", "-TERM", String(hold.lock.pid)]);
    }
  }

  /**
   * A person's Stop: the program itself, by root, only while its pid is still the process that was held (its start
   * time). Never as the agent: that `kill` would run outside the agent's view.
   */
  private async stopProgram(program: Running) {
    const signal = async (name: string) => {
      if (this.system.started(program.pid) !== program.started) return false;
      await this.system.run(["/bin/kill", `-${name}`, String(program.pid)]);
      return true;
    };
    if (!(await signal("TERM"))) return;
    const later = setTimeout(() => void signal("KILL"), KILL_AFTER_MS);
    later.unref?.();
  }

  private save() {
    try {
      writeJson(this.file, { boot: bootId(), holds: [...this.holds.values()], ended: this.ended } satisfies Stored);
    } catch (err) {
      this.opts.log(`${HOLDS_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
