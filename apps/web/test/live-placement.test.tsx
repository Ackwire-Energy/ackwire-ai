import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ActiveRun, ApiClient } from "@agenteschat/client";
import {
  ApiError,
  applyChannelEvent,
  emptyStreams,
  isQuiet,
  QUIET_AFTER_MS,
  reconcileRuns,
  steerStore,
} from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { blockRowByRun, elapsedParts, nextSlots, runPhase, SLOT_HOLD_MS, sameSlots } from "@/chat/run-slots";
import { createStreamsStore, reconcileChannelRuns } from "@/realtime/context";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  setSystemTime();
  steerStore.reset();
  cleanup();
});

const opts = (over: Partial<{ landed: string[]; expected: string[]; now: number }> = {}) => ({
  landed: (id: string) => (over.landed ?? []).includes(id),
  expected: (id: string) => (over.expected ?? []).includes(id),
  now: over.now ?? 1_000,
});

describe("one block per answer (run-slots)", () => {
  test("a 'pensando…' hands its block to the real run, then to its final message (same key)", () => {
    let slots = nextSlots([], [{ runId: "pending:ada:m1", agentId: "ada", provisional: true }], opts());
    expect(slots.map((s) => s.key)).toEqual(["run:pending:ada:m1"]);
    // The server's run replaces the guess: same block.
    slots = nextSlots(slots, [{ runId: "r1", agentId: "ada" }], opts());
    expect(slots).toEqual([
      { key: "run:pending:ada:m1", runId: "r1", agentId: "ada", provisional: false, goneAt: null },
    ]);
    // The run ended and its message is on its way: the block holds…
    slots = nextSlots(slots, [], opts({ expected: ["r1"], now: 2_000 }));
    expect(slots[0]?.goneAt).toBe(2_000);
    // …until the message is in the timeline, which takes its place.
    expect(nextSlots(slots, [], opts({ landed: ["r1"], now: 2_100 }))).toEqual([]);
  });

  test("new blocks go last, in order; one that ends with nothing to show goes at once; the hold has a limit", () => {
    let slots = nextSlots([], [{ runId: "a", agentId: "ada" }], opts());
    slots = nextSlots(
      slots,
      [
        { runId: "a", agentId: "ada" },
        { runId: "b", agentId: "theo" },
      ],
      opts(),
    );
    expect(slots.map((s) => s.runId)).toEqual(["a", "b"]);
    expect(nextSlots(slots, [{ runId: "b", agentId: "theo" }], opts()).map((s) => s.runId)).toEqual(["b"]);
    const held = nextSlots(slots, [], opts({ expected: ["a", "b"], now: 1_000 }));
    expect(nextSlots(held, [], opts({ expected: ["a", "b"], now: 1_000 + SLOT_HOLD_MS }))).toEqual([]);
    const again = nextSlots(
      slots,
      [
        { runId: "a", agentId: "ada" },
        { runId: "b", agentId: "theo" },
      ],
      opts(),
    );
    expect(sameSlots(slots, again)).toBe(true);
  });

  test("a run resumed after an approval or a question gets its block back (its card already landed)", () => {
    let slots = nextSlots([], [{ runId: "r1", agentId: "ada" }], opts());
    // The approval card landed and the run left the live store: the card takes the block's place.
    slots = nextSlots(slots, [], opts({ landed: ["r1"] }));
    expect(slots).toEqual([]);
    // Approved: the same run works again, its card still in the timeline.
    slots = nextSlots(slots, [{ runId: "r1", agentId: "ada" }], opts({ landed: ["r1"] }));
    expect(slots.map((s) => s.runId)).toEqual(["r1"]);
    // Still live on the next pass, even with a message of it in the timeline.
    expect(nextSlots(slots, [{ runId: "r1", agentId: "ada" }], opts({ landed: ["r1"] }))).toEqual(slots);
    // Done: its final message lands and takes the block's place.
    expect(nextSlots(slots, [], opts({ landed: ["r1"] }))).toEqual([]);
  });

  test("a run with many messages: only its last one takes the block's key, none while it is live", () => {
    const row = (key: string, agentRunId: string | null) => ({ kind: "message", key, message: { agentRunId } });
    const items = [row("m1", "r1"), { kind: "day", key: "d" }, row("m2", null), row("m3", "r1"), row("m4", "r2")];
    expect(blockRowByRun(items, new Set())).toEqual(
      new Map([
        ["r1", "m3"],
        ["r2", "m4"],
      ]),
    );
    expect(blockRowByRun(items, new Set(["r1"]))).toEqual(new Map([["r2", "m4"]]));
  });

  test("the header word and the elapsed time", () => {
    const base = { text: "", status: "running" as const, work: [], tool: null };
    expect(runPhase(base)).toBe("thinking");
    expect(runPhase({ ...base, tool: "github_list_prs" })).toBe("working");
    expect(runPhase({ ...base, text: "Olá" })).toBe("writing");
    expect(elapsedParts(1_500)).toBeNull();
    expect(elapsedParts(4_200)).toEqual({ m: 0, s: 4 });
    expect(elapsedParts(75_000)).toEqual({ m: 1, s: 15 });
  });
});

