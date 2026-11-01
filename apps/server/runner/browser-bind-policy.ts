import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { type AgentUser, systemLauncher } from "./agent-users";
import { bindCheckArgs } from "./browser-bind-check";
import { browserBand, browserPortsForUid, checkEphemeralRange, EPHEMERAL_RANGE_FILE } from "./browser-ports";
import { agentSlice, agentTmp, type RunCommand, systemdBooted } from "./service";

/**
 * A systemd unit property or a loaded table is only a claim until a process in the slice proves what the kernel
 * does. The probe waits up to 5 s for its own listener and 2 s on each of root's when refusals are drops.
 */
const runBounded: RunCommand = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 30_000 });
  if (result.error) return { code: 127, output: result.error.message };
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};

/** A listener on an assigned browser port must belong to that port's agent (`ss -Htln -e` output). */
export function conflictingBrowserPorts(ssOutput: string, uidRange: [number, number]): number[] {
  const [first, last] = browserBand(uidRange);
  const conflicts = new Set<number>();
  const bucket = Math.floor(uidRange[0] / 10_000) * 10_000;
  for (const line of ssOutput.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "LISTEN" || !cols[3]) continue;
    const port = Number(cols[3].slice(cols[3].lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port < first || port > last) continue;
    const owner = bucket + Math.floor((port - 10_000) / 2);
    const actual = Number(/\buid:(\d+)\b/.exec(line)?.[1] ?? 0);
    if (actual !== owner) conflicts.add(port);
  }
  return [...conflicts].sort((a, b) => a - b);
}

/** Root's own listeners on 127.0.0.1 and ::1, for the probe to be refused by. */
export interface Decoys {
  ports: [number, number];
  close(): void;
}

/**
 * Bound before `Bun.listen` returns. While root waits on the probe its event loop is blocked, but the kernel still
 * completes handshakes into the backlog: a rule that let the agent in shows as a completed connect.
 */
function rootDecoys(): Decoys {
  if (typeof Bun === "undefined") throw new Error("System mode runs the runner on Bun");
  const open = (hostname: string) => Bun.listen({ hostname, port: 0, socket: { data() {} } });
  const v4 = open("127.0.0.1");
  try {
    const v6 = open("::1");
    return {
      ports: [v4.port, v6.port],
      close: () => {
        v4.stop(true);
        v6.stop(true);
      },
    };
  } catch (err) {
    v4.stop(true);
    throw err;
  }
}

export interface BindPolicyOptions {
  /** The computer's agent uid range: its browser pairs are the band no agent binds in but on its own pair. */
  uidRange: [number, number];
  /** Root's loopback guard (`LoopbackGuard.reconcile`): maps the slice systemd just made before the probe. */
  refresh?: () => void;
  run?: RunCommand;
  /** Tests: the computer. */
  systemd?: boolean;
  ephemeralRange?: () => string;
  decoys?: () => Decoys;
  /** `<device>:<inode>` of a folder, or null. */
  folderId?: (dir: string) => string | null;
}

