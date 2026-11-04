import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { applyChannelEvent, emptyStreams, narrationOf, runsInChannel, type StreamsState } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const base = { channelId: "c", threadId: "t", agentId: "ada", runId: "r" };
type Ev = Parameters<typeof applyChannelEvent>[1];
const run = (events: Ev[], s: StreamsState = emptyStreams) => events.reduce(applyChannelEvent, s);

describe("streaming a reply with tools in between", () => {
  test("the first delta (seq 0) after agent.typing is kept: no cut-off start", () => {
    const s = run([
      { type: "agent.run", ...base, status: "running" } as Ev,
      { type: "agent.typing", ...base } as Ev,
      { type: "agent.delta", ...base, seq: 0, text: "Primeiro pedaço. " },
      { type: "agent.delta", ...base, seq: 1, text: "Segundo." },
      { type: "agent.delta", ...base, seq: 1, text: "Segundo." },
    ]);
    expect(runsInChannel(s, "c")[0]?.text).toBe("Primeiro pedaço. Segundo.");
  });

  test("3 model calls: narration leaves the body, no lost characters, the final message replaces the live one", () => {
    let seq = 0;
    const delta = (text: string): Ev => ({ type: "agent.delta", ...base, seq: seq++, text });
    let s = run([
      { type: "agent.run", ...base, status: "running" } as Ev,
      delta("Vou checar "),
      delta("o ambiente."),
      {
        type: "agent.tool",
        ...base,
        tool: "run_code",
        toolUseId: "t1",
        code: { language: "bash", source: "go version" },
      },
      { type: "agent.tool.output", ...base, toolUseId: "t1", stream: "stderr", text: "go: not found" },
      { type: "agent.tool", ...base, tool: null },
      delta("Go não está instalado; "),
      delta("vou tentar com gcc."),
      {
        type: "agent.tool",
        ...base,
        tool: "run_code",
        toolUseId: "t2",
        code: { language: "bash", source: "gcc --version" },
      },
      { type: "agent.tool", ...base, tool: null },
      delta("Pronto: "),
      delta("compilei."),
    ]);
    const r = runsInChannel(s, "c")[0];
    expect(narrationOf(r ?? {})).toEqual(["Vou checar o ambiente.", "Go não está instalado; vou tentar com gcc."]);
    expect(r?.text).toBe("Pronto: compilei.");
    const calls = (r?.work ?? []).filter((w) => w.kind === "call");
    expect(
      calls.map((c) => (c.kind === "call" ? [c.id, c.running, c.output.map((o) => o.text).join("")] : [])),
    ).toEqual([
      ["t1", false, "go: not found"],
      ["t2", false, ""],
    ]);
    s = applyChannelEvent(s, {
      type: "message.created",
      channelId: "c",
      messageId: "m",
      message: { agentRunId: "r", author: { type: "agent", id: "ada" }, threadId: "t" } as Message,
    });
    expect(runsInChannel(s, "c")).toHaveLength(0);
  });
});

