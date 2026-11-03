import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const box = () =>
  within(document.querySelector(".channel__header") as HTMLElement).getByRole("combobox", {
    name: "Buscar",
  }) as HTMLInputElement;
const typeIn = async (value: string) => {
  await act(async () => fireEvent.change(box(), { target: { value } }));
  // The search runs a beat after the last key.
  await act(() => new Promise((r) => setTimeout(r, 300)));
  await settle(4);
};
const enter = async () => {
  await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
  await act(() => new Promise((r) => setTimeout(r, 300)));
  await settle(4);
};
const results = () => screen().queryByRole("complementary", { name: "Resultados da busca" });
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;

const seeded = () => {
  const state = seedState();
  const at = new Date().toISOString();
  state.messages.push(
    {
      id: "m-reply",
      channelId: ENG_ID,
      threadId: "m-1",
      author: { type: "agent", id: ADA_ID },
      body: "zebra na resposta",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: at,
    },
    {
      id: "m-general",
      channelId: GENERAL_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "uma Zebra no general",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: at,
    },
  );
  return state;
};

describe("the header search (Discord's)", () => {
  test("focused: the filters with an example, the rest folded under Mais filtros; de: lists agents, then people", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(6);
    expect(box().getAttribute("placeholder")).toBe("Buscar em Acme");
    await act(async () => fireEvent.focus(box()));
    const menu = screen().getByRole("listbox", { name: "Opções de busca" });
    expect(within(menu).getByRole("option", { name: /De uma pessoa ou agente\s*de: nome/ })).toBeTruthy();
    expect(within(menu).queryByRole("option", { name: /Antes de uma data/ })).toBeNull();
    await act(async () => fireEvent.click(within(menu).getByRole("option", { name: /Mais filtros/ })));
    expect(screen().getByRole("option", { name: /Antes de uma data/ })).toBeTruthy();

    await typeIn("de:");
    const headings = [...document.querySelectorAll(".search-menu .ac-menu__heading")].map((h) => h.textContent);
    expect(headings).toEqual(["Agentes", "Pessoas"]);
    expect(screen().getByRole("option", { name: /^Ada/ })).toBeTruthy();
  });

  test("Enter shows the results in the panel by place, words marked; Ir para here highlights the message", async () => {
    const state = seeded();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    await typeIn("achei");
    expect(results()).toBeNull();
    await enter();
    const panel = results() as HTMLElement;
    expect(within(panel).getByRole("heading", { level: 1 }).textContent).toBe("1 resultado");
    const group = within(panel).getByRole("region", { name: "eng" });
    expect([...group.querySelectorAll(".search-hit__mark")].map((m) => m.textContent)).toEqual(["Achei"]);
    await act(async () => fireEvent.click(within(group).getByRole("button", { name: "Ir para a mensagem" })));
    await settle(4);
    expect(results()).toBeNull();
    expect(row("m-2").classList.contains("ac-msg--focus")).toBe(true);
    // The query stays: Enter brings the results back.
    expect(box().value).toBe("achei");
    await enter();
    expect(results()).toBeTruthy();
  });

  test("a reply groups under its thread and opens it; another channel's message navigates there, the query kept", async () => {
    const state = seeded();
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    await typeIn("zebra");
    await enter();
    const panel = results() as HTMLElement;
    const thread = within(panel).getByRole("region", { name: /^@ada o login está devolvendo 401/ });
    expect(thread.textContent).toContain("thread em #eng");
    expect(within(panel).getByRole("region", { name: "general" })).toBeTruthy();

    await act(async () => fireEvent.click(within(thread).getByRole("button", { name: "Ir para a mensagem" })));
    await settle(6);
    expect(results()).toBeNull();
    expect(screen().getByRole("complementary", { name: "Thread" })).toBeTruthy();

    await enter();
    const again = results() as HTMLElement;
    const general = within(again).getByRole("region", { name: "general" });
    await act(async () => fireEvent.click(within(general).getByRole("button", { name: "Ir para a mensagem" })));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    expect(router.state.location.search).toEqual({ m: "m-general" });
    expect(box().value).toBe("zebra");

    // Remembered: emptied, the box offers it under the recent searches.
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Limpar busca" })));
    await typeIn("");
    await act(async () => fireEvent.focus(box()));
    expect(screen().getByRole("option", { name: "zebra" })).toBeTruthy();
  });

  test("on a phone, the search icon opens it over the whole screen; Enter shows the results in the panel", async () => {
    const media = spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(max-width: 760px)",
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    try {
      await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
      await settle(6);
      const header = document.querySelector(".channel__header") as HTMLElement;
      expect(within(header).queryByRole("combobox")).toBeNull();
      await act(async () => fireEvent.click(within(header).getByRole("button", { name: "Buscar" })));
      await settle(2);
      const sheet = screen().getByRole("region", { name: "Buscar" });
      const field = within(sheet).getByRole("combobox", { name: "Buscar" });
      expect(document.activeElement).toBe(field);
      await act(async () => fireEvent.change(field, { target: { value: "zebra" } }));
      await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
      await act(() => new Promise((r) => setTimeout(r, 300)));
      await settle(4);
      expect(screen().queryByRole("region", { name: "Buscar" })).toBeNull();
      expect(results()?.textContent).toContain("zebra na resposta");
    } finally {
      media.mockRestore();
    }
  });
});
