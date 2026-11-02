import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cgroupCounters, memAvailable } from "@agenteschat/adapters/host-stats";
import { AGENTS_CGROUP } from "./service";
import { isSharedGroup } from "./shared-folder";

/**
 * `agentes-runner computer`: what this computer has and which of its agents use it now, so an agent about to start
 * something heavy can tell whether it fits and, when it doesn't, who is using the computer (in system mode the
 * agents share it: `agentLimits`). It reads only what every user may read (`/proc`, the cgroup tree, `/etc/passwd`
 * and `/etc/group`), so an agent runs it as itself. Agents are named by their user's comment, which is the agent's
 * name; only those of the caller's own runner (its shared group's members), so on the server's own computer
 * another organization's agents count together, unnamed.
 */
export interface ComputerIo {
  /** The agents' slice in the cgroup tree. */
  cgroup?: string;
  /** Where `/proc` and `/etc` are read. */
  proc?: string;
  etc?: string;
  uid?: number;
  groups?: number[];
  cpus?: number;
  totalBytes?: number;
  /** How long CPU use is measured over. */
  sampleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const GIB = 2 ** 30;
const SAMPLE_MS = 1000;
/** Agents listed by name at most; the rest count together. */
const LISTED = 10;
/** Less than this, of memory and of a CPU, is an agent doing nothing. */
const IDLE_BYTES = 0.05 * GIB;
const IDLE_CPUS = 0.05;

const readText = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
/** A cgroup file holding one number; null for `max` (no limit) or when it can't be read. */
const readNumber = (file: string) => {
  const text = readText(file)?.trim();
  const n = text ? Number(text) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};

/** A cgroup's memory in use, less the cache the kernel would take back (`inactive_file`), as `free` counts it. */
function cgroupMemory(dir: string): number | null {
  const current = readNumber(path.join(dir, "memory.current"));
  if (current === null) return null;
  return Math.max(0, current - (cgroupCounters(path.join(dir, "memory.stat"))?.inactive_file ?? 0));
}

/** `/proc/stat`'s CPU time so far, busy and in all (guest time is in user time already). */
export function cpuTimes(stat: string): { busy: number; total: number } | null {
  const f = /^cpu\s+(.+)$/m.exec(stat)?.[1]?.trim().split(/\s+/).map(Number);
  if (!f || f.length < 8 || f.some((n) => !Number.isFinite(n))) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idle + iowait };
}

interface AgentUse {
  uid: number;
  name: string;
  bytes: number;
  swapBytes: number;
  cpus: number;
}

/** passwd's users by uid: their name and comment (the first of its comma-separated fields). */
function passwdUsers(text: string) {
  const users = new Map<number, { user: string; comment: string }>();
  for (const line of text.split("\n")) {
    const [user = "", , uid = "", , gecos = ""] = line.split(":");
    if (user && /^\d+$/.test(uid)) users.set(Number(uid), { user, comment: gecos.split(",")[0]?.trim() ?? "" });
  }
  return users;
}

/** The users of the caller's runner: the members of its shared group (`isSharedGroup`); null when it has none. */
function sideBySide(groupText: string, groups: number[]): Set<string> | null {
  let members: Set<string> | null = null;
  for (const line of groupText.split("\n")) {
    const [name = "", , gid = "", list = ""] = line.split(":");
    if (!isSharedGroup(name) || !groups.includes(Number(gid))) continue;
    members ??= new Set();
    for (const m of list.split(",")) if (m.trim()) members.add(m.trim());
  }
  return members;
}

const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;
const cpu = (n: number) => n.toFixed(1);

