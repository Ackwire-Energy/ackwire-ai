import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { browserPortsForUid, checkEphemeralRange, validateBrowserUidRange } from "../../runner/browser-ports";
import {
  conflictingBrowserPorts,
  type GuardedListener,
  LoopbackGuard,
  parseListeners,
  RUNNER_NFT_TABLE,
  renderRuleset,
} from "../../runner/loopback-guard";
import type { RunCommand } from "../../runner/service";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const A: GuardedListener = { port: 45891, uid: 21000 };
const A2: GuardedListener = { port: 45777, uid: 21000 };
const B: GuardedListener = { port: 50001, uid: 21001 };
const RANGE: [number, number] = [21000, 21001];

/** `ss -Htln -e` lines as the kernel prints them: no `uid:` for root, `uid:<n>` otherwise. */
function ssOutput(rows: { port: number; uid?: number; state?: string; address?: string }[]): string {
  return rows
    .map((r) => {
      const uid = r.uid === undefined ? "" : ` uid:${r.uid}`;
      return `${r.state ?? "LISTEN"} 0      0       ${r.address ?? "127.0.0.1"}:${r.port} 0.0.0.0:*${uid} ino:7953 sk:0`;
    })
    .join("\n");
}

// ── render ───────────────────────────────────────────────────────────────

test("renders the table, both sets and the owner/root/reject chain for two agents", () => {
  const text = renderRuleset([A, A2, B], "reject with tcp reset", RANGE);
  // Atomic single-table replace, never `flush ruleset` (the Cloud guard has its own table).
  expect(text).toContain(`table inet ${RUNNER_NFT_TABLE} {}`);
  expect(text).toContain(`delete table inet ${RUNNER_NFT_TABLE}`);
  expect(text).not.toContain("flush ruleset");
  // Owner set: (port, uid) pairs for every listener.
  expect(text).toContain("type inet_service . uid");
  expect(text).toContain("45891 . 21000");
  expect(text).toContain("45777 . 21000");
  expect(text).toContain("50001 . 21001");
  // Guarded set: the ports, each once.
  expect(text).toContain("type inet_service\n");
  expect(text).toMatch(/guarded \{[^}]*elements = \{ 45891, 45777, 50001 \}/s);
  // Permanent browser pairs are checked before the polled listener exceptions.
  expect(text).toContain("12000 . 21000");
  expect(text).toContain("12002 . 21001");
  const reply = text.indexOf('oif "lo" ct direction reply accept');
  const browser = text.indexOf('oif "lo" tcp dport @browser_ports reject with tcp reset');
  const owner = text.indexOf('oif "lo" tcp dport . meta skuid @owner accept');
  const root = text.indexOf('oif "lo" meta skuid 0 accept');
  const reject = text.indexOf('oif "lo" tcp dport @guarded reject with tcp reset');
  expect(reply).toBeGreaterThan(root);
  expect(browser).toBeGreaterThan(reply);
  expect(owner).toBeGreaterThan(browser);
  expect(owner).toBeGreaterThan(0);
  expect(reject).toBeGreaterThan(owner);
});

test("browser ports are guarded before any agent listener or UID exists", () => {
  const text = renderRuleset([], "reject with tcp reset", RANGE);
  expect(text).toContain("set owner");
  expect(text).toContain("set guarded");
  expect(text).toContain("12000 . 21000");
  expect(text).toContain("12003 . 21001");
  expect(text).toContain("@browser_ports reject with tcp reset");
  expect(text).toContain("@guarded reject with tcp reset");
});

test("the drop fallback renders drop instead of reject", () => {
  expect(renderRuleset([A], "drop", RANGE)).toContain('oif "lo" tcp dport @guarded drop');
  expect(renderRuleset([A], "drop", RANGE)).not.toContain("reject");
});

// ── parse ss ───────────────────────────────────────────────────────────────

