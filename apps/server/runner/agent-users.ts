import { appendFileSync, chmodSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentScope } from "@agenteschat/adapters/machine-protocol";
import { isAgentUid } from "./config";
import { RunnerError } from "./errors";
import { readJson, writeJson } from "./json-file";
import { validateNetworkMark } from "./network-mark";
import { agentId8 } from "./paths";
import {
  AGENT_RAM_ROOT,
  AGENT_TMP_ROOT,
  agentSlice,
  agentTmp,
  type RunCommand,
  runSync,
  scopeOomPolicy,
  systemdBooted,
} from "./service";
import { joinShared, SHARED_BIN_ENV, SHARED_LINK, type SharedSpec } from "./shared-folder";

/**
 * System mode: every agent works as its own OS user, `ag-<first 8 of its id>`,
 * made on the agent's first request with the lowest free uid in the
 * computer's range. `<runner home>/agents.json` lists them as
 * `[{ id, user, uid }]`. Firewall rules and per-agent counters on the computer
 * key on those uids, so a uid listed there never goes to another agent, even
 * once its user is gone. Users are never removed here: wiping the computer does that.
 */
export const AGENT_USERS_FILE = "agents.json";

export interface AgentUser {
  id: string;
  user: string;
  uid: number;
  /** Supplied only by the root daemon, never persisted in the agent list. */
  networkLauncher?: string;
  /** Root-only routing configuration: also prevents acquiring network capabilities through file caps. */
  networkMark?: number;
  networkRevision?: number;
}

/** How root runs a command as an agent: `prefix` before the command, exactly `env`, in `home`. */
export interface Launcher {
  prefix: string[];
  /** The command's whole environment; callers add what it needs (DISPLAY, TERM…). */
  env: Record<string, string>;
  /** The agent's home (its worker makes the agent's folder inside it, as everywhere: `<handle>-<id8>`). */
  home: string;
  /** Where the agent's own /tmp is on the computer, when it has one (under systemd). */
  tmp?: string;
}

/**
 * Runs as root on the computer, before the agent's own mount namespace (`$1` its uid): the agent's tmpfs, so its
 * /tmp, /dev/shm and /run/lock are in memory as the computer's are, each with its own room. Mounted at its first
 * launch after the computer starts, under a lock: two first launches at once would stack two mounts.
 */
const AGENT_RAM = [
  "set -e",
  `r=${AGENT_RAM_ROOT}`,
  'mkdir -p "$r"',
  'chmod 0700 "$r"',
  'd="$r/$1"',
  "shift",
  'mkdir -p "$d"',
  `flock "$r/.lock" sh -c 'mountpoint -q "$1" || mount -t tmpfs -o mode=0700,size=50%,nr_inodes=1m agentes-runner-tmp "$1"' sh "$d"`,
  'exec "$@"',
].join("\n");

/**
 * Runs as root in the agent's new mount namespace, before it becomes the agent (`$1` its uid): its own temporary
 * folders over the shared ones, so nothing another agent leaves there (a Postgres socket on trust, a name it
 * squats) is in its reach. They live under folders only root reaches, so no agent can swap them; in the agent's
 * own /tmp only `mkdir` runs, never `chmod`, since the agent may have put a link there. Every launch of the agent
 * binds the same folders, so its processes see one /tmp.
 */
const PRIVATE_TMP = [
  "set -e",
  `m=${AGENT_RAM_ROOT}/$1`,
  `r=${AGENT_TMP_ROOT}`,
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
].join("\n");

/**
 * adb's server port for an agent (`ANDROID_ADB_SERVER_PORT`, which adb, the Android Gradle plugin, Expo and React
 * Native read): in 30000-32767, outside every browser band and Linux's ephemeral range, and different for every
 * uid of any range of up to 2768 uids. Without it every agent's adb would want 5037.
 */
export const adbServerPort = (uid: number) => 30_000 + (uid % 2768);

/**
 * Gradle's daemon exits after 5 idle minutes instead of 3 hours, and the Kotlin daemon with it: the agents share the
 * computer's memory (`agentLimits`), and a finished Android build's daemons hold gigabytes of it, which leaves the
 * other agents no room for their turns. Five minutes keep them warm between an agent's edits and builds. Gradle reads
 * its client's system properties after every gradle.properties (`LayoutToPropertiesConverter`), so this holds for
 * `gradlew` too, and an agent's own `-D` or `GRADLE_OPTS` still wins.
 */
