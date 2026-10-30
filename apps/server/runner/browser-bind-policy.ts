import { spawnSync } from "node:child_process";
import type { AgentUser } from "./agent-users";
import { BROWSER_PORT_FIRST, BROWSER_PORT_LAST, browserPortsForUid } from "./browser-ports";
import { conflictingBrowserPorts } from "./loopback-guard";
import { agentSlice, type RunCommand, systemdBooted } from "./service";

/** A systemd unit property is only a claim until a process in its slice proves the kernel denied bind(2). */
const runBounded: RunCommand = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 15_000 });
  if (result.error) return { code: 127, output: result.error.message };
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};

/** Must run as root before this agent's worker can start or restart. */
export function ensureBrowserBindPolicy(
  user: AgentUser,
  runner: string[],
  opts: { run?: RunCommand; systemd?: boolean } = {},
) {
  if (!(opts.systemd ?? systemdBooted())) {
    throw new Error("System agent browsers require systemd cgroup socket-bind enforcement");
  }
  const run = opts.run ?? runBounded;
  const { cdp, stream } = browserPortsForUid(user.uid);
  const slice = agentSlice(user.uid);
  // A newly allocated agent has no active slice yet. Start the empty slice as
  // root so set-property has a loaded unit to update before any worker enters.
  const started = run("systemctl", ["start", slice]);
  if (started.code !== 0) {
    throw new Error(`Cannot start ${slice} for browser bind policy: ${started.output.slice(0, 200)}`);
  }
  // The pinned agent-browser daemon falls back to bind(0) when its preferred
  // stream port is occupied. Denying every TCP bind with explicit non-browser
  // allowances also denies port 0 before the kernel can assign a random port.
  // Clearing and replacing the list in one set-property call avoids duplicate
  // allowances on worker restarts. systemd commits the cgroup change after all
  // properties in the call have been processed.
  const configured = run("systemctl", [
    "set-property", "--runtime", slice,
    "SocketBindAllow=",
    `SocketBindAllow=tcp:1-${BROWSER_PORT_FIRST - 1}`,
    `SocketBindAllow=tcp:${BROWSER_PORT_LAST + 1}-65535`,
    `SocketBindAllow=tcp:${cdp}-${stream}`,
    "SocketBindDeny=",
    "SocketBindDeny=tcp",
  ]);
  if (configured.code !== 0) {
    throw new Error(`Cannot set ${slice} browser bind policy: ${configured.output.slice(0, 200)}`);
  }
  // Pick a currently unused reserved port. EADDRINUSE is not proof of
  // enforcement, and the child only succeeds for EPERM/EACCES on IPv4+6.
  const sockets = run("ss", ["-Htln", "-e"]);
  if (sockets.code !== 0) throw new Error(`Cannot inspect browser bind test ports: ${sockets.output.slice(0, 200)}`);
  const wrongOwner = conflictingBrowserPorts(sockets.output, [user.uid, user.uid]);
  if (wrongOwner.length) throw new Error(`Agent ${user.uid}'s browser ports have the wrong listener owner: ${wrongOwner.join(", ")}`);
  const occupied = new Set<number>();
  for (const line of sockets.output.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    if (line.trim().startsWith("LISTEN") && local) {
      const port = Number(local.slice(local.lastIndexOf(":") + 1));
      if (Number.isInteger(port)) occupied.add(port);
    }
  }
  let forbidden = BROWSER_PORT_FIRST;
  while (forbidden <= BROWSER_PORT_LAST && (forbidden === cdp || forbidden === stream || occupied.has(forbidden))) forbidden++;
  if (forbidden > BROWSER_PORT_LAST) throw new Error("No free reserved port for browser bind policy self-check");
  let dev = 3000;
  while (dev < BROWSER_PORT_FIRST && occupied.has(dev)) dev++;
  if (dev >= BROWSER_PORT_FIRST) throw new Error("No free development port for browser bind policy self-check");
  const verified = run("/usr/bin/systemd-run", [
    "--quiet", "--scope", "--collect", `--slice=${slice}`, "--",
    "/usr/sbin/runuser", "-u", user.user, "--", ...runner, "bind-check", String(forbidden),
    String(occupied.has(cdp) ? 0 : cdp), String(occupied.has(stream) ? 0 : stream), String(dev),
  ]);
  if (verified.code !== 0) {
    throw new Error(`Browser bind policy is not enforced in ${slice}: ${verified.output.slice(0, 200)}`);
  }
  const finalSockets = run("ss", ["-Htln", "-e"]);
  if (finalSockets.code !== 0) throw new Error(`Cannot recheck browser listener owners: ${finalSockets.output.slice(0, 200)}`);
  const finalWrongOwner = conflictingBrowserPorts(finalSockets.output, [user.uid, user.uid]);
  if (finalWrongOwner.length) {
    throw new Error(`Agent ${user.uid}'s browser ports have the wrong listener owner: ${finalWrongOwner.join(", ")}`);
  }
}
