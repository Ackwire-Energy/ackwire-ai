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
  test("people's messages get the glass bar with '…': Salvar na wiki, Copiar link, Responder, Criar thread, Responder em thread", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    expect(bar.className).toContain("ac-msg__actions");
    const menu = await openMenu(within(bar).getByRole("button", { name: "Mais ações da mensagem" }));
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Salvar na wiki", "Copiar link", "Responder", "Criar thread a partir daqui", "Responder em thread"]);
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
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(4);
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

  test("Responder em thread: the composer says so, and the message goes to that thread", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    const menu = await openMenu(within(bar).getByRole("button", { name: "Mais ações da mensagem" }));
    await click(within(menu).getByRole("menuitem", { name: "Responder em thread" }));
    expect(document.querySelector(".composer-reply")?.textContent).toContain("Na thread de João");
    const box = screen().getByRole("combobox", { name: /Mensagem para/ });
    await act(async () => fireEvent.change(box, { target: { value: "vou olhar" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.post")?.args[2]).toMatchObject({
      body: "vou olhar",
      threadId: "m-1",
    });
    expect(document.querySelector(".composer-reply")).toBeNull();
  });
});
