import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message, RunStep } from "@agenteschat/client";
import { applyChannelEvent, emptyStreams, reconcileRuns, type StreamsState } from "@agenteschat/client";
import { splitCanceled, stopsMovedOn, workFromSteps } from "@agenteschat/client/lib/work";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const base = { channelId: "c", threadId: "t", agentId: "ada", runId: "r" };
type Ev = Parameters<typeof applyChannelEvent>[1];
const run = (events: Ev[], s: StreamsState = emptyStreams) => events.reduce((acc, e) => applyChannelEvent(acc, e), s);
/** An older server's piece of a reply (it still sent which model call it came from). */
const delta = (seq: number, turn: number, text: string) => ({ type: "agent.delta", ...base, seq, turn, text }) as Ev;

describe("a run's live state holds what it does, never what it writes", () => {
  test("an older server's deltas, of one turn or a new one: no words kept, only that it writes", () => {
    const s = run([delta(0, 0, "Não consigo, precisa do seu QR code."), delta(1, 1, "Achei.")]);
    expect(s.runs.r?.status).toBe("running");
    expect(JSON.stringify(s.runs.r)).not.toContain("QR code");
    expect(s.runs.r?.work ?? []).toEqual([]);
  });

  test("steered with stop: the row shows it's stopping; the message joins the work once read", () => {
    let s = run([
      delta(0, 0, "Trabalhando"),
      { type: "agent.run.steered", channelId: "c", runId: "r", messageId: "m9", stop: true } as Ev,
    ]);
    expect(s.runs.r?.stopping).toBe(true);
    s = run([{ type: "agent.run.read", channelId: "c", runId: "r", agentId: "ada", messageIds: ["m9"] } as Ev], s);
    expect(s.runs.r?.status).toBe("running");
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

  test("splitCanceled keeps the text and takes out the server's last line; the person comes from the meta", () => {
    expect(
      splitCanceled("Comecei a análise.\n\n_Interrompido por Walter._", { canceled: { byUserId: "u-walter" } }),
    ).toEqual({ body: "Comecei a análise.", canceled: true, byUserId: "u-walter", byAgentId: null, code: null });
    expect(splitCanceled("_ênfase_", {})).toEqual({
      body: "_ênfase_",
      canceled: false,
      byUserId: null,
      byAgentId: null,
      code: null,
    });
  });
});

describe("stops that are over", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();
  const row = (runId: string, minutes: number, over: Partial<Message> = {}) =>
    ({
      author: { type: "agent", id: "ada" },
      agentRunId: runId,
      threadId: null,
      createdAt: at(minutes),
      ...over,
    }) as Message;
  const stop = row("r1", 1, { meta: { canceled: { byUserId: "u" } } });

  test("the agent wrote again after it in the same thread, or works here now", () => {
    expect([...stopsMovedOn([stop])]).toEqual([]);
    expect([...stopsMovedOn([row("r2", 2), stop])]).toEqual(["r1"]);
    expect([...stopsMovedOn([stop], ["ada"])]).toEqual(["r1"]);
  });

  test("not what it wrote before, in another thread, in the same run, as a notice, nor another agent", () => {
    const others = [
      row("r0", 0),
      row("r2", 2, { threadId: "t1" }),
      row("r1", 2),
      row("r3", 2, { meta: { notice: { kind: "run_stopped" } } }),
      row("r4", 2, { author: { type: "agent", id: "atlas" } }),
    ];
    expect([...stopsMovedOn([stop, ...others], ["atlas"])]).toEqual([]);
  });
});

describe("in the channel", () => {
  test("a stopped message shows its text, its pill 'You stopped Ada' and Continue", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-stopped",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Comecei a revisar o PR.\n\n_Interrompido por Walter._",
      mentionedAgentIds: [],
      agentRunId: "r-stopped",
      meta: { canceled: { byUserId: "u-walter" } },
      createdAt: new Date().toISOString(),
    } as Message);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const msg = screen().getByText("Comecei a revisar o PR.").closest(".ac-msg") as HTMLElement;
    const line = msg.querySelector(".run-canceled") as HTMLElement;
    expect(line.textContent).toContain("Você parou a Ada");
    expect(msg.querySelector(".ac-msg__text")?.textContent).not.toContain("Interrompido");
    // Continuar picks it up from where it stopped; the button goes away.
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Continuar" })));
    await settle(3);
    expect(state.calls.find((c) => c.method === "agents.continueRun")?.args).toEqual([ORG_ID, "r-stopped"]);
    expect(within(msg).queryByRole("button", { name: "Continuar" })).toBeNull();
  });

  /** Ada's message in the channel, `minutes` ago. */
  const fromAda = (id: string, body: string, runId: string, minutes: number, meta?: Message["meta"]) =>
    ({
      id,
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body,
      mentionedAgentIds: [],
      agentRunId: runId,
      ...(meta ? { meta } : {}),
      createdAt: new Date(Date.now() - minutes * 60_000).toISOString(),
    }) as Message;

  test("a message sent with 'Parar e mandar' that stopped the task: no 'You stopped Ada', no Continuar", async () => {
    const state = seedState();
    // As the server leaves it: what Ada wrote before the send is a plain message, the sent one names the run.
    state.messages.push(fromAda("m-before", "Comecei a revisar o PR.", "r-stopped", 3), {
      id: "m-sent",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-walter" },
      body: "Na verdade, só o login.",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: { steerNow: true, stoppedRunIds: ["r-stopped"] },
      createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    } as Message);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    expect(screen().getByText("Comecei a revisar o PR.")).toBeTruthy();
    expect(document.querySelector(".run-canceled")).toBeNull();
    expect(document.body.textContent).not.toContain("Você parou");
    expect(screen().queryByRole("button", { name: "Continuar" })).toBeNull();
  });

  test("who stopped it, as the pill says it: the right hand at my word, someone else, or the system's cause", async () => {
    const state = withRightHand(seedState());
    state.messages.push(
      // The right hand stopped it at my word: its name, never "Você parou", and Continuar still mine (the latest, so
      // the agent has not gone on after it).
      fromAda("m-lodi", "Comecei o relatório.\n\n_Stopped by Lodi for Walter._", "r-lodi", 1, {
        canceled: {
          byUserId: "u-walter",
          byAgentId: "00000000-0000-4000-8000-0000000000a9",
          text: "Comecei o relatório.",
        },
      }),
      // João pressed Stop.
      fromAda("m-joao", "Comecei os testes.\n\n_Stopped by João._", "r-joao", 5, {
        canceled: { byUserId: "u-joao", text: "Comecei os testes." },
      }),
      // Archived: its cause in my language, never the server's English, and nothing to continue.
      fromAda("m-archived", "Comecei o deploy.\n\n_Stopped._", "r-archived", 4, {
        canceled: { byUserId: null, code: "run.agent_archived", text: "Comecei o deploy." },
      }),
      // A cause with no words of its own: the plain stop line.
      fromAda("m-mission", "Comecei o plano.\n\n_Stopped._", "r-mission", 3, {
        canceled: { byUserId: null, code: "run.failed", text: "Comecei o plano." },
      }),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const lineOf = (text: string) =>
      (screen().getByText(text).closest(".ac-msg") as HTMLElement).querySelector(".run-canceled") as HTMLElement;
    const lodi = lineOf("Comecei o relatório.");
    expect(lodi.textContent).toContain("Lodi parou a Ada");
    expect(lodi.textContent).not.toContain("Você");
    expect(within(lodi).getByRole("button", { name: "Continuar" })).toBeTruthy();
    expect(lineOf("Comecei os testes.").textContent).toContain("João parou a Ada");
    const archived = lineOf("Comecei o deploy.");
    expect(archived.textContent).toContain("O agente foi arquivado.");
    expect(within(archived).queryByRole("button", { name: "Continuar" })).toBeNull();
    const mission = lineOf("Comecei o plano.");
    expect(mission.textContent).toContain("Parou aqui");
    expect(within(mission).queryByRole("button", { name: "Continuar" })).toBeNull();
    expect(document.body.textContent).not.toContain("Stopped");
  });

  test("a stopped reply the agent wrote after keeps its pill and loses Continuar", async () => {
    const state = seedState();
    state.messages.push(
      fromAda("m-stopped", "Comecei a revisar o PR.\n\n_Stopped by Walter._", "r-stopped", 3, {
        canceled: { byUserId: "u-walter", text: "Comecei a revisar o PR." },
      }),
      fromAda("m-after", "Pronto, revisei o login.", "r-next", 1),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const line = document.querySelector(".run-canceled") as HTMLElement;
    expect(line.textContent).toContain("Você parou a Ada");
    expect(within(line).queryByRole("button", { name: "Continuar" })).toBeNull();
  });

  test("a stopped reply never offers Continuar while its agent works in the conversation", async () => {
    const state = seedState();
    state.messages.push(
      fromAda("m-stopped", "Comecei a revisar o PR.\n\n_Stopped by Walter._", "r-stopped", 3, {
        canceled: { byUserId: "u-walter", text: "Comecei a revisar o PR." },
      }),
    );
    const { sockets } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const line = () => document.querySelector(".run-canceled") as HTMLElement;
    expect(within(line()).getByRole("button", { name: "Continuar" })).toBeTruthy();
    const socket = sockets.last();
    await act(async () => socket.open());
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          channelId: ENG_ID,
          type: "agent.run",
          threadId: null,
          runId: "r-live",
          agentId: ADA_ID,
          status: "running",
        },
      }),
    );
    await settle(3);
    expect(document.querySelector('.ac-typing[data-active="true"] .ac-typing__text')?.textContent).toBe(
      "Ada pensando…",
    );
    expect(line().textContent).toContain("Você parou a Ada");
    expect(within(line()).queryByRole("button", { name: "Continuar" })).toBeNull();
  });

  test("a reply at the step limit says so in my language, with Continuar", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-limit",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "I ran out of steps before finishing.",
      mentionedAgentIds: [],
      agentRunId: "r-limit",
      meta: { bodyCode: "step_limit", stepLimit: {} },
      createdAt: new Date().toISOString(),
    } as Message);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const msg = screen().getByText("Meus passos acabaram antes de eu terminar.").closest(".ac-msg") as HTMLElement;
    const line = msg.querySelector(".run-canceled") as HTMLElement;
    expect(line.textContent).toContain("No limite de passos");
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Continuar" })));
    await settle(3);
    expect(state.calls.find((c) => c.method === "agents.continueRun")?.args).toEqual([ORG_ID, "r-limit"]);
    expect(within(msg).queryByRole("button", { name: "Continuar" })).toBeNull();
  });

  test("a reply of a run that stopped because it got stuck says so in my language, with Continuar", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-stuck",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "I got stuck and stopped before finishing.",
      mentionedAgentIds: [],
      agentRunId: "r-stuck",
      meta: { bodyCode: "stuck", stepLimit: { stuck: true } },
      createdAt: new Date().toISOString(),
    } as Message);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const msg = screen().getByText("Travei e parei antes de terminar.").closest(".ac-msg") as HTMLElement;
    const line = msg.querySelector(".run-canceled") as HTMLElement;
    expect(line.textContent).toContain("Parou porque travou");
    expect(line.textContent).not.toContain("No limite de passos");
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Continuar" })));
    await settle(3);
    expect(state.calls.find((c) => c.method === "agents.continueRun")?.args).toEqual([ORG_ID, "r-stuck"]);
  });

  test("Parar on a run that already finished (409 run_finished): the row just goes away", async () => {
    const state = seedState();
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    // run-1 is "done" on the server (seed).
    const ids = { threadId: null, runId: "run-1", agentId: ADA_ID, channelId: ENG_ID };
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.run", ...ids, status: "running" } }),
    );
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.typing", ...ids } }));
    await settle(2);
    // The composer's send button is the stop while the box is empty: one click, nothing asked.
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Parar a Ada" })));
    await settle(4);
    expect(state.calls.some((c) => c.method === "agents.cancelRun")).toBe(true);
    expect(document.querySelector('[data-run-id="run-1"]')).toBeNull();
  });
});