describe("stale runs: reconcile with the server", () => {
  const ev = (runId: string, at: number) =>
    applyChannelEvent(
      emptyStreams,
      { type: "agent.delta", channelId: "c", threadId: "t", agentId: "ada", runId, seq: 0, text: "oi" },
      at,
    );

  test("isQuiet after 3 min without events", () => {
    const run = ev("r", 1_000).runs.r;
    if (!run) throw new Error("no run");
    expect(isQuiet(run, 1_000 + QUIET_AFTER_MS - 1)).toBe(false);
    expect(isQuiet(run, 1_000 + QUIET_AFTER_MS)).toBe(true);
    expect(isQuiet({ ...run, status: "failed" }, 1_000 + QUIET_AFTER_MS)).toBe(false);
  });

  test("rows the server doesn't run go; unknown active runs appear; news after the request stays", () => {
    let s = ev("old", 1_000);
    s = applyChannelEvent(
      s,
      { type: "agent.delta", channelId: "c", threadId: "t", agentId: "bob", runId: "fresh", seq: 0, text: "x" },
      9_000,
    );
    const active: ActiveRun[] = [
      { runId: "new", agentId: "theo", channelId: "c", threadId: "t", status: "running", startedAt: null },
    ];
    s = reconcileRuns(s, "c", active, 10_000, 5_000);
    expect(Object.keys(s.runs).sort()).toEqual(["fresh", "new"]);
    expect(s.finished.old).toBe(true);
    expect(s.runs.new?.status).toBe("thinking");
  });

  test("without the endpoint: each live run's detail decides (404 or finished = gone)", async () => {
    const store = createStreamsStore();
    for (const runId of ["done", "gone", "busy"])
      store.apply({ type: "agent.delta", channelId: "c", threadId: "t", agentId: "ada", runId, seq: 0, text: "…" });
    const api = {
      agents: {
        activeRuns: async () => null,
        run: async (_o: string, runId: string) => {
          if (runId === "gone") throw new ApiError(404, "not_found", "nope");
          return { run: { id: runId, status: runId === "busy" ? "running" : "done" }, steps: [] };
        },
      },
    } as unknown as ApiClient;
    expect(await reconcileChannelRuns(api, store, "o", "c")).toBe(true);
    expect(Object.keys(store.get().streams.runs)).toEqual(["busy"]);
  });
});

describe("live row in the timeline", () => {
  const ids = { threadId: "m-1", runId: "r-live", agentId: ADA_ID };
  const open = async (configure?: (state: ReturnType<typeof seedState>) => void) => {
    const state = seedState();
    configure?.(state);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    const ev = (event: Record<string, unknown>) =>
      act(async () =>
        r.sockets.last().push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }),
      );
    return { state, ev, sockets: r.sockets };
  };
  const row = () => document.querySelector('[data-run-id="r-live"]') as HTMLElement;
  const post = (ev: (e: Record<string, unknown>) => Promise<void>, id: string, body: string) =>
    ev({
      type: "message.created",
      messageId: id,
      message: {
        id,
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-walter" },
        body,
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date(Date.now() + 10_000).toISOString(),
      },
    });

  test("one block from the start: it stays last while it works; a later message goes above it", async () => {
    const { ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    // Before any word: the block is there, "pensando".
    expect(row().textContent).toContain("pensando");
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "Olhando o login." });
    await settle(2);
    expect(row().classList.contains("ac-msg--grouped")).toBe(false);
    expect(row().textContent).toContain("Ada");
    expect(row().textContent).toContain("escrevendo");
    await post(ev, "m-later", "Também confere o refresh");
    await settle(3);
    const later = screen().getByText("Também confere o refresh").closest(".ac-msg") as HTMLElement;
    expect(later.compareDocumentPosition(row()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("steering: 'lê na próxima pausa' → 'leu', 'Leu seu recado' in the block; 'Ver' leads back", async () => {
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
    const before = proto.scrollIntoView;
    const scrolled: string[] = [];
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute("data-run-id") ?? "");
    };
    try {
      const { ev } = await open();
      await ev({ type: "agent.run", ...ids, status: "running" });
      await ev({ type: "agent.delta", ...ids, seq: 0, text: "Olhando o login." });
      await settle(2);
      await post(ev, "m-steer", "Olha também o refresh");
      await ev({ type: "agent.run.steered", ...ids, messageId: "m-steer" });
      await settle(4);
      // By id: once read, the text is also quoted in the agent's block.
      const mine = () => document.querySelector('[data-message-id="m-steer"]') as HTMLElement;
      expect(mine().textContent).toContain("Ada lê na próxima pausa");
      await ev({ type: "agent.run.read", ...ids, messageIds: ["m-steer"] });
      await settle(4);
      expect(mine().textContent).toContain("Ada leu");
      expect(row().querySelector(".live-work__steer")?.textContent).toContain("Leu seu recado");
      expect(row().querySelector(".live-work__steer")?.textContent).toContain("Olha também o refresh");
      // Out of view (no layout here), the line above the composer leads back to the block.
      await act(async () => fireEvent.click(screen().getByRole("button", { name: "Ver" })));
      expect(scrolled).toContain("r-live");
    } finally {
      proto.scrollIntoView = before;
    }
  });

  test("no news for 3 min: 'Atualizar' asks the server and drops a run that no longer exists", async () => {
    const { ev, state } = await open();
    setSystemTime(new Date(Date.now() - 4 * 60_000));
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "Rodando os testes." });
    setSystemTime();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle(2);
    expect(row().textContent).toContain("sem notícias há 4 min");
    await act(async () => fireEvent.click(within(row()).getByRole("button", { name: "Atualizar" })));
    await settle(4);
    expect(state.calls.some((c) => c.method === "agents.activeRuns")).toBe(true);
    expect(row()).toBeNull();
  });

  test("after a reconnect, live rows the server no longer runs go away", async () => {
    const { ev, sockets } = await open((s) => {
      s.activeRuns = { [ENG_ID]: [] };
    });
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "Quase lá." });
    await settle(2);
    expect(row()).not.toBeNull();
    await act(async () => sockets.last().drop());
    await act(() => new Promise((r) => setTimeout(r, 650)));
    await act(async () => sockets.last().open());
    await settle(4);
    expect(row()).toBeNull();
  });
});