const GRADLE_OPTS = "-Dorg.gradle.daemon.idletimeout=300000";

const USER_NAME = /^ag-[a-z0-9]{8}$/;
const AGENT_SHELL = "/bin/bash";
const AGENT_PATH = "/usr/local/bin:/usr/bin:/bin";

export const agentUserName = (agentId: string) => `ag-${agentId8(agentId)}`;
export const agentHome = (user: string) => `/home/${user}`;

/** passwd's comment field: useradd refuses `:` (its separator) and newlines, and breaks on other control characters. */
const passwdComment = (name: string | undefined) =>
  (name ?? "")
    .replace(/[\p{Cc}:]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);

const isAgentUser = (v: unknown): v is AgentUser => {
  const r = v as Partial<AgentUser> | null;
  return (
    typeof r?.id === "string" &&
    r.id.length > 0 &&
    r.id.length <= 64 &&
    typeof r.user === "string" &&
    USER_NAME.test(r.user) &&
    isAgentUid(r.uid)
  );
};

/** The listed agent users; a row that isn't well formed is left out. */
export function readAgentUsers(home: string): AgentUser[] {
  const v = readJson<unknown>(path.join(home, AGENT_USERS_FILE));
  return Array.isArray(v) ? v.filter(isAgentUser).map(({ id, user, uid }) => ({ id, user, uid })) : [];
}

interface PasswdEntry {
  name: string;
  uid: number;
  comment: string;
}

const parsePasswd = (text: string): PasswdEntry[] =>
  text.split("\n").flatMap((line) => {
    const [name = "", , uid = "", , comment = ""] = line.split(":");
    return name && /^\d+$/.test(uid) ? [{ name, uid: Number(uid), comment }] : [];
  });

function freeUid([first, last]: [number, number], used: Set<number>): number {
  for (let uid = first; uid <= last; uid++) if (!used.has(uid)) return uid;
  throw new RunnerError("internal", `No uid is left for a new agent user in ${first}-${last}`);
}

export class AgentUsers {
  /** Agents already checked by this process, with their user's comment. */
  private readonly ready = new Map<string, { user: AgentUser; comment: string }>();

  constructor(
    private readonly opts: {
      home: string;
      range: [number, number];
      run?: RunCommand;
      etc?: string;
      /** The computer's shared folder (ADR 0115), which every agent's user joins. */
      shared?: Required<SharedSpec>;
      log?: (line: string) => void;
    },
  ) {}

  /**
   * The agent's user, made on its first request. After that, a request only
   * keeps the user's comment to the agent's name (`usermod -c` after a rename).
   */
  ensure(agent: AgentScope): AgentUser {
    const name = passwdComment(agent.name);
    const known = this.ready.get(agent.id);
    if (known && (!name || name === known.comment)) return known.user;
    const userName = agentUserName(agent.id);
    const passwd = parsePasswd(this.run("getent", ["passwd"]));
    const user = known?.user ?? this.listed(agent.id, userName, passwd);
    const entry = passwd.find((e) => e.name === user.user);
    let comment = entry?.comment ?? "";
    if (!entry) {
      comment = name || passwdComment(agent.handle) || user.user;
      const home = agentHome(user.user);
      this.run("useradd", [
        "--uid",
        String(user.uid),
        "--user-group",
        "--create-home",
        "--home-dir",
        home,
        "--shell",
        AGENT_SHELL,
        "--comment",
        comment,
        user.user,
      ]);
      // Without HOME_MODE in login.defs (older useradd), the home would be 755.
      this.run("chmod", ["0700", home]);
    } else if (entry.uid !== user.uid) {
      throw new RunnerError(
        "internal",
        `${user.user} has uid ${entry.uid} on this computer, not ${user.uid} as ${AGENT_USERS_FILE} says`,
      );
    } else if (name && name !== entry.comment) {
      this.run("usermod", ["--comment", name, user.user]);
      comment = name;
    }
    if (!known) {
      denySchedulers(user.user, this.opts.etc);
      // A computer that can't share still serves the agent, in its own folders.
      const { shared } = this.opts;
      for (const p of shared ? joinShared(user.user, agentHome(user.user), shared, this.opts.run) : []) {
        this.opts.log?.(`${user.user} can't use the shared folder: ${p}`);
      }
    }
    this.ready.set(agent.id, { user, comment });
    return user;
  }

