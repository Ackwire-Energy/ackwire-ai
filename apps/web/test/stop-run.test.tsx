import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { LiveRun } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { TFunction } from "i18next";
import { runContext } from "@/components/StopRun";
import { createI18n } from "@/i18n";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const ids = { threadId: "m-1", runId: "r-live", agentId: ADA_ID };

const open = async (configure?: (s: ReturnType<typeof seedState>) => void) => {
  const state = seedState();
  configure?.(state);
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const ev = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
  return { state, ev };
};
const cancels = (state: ReturnType<typeof seedState>) => state.calls.filter((c) => c.method === "agents.cancelRun");
const esc = () => act(async () => fireEvent.keyDown(window, { key: "Escape" }));

describe("Parar is immediate (telas/Mensagens.html)", () => {
  test("the bar out of view: living avatar with its look, the words, 'Ver' and 'Esc para parar'", async () => {
    const { ev } = await open((s) => {
      const ada = s.agents.find((a) => a.id === ADA_ID);
      if (ada) (ada as { appearance?: unknown }).appearance = { color: "amber", accessory: "hat" };
    });
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(3);
    // happy-dom has no layout: the block counts as out of view, so the line above the composer speaks.
    const bar = document.querySelector('.ac-typing[data-active="true"]') as HTMLElement;
    const avatar = bar.querySelector(".ac-avatar--agent") as HTMLElement;
    expect(avatar.getAttribute("data-accessory")).toBe("hat");
    expect(within(bar).getByRole("button", { name: "Ver" })).toBeTruthy();
    expect(bar.textContent).toContain("para parar");
    // No confirmation anywhere.
    expect(within(bar).queryByRole("button", { name: "Parar" })).toBeNull();
  });

  test("the send button turns into stop with an empty box; one click stops, nothing asked", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "Escrevendo" });
    await settle(2);
    const stop = screen().getByRole("button", { name: "Parar a Ada" });
    expect(stop.getAttribute("data-mode")).toBe("stop");
    await act(async () => fireEvent.click(stop));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(cancels(state)).toHaveLength(1);
  });

  test("Esc with an empty composer stops right away", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    await esc();
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(cancels(state)).toHaveLength(1);
  });

  test("typing while it works: 'Juntar' (↵) joins; ⌘↵ / Ctrl↵ sends with 'Parar e mandar'", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    const box = screen().getByRole("combobox", { name: /Mensagem para/ });
    await act(async () => fireEvent.change(box, { target: { value: "olha o refresh" } }));
    const group = screen().getByRole("radiogroup", { name: "Como mandar enquanto a Ada trabalha" });
    expect(
      within(group)
        .getByRole("radio", { name: /Juntar ao que ela faz/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await act(async () => fireEvent.keyDown(box, { key: "Enter", ctrlKey: true }));
    await settle(3);
    const posts = state.calls.filter((c) => c.method === "chat.post").map((c) => c.args[2] as { steer?: string });
    expect(posts.at(-1)?.steer).toBe("now");
    await act(async () => fireEvent.change(box, { target: { value: "e o login" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(3);
    const again = state.calls.filter((c) => c.method === "chat.post").map((c) => c.args[2] as { steer?: string });
    expect(again.at(-1)?.steer).toBeUndefined();
  });

  test("the context line: code for N min, a tool, writing, thinking", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n) as TFunction;
    const base: LiveRun = {
      runId: "r",
      agentId: "a",
      channelId: "c",
      threadId: "t",
      status: "running",
      text: "",
      lastSeq: -1,
      startedAt: 0,
    };
    const call = (tool: string, code: boolean) => ({
      kind: "call" as const,
      id: "x",
      tool,
      connector: null,
      detail: null,
      code: code ? { language: "bash", source: "ls" } : null,
      output: [],
      running: true,
      since: 0,
    });
    expect(runContext(t, { ...base, work: [call("run_code", true)] }, 2 * 60_000)).toBe("rodando código há 2 min");
    expect(runContext(t, { ...base, text: "Oi" }, 1000)).toBe("escrevendo a resposta");
    expect(runContext(t, base, 10_000)).toBe("pensando há menos de 1 min");
  });
});
