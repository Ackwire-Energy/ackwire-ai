import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { messageLink } from "@/components/MessageMore";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return screen().getByRole("menu");
};

describe("message action bars", () => {
  test("people's messages get the glass bar with '…': Salvar na wiki, Copiar link, Responder", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    expect(bar.className).toContain("ac-msg__actions");
    const menu = await openMenu(within(bar).getByRole("button", { name: "Mais ações da mensagem" }));
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Salvar na wiki", "Copiar link", "Responder"]);
  });

  test("agents keep 👍 👎 ✏️, get Reagir and Responder, and the same '…'", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de Ada" });
    expect(within(bar).getByRole("button", { name: "Útil" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Não ajudou" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Corrigir resposta" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Reagir" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Responder" })).toBeTruthy();
    const menu = await openMenu(within(bar).getByRole("button", { name: "Mais ações da mensagem" }));
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
  });

  test("Copiar link copies the message's address", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (s: string) => void copied.push(s) },
    });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    const menu = await openMenu(within(bar).getByRole("button", { name: "Mais ações da mensagem" }));
    await click(within(menu).getByRole("menuitem", { name: "Copiar link" }));
    await settle(2);
    expect(copied[0]).toBe(messageLink(window.location.origin, ORG_ID, { id: "m-1", channelId: ENG_ID }));
    expect(document.body.textContent).toContain("Link copiado.");
  });

  test("Responder opens the message's thread in the panel; the reply there takes the rest out of the channel", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    await click(within(bar).getByRole("button", { name: "Responder" }));
    await settle(6);
    // The thread beside the channel: João's message on top and Ada's replies so far.
    const panel = screen().getByRole("complementary", { name: "Thread" });
    expect(within(panel).getByRole("button", { name: "Fechar a thread" })).toBeTruthy();
    expect(panel.textContent).toContain("o login está devolvendo 401");
    expect(panel.textContent).toContain("Achei a causa");
    const box = within(panel).getByRole("combobox", { name: "Responder na thread" });
    await act(async () => fireEvent.change(box, { target: { value: "vou olhar" } }));
    await click(within(panel).getByRole("button", { name: "Enviar" }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "chat.post")?.args[2]).toMatchObject({
      body: "vou olhar",
      threadId: "m-1",
      openThread: true,
    });
    // From my reply on, the thread leaves the channel: one line where it was (pressed while open).
    const channel = screen().getByRole("region", { name: /Mensagens/ });
    expect(channel.textContent).not.toContain("vou olhar");
    expect(
      within(channel)
        .getByRole("button", { name: /1 resposta/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("a thread opened with Responder: the channel keeps what came before, one line opens the rest", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-3",
      channelId: ENG_ID,
      threadId: "m-1",
      author: { type: "person", id: "u-walter" },
      body: "vou olhar o refresh",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    const api = createFakeApi(state);
    await state.openThread?.(ORG_ID, "m-1", state.messages.at(-1)?.createdAt ?? "");
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const channel = screen().getByRole("region", { name: /Mensagens/ });
    expect(channel.textContent).toContain("Achei a causa");
    expect(channel.textContent).not.toContain("vou olhar o refresh");
    const line = within(channel).getByRole("button", { name: /1 resposta/ });
    expect(line.getAttribute("aria-pressed")).toBe("false");
    await click(line);
    await settle(6);
    const panel = screen().getByRole("complementary", { name: "Thread" });
    expect(panel.textContent).toContain("vou olhar o refresh");
    expect(line.getAttribute("aria-pressed")).toBe("true");
    await click(within(panel).getByRole("button", { name: "Fechar a thread" }));
    expect(screen().queryByRole("complementary", { name: "Thread" })).toBeNull();
  });
});
