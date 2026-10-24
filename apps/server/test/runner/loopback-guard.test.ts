import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
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

/** `ss -Htln -e` lines as the kernel prints them: no `uid:` for root, `uid:<n>` otherwise. */
function ssOutput(rows: { port: number; uid?: number; state?: string }[]): string {
  return rows
    .map((r) => {
      const uid = r.uid === undefined ? "" : ` uid:${r.uid}`;
      return `${r.state ?? "LISTEN"} 0      0       127.0.0.1:${r.port} 0.0.0.0:*${uid} ino:7953 sk:0`;
    })
    .join("\n");
}

// ── render ───────────────────────────────────────────────────────────────

test("renders the table, both sets and the owner/root/reject chain for two agents", () => {
  const text = renderRuleset([A, A2, B], "reject with tcp reset");
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
  // The three rules, in order: owner pair, then root, then reject.
  const owner = text.indexOf('oif "lo" tcp dport . meta skuid @owner accept');
  const root = text.indexOf('oif "lo" meta skuid 0 accept');
  const reject = text.indexOf('oif "lo" tcp dport @guarded reject with tcp reset');
  expect(owner).toBeGreaterThan(0);
  expect(root).toBeGreaterThan(owner);
  expect(reject).toBeGreaterThan(root);
});

test("with no agent listeners the sets are empty and nothing is rejected but the table still loads", () => {
  const text = renderRuleset([], "reject with tcp reset");
  expect(text).toContain("set owner");
  expect(text).toContain("set guarded");
  expect(text).not.toContain("elements =");
  expect(text).toContain("@guarded reject with tcp reset");
});

test("the drop fallback renders drop instead of reject", () => {
  expect(renderRuleset([A], "drop")).toContain('oif "lo" tcp dport @guarded drop');
  expect(renderRuleset([A], "drop")).not.toContain("reject");
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
  return { g: new LoopbackGuard({ home, agentUids: () => agentUids, run, log: (l) => logs.push(l) }), logs };
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

test("without nft it warns once and does not crash or apply", () => {
  const nft = fakeNft({ hasNft: false });
  const { g, logs } = guard(nft.run, [21000]);
  g.start();
  g.reconcile();
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain("not isolated");
  expect(nft.calls.some((c) => c.startsWith("nft -f"))).toBe(false);
  g.stop();
});
