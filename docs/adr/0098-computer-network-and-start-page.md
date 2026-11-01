# 0098 — Observed computer networking and the browser start page

Date: 2026-11-01. Status: accepted.

## Context

An agent's public route can change independently of its computer's host address. A person watching the
computer also needs a clear path into control, and a new browser tab should belong to the same computer.
The public runner must support deployments with their own network isolation without knowing a provider.

## Decision

Protocol 33 adds an optional `egress` observation to `pong`: `{ip: string | null, country?: string}`. The
runner samples its paired server's unauthenticated `/api/machines/ip` every 30 seconds and on welcome. In system
mode the request runs as an agent's UID through its normal network launcher, with no machine credentials.
Single-user mode uses the runner's own route. Only public addresses survive validation; three failures report
`{ip:null}`. Identical observations reuse their object, so ordinary heartbeats carry no repeated payload.
The server stores its receive time in `machines.egress`, clears it on a new connection, and publishes changed
observations. Offline computers show no address. Country marks are bundled SVGs; unknown countries use a globe.
The field is informational and is excluded from telemetry.

`networkLauncher` is an optional administrator-owned executable in the system runner's configuration. It
receives the UID, `--`, and the command, and must prepare the network context before exec. Both root-side
socket inspection and the bind-enforcement self-check enter it; the worker then runs there as the agent.
Thus Chrome, agent-browser, CDP HTTP/WebSocket calls, terminal shells and desktop processes inherit the same
context. VNC and worker coordination retain their filesystem sockets. Every executable path component is
root-owned and immutable to ordinary users. The existing host loopback guard remains for old processes.
Changing the setting requires an operator-coordinated restart; the hook does not migrate live processes.

The offline new-tab page is a permissionless extension loaded by Chrome's command line. It reuses the desktop
art and brand fonts, contains no links or buttons, and hides its decorative content from accessibility snapshots.
The root runner installs system-mode assets outside agent homes, with read-only access for agents; a regular
runner writes its own assets. Only the local data file is refreshed. The server sends the responsible person's
language with the agent list; Portuguese maps to pt-BR and all other languages fall back to English. No Chrome
managed policy is installed. Only the extension's exact fixed URL is treated as a blank page in site checks.

A screen click or printable key while watching opens a translucent take-control prompt. The initial input is
not replayed. Escape dismisses the prompt first, and the prompt waits twenty seconds before offering again.
Keyboard-triggered prompts keep focus where it was. The existing explicit control action remains authoritative.

Browser streams use JPEG quality 60. A backed-up runner socket skips independent browser pictures above 2 MiB,
while results and heartbeats keep their ordered delivery. Desktop encoding adjusts to browser-reported network
conditions and data-saving preferences without reopening the stream. These are bounded improvements; end-to-end
viewer acknowledgements and measured-throughput adaptation remain separate work.

A root-configured `networkMark` optionally permits trusted routing through loopback for foreign destinations.
It is one uint32 packet bit outside the local-service conntrack tag bits, absent by default. The early guard
exception tests that bit, excludes destination NAT, and requires `fib daddr type != local` without `.mark`.
This preserves the original destination check, including wildcard services on a host's public address. The
external routing layer must reject private destinations before marking and keep agent processes without
network administrative/raw capabilities, including file capability escalation. No provider is named in core.
The exception is independent of the optional namespace launcher, so existing host-network processes can drain.
The [Linux IPv4 FIB implementation](https://kernel.googlesource.com/pub/scm/linux/kernel/git/stable/linux-stable.git/+/3f786abd23951f3f600a62fef42469d9200d5f52/net/ipv4/netfilter/nft_fib_ipv4.c)
checks local address type separately from the marked policy route. The
[IPv6 FIB implementation](https://kernel.googlesource.com/pub/scm/linux/kernel/git/stable/linux-stable/+/4fa048ed72531d6c2a2147fa9b52b6a5451213a2/net/ipv6/netfilter/nft_fib_ipv6.c)
also only includes the packet mark when explicitly requested.

When `networkMark` is configured, `systemLauncher` runs `setpriv --no-new-privs --bounding-set=-net_admin,-net_raw` immediately before `runuser`, after the optional network launcher.
This also covers deployments using marked routing without a namespace launcher. The kernel bind self-check
uses the same restriction. Existing processes must be drained or restarted before relying on it.

## Verification

Unit tests use fake sockets, processes and the in-memory database. They cover observed-address validation,
clearing and live updates, forwarded-address handling, helper ownership and command ordering, offline extension
permissions, localization, accidental input, and streaming backpressure. A release using a custom helper also
needs Linux acceptance checks of both IPv4 and IPv6, existing-process coexistence, browser CDP, desktop and
terminal paths, Chrome's user-namespace sandbox under no-new-privileges, and rollback before any production rollout.
