import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  createFakeApi,
  type FakeState,
  GENERAL_ID,
  LODI_ID,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** A DM's header: who it is with as one button to their profile, and the channel's search held to the DM. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const go = async (state: FakeState, path: string) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return document.querySelector(".channel__header") as HTMLElement;
};
const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};

describe("who the DM is with, one button", () => {
  test("an agent's opens its page in the panel; no Ver perfil beside it; the name stays the heading", async () => {
    const header = await go(seedState(), `dm/agent/${ADA_ID}`);
    expect(within(header).getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "Ver perfil" })).toBeNull();
    await click(within(header).getByRole("button", { name: "Perfil de Ada" }));
    expect(screen().getByRole("complementary", { name: "Perfil da Ada" })).toBeTruthy();
  });

  test("a person's opens their profile card, as their name in a message does", async () => {
    const header = await go(seedState(), "dm/person/u-joao");
    await click(within(header).getByRole("button", { name: "Perfil de João" }));
    const card = screen().getByRole("dialog", { name: "Perfil" });
    expect(card.textContent).toContain("João");
  });
});

describe("the DM's search is the channel's, held to the DM", () => {
  const seeded = () => {
    const state = seedState();
    const dm = seedDm(state, { type: "agent", id: ADA_ID }, { body: "zebra na DM" });
    state.messages.push({
      id: "m-general",
      channelId: GENERAL_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "uma zebra no general",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    });
    return { state, dm };
  };

  test("the field with no chip to remove and no who or where; Enter finds only the DM's messages", async () => {
    const { state, dm } = seeded();
    const header = await go(state, `dm/agent/${ADA_ID}`);
    expect(within(header).queryByRole("link", { name: "Buscar nesta conversa" })).toBeNull();
    const box = within(header).getByRole("combobox", { name: "Buscar" }) as HTMLInputElement;
    expect(header.querySelector(".ac-token")).toBeNull();
    expect(box.getAttribute("placeholder")).toBe("Buscar nesta conversa");
    await act(async () => fireEvent.focus(box));
    const menu = screen().getByRole("listbox", { name: "Opções de busca" });
    expect(within(menu).queryByRole("option", { name: /De uma pessoa ou agente/ })).toBeNull();
    expect(within(menu).queryByRole("option", { name: /Enviada em um canal ou DM/ })).toBeNull();
    expect(within(menu).getByRole("option", { name: /Com link, arquivo, imagem ou cartão/ })).toBeTruthy();
    await click(within(menu).getByRole("option", { name: /Mais filtros/ }), 1);
    expect(screen().getByRole("option", { name: /Antes de uma data/ })).toBeTruthy();
    expect(screen().queryByRole("option", { name: /Escrita por pessoas ou por agentes/ })).toBeNull();

    await act(async () => fireEvent.change(box, { target: { value: "zebra" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    await settle(4);
    const panel = screen().getByRole("complementary", { name: "Resultados da busca" });
    expect(panel.textContent).toContain("zebra na DM");
    expect(panel.textContent).not.toContain("uma zebra no general");
    // Ir para lands on the message in the DM.
    await click(within(panel).getByRole("button", { name: "Ir para a mensagem de Ada" }));
    expect(screen().queryByRole("complementary", { name: "Resultados da busca" })).toBeNull();
    const row = document.querySelector(`article[data-message-id="m-${dm}"]`);
    expect(row?.classList.contains("ac-msg--focus")).toBe(true);
  });
});

describe("where Lodi's name comes from", () => {
  const story = "O nome vem de lodestar, a estrela que guia os navegantes.";
  const cardOf = async (state: FakeState) => {
    seedDm(state, { type: "agent", id: LODI_ID });
    await go(state, `dm/agent/${LODI_ID}`);
    await click(document.querySelector("article .profile-trigger--name") as HTMLElement);
    return screen().getByRole("dialog", { name: "Perfil" });
  };

  test("its profile card and its page tell it while it keeps its name", async () => {
    const card = await cardOf(withRightHand(seedState()));
    expect(card.textContent).toContain(story);
    cleanup();
    const header = await go(withRightHand(seedState()), `dm/agent/${LODI_ID}`);
    await click(within(header).getByRole("button", { name: "Perfil de Lodi" }));
    expect(document.body.textContent).toContain(story);
  });

  test("renamed, it has another story: none is told", async () => {
    const card = await cardOf(withRightHand(seedState(), { name: "Tuca", handle: "tuca" }));
    expect(card.textContent).toContain("Tuca");
    expect(card.textContent).not.toContain(story);
  });
});
