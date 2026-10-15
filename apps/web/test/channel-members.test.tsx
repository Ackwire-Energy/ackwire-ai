import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
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
