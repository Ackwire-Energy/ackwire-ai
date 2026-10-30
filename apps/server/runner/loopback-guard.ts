import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browserPortsForUid, checkEphemeralRange, validateBrowserUidRange } from "./browser-ports";
import { type RunCommand, runSync, systemdBooted } from "./service";

/**
 * System mode: Chrome CDP and agent-browser stream use permanent per-UID ports.
 * The root guard installs their owner rules for the entire configured UID range
 * before starting any worker, including the first agent. A per-agent systemd
 * bind policy prevents another agent from taking an assigned browser port and
 * denies bind(0), which the pinned stream daemon uses on port collision.
 *
 * Other agent-owned listeners are still discovered with `ss` every two
 * seconds. That polling has a startup and stale-port reuse window; this guard
 * does not provide complete isolation for arbitrary local development servers.
 * `meta skuid` is the connecting socket's UID. Reply packets are excluded
 * before port checks because their destination can be another guarded port.
 */

/** Our table; the Cloud guard has its own (`inet agentes_guard`). */
export const RUNNER_NFT_TABLE = "agentes_runner";
/**
 * How often the supervisor rescans loopback listeners (a cheap `ss`; `nft`
 * runs only when the set changed).
 * Polled discovery retains a window between a generic listener opening and
 * its next scan, and a stale owner exception after a listener closes.
 */
export const GUARD_RESCAN_MS = 2000;

/** A guarded loopback listener: an agent-owned TCP listening socket. */
export interface GuardedListener {
  port: number;
  uid: number;
}

type RejectVerb = "reject with tcp reset" | "drop";

/**
 * The agent-owned loopback listeners in `ss -Htln -e` output: the local port
 * and the socket's owner uid. `ss` run as root prints `uid:<n>` for every
 * socket a non-root user owns and omits it for root's own (uid 0), so a line
 * with no `uid:` is root's and never an agent's. Only listeners whose owner is
 * an agent's uid are kept (deduplicated by port and uid).
 */
