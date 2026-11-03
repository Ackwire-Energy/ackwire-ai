import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AiStatus } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { COMPACT_QUERY, DESKTOP_QUERY } from "@/components/NavDrawer";
import { TABLET_QUERY } from "@/components/Sidebar";
import { STORAGE_KEYS } from "@/lib/storage";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let media: { mockRestore: () => void } | null = null;
/** Only `query` matches (a desktop, a tablet, a phone). */
const widthIs = (query: string) => {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === query,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
};

afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
  localStorage.clear();
});

const COLUMN_KEY = `${STORAGE_KEYS.membersColumn}.u-walter.${ORG_ID}`;
const toggle = () => screen().getByRole("button", { name: "Membros do canal (4)" });
const column = () => screen().queryByRole("complementary", { name: "Membros de #eng" });

const open = async (state: FakeState = seedState()) => {
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) (ada as { appearance?: unknown }).appearance = { color: "amber", accessory: "hat" };
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  await act(async () => r.sockets.last().open());
  return { state, sockets: r.sockets };
};

describe("the members column", () => {
  test("open by default on a desktop; the toggle closes it and the choice outlives a remount", async () => {
    widthIs(DESKTOP_QUERY);
    await open();
    expect(column()).toBeTruthy();
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().getAttribute("title")).toBe("Esconder membros");
    expect(toggle().querySelectorAll(".ac-avatar")).toHaveLength(0);
    await act(async () => fireEvent.click(toggle()));
    expect(column()).toBeNull();
    expect(localStorage.getItem(COLUMN_KEY)).toBe("0");
    cleanup();
    await open();
    expect(column()).toBeNull();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  test("closed by default on a tablet, where the toggle opens it beside the chat", async () => {
    widthIs(TABLET_QUERY);
    await open();
    expect(column()).toBeNull();
    await act(async () => fireEvent.click(toggle()));
    expect(column()).toBeTruthy();
    expect(localStorage.getItem(COLUMN_KEY)).toBe("1");
  });

  test("groups: the owner with the crown, the hoisted Admin, the agents, then offline; you, and the agents' lines", async () => {
    widthIs(DESKTOP_QUERY);
    const state = seedState();
    state.online.add("u-joao");
    const { sockets } = await open(state);
    const side = column() as HTMLElement;
    const heads = [...side.querySelectorAll(".members-side__head")].map((h) => h.textContent);
    expect(heads).toEqual(["Dono · 1", "Admin · 1", "Agentes · 2"]);
    // The owner's and each role's group carry their mark.
    expect(side.querySelectorAll(".members-side__head .ac-rolemark")).toHaveLength(2);
    const owner = within(side).getByRole("region", { name: "Dono" });
    expect(within(owner).getByRole("img", { name: "Dono do workspace" })).toBeTruthy();
    expect(owner.textContent).toContain("você");
    expect(within(side).getByRole("region", { name: "Admin" }).textContent).toContain("João");
    const agents = within(side).getByRole("region", { name: "Agentes" });
    expect(agents.textContent).toContain("Dev");
    expect(agents.textContent).toContain("responde sem menção");
    // Ada starts thinking: her state here, and the trail behind her row.
    await act(async () =>
      sockets.last().push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "agent.run",
          channelId: ENG_ID,
          threadId: "m-1",
          runId: "r9",
          agentId: ADA_ID,
          status: "running",
        },
      }),
    );
    await settle(2);
    const ada = within(column() as HTMLElement).getByRole("button", { name: "Perfil de Ada" });
    expect(ada.textContent).toContain("pensando");
    expect(ada.querySelector("[data-busy] .sidebar__trail")).toBeTruthy();
    // ↑/↓ between the rows.
    const rows = [...(column() as HTMLElement).querySelectorAll<HTMLElement>(".members-side__row")];
    rows[0]?.focus();
    await act(async () => fireEvent.keyDown(rows[0] as HTMLElement, { key: "ArrowDown" }));
    expect(document.activeElement).toBe(rows[1] as HTMLElement);
  });

  test("someone offline sits under Offline, drawn quieter", async () => {
    widthIs(DESKTOP_QUERY);
    await open();
    const offline = within(column() as HTMLElement).getByRole("region", { name: "Offline" });
    const joao = offline.querySelector(".members-side__inner") as HTMLElement;
    expect(joao.textContent).toContain("João");
    expect(joao.getAttribute("data-presence")).toBe("offline");
  });

  test("a row opens the member's card", async () => {
    widthIs(DESKTOP_QUERY);
    await open();
    await act(async () =>
      fireEvent.click(within(column() as HTMLElement).getByRole("button", { name: "Perfil de João" })),
    );
    await settle(3);
    expect(screen().getByRole("dialog", { name: "Perfil" }).textContent).toContain("João");
  });

  test("not in a DM", async () => {
    widthIs(DESKTOP_QUERY);
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(seedState()) });
    await settle(6);
    expect(document.querySelector(".members-side")).toBeNull();
  });

  test("on a phone: a sheet with the threads, pins and settings buttons, and a field that finds members", async () => {
    widthIs(COMPACT_QUERY);
    await open();
    expect(column()).toBeNull();
    await act(async () => fireEvent.click(toggle()));
    await settle(2);
    const sheet = screen().getByRole("complementary", { name: "Membros de #eng" });
    expect(sheet.classList.contains("members-sheet")).toBe(true);
    expect(within(sheet).getByRole("button", { name: "Configurações do canal" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Mensagens fixadas" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: /^Threads/ })).toBeTruthy();
    await act(async () =>
      fireEvent.change(within(sheet).getByRole("searchbox", { name: "Buscar pessoas e agentes" }), {
        target: { value: "atl" },
      }),
    );
    expect(within(sheet).queryByRole("button", { name: "Perfil de Ada" })).toBeNull();
    expect(within(sheet).getByRole("button", { name: "Perfil de Atlas" })).toBeTruthy();
    // The cog closes the sheet for the channel's details.
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Configurações do canal" })));
    await settle(3);
    expect(screen().queryByRole("complementary", { name: "Membros de #eng" })).toBeNull();
    expect(screen().getByRole("dialog", { name: /eng/ })).toBeTruthy();
  });
});

describe("answering without a mention, as true for my own messages as who picks them", () => {
  const withRouting = async (mine: NonNullable<AiStatus["routing"]>["mine"]) => {
    const state = seedState({
      aiStatus: {
        any: true,
        agents: [],
        routing: { by: mine === "plan" ? "plans" : mine, mine, model: null, noSmallModel: null },
        apiKey: false,
      },
    });
    await open(state);
  };
  const columnAgents = async () => {
    await settle(4);
    return within(column() as HTMLElement).getByRole("region", { name: "Agentes" }).textContent;
  };
  /** The details' row line of an agent that answers on its own, and its menu's "Por conta própria" line. */
  const onItsOwn = async () => {
    await act(async () =>
      fireEvent.click(within(screen().getByRole("main")).getByRole("button", { name: "Configurações do canal" })),
    );
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "#eng" });
    const row = within(dialog).getByText("Atlas").closest(".member-row") as HTMLElement;
    const line = row.querySelector(".small")?.textContent;
    const button = within(row).getByRole("button", { name: "Opções de Atlas" });
    button.focus();
    await act(async () => {
      fireEvent.keyDown(button, { key: "Enter" });
      fireEvent.keyUp(button, { key: "Enter" });
    });
    await settle(1);
    const option = within(screen().getByRole("menu")).getByRole("menuitemradio", { name: /^Por conta própria/ });
    return { line, option: option.querySelector(".ac-menu__desc")?.textContent };
  };

  test("my own plan picks: the chip, and the topic is what calls it", async () => {
    await withRouting("plan");
    expect(await columnAgents()).toContain("responde sem menção");
  });

  test("only rules for my messages: no chip; it still takes replies and follow-ups", async () => {
    await withRouting("rules");
    expect(await columnAgents()).not.toContain("responde sem menção");
    cleanup();
    await withRouting("rules");
    expect(await onItsOwn()).toEqual({
      line: "Também responde a respostas e continuações",
      option: "Também responde a respostas e continuações",
    });
  });

  test("the router off: for now only a mention calls it", async () => {
    await withRouting("off");
    expect(await columnAgents()).not.toContain("responde sem menção");
    cleanup();
    await withRouting("off");
    expect(await onItsOwn()).toEqual({
      line: "Por enquanto, responde só quando alguém menciona",
      option: "Por enquanto, responde só quando alguém menciona",
    });
  });

  test("Jev picks: it joins in on its own, when the topic calls for it", async () => {
    await withRouting("jev");
    expect(await onItsOwn()).toEqual({
      line: "Entra na conversa por conta própria",
      option: "Responde quando o assunto pede, sem precisar de @",
    });
  });
});

