import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type State = ReturnType<typeof seedState>;
const go = async (state: State = seedState()) => {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
// The page behind an open dialog is hidden from roles: the sidebar by its element.
const nav = () => document.getElementById("app-nav") as HTMLElement;
const rows = () =>
  [...nav().querySelectorAll(".sidebar__tools > a.sidebar__item .sidebar__item-label")].map((l) => l.textContent);
/** The tools in the list on top, in order (More keeps the rest), under Início, which always heads it. */
const listed = () => rows().slice(1);
const openMore = async () => {
  await click(within(nav()).getByRole("button", { name: "Mais" }));
  return screen().getByRole("dialog", { name: "Mais" });
};
/** What More lists, each tool's name before its line on what it is for. */
const inMore = (more: HTMLElement) =>
  within(more)
    .getAllByRole("link")
    .map((l) => l.querySelector(".ac-menu__label")?.firstChild?.textContent);
const openSetup = async () => {
  await click(within(await openMore()).getByRole("button", { name: "Personalizar a barra lateral" }));
  return screen().getByRole("dialog", { name: "Personalizar a barra lateral" });
};
const choose = (dialog: HTMLElement, tool: string, place: string) =>
  click(within(within(dialog).getByRole("radiogroup", { name: tool })).getByRole("radio", { name: place }));
const chosen = (dialog: HTMLElement, tool: string) =>
  within(within(dialog).getByRole("radiogroup", { name: tool }))
    .getAllByRole("radio")
    .find((r) => r.getAttribute("aria-checked") === "true")?.textContent;
/** What each choice sent: the tool and its place (null: back on its default), or `{}` for Restaurar o padrão. */
const sent = (state: State) =>
  state.calls
    .filter((c) => c.method === "orgs.setSidebarItem" || c.method === "orgs.setSidebarItems")
    .map((c) => c.args.slice(1));
const noneWaiting = () => {
  const state = seedState();
  for (const a of state.approvals) a.status = "approved";
  return state;
};

describe("the bell", () => {
  test("at the end of my row at the bottom, saying how many are unread; no longer on top", async () => {
    await go(
      seedState({
        notifications: [notification({ id: "n1", kind: "mention" }), notification({ id: "n2", kind: "dm" })],
      }),
    );
    const bell = within(nav()).getByRole("link", { name: "2 notificações não lidas" });
    expect(bell.getAttribute("href")).toBe(`/org/${ORG_ID}/notifications`);
    expect(bell.closest(".sidebar__me")).toBeTruthy();
    expect(bell.textContent).toBe("2");
    expect(listed()).not.toContain("Notificações");
  });

  test("nothing unread: the bell alone, named Notificações", async () => {
    await go();
    const bell = within(nav()).getByRole("link", { name: "Notificações" });
    expect(bell.textContent).toBe("");
  });
});

describe("the tools on top", () => {
  test("by default Threads, Tarefas and Drive, Aprovações while some wait; the rest in More, then Personalizar", async () => {
    await go();
    expect(rows()[0]).toBe("Início");
    expect(listed()).toEqual(["Aprovações", "Threads", "Tarefas", "Drive"]);
    const more = await openMore();
    expect(inMore(more)).toEqual(["Wiki", "Rotinas", "Calendário", "Fórum"]);
    expect(within(more).getByRole("button", { name: "Personalizar a barra lateral" })).toBeTruthy();
    cleanup();
    await go(noneWaiting());
    expect(listed()).toEqual(["Threads", "Tarefas", "Drive"]);
    expect(inMore(await openMore())).toEqual(["Aprovações", "Wiki", "Rotinas", "Calendário", "Fórum"]);
  });

  test("Personalizar: each choice moves the tool at once and is saved for me; Restaurar o padrão undoes them", async () => {
    const state = await go(noneWaiting());
    const dialog = await openSetup();
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
    expect(chosen(dialog, "Aprovações")).toBe("Quando tiver algo");
    // Only a tool with a count can wait until there's something.
    const offered = (tool: string) =>
      within(within(dialog).getByRole("radiogroup", { name: tool }))
        .getAllByRole("radio")
        .map((r) => r.textContent);
    expect(offered("Threads")).toEqual(["Sempre", "Em Mais", "Quando tiver algo"]);
    expect(offered("Wiki")).toEqual(["Sempre", "Em Mais"]);
    const reset = within(dialog).getByRole("button", { name: "Restaurar o padrão" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);

    await choose(dialog, "Wiki", "Sempre");
    expect(listed()).toEqual(["Threads", "Tarefas", "Wiki", "Drive"]);
    await choose(dialog, "Drive", "Em Mais");
    await choose(dialog, "Aprovações", "Sempre");
    // Threads with no mission waiting for me: in More until one does.
    await choose(dialog, "Threads", "Quando tiver algo");
    expect(listed()).toEqual(["Aprovações", "Tarefas", "Wiki"]);
    // One tool each time: what another device chose meanwhile stays.
    expect(sent(state)).toEqual([
      ["wiki", "always"],
      ["drive", "more"],
      ["approvals", "always"],
      ["threads", "auto"],
    ]);
    expect(state.sidebarItems).toEqual({ wiki: "always", drive: "more", approvals: "always", threads: "auto" });
    // Back on its default: the tool leaves the saved choices.
    await choose(dialog, "Threads", "Sempre");
    expect(sent(state).at(-1)).toEqual(["threads", null]);
    expect(state.sidebarItems).toEqual({ wiki: "always", drive: "more", approvals: "always" });

    expect(reset.disabled).toBe(false);
    await click(reset);
    expect(listed()).toEqual(["Threads", "Tarefas", "Drive"]);
    expect(sent(state).at(-1)).toEqual([{}]);
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
  });

  test("another device moved a tool after this one loaded: Personalizar shows it, and a choice here keeps it", async () => {
    const state = await go(noneWaiting());
    state.sidebarItems = { wiki: "always" };
    const dialog = await openSetup();
    expect(chosen(dialog, "Wiki")).toBe("Sempre");
    expect(listed()).toEqual(["Threads", "Tarefas", "Wiki", "Drive"]);
    await choose(dialog, "Drive", "Em Mais");
    expect(state.sidebarItems).toEqual({ wiki: "always", drive: "more" });
    expect(listed()).toEqual(["Threads", "Tarefas", "Wiki"]);
  });

  test("the choices couldn't be read: a choice here moves only its tool, and the server's answer shows the rest", async () => {
    const state = noneWaiting();
    state.sidebarItems = { wiki: "always", routines: "always" };
    const api = createFakeApi(state);
    api.orgs.sidebarItems = async () => {
      throw new ApiError(500, "internal", "Não deu");
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const dialog = await openSetup();
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
    await choose(dialog, "Drive", "Em Mais");
    expect(state.sidebarItems).toEqual({ wiki: "always", routines: "always", drive: "more" });
    expect(chosen(dialog, "Wiki")).toBe("Sempre");
    expect(listed()).toEqual(["Threads", "Tarefas", "Wiki", "Rotinas"]);
  });

  test("the choices are the server's: the same sidebar on every device", async () => {
    await go(seedState({ sidebarItems: { drive: "more", routines: "always", approvals: "more" } }));
    expect(listed()).toEqual(["Threads", "Tarefas", "Rotinas"]);
    expect(inMore(await openMore())).toEqual(["Aprovações", "Wiki", "Drive", "Calendário", "Fórum"]);
  });

  test("the server refuses: the tool goes back where it was", async () => {
    const state = seedState();
    state.sidebarItemsError = new ApiError(500, "internal", "Não deu");
    await go(state);
    const dialog = await openSetup();
    await choose(dialog, "Wiki", "Sempre");
    await settle(3);
    expect(listed()).toEqual(["Aprovações", "Threads", "Tarefas", "Drive"]);
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
  });

  test("two choices in a row, both refused: the sidebar ends as the server keeps it", async () => {
    const state = seedState();
    state.sidebarItemsError = new ApiError(500, "internal", "Não deu");
    const api = createFakeApi(state);
    const refuse = api.orgs.setSidebarItem;
    let release = () => {};
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    api.orgs.setSidebarItem = async (orgId, item, place) => {
      if (calls++ === 0) await first;
      return refuse(orgId, item, place);
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const dialog = await openSetup();
    await choose(dialog, "Wiki", "Sempre");
    // The second waits for the first, and shows at once.
    await choose(dialog, "Drive", "Em Mais");
    expect(listed()).toEqual(["Aprovações", "Threads", "Tarefas", "Wiki"]);
    await act(async () => release());
    await settle(6);
    expect(calls).toBe(2);
    expect(listed()).toEqual(["Aprovações", "Threads", "Tarefas", "Drive"]);
    expect(chosen(dialog, "Wiki")).toBe("Em Mais");
  });
});

describe("the sidebar's parts", () => {
  test("lines between the tools, the channels, the agents and the people; Agentes and Mensagens diretas aren't categories", async () => {
    const state = seedState();
    state.channelCategories = [{ id: "00000000-0000-4000-8000-0000000000f1", name: "Engenharia", position: 0 }];
    for (const c of state.channels) if (c.id === ENG_ID) c.categoryId = "00000000-0000-4000-8000-0000000000f1";
    await go(state);
    const section = (name: string) =>
      within(nav()).getByRole("button", { name }).closest(".sidebar__section") as HTMLElement;
    expect(nav().querySelectorAll(".sidebar__divider")).toHaveLength(3);
    for (const part of ["Agentes", "Mensagens diretas"]) {
      expect(section(part).previousElementSibling?.className).toBe("sidebar__divider");
      expect(section(part).classList.contains("sidebar__section--part")).toBe(true);
    }
    expect(section("Engenharia").classList.contains("sidebar__section--part")).toBe(false);
  });
});