export async function computerNow(io: ComputerIo = {}): Promise<string> {
  const cgroup = io.cgroup ?? AGENTS_CGROUP;
  const proc = io.proc ?? "/proc";
  const etc = io.etc ?? "/etc";
  const uid = io.uid ?? process.getuid?.() ?? -1;
  const cpus = io.cpus ?? (os.cpus().length || os.availableParallelism());
  const totalBytes = io.totalBytes ?? os.totalmem();
  const sampleMs = io.sampleMs ?? SAMPLE_MS;
  const slices = (() => {
    try {
      return readdirSync(cgroup, { withFileTypes: true }).flatMap((e) => {
        const m = /^agents-(\d+)\.slice$/.exec(e.name);
        return e.isDirectory() && m ? [Number(m[1])] : [];
      });
    } catch {
      return null;
    }
  })();
  const usage = (u: number) => cgroupCounters(path.join(cgroup, `agents-${u}.slice`, "cpu.stat"))?.usage_usec ?? null;
  const machineBefore = cpuTimes(readText(path.join(proc, "stat")) ?? "");
  const before = new Map((slices ?? []).map((u) => [u, usage(u)]));
  await (io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(sampleMs);
  const machineAfter = cpuTimes(readText(path.join(proc, "stat")) ?? "");
  const free = memAvailable(readText(path.join(proc, "meminfo")) ?? "") ?? os.freemem();

  const lines = [
    `This computer: ${cpus} CPUs and ${gb(totalBytes)} of memory${slices ? ", shared by all its agents" : ""}.`,
  ];
  const elapsed = machineBefore && machineAfter ? machineAfter.total - machineBefore.total : null;
  const busy =
    machineBefore && machineAfter && elapsed !== null
      ? elapsed > 0
        ? ((machineAfter.busy - machineBefore.busy) / elapsed) * cpus
        : 0
      : null;
  const cpuNow =
    busy === null ? `a load of ${cpu(os.loadavg()[0] ?? 0)} on ${cpus} CPUs` : `${cpu(busy)} of ${cpus} CPUs busy`;
  const used = slices ? cgroupMemory(cgroup) : null;
  if (!slices || used === null) {
    lines.push(`Now: ${cpuNow}, ${gb(free)} of memory free.`);
    return lines.join("\n");
  }

  const limit = readNumber(path.join(cgroup, "memory.max"));
  const swap = readNumber(path.join(cgroup, "memory.swap.current")) ?? 0;
  const swapLimit = readNumber(path.join(cgroup, "memory.swap.max"));
  const share = limit === null ? `${gb(used)} of memory` : `${gb(used)} of the ${gb(limit)} they may use together`;
  const swapped = swapLimit === null ? "" : ` (swap: ${gb(swap)} of ${gb(swapLimit)})`;
  lines.push(`Now: ${cpuNow}. The agents use ${share}${swapped}.`);
  const room = Math.max(0, Math.min(free, limit === null ? free : limit - used));
  lines.push(`Free for new work: about ${gb(room)} of memory.`);

  const users = passwdUsers(readText(path.join(etc, "passwd")) ?? "");
  const named = sideBySide(readText(path.join(etc, "group")) ?? "", io.groups ?? process.getgroups?.() ?? []);
  const micros = sampleMs * 1000;
  const agents: AgentUse[] = slices.map((u) => {
    const dir = path.join(cgroup, `agents-${u}.slice`);
    const was = before.get(u);
    const is = usage(u);
    const user = users.get(u);
    const known = user && (named === null || named.has(user.user) || u === uid);
    return {
      uid: u,
      name: known ? `${user.comment || user.user}${u === uid ? " (you)" : ""}` : "",
      bytes: cgroupMemory(dir) ?? 0,
      swapBytes: readNumber(path.join(dir, "memory.swap.current")) ?? 0,
      cpus: was !== null && was !== undefined && is !== null ? Math.max(0, (is - was) / micros) : 0,
    };
  });
  const active = agents
    .filter((a) => a.bytes + a.swapBytes >= IDLE_BYTES || a.cpus >= IDLE_CPUS)
    .sort((a, b) => b.bytes + b.swapBytes - (a.bytes + a.swapBytes) || b.cpus - a.cpus);
  if (active.length === 0) return [...lines, "No agent is using it now."].join("\n");
  const listed = active.filter((a) => a.name).slice(0, LISTED);
  const others = active.filter((a) => !listed.includes(a));
  const row = (name: string, bytes: number, swapBytes: number, n: number) =>
    `- ${name}: ${gb(bytes)}${swapBytes >= IDLE_BYTES ? ` (and ${gb(swapBytes)} in swap)` : ""}, ${cpu(n)} CPUs`;
  lines.push("Using the most now:", ...listed.map((a) => row(a.name, a.bytes, a.swapBytes, a.cpus)));
  if (others.length > 0) {
    const sum = (f: (a: AgentUse) => number) => others.reduce((n, a) => n + f(a), 0);
    lines.push(
      row(
        listed.length > 0 ? "Other agents" : "Agents",
        sum((a) => a.bytes),
        sum((a) => a.swapBytes),
        sum((a) => a.cpus),
      ),
    );
  }
  return lines.join("\n");
}