  /** The agent's row in agents.json, added (before its user exists) when it has none. */
  private listed(id: string, user: string, passwd: PasswdEntry[]): AgentUser {
    const file = path.join(this.opts.home, AGENT_USERS_FILE);
    const rows = readAgentUsers(this.opts.home);
    const row = rows.find((r) => r.id === id);
    if (row) return row;
    if (rows.some((r) => r.user === user)) {
      throw new RunnerError("internal", `Another agent on this computer already has the user ${user}`);
    }
    const [first, last] = this.opts.range;
    // A user by that name that isn't listed (agents.json was lost) is this agent's when it has an agent uid nobody listed.
    const existing = passwd.find((e) => e.name === user);
    if (existing && (existing.uid < first || existing.uid > last || rows.some((r) => r.uid === existing.uid))) {
      throw new RunnerError("internal", `${user} already exists on this computer with uid ${existing.uid}`);
    }
    const uid = existing?.uid ?? freeUid(this.opts.range, new Set([...passwd, ...rows].map((r) => r.uid)));
    const added = { id, user, uid };
    // Listed first: a useradd that fails leaves the uid this agent's, and the next request retries it.
    writeJson(file, [...rows, added]);
    return added;
  }

  private run(file: string, args: string[]): string {
    const r = (this.opts.run ?? runSync)(file, args);
    if (r.code !== 0) throw new RunnerError("internal", `${file} failed (${r.code}): ${r.output.slice(0, 500)}`);
    return r.output;
  }
}

/**
 * cron and at would start the agent's jobs outside its launcher: in no slice of its own, with the computer's
 * shared /tmp. Its user goes in their deny files: `cron.deny` made where missing (without it or `cron.allow`,
 * cron takes everyone's jobs), `at.deny` only where it is (without it or `at.allow`, at takes root's alone). An
 * allow file, where one is, already leaves agents out.
 */