export function parseListeners(ssOutput: string, agentUids: ReadonlySet<number>): GuardedListener[] {
  const seen = new Set<string>();
  const out: GuardedListener[] = [];
  for (const line of ssOutput.split("\n")) {
    const cols = line.trim().split(/\s+/);
    // State Recv-Q Send-Q Local:Port Peer:Port [uid:N ino:N …]
    const local = cols[3];
    if (!local || cols[0] !== "LISTEN") continue;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const m = /\buid:(\d+)\b/.exec(line);
    const uid = m ? Number(m[1]) : 0;
    if (!agentUids.has(uid)) continue;
    const key = `${port}.${uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, uid });
  }
  return out;
}

/** A listener on an assigned browser port must belong to that port's agent. */
export function conflictingBrowserPorts(ssOutput: string, uidRange: [number, number]): number[] {
  validateBrowserUidRange(uidRange);
  const conflicts = new Set<number>();
  const bucket = Math.floor(uidRange[0] / 10_000) * 10_000;
  for (const line of ssOutput.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "LISTEN" || !cols[3]) continue;
    const port = Number(cols[3].slice(cols[3].lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port < 10_000 || port > 29_999) continue;
    const owner = bucket + Math.floor((port - 10_000) / 2);
    if (owner < uidRange[0] || owner > uidRange[1]) continue;
    const actual = Number(/\buid:(\d+)\b/.exec(line)?.[1] ?? 0);
    if (actual !== owner) conflicts.add(port);
  }
  return [...conflicts].sort((a, b) => a - b);
}

const elementList = (items: string[]) => (items.length ? `\n\t\telements = { ${items.join(", ")} }` : "");

/**
 * The whole `nft -f` script for the current listeners. The
 * create-then-delete-then-create idiom replaces the table atomically whatever
 * state it was in, without touching any other table (never `flush ruleset`).
 */
export function renderRuleset(
  listeners: readonly GuardedListener[], reject: RejectVerb, uidRange: [number, number],
  conflictingPorts: ReadonlySet<number> = new Set(),
): string {
  validateBrowserUidRange(uidRange);
  const browserOwner: string[] = [];
  const browserPorts: string[] = [];
  for (let uid = uidRange[0]; uid <= uidRange[1]; uid++) {
    const { cdp, stream } = browserPortsForUid(uid);
    if (!conflictingPorts.has(cdp)) browserOwner.push(`${cdp} . ${uid}`);
    if (!conflictingPorts.has(stream)) browserOwner.push(`${stream} . ${uid}`);
    browserPorts.push(String(cdp), String(stream));
  }
  const uidsByPort = new Map<number, Set<number>>();
  for (const { port, uid } of listeners) {
    const uids = uidsByPort.get(port) ?? new Set<number>();
    uids.add(uid);
    uidsByPort.set(port, uids);
  }
  // An attacker can bind 127.0.0.2:port while another agent owns 127.0.0.1:port.
  // Allowing either uid by port alone would also allow it into the other's listener.
  const owner = listeners.filter((l) => uidsByPort.get(l.port)?.size === 1).map((l) => `${l.port} . ${l.uid}`);
  const ports = [...new Set(listeners.map((l) => l.port))].map(String);
  return [
    `table inet ${RUNNER_NFT_TABLE} {}`,
    `delete table inet ${RUNNER_NFT_TABLE}`,
    `table inet ${RUNNER_NFT_TABLE} {`,
    `\tset browser_owner {\n\t\ttype inet_service . uid${elementList(browserOwner)}\n\t}`,
    `\tset browser_ports {\n\t\ttype inet_service${elementList(browserPorts)}\n\t}`,
    `\tset owner {\n\t\ttype inet_service . uid${elementList(owner)}\n\t}`,
    `\tset guarded {\n\t\ttype inet_service${elementList(ports)}\n\t}`,
    "\tchain output {",
    "\t\ttype filter hook output priority 0; policy accept;",
    '\t\toif "lo" meta skuid 0 accept',
    // A local TCP server's reply has the client's ephemeral destination port.
    '\t\toif "lo" ct direction reply accept',
    '\t\toif "lo" tcp dport . meta skuid @browser_owner accept',
    `\t\toif "lo" tcp dport @browser_ports ${reject}`,
    '\t\toif "lo" tcp dport . meta skuid @owner accept',
    `\t\toif "lo" tcp dport @guarded ${reject}`,
    "\t}",
    "}",
    "",
  ].join("\n");
}

export interface LoopbackGuardOptions {
  /** The runner home: the rendered ruleset is written here (root-owned, 0600). */
  home: string;
  /** The agents' uids right now (`agents.json`); only their loopback listeners are guarded. */
  agentUids: () => number[];
  /** Entire configured system-agent UID range, including agents not yet created. */
  uidRange: [number, number];
  log: (line: string) => void;
  run?: RunCommand;
  /** Tests: the systemd and kernel state checked before the guard starts. */
  systemd?: boolean;
  ephemeralRange?: string;
}

/**
 * Keeps `table inet agentes_runner` matching the agents' current loopback
 * listeners. Lives in the root supervisor; the workers (the agents' own uids)
 * can't touch nftables.
 */
export class LoopbackGuard {
  private readonly run: RunCommand;
  private readonly rulesetFile: string;
  private verb: RejectVerb = "reject with tcp reset";
  private applied = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  /** One warning per failure streak, cleared on the next success. */
  private warned = false;
  private conflicts: number[] = [];

  constructor(private readonly opts: LoopbackGuardOptions) {
    this.run = opts.run ?? runSync;
    this.rulesetFile = path.join(opts.home, "loopback-guard.nft");
  }

  /** Whether `nft` is here to run (single-user self-hosts have no system-mode guard). */
  available(): boolean {
    return this.run("nft", ["--version"]).code === 0;
  }

  /** Loads the reject module, applies the first ruleset, and rescans on a timer. */
  start() {
    if (!(this.opts.systemd ?? systemdBooted())) {
      throw new Error("System mode requires systemd socket-bind enforcement for agent browsers");
    }
    validateBrowserUidRange(this.opts.uidRange);
    this.validateExistingUids();
    checkEphemeralRange(this.opts.ephemeralRange ?? readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8"));
    if (!this.available()) throw new Error("System mode requires nft for browser port isolation");
    // Best effort: reject needs nft_reject_inet; without it the ruleset falls back to drop.
    this.run("modprobe", ["nft_reject_inet"]);
    if (!this.reconcile()) throw new Error("System mode requires ss and an applied nft loopback guard");
    if (this.conflicts.length) throw new Error(`Reserved browser ports have the wrong owner: ${this.conflicts.join(", ")}`);
    this.timer = setInterval(() => this.reconcile(), GUARD_RESCAN_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Rescans loopback listeners and, when they changed, reapplies the table. */
  reconcile(): boolean {
    const existing = this.opts.agentUids();
    if (!this.validExistingUids(existing)) {
      this.warnOnce("agent UIDs overlap or fall outside the configured browser port range");
      return false;
    }
    const uids = new Set(existing);
    const ss = this.run("ss", ["-Htln", "-e"]);
    if (ss.code !== 0) {
      // No listing is not "no listeners": an empty set would unguard every port, so what is applied stays.
      this.warnOnce(`couldn't list local ports (${ss.output.slice(0, 200)}); the loopback guard keeps its last rules`);
      return false;
    }
    const listeners = parseListeners(ss.output, uids);
    this.conflicts = conflictingBrowserPorts(ss.output, this.opts.uidRange);
    const blocked = new Set(this.conflicts);
    if (this.conflicts.length) this.warnOnce(`reserved browser ports have the wrong owner: ${this.conflicts.join(", ")}`);
    const text = renderRuleset(listeners, this.verb, this.opts.uidRange, blocked);
    if (text === this.applied) return true;
    if (this.apply(text)) {
      this.applied = text;
      this.warned = false;
      return true;
    }
    // The reject rule may be what nft refused (no nft_reject_inet): try drop once.
    if (this.verb !== "drop") {
      this.verb = "drop";
      const dropText = renderRuleset(listeners, this.verb, this.opts.uidRange, blocked);
      if (this.apply(dropText)) {
        this.applied = dropText;
        this.warned = false;
        return true;
      }
    }
    this.warnOnce("couldn't apply the loopback guard (is NET_ADMIN available?); local ports are not isolated");
    return false;
  }

  private warnOnce(line: string) {
    if (this.warned) return;
    this.warned = true;
    this.opts.log(line);
  }

  private validExistingUids(uids: number[]): boolean {
    const [first, last] = this.opts.uidRange;
    return new Set(uids).size === uids.length && uids.every((uid) => Number.isInteger(uid) && uid >= first && uid <= last);
  }

  private validateExistingUids() {
    if (!this.validExistingUids(this.opts.agentUids())) {
      throw new Error("Persisted agent UIDs overlap or fall outside the configured browser port range");
    }
  }

  /** Writes the script and applies it (checked first). True when it took. */
  private apply(text: string): boolean {
    try {
      writeFileSync(this.rulesetFile, text, { mode: 0o600 });
    } catch {
      return false;
    }
    if (this.run("nft", ["-c", "-f", this.rulesetFile]).code !== 0) return false;
    return this.run("nft", ["-f", this.rulesetFile]).code === 0;
  }
}
