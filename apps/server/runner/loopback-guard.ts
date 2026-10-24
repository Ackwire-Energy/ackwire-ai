import { writeFileSync } from "node:fs";
import path from "node:path";
import { type RunCommand, runSync } from "./service";

/**
 * System mode: a loopback firewall so an agent can't reach another agent's
 * local ports. Chrome's debugging port and agent-browser's stream port have
 * no authentication of their own and are OS-assigned (unpredictable, in the
 * ephemeral range, where agents' own tools — a dev server, `node --inspect` —
 * also listen), so a fixed port range can't be guarded without catching those
 * too. Instead the supervisor (the only root process) learns each agent's
 * loopback listeners from `ss`, which gives the listening socket's real owner
 * uid, and guards exactly those ports: each is reachable over `lo` only by its
 * owner's uid and by root (the supervisor, the desktop relay). Any other local
 * user — another agent — is refused.
 *
 * `table inet agentes_runner` (its own table, separate from the Cloud guard's
 * `inet agentes_guard`; a reject in either base chain wins):
 *   set owner   { type inet_service . uid }  — (port, owning uid) pairs
 *   set guarded { type inet_service }         — the ports under guard
 *   chain output (filter hook output):
 *     oif lo tcp dport . meta skuid @owner accept   — the owner reaches its own port
 *     oif lo meta skuid 0 accept                     — root reaches anything
 *     oif lo tcp dport @guarded reject               — anyone else is refused
 * On the output hook `meta skuid` is the connecting process's uid, so a new
 * connection to a guarded port from a non-owner, non-root user is refused.
 * The reply direction (source port = the guarded port, destination = the
 * client's ephemeral port) never matches `tcp dport @guarded`, so it is let
 * through by the chain's accept policy.
 *
 * `reject` (not `drop`) so a refused `connect()` fails at once instead of
 * hanging; it needs `nft_reject_inet`, loaded with `modprobe` at start and
 * falling back to `drop` if the module can't load. Without `nft` at all the
 * guard is off with one warning: single-user self-hosts don't have it, and the
 * isolation it adds only matters when agents of different people share a
 * computer.
 */

/** Our table; the Cloud guard has its own (`inet agentes_guard`). */
export const RUNNER_NFT_TABLE = "agentes_runner";
/**
 * How often the supervisor rescans loopback listeners (a cheap `ss`; `nft`
 * runs only when the set changed).
 * ponytail: polled discovery leaves a sub-rescan window between a port opening
 * and its guard; a worker reporting its listeners for the supervisor to verify
 * with `ss` would close it, at the cost of a worker→supervisor frame.
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

const elementList = (items: string[]) => (items.length ? `\n\t\telements = { ${items.join(", ")} }` : "");

/**
 * The whole `nft -f` script for the current listeners. The
 * create-then-delete-then-create idiom replaces the table atomically whatever
 * state it was in, without touching any other table (never `flush ruleset`).
 */
export function renderRuleset(listeners: readonly GuardedListener[], reject: RejectVerb): string {
  const owner = listeners.map((l) => `${l.port} . ${l.uid}`);
  const ports = [...new Set(listeners.map((l) => l.port))].map(String);
  return [
    `table inet ${RUNNER_NFT_TABLE} {}`,
    `delete table inet ${RUNNER_NFT_TABLE}`,
    `table inet ${RUNNER_NFT_TABLE} {`,
    `\tset owner {\n\t\ttype inet_service . uid${elementList(owner)}\n\t}`,
    `\tset guarded {\n\t\ttype inet_service${elementList(ports)}\n\t}`,
    "\tchain output {",
    "\t\ttype filter hook output priority 0; policy accept;",
    '\t\toif "lo" tcp dport . meta skuid @owner accept',
    '\t\toif "lo" meta skuid 0 accept',
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
  log: (line: string) => void;
  run?: RunCommand;
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
  private off = false;
  /** One warning per failure streak, cleared on the next success. */
  private warned = false;

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
    if (!this.available()) {
      this.opts.log(
        "nft isn't available: agents on this computer are not isolated on local ports (expected off a shared Cloud machine)",
      );
      this.off = true;
      return;
    }
    // Best effort: reject needs nft_reject_inet; without it the ruleset falls back to drop.
    this.run("modprobe", ["nft_reject_inet"]);
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), GUARD_RESCAN_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Rescans loopback listeners and, when they changed, reapplies the table. */
  reconcile() {
    if (this.off) return;
    const uids = new Set(this.opts.agentUids());
    const listeners = uids.size ? parseListeners(this.run("ss", ["-Htln", "-e"]).output, uids) : [];
    const text = renderRuleset(listeners, this.verb);
    if (text === this.applied) return;
    if (this.apply(text)) {
      this.applied = text;
      this.warned = false;
      return;
    }
    // The reject rule may be what nft refused (no nft_reject_inet): try drop once.
    if (this.verb !== "drop") {
      this.verb = "drop";
      const dropText = renderRuleset(listeners, this.verb);
      if (this.apply(dropText)) {
        this.applied = dropText;
        this.warned = false;
        return;
      }
    }
    if (!this.warned) {
      this.warned = true;
      this.opts.log("couldn't apply the loopback guard (is NET_ADMIN available?); local ports are not isolated");
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