export function denySchedulers(user: string, etc = "/etc") {
  for (const [name, make] of [
    ["cron.deny", true],
    ["at.deny", false],
  ] as const) {
    const file = path.join(etc, name);
    let text: string | null = null;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // missing
    }
    if (text === null && !make) continue;
    if (text?.split("\n").some((line) => line.trim() === user)) continue;
    try {
      appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${user}\n`);
      // crontab reads it as the person who runs it: a file it can't read would deny no one.
      if (text === null) chmodSync(file, 0o644);
    } catch (err) {
      throw new RunnerError(
        "internal",
        `Couldn't keep ${user} from scheduling cron and at jobs (${file}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Runs a command as the agent's user inside its slice (whose limits then
 * hold), with its own temporary folders (`AGENT_RAM`, `PRIVATE_TMP`), or with
 * runuser alone where systemd isn't PID 1 (a container). Absolute paths: root
 * never looks these up on a PATH. `--collect`: a scope the OOM killer ended
 * doesn't stay behind as a failed unit. `OOMPolicy=continue` (`oomPolicy`): a
 * process the kernel stops for memory takes only itself, so the command it ran
 * fails where its caller can tell, and the agent's other work goes on. sh,
 * unshare and sh each become the next program (no fork), so runuser still
 * passes SIGTERM on; with slave propagation, what the computer unmounts leaves
 * the agent's namespace too.
 */
export function systemLauncher(
  u: AgentUser,
  systemd = systemdBooted(),
  oomPolicy = systemd && scopeOomPolicy(),
): Launcher {
  const home = agentHome(u.user);
  const runuser = ["/usr/sbin/runuser", "-u", u.user, "--"];
  const command = [...networkPrefix(u), ...networkRestrictions(u), ...runuser];
  const env = {
    HOME: home,
    USER: u.user,
    LOGNAME: u.user,
    SHELL: AGENT_SHELL,
    // Last, so a tool an agent put in the shared `bin/` never stands in for the computer's own.
    PATH: `${AGENT_PATH}:${home}/${SHARED_LINK}/bin`,
    [SHARED_BIN_ENV]: `${home}/${SHARED_LINK}/bin`,
    LANG: "C.UTF-8",
    ANDROID_ADB_SERVER_PORT: String(adbServerPort(u.uid)),
    GRADLE_OPTS,
  };
  if (!systemd) return { prefix: command, env, home };
  return {
    prefix: [
      "/usr/bin/systemd-run",
      "--quiet",
      "--scope",
      "--collect",
      ...(oomPolicy ? ["--property=OOMPolicy=continue"] : []),
      `--slice=${agentSlice(u.uid)}`,
      "--",
      "/bin/sh",
      "-c",
      AGENT_RAM,
      "sh",
      String(u.uid),
      "/usr/bin/unshare",
      "--mount",
      "--propagation",
      "slave",
      "--",
      "/bin/sh",
      "-c",
      // A configured isolation policy gets a fresh private proc instance, never a host remount.
      u.networkLauncher || u.networkMark || u.networkRevision
        ? `set -e\n/usr/bin/mount -t proc -o nosuid,nodev,noexec,hidepid=2 proc /proc\n${PRIVATE_TMP}`
        : PRIVATE_TMP,
      "sh",
      String(u.uid),
      ...command,
    ],
    env,
    home,
    tmp: agentTmp(u.uid),
  };
}

/** Root executes this hook before dropping privileges. Every path component must remain root-controlled. */
export function trustedNetworkLauncher(file: string, stat = lstatSync): string[] {
  if (!path.isAbsolute(file) || file.includes("\0")) throw new Error("The network launcher must be an absolute path");
  let current = path.resolve(file);
  while (true) {
    const info = stat(current);
    if (
      info.uid !== 0 ||
      (info.mode & 0o022) !== 0 ||
      info.isSymbolicLink() ||
      (current === path.resolve(file) ? !info.isFile() || (info.mode & 0o111) === 0 : !info.isDirectory())
    ) {
      throw new Error("The network launcher and its parent directories must be owned and writable only by root");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [path.resolve(file)];
}

/** The agent user's own group (`useradd --user-group` made it; its id needn't be the uid). */
export function agentGid(user: string, run: RunCommand = runSync): number {
  const r = run("id", ["-g", user]);
  const gid = Number(r.output);
  if (r.code !== 0 || !/^\d+$/.test(r.output) || gid === 0) {
    throw new RunnerError("internal", `The group of ${user} isn't known here (${r.code}): ${r.output.slice(0, 200)}`);
  }
  return gid;
}

/** Commands before runuser and root's network diagnostics enter the same optional network context. */
export function networkPrefix(user: AgentUser): string[] {
  return user.networkLauncher ? [...trustedNetworkLauncher(user.networkLauncher), String(user.uid), "--"] : [];
}

/** A configured routing exemption must not be forgeable by gaining file capabilities after exec. */
export function networkRestrictions(user: AgentUser): string[] {
  if (user.networkMark === undefined) return [];
  validateNetworkMark(user.networkMark);
  return ["/usr/bin/setpriv", "--no-new-privs", "--bounding-set=-net_admin,-net_raw", "--"];
}

/** Root's shared git cache on a system-mode computer (ADR 0116 §4) and the system user that owns it. */
export const GIT_CACHE_DIR = "/var/cache/agentes-git";
export const GIT_CACHE_USER = "agentes-git";

/** The cache's owner, made the first time (a system user nobody signs in as). */
export function ensureGitCacheUser(run: RunCommand = runSync): { uid: number; gid: number } {
  const id = (flag: string) => run("id", [flag, GIT_CACHE_USER]);
  if (id("-u").code !== 0) {
    run("useradd", [
      "--system",
      "--user-group",
      "--no-create-home",
      "--home-dir",
      GIT_CACHE_DIR,
      "--shell",
      "/usr/sbin/nologin",
      GIT_CACHE_USER,
    ]);
  }
  const uid = id("-u");
  const gid = id("-g");
  if (uid.code !== 0 || gid.code !== 0) throw new RunnerError("internal", `${GIT_CACHE_USER} couldn't be made`);
  return { uid: Number(uid.output.trim()), gid: Number(gid.output.trim()) };
}

/** Lets one agent's uid into one cached repository; false without `setfacl` (the clone then goes without the cache). */
export const grantGitCache = (dir: string, uid: number, run: RunCommand = runSync) =>
  run("setfacl", ["-m", `u:${uid}:rx`, dir]).code === 0;
