import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ActiveRun, ApiClient, Message } from "@agenteschat/client";
import { ApiError, applyChannelEvent, emptyStreams, isQuiet, QUIET_AFTER_MS, reconcileRuns } from "@agenteschat/client";
import type { TimelineItem } from "@agenteschat/client/lib/timeline";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { liveAnchors } from "@/pages/ChannelPage";
import { createStreamsStore, reconcileChannelRuns } from "@/realtime/context";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  setSystemTime();
  cleanup();
});

const msg = (id: string, threadId: string | null, at: number): TimelineItem => ({
  kind: "message",
  key: id,
  grouped: false,
  message: {
    id,
    channelId: "c",
    threadId,
    author: { type: "person", id: "u" },
    body: "",
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(at).toISOString(),
  } as Message,
});
const key = (runId: string, startedAt: number, threadId: string, trigger: string | null = null) =>
  JSON.stringify([runId, startedAt, threadId, trigger]);

describe("where a live run goes", () => {
  const items = [msg("a", null, 1_000), msg("b", "a", 60_000), msg("other", null, 120_000), msg("c", "a", 180_000)];

  test("right after the last message of its conversation sent before it started; later ones stay below", () => {
    const { anchors, unanchored } = liveAnchors(key("r1", 100_000, "a"), items);
    expect([...anchors.entries()]).toEqual([["b", ["r1"]]]);
    expect(unanchored).toEqual([]);
  });

  test("the server's triggerMessageId wins over the time guess", () => {
    const { anchors } = liveAnchors(key("r1", 500_000, "a", "b"), items);
    expect([...anchors.entries()]).toEqual([["b", ["r1"]]]);
  });

  test("ids with colons, several runs, unknown conversation at the end", () => {
    const k = [key("pending:x:a", 10_000, "a"), key("r2", 500_000, "a"), key("r3", 1, "zzz")].join("\n");
    const { anchors, unanchored } = liveAnchors(k, items);
    expect(anchors.get("a")).toEqual(["pending:x:a"]);
    expect(anchors.get("c")).toEqual(["r2"]);
    expect(unanchored).toEqual(["r3"]);
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

  test("own header (never grouped), placed by time; a later message stays below with a full header", async () => {
    const { ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "Olhando o login." });
    await settle(2);
    expect(row().classList.contains("ac-msg--grouped")).toBe(false);
    expect(row().textContent).toContain("Ada");
    expect(row().textContent).toContain("em andamento");
    await post(ev, "m-later", "Também confere o refresh");
    await settle(3);
    const later = screen().getByText("Também confere o refresh").closest(".ac-msg") as HTMLElement;
    expect(row().compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(later.classList.contains("ac-msg--grouped")).toBe(false);
  });

  test("'ainda trabalhando' jumps back to the row; steering shows on my message and in the row; no composer hint", async () => {
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
      // No "is working" line under the composer: stopping stays on the run itself (and Esc, /stop).
      expect(document.body.textContent).not.toContain("Sua mensagem entra na tarefa atual");
      expect(document.body.textContent).not.toContain("Ada está trabalhando");
      expect(within(row()).getByRole("button", { name: "Parar" })).toBeTruthy();

      await post(ev, "m-steer", "Olha também o refresh");
      await ev({ type: "agent.run.steered", ...ids, messageId: "m-steer" });
      await settle(4);
      const mine = screen().getByText("Olha também o refresh").closest(".ac-msg") as HTMLElement;
      expect(mine.textContent).toContain("Ada recebeu durante a tarefa");
      expect(row().textContent).toContain("Nova mensagem de Walter");

      // The chip follows the DOM (a MutationObserver, batched per frame).
      await act(() => new Promise((r) => setTimeout(r, 60)));
      await act(async () => fireEvent.click(screen().getByRole("button", { name: "Ada ainda trabalhando" })));
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
