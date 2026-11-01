import { lstatSync } from "node:fs";
import path from "node:path";
import type { AgentScope } from "@agenteschat/adapters/machine-protocol";
import { isAgentUid } from "./config";
import { RunnerError } from "./errors";
import { readJson, writeJson } from "./json-file";
import { validateNetworkMark } from "./network-mark";
import { agentId8 } from "./paths";
import { agentSlice, type RunCommand, runSync, systemdBooted } from "./service";

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
}

/** How root runs a command as an agent: `prefix` before the command, exactly `env`, in `home`. */
export interface Launcher {
  prefix: string[];
  /** The command's whole environment; callers add what it needs (DISPLAY, TERM…). */
  env: Record<string, string>;
  /** The agent's home (its worker makes the agent's folder inside it, as everywhere: `<handle>-<id8>`). */
  home: string;
}

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

  constructor(private readonly opts: { home: string; range: [number, number]; run?: RunCommand }) {}

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
 * Runs a command as the agent's user inside its slice (whose limits then
 * hold), or with runuser alone where systemd isn't PID 1 (a container).
 * Absolute paths: root never looks these up on a PATH. `--collect`: a scope
 * the OOM killer ended doesn't stay behind as a failed unit.
 */
export function systemLauncher(u: AgentUser, systemd = systemdBooted()): Launcher {
  const home = agentHome(u.user);
  const runuser = ["/usr/sbin/runuser", "-u", u.user, "--"];
  const command = [...networkPrefix(u), ...networkRestrictions(u), ...runuser];
  return {
    prefix: systemd
      ? ["/usr/bin/systemd-run", "--quiet", "--scope", "--collect", `--slice=${agentSlice(u.uid)}`, "--", ...command]
      : command,
    env: { HOME: home, USER: u.user, LOGNAME: u.user, SHELL: AGENT_SHELL, PATH: AGENT_PATH, LANG: "C.UTF-8" },
    home,
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
