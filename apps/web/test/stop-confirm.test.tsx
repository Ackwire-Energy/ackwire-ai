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

describe("Parar with a confirmation", () => {
  test("the bar is a pill: living avatar with its look, the words, then a small round Parar", async () => {
    const { ev } = await open((s) => {
      const ada = s.agents.find((a) => a.id === ADA_ID);
      if (ada) (ada as { appearance?: unknown }).appearance = { color: "amber", accessory: "hat" };
    });
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(3);
    const bar = document.querySelector('.ac-typing[data-active="true"]') as HTMLElement;
    const avatar = bar.querySelector(".ac-avatar--agent") as HTMLElement;
    expect(avatar.getAttribute("data-accessory")).toBe("hat");
    expect(bar.querySelector(".ac-typing__sep")).not.toBeNull();
    const stop = within(bar).getByRole("button", { name: "Parar" });
    expect(stop.className).toBe("stop-run");
    expect(stop.getAttribute("title")).toBe("Parar tarefa · Esc");
  });

  test("click: the confirmation says what it's doing, focuses Parar; Continuar keeps it running", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: "Escrevendo" });
    await settle(2);
    const row = document.querySelector('[data-run-id="r-live"]') as HTMLElement;
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Parar" })));
    await settle(2);
    const confirm = screen().getByRole("dialog", { name: "Parar a tarefa da Ada?" });
    expect(confirm.textContent).toContain("Escrevendo a resposta. O que já foi feito fica salvo.");
    expect(confirm.textContent).toContain("Esc duas vezes para parar direto");
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Parar" }));
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Continuar" })));
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Parar a tarefa da Ada?" })).toBeNull();
    expect(cancels(state)).toHaveLength(0);
  });

  test("opened by a click, Esc only closes it", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    const bar = document.querySelector(".ac-typing") as HTMLElement;
    await act(async () => fireEvent.click(within(bar).getByRole("button", { name: "Parar" })));
    await settle(2);
    expect(screen().getByRole("dialog", { name: "Parar a tarefa da Ada?" })).toBeTruthy();
    await esc();
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Parar a tarefa da Ada?" })).toBeNull();
    expect(cancels(state)).toHaveLength(0);
  });

  test("Esc opens it; after 1.5 s a second Esc just closes it; confirming shows Parando…", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    const realNow = Date.now;
    try {
      await esc();
      await settle(2);
      expect(screen().getByRole("dialog", { name: "Parar a tarefa da Ada?" })).toBeTruthy();
      Date.now = () => realNow() + 2000;
      await esc();
      await settle(2);
      expect(screen().queryByRole("dialog", { name: "Parar a tarefa da Ada?" })).toBeNull();
      expect(cancels(state)).toHaveLength(0);
    } finally {
      Date.now = realNow;
    }
    await esc();
    await settle(2);
    const confirm = screen().getByRole("dialog", { name: "Parar a tarefa da Ada?" });
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Parar" })));
    await settle(2);
    expect(cancels(state)).toHaveLength(1);
    const bar = document.querySelector(".ac-typing") as HTMLElement;
    expect(within(bar).getByRole("button", { name: "Parando…" }).hasAttribute("disabled")).toBe(true);
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