test("keeps only listeners owned by an agent uid, with the uid read from ss", () => {
  const out = ssOutput([
    { port: 45891, uid: 21000 }, // agent A
    { port: 50001, uid: 21001 }, // agent B
    { port: 53, uid: 990 }, // systemd-resolve: not an agent
    { port: 25 }, // root (no uid:): not an agent
  ]);
  expect(parseListeners(out, new Set([21000, 21001]))).toEqual([
    { port: 45891, uid: 21000 },
    { port: 50001, uid: 21001 },
  ]);
});

test("deduplicates a port/uid seen twice (IPv4 and IPv6 rows) and ignores non-LISTEN rows", () => {
  const out = [
    "LISTEN 0 0 127.0.0.1:45891 0.0.0.0:* uid:21000 ino:1 sk:0",
    "LISTEN 0 0 [::1]:45891 [::]:* uid:21000 ino:2 sk:0",
    "ESTAB  0 0 127.0.0.1:45891 127.0.0.1:55000 uid:21000 ino:3 sk:0",
  ].join("\n");
  expect(parseListeners(out, new Set([21000]))).toEqual([{ port: 45891, uid: 21000 }]);
});

test("a port shared by different agent uids never grants either uid access to the other's address", () => {
  const listeners = parseListeners(
    ssOutput([
      { port: 45891, uid: 21000, address: "127.0.0.1" },
      { port: 45891, uid: 21001, address: "127.0.0.2" },
      { port: 50001, uid: 21001, address: "127.0.0.1" },
    ]),
    new Set([21000, 21001]),
  );
  expect(listeners).toContainEqual({ port: 45891, uid: 21000 });
  expect(listeners).toContainEqual({ port: 45891, uid: 21001 });
  const text = renderRuleset(listeners, "reject with tcp reset", RANGE);
  expect(text).not.toContain("45891 . 21000");
  expect(text).not.toContain("45891 . 21001");
  expect(text).toContain("50001 . 21001");
  expect(text).toMatch(/guarded \{[^}]*elements = \{ 45891, 50001 \}/s);

  // The decision is also fail-closed across IPv4/IPv6 and wildcard listener rows.
  for (const address of ["[::1]", "0.0.0.0", "[::]"]) {
    const mixed = parseListeners(
      ssOutput([
        { port: 45891, uid: 21000, address: "127.0.0.1" },
        { port: 45891, uid: 21001, address },
      ]),
      new Set([21000, 21001]),
    );
    const rules = renderRuleset(mixed, "reject with tcp reset", RANGE);
    expect(rules).not.toContain("45891 . 21000");
    expect(rules).not.toContain("45891 . 21001");
    expect(rules).toMatch(/guarded \{[^}]*elements = \{ 45891 \}/s);
  }
});

// ── reconcile ────────────────────────────────────────────────────────────────

/** A fake root toolbox: records calls and lets a test read back the applied ruleset. */
function fakeNft(opts: { hasNft?: boolean; listeners?: string; failReject?: boolean; ssFails?: boolean } = {}) {
  const calls: string[] = [];
  let appliedFile = "";
  const run: RunCommand = (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "nft" && args[0] === "--version") return { code: opts.hasNft === false ? 127 : 0, output: "" };
    if (file === "ss")
      return opts.ssFails ? { code: 127, output: "spawnSync ss ENOENT" } : { code: 0, output: opts.listeners ?? "" };
    if (file === "modprobe") return { code: 0, output: "" };
    if (file === "nft") {
      const f = args.at(-1) ?? "";
      const text = f ? readFileSync(f, "utf8") : "";
      // The kernel without nft_reject_inet refuses a reject rule (both -c and -f).
      if (opts.failReject && text.includes("reject with tcp reset")) return { code: 1, output: "reject not supported" };
      if (args[0] === "-f") appliedFile = text;
      return { code: 0, output: "" };
    }
    return { code: 0, output: "" };
  };
  return { run, calls, applied: () => appliedFile };
}

