import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ActiveRun, ApiClient, LiveRun } from "@agenteschat/client";
import {
  ApiError,
  applyChannelEvent,
  emptyStreams,
  isQuiet,
  QUIET_AFTER_MS,
  reconcileRuns,
  steerStore,
} from "@agenteschat/client";
import { elapsedParts } from "@agenteschat/client/lib/activity";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { blockRowByRun, nextSlots, openerOf, rowShows, SLOT_HOLD_MS, sameSlots, waitingLast } from "@/chat/run-slots";
import { createStreamsStore, reconcileChannelRuns } from "@/realtime/context";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
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

  test("every block draws, the ones waiting for words last (each group in its order)", () => {
    const slots = ["a", "b", "c", "d"].map((runId) => ({ runId }));
    const waiting = new Set(["a", "c"]);
    expect(waitingLast(slots, (id) => waiting.has(id)).map((s) => s.runId)).toEqual(["b", "d", "a", "c"]);
    expect(waitingLast(slots, () => false)).toEqual(slots);
  });

  test("no thinking row: its block shows once it has words, a browser card or a quiet notice (the bar says the rest)", () => {
    const fresh = {
      runId: "a",
      agentId: "ada",
      channelId: "c",
      threadId: null,
      status: "running" as const,
      text: "",
      work: [],
      startedAt: 10_000,
      lastEventAt: 10_000,
    } as unknown as LiveRun;
    expect(rowShows(fresh, 10_500)).toBe(false);
    expect(rowShows(fresh, 60_000)).toBe(false);
    const call = {
      kind: "call" as const,
      id: "t1",
      tool: "read_file",
      connector: null,
      detail: null,
      code: null,
      output: [],
      running: true,
    };
    expect(rowShows({ ...fresh, work: [call] }, 60_000)).toBe(false);
    expect(rowShows({ ...fresh, text: "Oi" }, 10_500)).toBe(true);
    expect(rowShows({ ...fresh, work: [{ kind: "say", text: "Vou ler.", turn: 1 }] } as LiveRun, 10_500)).toBe(true);
    expect(rowShows({ ...fresh, work: [{ ...call, tool: "browser_navigate" }] }, 10_500)).toBe(true);
    expect(rowShows(fresh, 10_000 + QUIET_AFTER_MS)).toBe(true);
  });

  test("it opens with the first thing it said (no placeholder before); the elapsed time", () => {
    const base = { work: [] };
    expect(openerOf(base)).toEqual({ said: null, work: [] });
    const said = openerOf({
      ...base,
      work: [
        { kind: "say" as const, text: "Vou ler o código.", turn: 1 },
        { kind: "say" as const, text: "Uso as ferramentas.", turn: 2 },
      ],
    });
    expect(said.said).toBe("Vou ler o código.");
    expect(said.work).toEqual([{ kind: "say", text: "Uso as ferramentas.", turn: 2 }]);
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
    expect(s.finished.old).toBeTruthy();
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
  const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };
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

  const bar = () => document.querySelector(".ac-typing") as HTMLElement;
  const shownText = (el: Element) => [...el.querySelectorAll(".ac-turn__in")].map((e) => e.textContent).join("|");

  test("no thinking row: the bar alone says its face, step, time and stop; words bring its row, last while it works", async () => {
    const { ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    expect(row()).toBeNull();
    expect(bar().querySelector(".ac-typing__avatars")).not.toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    // Still no row, no pixels, no step line in the conversation: only the bar.
    expect(row()).toBeNull();
    expect(document.querySelector(".ac-msg--waiting, .ac-wait")).toBeNull();
    expect(bar().querySelector(".ac-typing__text")?.textContent).toBe("Ada pensando…");
    expect(within(bar()).getByRole("button", { name: "Parar" })).toBeTruthy();
    // The step follows the run there.
    await ev({
      type: "agent.tool",
      ...ids,
      tool: "read_file",
      toolUseId: "t1",
      detail: "apps/api/auth/refresh.ts",
    });
    await settle(2);
    expect(row()).toBeNull();
    expect(bar().querySelector(".ac-typing__text")?.textContent).toBe("Ada mexendo nos arquivos do PC · refresh.ts…");
    await ev({ type: "agent.tool", ...ids, tool: null, toolUseId: "t1" });
    await settle(2);
    expect(bar().querySelector(".ac-typing__text")?.textContent).toBe("Ada pensando…");
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "O login devolve 401 depois do refresh." });
    await settle(3);
    // Its words: the row, with its name, the time it started, its time and its stop in the header.
    expect(row().classList.contains("ac-msg--waiting")).toBe(false);
    expect(row().querySelector(".ac-msg__head")?.textContent).toContain("Ada");
    expect(row().querySelector(".ac-msg__head time")).not.toBeNull();
    const tail = row().querySelector(".ac-msg__head .ac-msg__status .run-tail") as HTMLElement;
    expect(tail.querySelector(".run-tail__clock")).not.toBeNull();
    expect(within(tail).getByRole("button", { name: "Parar" })).toBeTruthy();
    expect(row().textContent).toContain("O login devolve 401");
    await post(ev, "m-later", "Também confere o refresh");
    await settle(3);
    const later = screen().getByText("Também confere o refresh").closest(".ac-msg") as HTMLElement;
    expect(later.compareDocumentPosition(row()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("a reply keeps the place its first words showed in: what is sent meanwhile goes below it, then its message takes it", async () => {
    const { ev } = await open();
    const said = (id: string, body: string, createdAt: string, agentRunId: string | null = null) =>
      ev({
        type: "message.created",
        messageId: id,
        message: {
          id,
          channelId: ENG_ID,
          threadId: null,
          author: agentRunId ? { type: "agent", id: ADA_ID } : { type: "person", id: "u-joao" },
          body,
          mentionedAgentIds: [],
          agentRunId,
          createdAt,
        },
      });
    const now = Date.now();
    await said("m-ask", "Por que o login cai?", new Date(now - 2_000).toISOString());
    const shownAt = new Date(now - 1_000).toISOString();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, turn: 1, at: 0, text: "O login cai depois do refresh.", shownAt });
    await settle(3);
    await said("m-meanwhile", "Também confere o refresh", new Date(now + 10_000).toISOString());
    await settle(3);
    const meanwhile = () => document.querySelector('[data-message-id="m-meanwhile"]') as HTMLElement;
    // The block stays where its words first showed; the message sent meanwhile is below it, with its own header.
    expect(row().compareDocumentPosition(meanwhile()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(meanwhile().classList.contains("ac-msg--grouped")).toBe(false);
    expect(meanwhile().querySelector(".ac-msg__head")?.textContent).toContain("João");
    // Its message, another text than the draft, is posted at that moment: it takes the block's place, still above.
    await said("m-reply", "A chave do cache mudou no deploy de ontem.", shownAt, "r-live");
    await ev({ type: "agent.run", ...ids, status: "done" });
    await settle(4);
    const reply = document.querySelector('[data-message-id="m-reply"]') as HTMLElement;
    expect(reply.textContent).toContain("A chave do cache mudou");
    expect(document.body.textContent).not.toContain("O login cai depois do refresh.");
    expect(reply.compareDocumentPosition(meanwhile()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("a reply that lands above the last message marks the conversation read, as one at the end does", async () => {
    // Only messages with the server's ids here: they sort in the order it posted them (UUIDv7).
    const { ev, state } = await open((s) => {
      s.messages = s.messages.filter((m) => m.channelId !== ENG_ID);
    });
    const id = (n: number) => `0198f000-0000-7000-8000-${String(n).padStart(12, "0")}`;
    const said = (n: number, createdAt: string, agentRunId: string | null = null) =>
      ev({
        type: "message.created",
        messageId: id(n),
        message: {
          id: id(n),
          channelId: ENG_ID,
          threadId: null,
          author: agentRunId ? { type: "agent", id: ADA_ID } : { type: "person", id: "u-joao" },
          body: `mensagem ${n}`,
          mentionedAgentIds: [],
          agentRunId,
          createdAt,
        },
      });
    const reads = () => state.calls.filter((c) => c.method === "dms.markRead" && c.args[1] === ENG_ID).length;
    const now = Date.now();
    await said(1, new Date(now - 2_000).toISOString());
    const shownAt = new Date(now - 1_000).toISOString();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, turn: 1, at: 0, text: "O login cai depois do refresh.", shownAt });
    await said(2, new Date(now + 10_000).toISOString());
    await settle(3);
    const before = reads();
    await said(3, shownAt, "r-live");
    await ev({ type: "agent.run", ...ids, status: "done" });
    await settle(4);
    const reply = document.querySelector(`[data-message-id="${id(3)}"]`) as HTMLElement;
    const meanwhile = document.querySelector(`[data-message-id="${id(2)}"]`) as HTMLElement;
    expect(reply.compareDocumentPosition(meanwhile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reads()).toBeGreaterThan(before);
  });

  test("under the agent's own message its row starts with its face once its words arrive (no grouping, no jump)", async () => {
    const { ev } = await open();
    await ev({
      type: "message.created",
      messageId: "m-ada",
      message: {
        id: "m-ada",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "Feito, o deploy subiu.",
        mentionedAgentIds: [],
        agentRunId: "r-old",
        createdAt: new Date().toISOString(),
      },
    });
    await settle(2);
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "Também revisei o rollback." });
    await settle(3);
    expect(row().classList.contains("ac-msg--grouped")).toBe(false);
    expect(row().querySelector(".ac-msg__avatar .ac-avatar")).not.toBeNull();
    expect(row().querySelector(".ac-msg__head")?.textContent).toContain("Ada");
  });

  test("a call that waits for approval draws no thinking row (its request says it)", async () => {
    const { ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.tool", ...ids, tool: "github_merge_pull_request", toolUseId: "t1" });
    await ev({ type: "agent.tool", ...ids, tool: null, toolUseId: "t1", held: true });
    await ev({ type: "agent.run", ...ids, status: "waiting_approval" });
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    expect(row()).toBeNull();
  });

  test("two agents: no rows while they think, the bar says both; the one that answers gets its row", async () => {
    const { ev } = await open();
    const atlas = { threadId: null, runId: "r-atlas", agentId: ATLAS_ID };
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.run", ...atlas, status: "running" });
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    const atlasRow = () => document.querySelector('[data-run-id="r-atlas"]') as HTMLElement;
    expect(row()).toBeNull();
    expect(atlasRow()).toBeNull();
    expect(shownText(bar())).toBe("Ada e Atlas estão trabalhando…");
    await ev({ type: "agent.delta", ...atlas, seq: 0, text: "Nenhum deploy desde ontem." });
    await settle(3);
    expect(atlasRow().classList.contains("ac-msg--waiting")).toBe(false);
    expect(row()).toBeNull();
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

  test("a line said before a call and posted as the message shows once (a repeated delta adds nothing)", async () => {
    const { ev } = await open();
    const said = "Achei o painel de cobrança. Preciso da sua sessão para puxar os valores.";
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: said });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: said });
    await ev({ type: "agent.tool", ...ids, tool: "browser_ask_person", toolUseId: "call-1" });
    await settle(2);
    await ev({
      type: "message.created",
      messageId: "m-said",
      message: {
        id: "m-said",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: said,
        mentionedAgentIds: [],
        agentRunId: "r-live",
        createdAt: new Date(Date.now() + 10_000).toISOString(),
      },
    });
    await ev({ type: "agent.run", ...ids, status: "waiting_input" });
    await settle(4);
    const text = document.body.textContent ?? "";
    expect(text.split(said).length - 1).toBe(1);
  });

  test("after a reconnect, once the server confirms the channel again, live rows it no longer runs go away", async () => {
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
    await act(async () => sockets.last().push({ type: "subscribed", channelId: ENG_ID }));
    await settle(4);
    expect(row()).toBeNull();
  });
});
