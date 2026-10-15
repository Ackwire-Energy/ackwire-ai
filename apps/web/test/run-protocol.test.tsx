import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { Message, RunStep } from "@/api/types";
import { splitCanceled, workFromSteps } from "@/lib/work";
import { applyChannelEvent, emptyStreams, narrationOf, reconcileRuns, type StreamsState } from "@/realtime/streams";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const base = { channelId: "c", threadId: "t", agentId: "ada", runId: "r" };
type Ev = Parameters<typeof applyChannelEvent>[1];
const run = (events: Ev[], s: StreamsState = emptyStreams) => events.reduce((acc, e) => applyChannelEvent(acc, e), s);
const delta = (seq: number, turn: number, text: string): Ev => ({ type: "agent.delta", ...base, seq, turn, text });
const narration = (turn: number, text: string) => ({ type: "agent.narration", ...base, turn, text }) as Ev;

describe("narration keyed by turn", () => {
  test("agent.narration moves that turn's text out of the answer", () => {
    const s = run([delta(0, 0, "Vou checar "), delta(1, 0, "o ambiente."), narration(0, "Vou checar o ambiente.")]);
    const r = s.runs.r;
    expect(narrationOf(r ?? {})).toEqual(["Vou checar o ambiente."]);
    expect(r?.text).toBe("");
  });

  test("tool call first, then narration for the same turn: one line, not two", () => {
    const s = run([
      delta(0, 0, "Vou checar"),
      { type: "agent.tool", ...base, tool: "run_code", toolUseId: "t1" } as Ev,
      narration(0, "Vou checar o ambiente."),
      delta(1, 1, "Pronto."),
    ]);
    expect(narrationOf(s.runs.r ?? {})).toEqual(["Vou checar o ambiente."]);
    expect(s.runs.r?.text).toBe("Pronto.");
  });

  test("a delta of a new turn turns the previous text into narration", () => {
    const s = run([delta(0, 0, "Primeiro olho os logs."), delta(1, 1, "Achei.")]);
    expect(narrationOf(s.runs.r ?? {})).toEqual(["Primeiro olho os logs."]);
    expect(s.runs.r?.text).toBe("Achei.");
  });

  test("steered with stop: the row shows it's stopping", () => {
    const s = run([
      delta(0, 0, "Trabalhando"),
      { type: "agent.run.steered", channelId: "c", runId: "r", messageId: "m9", stop: true } as Ev,
    ]);
    expect(s.runs.r?.stopping).toBe(true);
    expect(s.runs.r?.work?.at(-1)).toEqual({ kind: "steer", messageId: "m9" });
  });
});

describe("server truth for live rows", () => {
  test("active-runs fills the trigger, the server start and the heartbeat of a known run", () => {
    let s = run([delta(0, 0, "oi")]);
    s = { ...s, runs: { r: { ...(s.runs.r as NonNullable<typeof s.runs.r>), lastEventAt: 1_000 } } };
    s = reconcileRuns(
      s,
      "c",
      [
        {
          runId: "r",
          agentId: "ada",
          channelId: "c",
          threadId: "t",
          status: "running",
          triggerMessageId: "m-7",
          startedAt: new Date(500).toISOString(),
          heartbeatAt: new Date(9_000).toISOString(),
        },
      ],
      10_000,
      10_000,
    );
    expect(s.runs.r?.triggerMessageId).toBe("m-7");
    expect(s.runs.r?.startedAt).toBe(500);
    expect(s.runs.r?.lastEventAt).toBe(9_000);
  });

  test("agent.run carries the trigger; a 'pensando…' row passes its message on", () => {
    const s = run([{ type: "agent.run", ...base, status: "running", triggerMessageId: "m-3" } as Ev]);
    expect(s.runs.r?.triggerMessageId).toBe("m-3");
    const p = run([
      { type: "agent.thinking", channelId: "c", threadId: "m-5", agentId: "ada", runId: null } as Ev,
      { type: "agent.run", channelId: "c", threadId: "m-5", agentId: "ada", runId: "r2", status: "running" } as Ev,
    ]);
    expect(p.runs.r2?.triggerMessageId).toBe("m-5");
  });
});

describe("work summary and stopped messages", () => {
  test("model_call narration sits before the tool calls of its turn", () => {
    const at = (s: number) => new Date(s * 1000).toISOString();
    const steps: RunStep[] = [
      { seq: 1, kind: "model_call", data: { turn: 0, narration: "Vou checar o ambiente." }, createdAt: at(0) },
      { seq: 2, kind: "tool_call", data: { name: "run_code", toolUseId: "a", input: {} }, createdAt: at(1) },
      { seq: 3, kind: "tool_result", data: { toolUseId: "a", content: "" }, createdAt: at(2) },
      { seq: 4, kind: "model_call", data: { turn: 1, narration: "" }, createdAt: at(3) },
    ];
    const w = workFromSteps(steps);
    expect(w.narration).toEqual([{ key: "say-1", turn: 0, text: "Vou checar o ambiente.", at: 0 }]);
    expect(w.steps).toHaveLength(1);
  });

  test("splitCanceled keeps the text and turns the last line into a note", () => {
    expect(splitCanceled("Comecei a análise.\n\n_Interrompido por Walter._", { canceled: true })).toEqual({
      body: "Comecei a análise.",
      note: "Interrompido por Walter",
    });
    expect(splitCanceled("_ênfase_", {})).toEqual({ body: "_ênfase_", note: null });
  });
});

describe("in the channel", () => {
  test("a stopped message shows its text and 'Interrompido por Walter' as a note", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-stopped",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Comecei a revisar o PR.\n\n_Interrompido por Walter._",
      mentionedAgentIds: [],
      agentRunId: "r-stopped",
      meta: { canceled: true },
      createdAt: new Date().toISOString(),
    } as Message);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const msg = screen().getByText("Comecei a revisar o PR.").closest(".ac-msg") as HTMLElement;
    expect(msg.querySelector(".run-canceled")?.textContent).toBe("Interrompido por Walter");
    expect(msg.querySelector(".ac-msg__text")?.textContent).not.toContain("Interrompido");
  });

  test("Parar on a run that already finished (409 run_finished): the row just goes away", async () => {
    const state = seedState();
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    // run-1 is "done" on the server (seed).
    const ids = { threadId: "m-1", runId: "run-1", agentId: ADA_ID, channelId: ENG_ID };
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.run", ...ids, status: "running" } }),
    );
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.delta", ...ids, seq: 0, text: "Quase" } }),
    );
    await settle(2);
    const row = document.querySelector('[data-run-id="run-1"]') as HTMLElement;
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Parar" })));
    await settle(4);
    expect(state.calls.some((c) => c.method === "agents.cancelRun")).toBe(true);
    expect(document.querySelector('[data-run-id="run-1"]')).toBeNull();
  });
});