function guard(run: RunCommand, agentUids: number[]) {
  const home = tempDir("loopback-guard-");
  dirs.push(home);
  const logs: string[] = [];
  return {
    g: new LoopbackGuard({
      home,
      agentUids: () => agentUids,
      uidRange: RANGE,
      run,
      log: (l) => logs.push(l),
      systemd: true,
      ephemeralRange: "32768 60999",
    }),
    logs,
  };
}

test("reconcile guards the agent's port after reading its uid from ss, and leaves others alone", () => {
  const nft = fakeNft({
    listeners: ssOutput([
      { port: 45891, uid: 21000 },
      { port: 22, uid: 0 },
    ]),
  });
  const { g } = guard(nft.run, [21000]);
  g.start();
  expect(nft.calls).toContain("modprobe nft_reject_inet");
  expect(nft.calls.some((c) => c.startsWith("nft -c -f"))).toBe(true);
  const applied = nft.applied();
  expect(applied).toContain("45891 . 21000");
  expect(applied).toContain("elements = { 45891 }");
  // The port 22 (root) listener is not an agent's and is never guarded.
  expect(applied).not.toContain(" 22 ");
  g.stop();
});

test("reconcile removes an owner exception when another uid binds the same port", () => {
  const opts = { listeners: ssOutput([{ port: 45891, uid: 21000, address: "127.0.0.1" }]) };
  const nft = fakeNft(opts);
  const { g } = guard(nft.run, [21000, 21001]);
  g.start();
  expect(nft.applied()).toContain("45891 . 21000");

  opts.listeners = ssOutput([
    { port: 45891, uid: 21000, address: "127.0.0.1" },
    { port: 45891, uid: 21001, address: "127.0.0.2" },
  ]);
  g.reconcile();
  expect(nft.applied()).not.toContain("45891 . 21000");
  expect(nft.applied()).not.toContain("45891 . 21001");
  expect(nft.applied()).toMatch(/guarded \{[^}]*elements = \{ 45891 \}/s);
  g.stop();
});

test("reconcile reapplies only when the listener set changed", () => {
  const nft = fakeNft({ listeners: ssOutput([{ port: 45891, uid: 21000 }]) });
  const { g } = guard(nft.run, [21000]);
  g.start();
  const applies = () => nft.calls.filter((c) => c.startsWith("nft -f")).length;
  const first = applies();
  expect(first).toBe(1);
  g.reconcile(); // same ss output → no new apply
  expect(applies()).toBe(first);
});

test("a listing that fails keeps the rules applied, with one warning, instead of unguarding every port", () => {
  const opts = { listeners: ssOutput([{ port: 45891, uid: 21000 }]), ssFails: false };
  const nft = fakeNft(opts);
  const { g, logs } = guard(nft.run, [21000]);
  g.start();
  const applies = () => nft.calls.filter((c) => c.startsWith("nft -f")).length;
  expect(applies()).toBe(1);
  opts.ssFails = true;
  g.reconcile();
  g.reconcile();
  expect(applies()).toBe(1);
  expect(nft.applied()).toContain("45891 . 21000");
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("keeps its last rules");
  // Back: a changed listing applies again.
  opts.ssFails = false;
  opts.listeners = ssOutput([{ port: 45900, uid: 21000 }]);
  g.reconcile();
  expect(applies()).toBe(2);
  expect(nft.applied()).toContain("45900 . 21000");
  g.stop();
});

test("falls back to drop when the kernel refuses the reject rule", () => {
  const nft = fakeNft({ listeners: ssOutput([{ port: 45891, uid: 21000 }]), failReject: true });
  const { g } = guard(nft.run, [21000]);
  g.start();
  expect(nft.applied()).toContain('oif "lo" tcp dport @guarded drop');
  expect(nft.applied()).not.toContain("reject");
  g.stop();
});

test("without nft system mode refuses before a worker starts", () => {
  const nft = fakeNft({ hasNft: false });
  const { g, logs } = guard(nft.run, [21000]);
  expect(() => g.start()).toThrow("requires nft");
  expect(logs).toHaveLength(0);
  expect(nft.calls.some((c) => c.startsWith("nft -f"))).toBe(false);
  g.stop();
});

