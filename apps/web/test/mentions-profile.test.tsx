import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { mentionQuery } from "@agenteschat/ui";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (path: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const typeIn = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  });
const keyDown = (el: Element, key: string) => act(async () => fireEvent.keyDown(el, { key }));
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("@mention autocomplete", () => {
  test("query right before the caret", () => {
    expect(mentionQuery("oi @ad", 6)).toEqual({ start: 3, query: "ad" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("joao@acme", 9)).toBeNull();
    expect(mentionQuery("@ada ", 5)).toBeNull();
  });

  test("channel members first, filter as you type, arrows and Enter insert @handle + space", async () => {
    await go(`c/${ENG_ID}`);
    const box = composer();
    expect(box.getAttribute("aria-expanded")).toBe("false");
    await typeIn(box, "oi @a");
    expect(box.getAttribute("aria-expanded")).toBe("true");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    const options = within(list).getAllByRole("option");
    // Name matches first (Ada, Atlas), then other matches (João).
    expect(options[0]?.textContent).toContain("Ada");
    expect(options[1]?.textContent).toContain("Atlas");
    expect(options[0]?.textContent).toContain("@ada · Agente · Dev");
    expect(list.textContent).toContain("Neste canal");
    expect(box.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    await keyDown(box, "ArrowDown");
    expect(box.getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    await keyDown(box, "Enter");
    expect(composer().value).toBe("oi @atlas ");
    expect(screen().queryByRole("listbox", { name: "Pessoas e agentes" })).toBeNull();
  });

  test("Tab picks, Esc closes without sending", async () => {
    const { state } = await go(`c/${ENG_ID}`);
    await typeIn(composer(), "@jo");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    expect(within(list).getAllByRole("option")[0]?.textContent).toContain("João");
    await keyDown(composer(), "Tab");
    expect(composer().value).toBe("@joao ");
    await typeIn(composer(), "@joao e @ad");
    expect(screen().getByRole("listbox", { name: "Pessoas e agentes" })).toBeTruthy();
    await keyDown(composer(), "Escape");
    expect(screen().queryByRole("listbox", { name: "Pessoas e agentes" })).toBeNull();
    expect(composer().value).toBe("@joao e @ad");
    expect(state.calls.some((c) => c.method === "chat.post")).toBe(false);
  });

  test("an agent outside the channel says so, and picking it offers to add it", async () => {
    const { state } = await go(`c/${GENERAL_ID}`);
    await typeIn(composer(), "@atl");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    const atlas = within(list).getByRole("option", { name: /Atlas/ });
    expect(atlas.textContent).toContain("não está no canal");
    expect(list.textContent).toContain("No workspace");
    await click(atlas);
    expect(composer().value).toBe("@atlas ");
    const offer = screen()
      .getByText("Atlas não está no canal e não vai ver a menção.")
      .closest(".mention-offer") as HTMLElement;
    await click(within(offer).getByRole("button", { name: "Adicionar ao canal" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.addMember")?.args).toEqual([
      ORG_ID,
      GENERAL_ID,
      { agentId: ATLAS_ID },
    ]);
    expect(screen().getByText("Atlas entrou no canal.")).toBeTruthy();
  });

  test("works in the issue comment box too", async () => {
    await go("issues/131");
    const box = screen().getByRole("combobox", { name: "Comentar na issue" }) as HTMLTextAreaElement;
    await typeIn(box, "@ad");
    const list = screen().getByRole("listbox", { name: "Pessoas e agentes" });
    expect(within(list).getAllByRole("option")[0]?.textContent).toContain("Ada");
    await keyDown(box, "Enter");
    expect(box.value).toBe("@ada ");
  });
});

describe("profile card", () => {
  const card = () => screen().getByRole("dialog", { name: "Perfil" });

  test("person: role, presence, local time and Mensagem direta", async () => {
    await go(`c/${ENG_ID}`);
    await click(screen().getAllByRole("button", { name: "Perfil de João" })[0] as HTMLElement);
    await settle(4);
    const c = card();
    expect(c.textContent).toContain("João");
    expect(c.textContent).toContain("Admin");
    expect(c.textContent).toContain("Hora local");
    expect(c.textContent).toContain("America/Sao_Paulo");
    expect(within(c).getByRole("link", { name: "Mensagem direta" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/dm/person/u-joao`,
    );
  });

  test("agent: role, owner, model, what it can do, spend vs budget, DM and profile", async () => {
    await go(`c/${ENG_ID}`);
    await click(screen().getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement);
    await settle(6);
    const c = card();
    expect(c.textContent).toContain("Agente · Dev");
    expect(c.textContent).toContain("Responsável");
    expect(c.textContent).toContain("João");
    expect(c.textContent).toContain("sonnet 5.5");
    expect(c.textContent).toContain("Pode");
    expect(c.textContent).toMatch(/US\$\s?12,30 de US\$\s?40,00 este mês/);
    expect(within(c).getByRole("meter", { name: "Gasto do mês" })).toBeTruthy();
    expect(within(c).getByRole("link", { name: "Mensagem direta" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/dm/agent/${ADA_ID}`,
    );
    expect(within(c).getByRole("link", { name: "Ver perfil" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/agents/${ADA_ID}`,
    );
  });

  test("an agent without owner says so; members don't see spend", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = null;
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(`c/${ENG_ID}`, state);
    await click(screen().getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement);
    await settle(6);
    expect(card().textContent).toContain("sem responsável");
    expect(within(card()).queryByRole("meter")).toBeNull();
  });

  test("keyboard: the name is focusable and Enter opens it; the avatar copy is mouse-only", async () => {
    await go(`c/${ENG_ID}`);
    const triggers = screen().getAllByRole("button", { name: "Perfil de João" });
    // The avatar trigger is hidden from assistive tech and the tab order.
    const avatar = document.querySelector('.profile-trigger[aria-hidden="true"]');
    expect(avatar?.getAttribute("tabindex")).toBe("-1");
    const name = triggers[0] as HTMLElement;
    name.focus();
    await keyDown(name, "Enter");
    await click(name);
    await settle(3);
    expect(card()).toBeTruthy();
  });

  test("hover with a mouse opens after ~400 ms; touch hover never does", async () => {
    await go(`c/${ENG_ID}`);
    const name = screen().getAllByRole("button", { name: "Perfil de João" })[0] as HTMLElement;
    await act(async () => fireEvent.pointerEnter(name, { pointerType: "touch" }));
    await wait(500);
    expect(screen().queryByRole("dialog", { name: "Perfil" })).toBeNull();
    await act(async () => fireEvent.pointerLeave(name, { pointerType: "touch" }));
    await act(async () => fireEvent.pointerEnter(name, { pointerType: "mouse" }));
    await wait(150);
    expect(screen().queryByRole("dialog", { name: "Perfil" })).toBeNull();
    await wait(350);
    await settle(3);
    expect(card().textContent).toContain("João");
  });

  test("mention chips in messages open the card too", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-mention",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: "Pode ver isso, @ada?",
      mentionedAgentIds: [ADA_ID],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    const chip = Array.from(document.querySelectorAll(".profile-trigger--mention")).find((b) =>
      b.textContent?.includes("@Ada"),
    ) as HTMLElement;
    expect(chip.getAttribute("aria-label")).toBe("Perfil de Ada");
    await click(chip);
    await settle(6);
    expect(card().textContent).toContain("Agente · Dev");
  });
});
