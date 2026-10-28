import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AiStatus } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async () => {
  const state = seedState();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) (ada as { appearance?: unknown }).appearance = { color: "amber", accessory: "hat" };
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  return { state, sockets: r.sockets };
};

describe("channel header: who's here", () => {
  test("a button with the count; at most 3 avatars, then +N; agents with their look", async () => {
    await open();
    const stack = screen().getByRole("button", { name: "Membros do canal (4)" });
    expect(stack.querySelectorAll(".ac-avatar")).toHaveLength(3);
    expect(stack.textContent).toContain("+1");
    expect(stack.querySelector('[data-accessory="hat"]')).not.toBeNull();
  });

  test("the list: people (você, @handle) and agents (state, chip); arrows move; footer opens the details", async () => {
    const { sockets } = await open();
    await act(async () => sockets.last().open());
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Membros do canal (4)" })));
    await settle(4);
    const people = screen().getByRole("region", { name: "Pessoas" });
    expect(people.textContent).toContain("Walter · você");
    expect(people.textContent).toContain("@");
    const agents = screen().getByRole("region", { name: "Agentes" });
    expect(agents.textContent).toContain("disponível");
    expect(agents.textContent).toContain("responde sem menção");
    // Live state: Ada starts thinking.
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
    expect(screen().getByRole("region", { name: "Agentes" }).textContent).toContain("pensando");
    // ↑/↓ between the rows.
    const rows = [...document.querySelectorAll<HTMLElement>(".members-pop__row")];
    rows[0]?.focus();
    await act(async () => fireEvent.keyDown(rows[0] as HTMLElement, { key: "ArrowDown" }));
    expect(document.activeElement).toBe(rows[1] as HTMLElement);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Ver detalhes do canal" })));
    await settle(3);
    expect(screen().getByRole("dialog", { name: /eng/ })).toBeTruthy();
  });

  test("hover opens it after a short delay", async () => {
    await open();
    const stack = screen().getByRole("button", { name: "Membros do canal (4)" });
    await act(async () => fireEvent.pointerEnter(stack, { pointerType: "mouse" }));
    expect(screen().queryByRole("region", { name: "Pessoas" })).toBeNull();
    await act(() => new Promise((r) => setTimeout(r, 220)));
    await settle(2);
    expect(screen().getByRole("region", { name: "Pessoas" })).toBeTruthy();
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
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    await act(async () => r.sockets.last().open());
  };
  const popoverAgents = async () => {
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Membros do canal (4)" })));
    await settle(4);
    return screen().getByRole("region", { name: "Agentes" }).textContent;
  };
  /** The details' row line of an agent that answers on its own, and its menu's "Por conta própria" line. */
  const onItsOwn = async () => {
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Detalhes do canal" })));
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
    expect(await popoverAgents()).toContain("responde sem menção");
  });

  test("only rules for my messages: no chip; it still takes replies and follow-ups", async () => {
    await withRouting("rules");
    expect(await popoverAgents()).not.toContain("responde sem menção");
    cleanup();
    await withRouting("rules");
    expect(await onItsOwn()).toEqual({
      line: "Também responde a respostas e continuações",
      option: "Também responde a respostas e continuações",
    });
  });

  test("the router off: for now only a mention calls it", async () => {
    await withRouting("off");
    expect(await popoverAgents()).not.toContain("responde sem menção");
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