test("two host organization blocks get distinct permanent browser pairs", () => {
  expect(browserPortsForUid(20000)).toEqual({ cdp: 10000, stream: 10001 });
  expect(browserPortsForUid(20100)).toEqual({ cdp: 10200, stream: 10201 });
  const text = renderRuleset([], "drop", [20000, 20100]);
  expect(text).toContain("10000 . 20000");
  expect(text).toContain("10200 . 20100");
  expect(() => validateBrowserUidRange([20000, 30000])).toThrow("one 10,000-uid block");
});

test("a pre-existing wrong-owner browser listener blocks startup with its owner exception removed", () => {
  const nft = fakeNft({ listeners: ssOutput([{ port: 12000, uid: 21001 }]) });
  const { g } = guard(nft.run, [21000, 21001]);
  expect(conflictingBrowserPorts(ssOutput([{ port: 12000, uid: 21001 }]), RANGE)).toEqual([12000]);
  expect(() => g.start()).toThrow("Reserved browser ports have the wrong owner: 12000");
  expect(nft.applied()).not.toContain("12000 . 21000");
  expect(nft.applied()).toContain("12001 . 21000");
  g.stop();
});

test("correct browser owner is accepted and a later collision removes its exception", () => {
  const opts = { listeners: ssOutput([{ port: 12000, uid: 21000 }]) };
  const nft = fakeNft(opts);
  const { g } = guard(nft.run, [21000, 21001]);
  g.start();
  expect(nft.applied()).toContain("12000 . 21000");
  opts.listeners = ssOutput([{ port: 12000, uid: 21001 }]);
  g.reconcile();
  expect(nft.applied()).not.toContain("12000 . 21000");
  g.stop();
});

test("an overlapping ephemeral range refuses system mode because bind(0) can select a browser port", () => {
  expect(() => checkEphemeralRange("10000 60999")).toThrow("overlaps reserved browser ports");
  expect(() => checkEphemeralRange("32768 60999")).not.toThrow();
});

test("old UIDs in another bucket or duplicate UIDs refuse startup before nft applies", () => {
  for (const uids of [
    [21000, 31000],
    [21000, 21000],
  ]) {
    const nft = fakeNft();
    const { g } = guard(nft.run, uids);
    expect(() => g.start()).toThrow("Persisted agent UIDs overlap or fall outside");
    expect(nft.calls.some((call) => call.startsWith("nft -f"))).toBe(false);
  }
});

test("a configured routing bit exempts only unchanged foreign destinations, keeping host addresses guarded", () => {
  const plain = renderRuleset([A], "drop", RANGE);
  expect(plain).not.toContain("meta mark &");
  const marked = renderRuleset([A], "drop", RANGE, new Set(), 0x08000000);
  const rule = "meta mark & 0x08000000 == 0x08000000 ct status != dnat fib daddr type != local return";
  expect(marked).toContain(rule);
  expect(marked.indexOf(rule)).toBeLessThan(marked.indexOf('oif "lo" meta skuid 0'));
  expect(marked).not.toContain("fib daddr . mark");
  expect(marked).toContain('oif "lo" tcp dport @browser_ports drop');
  expect(marked).toContain('oif "lo" tcp dport @guarded drop');
  expect(() => renderRuleset([], "drop", RANGE, new Set(), 0)).toThrow("networkMark");
});

test("network mark reconciliation updates atomically and retains the previous setting on failure", () => {
  const options = { ssFails: false };
  const nft = fakeNft(options);
  const { g } = guard(nft.run, [21000]);
  expect(g.reconcile()).toBe(true);
  expect(g.setNetworkMark(0x08000000)).toBe(true);
  const applied = nft.applied();
  expect(applied).toContain("agentes network mark 134217728");
  options.ssFails = true;
  expect(g.setNetworkMark(0x10000000)).toBe(false);
  expect(nft.applied()).toBe(applied);
  options.ssFails = false;
  expect(g.reconcile()).toBe(true);
  expect(nft.applied()).toBe(applied);
});