describe("the team's coordinator here (ADR 0093)", () => {
  test("its chip says it coordinates the team, and its line in the details what that means", async () => {
    widthIs(DESKTOP_QUERY);
    const state = seedState();
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.coordinator = true;
    await open(state);
    const agents = within(column() as HTMLElement).getByRole("region", { name: "Agentes" });
    const chips = [...agents.querySelectorAll(".members-side__chip")];
    expect(chips.map((c) => c.textContent).sort()).toEqual(["coordena o time", "responde sem menção"]);
    await act(async () =>
      fireEvent.click(within(screen().getByRole("main")).getByRole("button", { name: "Configurações do canal" })),
    );
    await settle(3);
    const row = within(screen().getByRole("dialog", { name: /eng/ }))
      .getByText("Atlas")
      .closest(".member-row") as HTMLElement;
    expect(row.querySelector(".small")?.textContent).toBe("Coordena o time: pega o que ninguém pegou");
  });
});

describe("Settings › Papéis: listed apart", () => {
  test("a role's switch sets whether its people get their own group in the members column", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings/roles`, { api: createFakeApi(state) });
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Admin/ })));
    await settle(4);
    const hoist = screen().getByRole("switch", { name: /Mostrar separado na lista de membros/ });
    expect(hoist.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(hoist));
    await settle(2);
    expect(state.calls.find((c) => c.method === "roles.update")?.args[2]).toEqual({ hoist: false });
  });
});
