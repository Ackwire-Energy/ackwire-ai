import { afterEach, describe, expect, test } from "bun:test";
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
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    return { state, ev };
  };
  const ids = { threadId: "m-1", runId: "r-live", agentId: ADA_ID };

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
    expect(document.querySelector(".live-work__say")?.textContent).toBe("Vou checar o ambiente.");
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
    const heads = within(row).getAllByRole("button", { name: /Rodando código|Rodou/ });
    expect(heads).toHaveLength(2);
    // t2 still runs: open, with its code.
    expect(heads[1]?.getAttribute("aria-expanded")).toBe("true");
    expect(within(row).getByLabelText("Código (python)").textContent).toBe("print(2)");
    await ev({ type: "agent.tool", ...ids, tool: null });
    await settle(2);
    const done = within(row).getAllByRole("button", { name: /Rodou/ });
    expect(done.at(-1)?.textContent).toBe("Rodou 1 linha de python · saída 2 B");
    expect(done.at(-1)?.getAttribute("aria-expanded")).toBe("false");
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