const folderId = (dir: string) => {
  try {
    const st = statSync(dir, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
};

/**
 * Must run as root before this agent's worker can start or restart: the bind policy on its slice, then a probe in
 * it (`bind-check`, launched as every agent process is) that proves on this kernel what the agent may bind and
 * reach, and that its /tmp is its own.
 */
export function ensureBrowserBindPolicy(user: AgentUser, runner: string[], opts: BindPolicyOptions) {
  if (!(opts.systemd ?? systemdBooted())) {
    throw new Error("System agent browsers require systemd cgroup socket-bind enforcement");
  }
  const run = opts.run ?? runBounded;
  const band = browserBand(opts.uidRange);
  // Read again each time: bind(0) must never land in the band, which the bind policy can't see.
  checkEphemeralRange((opts.ephemeralRange ?? (() => readFileSync(EPHEMERAL_RANGE_FILE, "utf8")))(), band);
  const { cdp, stream } = browserPortsForUid(user.uid);
  const slice = agentSlice(user.uid);
  // A newly allocated agent has no active slice yet. Start the empty slice as
  // root so set-property has a loaded unit to update before any worker enters.
  const started = run("systemctl", ["start", slice]);
  if (started.code !== 0) {
    throw new Error(`Cannot start ${slice} for browser bind policy: ${started.output.slice(0, 200)}`);
  }
  // A slice made now is a new cgroup: mapped at once, so the agent's connections are its own from the probe on.
  opts.refresh?.();
  // Only the band is denied, its own pair excepted: bind(0) matches no rule with ports, so it binds (outside the
  // band, by the ephemeral range). Clearing and replacing the lists in one call avoids duplicates on restarts;
  // systemd commits the cgroup change after every property of the call.
  const configured = run("systemctl", [
    "set-property",
    "--runtime",
    slice,
    "SocketBindAllow=",
    `SocketBindAllow=tcp:${cdp}-${stream}`,
    "SocketBindDeny=",
    `SocketBindDeny=tcp:${band[0]}-${band[1]}`,
  ]);
  if (configured.code !== 0) {
    throw new Error(`Cannot set ${slice} browser bind policy: ${configured.output.slice(0, 200)}`);
  }
  // Pick a currently unused reserved port. EADDRINUSE is not proof of
  // enforcement, and the child only succeeds for EPERM/EACCES on IPv4+6.
  const sockets = run("ss", ["-Htln", "-e"]);
  if (sockets.code !== 0) throw new Error(`Cannot inspect browser bind test ports: ${sockets.output.slice(0, 200)}`);
  const wrongOwner = conflictingBrowserPorts(sockets.output, [user.uid, user.uid]);
  if (wrongOwner.length)
    throw new Error(`Agent ${user.uid}'s browser ports have the wrong listener owner: ${wrongOwner.join(", ")}`);
  const occupied = new Set<number>();
  for (const line of sockets.output.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    if (line.trim().startsWith("LISTEN") && local) {
      const port = Number(local.slice(local.lastIndexOf(":") + 1));
      if (Number.isInteger(port)) occupied.add(port);
    }
  }
  let forbidden = band[0];
  while (forbidden <= band[1] && (forbidden === cdp || forbidden === stream || occupied.has(forbidden))) forbidden++;
  if (forbidden > band[1]) throw new Error("No free reserved port for browser bind policy self-check");
  let dev = 3000;
  while (dev < band[0] && occupied.has(dev)) dev++;
  if (dev >= band[0]) throw new Error("No free development port for browser bind policy self-check");
  // As every agent process starts: its slice, its private temporary folders, its user.
  const [launch = "", ...prefix] = systemLauncher(user, true).prefix;
  const decoys = (opts.decoys ?? rootDecoys)();
  let verified: ReturnType<RunCommand>;
  try {
    verified = run(launch, [
      ...prefix,
      ...runner,
      "bind-check",
      ...bindCheckArgs({
        forbidden,
        allowed: [occupied.has(cdp) ? 0 : cdp, occupied.has(stream) ? 0 : stream, dev],
        band,
        decoys: decoys.ports,
      }),
    ]);
  } finally {
    decoys.close();
  }
  if (verified.code !== 0) {
    throw new Error(`Agent ${user.uid}'s isolation doesn't hold in ${slice}: ${verified.output.slice(0, 300)}`);
  }
  const seen = /^tmp (\d+:\d+)$/m.exec(verified.output)?.[1];
  const own = (opts.folderId ?? folderId)(agentTmp(user.uid));
  if (!seen || seen !== own) {
    throw new Error(`Agent ${user.uid}'s /tmp isn't its own (${seen ?? "not said"}, its folder ${own ?? "missing"})`);
  }
  const finalSockets = run("ss", ["-Htln", "-e"]);
  if (finalSockets.code !== 0)
    throw new Error(`Cannot recheck browser listener owners: ${finalSockets.output.slice(0, 200)}`);
  const finalWrongOwner = conflictingBrowserPorts(finalSockets.output, [user.uid, user.uid]);
  if (finalWrongOwner.length) {
    throw new Error(`Agent ${user.uid}'s browser ports have the wrong listener owner: ${finalWrongOwner.join(", ")}`);
  }
}
