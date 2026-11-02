import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADMIN_ROLE_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const go = async (channel: string) => {
  const state = seedState();
  await renderApp(`/org/${ORG_ID}/c/${channel}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args.at(-1));

describe("a channel for departments or roles (ADR 0125)", () => {
  test("Criar canal: the third choice asks for a role, then creates it private and limited to the roles ticked", async () => {
    const state = await go(GENERAL_ID);
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    const plus = within(nav).getByRole("button", { name: "Novo canal ou categoria" });
    await act(async () => {
      fireEvent.keyDown(plus, { key: "Enter" });
      fireEvent.keyUp(plus, { key: "Enter" });
    });
    await settle(2);
    await click(screen().getByRole("menuitem", { name: "Novo canal" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Criar canal" });
    await act(async () => fireEvent.change(within(dialog).getByLabelText("Nome"), { target: { value: "vendas" } }));
    await click(within(dialog).getByRole("radio", { name: /Departamentos ou papéis/ }));
    await settle(3);

    await click(within(dialog).getByRole("button", { name: "Criar #vendas" }));
    await settle(3);
    expect(calls(state, "chat.createChannel")).toEqual([]);
    expect(dialog.textContent).toContain("Escolha pelo menos um papel.");

    await click(within(dialog).getByRole("checkbox", { name: /Admin/ }));
    await click(within(dialog).getByRole("button", { name: "Criar #vendas" }));
    await settle(6);
    expect(calls(state, "chat.createChannel")).toEqual([
      { name: "vendas", visibility: "private", audienceRoleIds: [ADMIN_ROLE_ID] },
    ]);
  });

  test("Detalhes do canal: changed later, saved once a role is ticked; back to Público drops the roles", async () => {
    const state = await go(ENG_ID);
    await click(screen().getByRole("button", { name: "Detalhes do canal" }));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "#eng" });
    await click(within(dialog).getByRole("radio", { name: /Departamentos ou papéis/ }));
    await settle(3);
    expect(calls(state, "chat.update")).toEqual([]);
    await click(within(dialog).getByRole("checkbox", { name: /Admin/ }));
    await settle(3);
    expect(calls(state, "chat.update")).toEqual([{ visibility: "private", audienceRoleIds: [ADMIN_ROLE_ID] }]);

    // Unticking the last role saves nothing, and says why.
    await click(within(dialog).getByRole("checkbox", { name: /Admin/ }));
    await settle(3);
    expect(calls(state, "chat.update")).toHaveLength(1);
    expect(dialog.textContent).toContain("Escolha pelo menos um papel.");
    await click(within(dialog).getByRole("checkbox", { name: /Admin/ }));
    await settle(3);
    expect(calls(state, "chat.update")).toHaveLength(2);

    // Going public opens every message to the workspace: asked first.
    await click(within(dialog).getByRole("radio", { name: /Público/ }));
    await settle(3);
    expect(calls(state, "chat.update")).toHaveLength(2);
    const ask = screen().getByRole("dialog", { name: "Tornar #eng público?" });
    await click(within(ask).getByRole("button", { name: "Cancelar" }));
    await settle(3);
    expect(calls(state, "chat.update")).toHaveLength(2);

    const again = screen().getByRole("dialog", { name: /^#eng/ });
    await click(within(again).getByRole("radio", { name: /Público/ }));
    await settle(3);
    await click(
      within(screen().getByRole("dialog", { name: "Tornar #eng público?" })).getByRole("button", {
        name: "Tornar público",
      }),
    );
    await settle(3);
    expect(calls(state, "chat.update").at(-1)).toEqual({ visibility: "public" });
  });
});
