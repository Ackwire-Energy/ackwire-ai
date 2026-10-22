import { expect, test } from "bun:test";
import type { ControlEvent, ControlStatus } from "@agenteschat/adapters/runner-control";
import { DesktopStore } from "../src/control/store";
import { answerThisMac } from "../src/control/this-mac";
import type { Host } from "../src/host/types";

/** The site in the main window asking this Mac (D79): status, connect, Preferences. */

const paired = (orgId: string, connection: ControlStatus["connection"] = "online"): ControlStatus => ({
  paired: true,
  org: { id: orgId, name: "Acme" },
  machine: { id: `m-${orgId}`, name: "MacBook" },
  connection,
  version: "0.1.0",
  protocol: 10,
  paused: { paused: false, until: null },
  executors: {},
  agents: [],
});
const unpaired: ControlStatus = {
  ...paired("x"),
  paired: false,
  org: undefined,
  machine: undefined,
  connection: "unpaired",
};

/** Runners answering from `statuses` (by home); `sent` records every request. */
function setup(statuses: Record<string, ControlStatus>) {
  const sent: { homeId: string; type: string }[] = [];
  let onLine: (homeId: string, line: string) => void = () => {};
  let added = 0;
  const host = {
    window: "popover",
    fake: true,
    listRunners: async () =>
      Object.keys(statuses).map((homeId) => ({ homeId, dir: `/tmp/${homeId}`, running: true, hello: null })),
    onLine: (cb: typeof onLine) => {
      onLine = cb;
      return () => {};
    },
    onRunnerState: () => () => {},
    addRunner: async () => {
      const homeId = `new${++added}`;
      statuses[homeId] = unpaired;
      return homeId;
    },
    send: async (homeId: string, line: string) => {
      const req = JSON.parse(line) as { id: string; type: string };
      sent.push({ homeId, type: req.type });
      let data: unknown = {};
      if (req.type === "status") data = statuses[homeId];
      if (req.type === "jobs") data = { jobs: [] };
      if (req.type === "access.pending") data = { requests: [] };
      if (req.type === "access.get") data = { folders: [], tools: { claude: true, codex: false, commands: false } };
      if (req.type === "org.logo") data = { logo: null };
      if (req.type === "pair.start") data = { started: true };
      queueMicrotask(() => onLine(homeId, JSON.stringify({ type: "reply", id: req.id, ok: true, data })));
    },
  } as unknown as Host;
  const store = new DesktopStore(host, { idPrefix: "t" });
  const event = (homeId: string, e: ControlEvent) => onLine(homeId, JSON.stringify({ type: "event", event: e }));
  const prefs: string[] = [];
  const deps = {
    store,
    openPrefs: async (tab: "folders" | "tools" | "updates") => void prefs.push(tab),
    showRequests: async () => void prefs.push("requests"),
    codeTimeoutMs: 500,
  };
  return { store, sent, event, deps, prefs };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test("status: the organizations this Mac is connected to, with its machine there", async () => {
  const { store, deps } = setup({ h1: paired("o1"), h2: unpaired });
  store.start();
  await settle();
  expect(await answerThisMac(deps, { kind: "status" })).toEqual({
    orgs: [{ orgId: "o1", machineId: "m-o1", connection: "online" }],
  });
});

test("connect: already connected asks nothing; a new organization gets the runner's code", async () => {
  const { store, sent, event, deps } = setup({ h1: paired("o1") });
  store.start();
  await settle();
  expect(await answerThisMac(deps, { kind: "connect", orgId: "o1" })).toEqual({ userCode: null });
  expect(sent.some((s) => s.type === "pair.start")).toBe(false);

  const answer = answerThisMac(deps, { kind: "connect", orgId: "o2" });
  await settle();
  expect(sent.filter((s) => s.type === "pair.start")).toEqual([{ homeId: "new1", type: "pair.start" }]);
  event("new1", {
    kind: "pair.code",
    userCode: "ABCD-EFGH",
    verificationUrl: "https://agentes.chat/conectar",
    expiresAt: "2026-10-21T20:00:00Z",
  });
  expect(await answer).toEqual({ userCode: "ABCD-EFGH" });

  // Confirmed on the site: the new organization gets the tools the other one has.
  event("new1", { kind: "pair.done", org: { id: "o2", name: "Beta" }, machine: { id: "m2", name: "MacBook" } });
  await settle();
  await settle();
  expect(sent.filter((s) => s.homeId === "new1" && s.type === "tools.set")).toHaveLength(3);
});

test("connect: a refused organization comes back on its own home; a failure rejects", async () => {
  const { store, sent, event, deps } = setup({ h1: paired("o1", "refused") });
  store.start();
  await settle();
  const answer = answerThisMac(deps, { kind: "connect", orgId: "o1" });
  await settle();
  expect(sent.filter((s) => s.type === "pair.start")).toEqual([{ homeId: "h1", type: "pair.start" }]);
  event("h1", { kind: "pair.failed", code: "network", message: "offline" });
  await expect(answer).rejects.toThrow("network");
});

test("prefs and requests: Preferences on the asked tab, the popover", async () => {
  const { deps, prefs } = setup({});
  expect(await answerThisMac(deps, { kind: "prefs", tab: "updates" })).toEqual({});
  expect(await answerThisMac(deps, { kind: "requests" })).toEqual({});
  expect(prefs).toEqual(["updates", "requests"]);
});

test("reconnect: the organization's own runner; not connected there rejects", async () => {
  const { store, sent, deps } = setup({ h1: paired("o1", "offline") });
  store.start();
  await settle();
  expect(await answerThisMac(deps, { kind: "reconnect", orgId: "o1" })).toEqual({});
  expect(sent.filter((s) => s.type === "reconnect")).toEqual([{ homeId: "h1", type: "reconnect" }]);
  await expect(answerThisMac(deps, { kind: "reconnect", orgId: "o2" })).rejects.toThrow("not_connected");
});