describe("live row and Parar", () => {
  const open = async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    return { state, api, ev };
  };
  const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };

  test("tool calls stack in the block: open while running, folded into a summary when done", async () => {
    const { ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "Vou checar o ambiente." });
    await ev({
      type: "agent.tool",
      ...ids,
      tool: "run_code",
      toolUseId: "t1",
      code: { language: "python", source: "print(1)" },
    });
    await settle(2);
    // The first thing it says opens the block, as a message would; the steps list holds the rest.
    const opened = document.querySelector(".ac-msg--streaming") as HTMLElement;
    expect(opened.querySelector(".ac-msg__text")?.textContent).toBe("Vou checar o ambiente.");
    expect(document.querySelector(".live-work__say")).toBeNull();
    await ev({ type: "agent.delta", ...ids, seq: 1, text: "Rodando o teste." });
    await ev({
      type: "agent.tool",
      ...ids,
      tool: "run_code",
      toolUseId: "t2",
      code: { language: "python", source: "print(2)" },
    });
    await ev({ type: "agent.tool.output", ...ids, toolUseId: "t2", stream: "stdout", text: "2\n" });
    await ev({ type: "agent.delta", ...ids, seq: 2, text: "Deu 2." });
    await settle(3);
    const row = document.querySelector(".ac-msg--streaming") as HTMLElement;
    // One line while it works: what it does now and the steps; a click opens every call.
    const head = row.querySelector(".ac-tools__head") as HTMLElement;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(head.textContent).toContain("Rodando código…");
    expect(head.textContent).toContain("2 passos");
    await act(async () => fireEvent.click(head));
    const lines = () => [...row.querySelectorAll<HTMLElement>("button.ac-tools__row")];
    expect(lines()).toHaveLength(2);
    // t2 still runs: open, with its code.
    expect(lines()[1]?.getAttribute("aria-expanded")).toBe("true");
    expect(within(row).getByLabelText("Código (python)").textContent).toBe("print(2)");
    await ev({ type: "agent.tool", ...ids, tool: null, toolUseId: "t2" });
    await settle(2);
    expect(lines().at(-1)?.textContent).toContain("Rodou 1 linha de python · saída 2 B");
    expect(lines().at(-1)?.getAttribute("aria-expanded")).toBe("false");
  });

  test("Parar: one click on the composer's stop, then 'Parado por você · Continuar'; text kept", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "Começando a análise" });
    await settle(2);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Parar a Ada" })));
    await settle(2);
    // Nothing asked: it stops at once.
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(state.calls.find((c) => c.method === "agents.cancelRun")?.args).toEqual([ORG_ID, "r-live"]);
    await ev({ type: "run.canceled", ...ids, byUserId: "u-walter" });
    await settle(2);
    const stopped = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Começando a análise")) as HTMLElement;
    expect(stopped.textContent).toContain("Parado por você");
    expect(within(stopped).getByRole("button", { name: "Continuar" })).toBeTruthy();
    expect(stopped.querySelector('.ac-avatar[data-state="idle"]')).not.toBeNull();
  });

  test("a reply too big to ride its event keeps its text on screen until its copy read over HTTP takes the place", async () => {
    const { state, api, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "Resposta longa sobre o Azure" });
    await settle(2);
    const body = `Resposta longa sobre o Azure. ${"Mais detalhes. ".repeat(400)}`;
    state.messages.push({
      id: "m-big",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body,
      mentionedAgentIds: [],
      mentionedUserIds: [],
      agentRunId: "r-live",
      meta: {},
      clientId: null,
      createdAt: new Date().toISOString(),
    } as Message);
    // The conversation's read is slow to come back.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = api.chat.messages;
    api.chat.messages = async (...args) => {
      await gate;
      return read(...args);
    };
    // Past the pub/sub's size, the server sends the message's id without the message.
    await ev({ type: "message.created", messageId: "m-big", agentRunId: "r-live", threadId: null });
    await ev({ type: "agent.run", ...ids, status: "done" });
    await ev({ type: "agent.idle", ...ids });
    await ev({ type: "run.finished", ...ids, status: "done" });
    await settle(3);
    // Not a blank while the read is on its way: the streamed text stays.
    expect(document.body.textContent).toContain("Resposta longa sobre o Azure");
    await act(async () => release());
    await settle(5);
    const answers = screen()
      .getAllByRole("article")
      .filter((a) => a.textContent?.includes("Resposta longa sobre o Azure"));
    expect(answers).toHaveLength(1);
    expect(answers[0]?.textContent).toContain("Mais detalhes.");
    expect(document.querySelector(".ac-msg--streaming")).toBeNull();
  });

  test("back to the tab after a while, the conversation is read again: an answer whose end never came lands", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "Começando a resposta" });
    await settle(2);
    // While the tab was away, the run ended and its events never reached this page (the socket still looks open).
    state.activeRuns = { [ENG_ID]: [] };
    state.messages.push({
      id: "m-done",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Começando a resposta, e aqui está o fim dela.",
      mentionedAgentIds: [],
      mentionedUserIds: [],
      agentRunId: "r-live",
      meta: {},
      clientId: null,
      createdAt: new Date().toISOString(),
    } as Message);
    const visibility = (value: "hidden" | "visible") =>
      act(async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    try {
      await visibility("hidden");
      setSystemTime(new Date(Date.now() + 60_000));
      await visibility("visible");
      await settle(5);
      expect(document.querySelector(".ac-msg--streaming")).toBeNull();
      expect(document.body.textContent).toContain("e aqui está o fim dela.");
    } finally {
      setSystemTime();
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  test("Esc with an empty composer stops the latest run I may stop, right away", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(state.calls.find((c) => c.method === "agents.cancelRun")?.args).toEqual([ORG_ID, "r-live"]);
  });
});
