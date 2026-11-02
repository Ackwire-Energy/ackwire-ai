import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type Member } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, meAsAdmin, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/* Taking someone out of the workspace from Members: who may, the confirmation in place, and the server's refusals. */

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const bia: Member = {
  userId: "u-bia",
  name: "Bia",
  email: "bia@example.com",
  image: null,
  role: "member",
  roleIds: [],
  joinedAt: new Date(Date.now() - 86_400_000).toISOString(),
  handle: "bia",
  timezone: "America/Sao_Paulo",
};

async function members(state = seedState(), api = createFakeApi(state)) {
  await renderApp(`/org/${ORG_ID}/settings/members`, { api });
  await settle(6);
  return state;
}
async function openRemove(name: string) {
  const trigger = screen().getByRole("button", { name: `Opções de ${name}` });
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
  await click(screen().getByRole("menuitem", { name: "Remover do workspace" }));
  await settle(2);
  return screen().getByRole("dialog", { name: `Remover ${name} da Acme?` });
}

describe("removing a member", () => {
  test("the owner removes someone after confirming in place; their own row has no such menu", async () => {
    const state = await members();
    expect(screen().queryByRole("button", { name: "Opções de Walter" })).toBeNull();
    const dialog = await openRemove("João");
    expect(dialog.textContent).toContain("perde o acesso à Acme na hora");
    await click(within(dialog).getByRole("button", { name: "Remover" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.removeMember")?.args).toEqual([ORG_ID, "u-joao"]);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(screen().getByText("João saiu da Acme.")).toBeTruthy();
    expect(screen().queryByText("joao@acme.com.br")).toBeNull();
  });

  test("Cancelar removes nobody", async () => {
    const state = await members();
    const dialog = await openRemove("João");
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await settle(2);
    expect(state.calls.some((c) => c.method === "orgs.removeMember")).toBe(false);
    expect(screen().getByText("joao@acme.com.br")).toBeTruthy();
  });

  test("an admin removes only who is below them: not the owner, not another admin", async () => {
    const state = seedState();
    meAsAdmin(state);
    state.members.push(bia);
    await members(state);
    expect(screen().queryByRole("button", { name: "Opções de Walter" })).toBeNull();
    expect(screen().queryByRole("button", { name: "Opções de João" })).toBeNull();
    expect(screen().getByRole("button", { name: "Opções de Bia" })).toBeTruthy();
  });

  test("a member who doesn't manage members sees no menu at all", async () => {
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) org.role = "member";
    const me = state.members.find((m) => m.userId === state.me?.user.id);
    if (me) me.roleIds = [];
    state.members.push(bia);
    await members(state);
    expect(screen().queryByRole("button", { name: /^Opções de / })).toBeNull();
  });

  test("the server's refusal stays in the dialog, in our words", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    api.orgs.removeMember = async () => {
      throw new ApiError(409, "org.last_owner", "An organization needs at least one owner");
    };
    await members(state, api);
    const dialog = await openRemove("João");
    await click(within(dialog).getByRole("button", { name: "Remover" }));
    await settle(4);
    expect(dialog.textContent).toContain("Um workspace precisa de pelo menos um dono.");
    expect(screen().getByText("joao@acme.com.br")).toBeTruthy();
  });
});
