import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** I (Walter) am a member; Ada answers only João, her owner: I see her public card. */
const outside = () => {
  const state = seedState();
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) {
    ada.ownerUserId = "u-joao";
    ada.audience = { mode: "owner", userIds: [] };
    ada.instructions = "Os preços da tabela 4 são confidenciais.";
    ada.seesDetails = false;
  }
  return state;
};

describe("an agent seen from outside its audience", () => {
  test("its page is the public card: who answers for it, who it answers, where it works, a way to ask", async () => {
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: createFakeApi(outside()) });
    await settle(8);
    expect(screen().queryByRole("tablist")).toBeNull();
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("tabela 4");
    expect(document.body.textContent).toContain("João");
    const ask = screen().getByRole("link", { name: "Pedir acesso" });
    expect(ask.getAttribute("href")).toBe(`/org/${ORG_ID}/dm/person/u-joao`);
  });

  test("the Team card leaves out what it does and can do, and offers to ask for access", async () => {
    await renderApp(`/org/${ORG_ID}/team`, { api: createFakeApi(outside()) });
    await settle(4);
    const sky = screen().getByRole("region", { name: /Agentes agrupados por pessoa responsável/ });
    await act(async () => fireEvent.click(within(sky).getByRole("button", { name: "Ada, ver detalhes" })));
    await settle(2);
    const card = screen().getByRole("dialog", { name: "Detalhes de Ada" });
    expect(card.textContent).not.toContain("tabela 4");
    expect(card.querySelectorAll(".ac-chip")).toHaveLength(0);
    expect(within(card).getByRole("link", { name: "Pedir acesso" })).toBeTruthy();
    expect(within(card).queryByRole("link", { name: "Editar" })).toBeNull();
  });
});

describe("an agent that doesn't answer an admin", () => {
  /** I (Walter) own the workspace; Ada is João's, kept to the Suporte role I don't hold. */
  const keptOut = () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) {
      ada.ownerUserId = "u-joao";
      ada.audience = { mode: "people", userIds: [], roleIds: ["r-suporte"] };
      ada.canTalk = false;
      ada.seesDetails = true;
    }
    return state;
  };

  test("its conversation opens, says why the composer is off, and lets me in", async () => {
    const state = keptOut();
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const allow = screen().getByRole("button", { name: /Quero falar com/ });
    await act(async () => fireEvent.click(allow));
    await settle(2);
    const update = state.calls.find((c) => c.method === "agents.update");
    expect(update?.args[2]).toEqual({ audience: { mode: "people", userIds: ["u-walter"], roleIds: ["r-suporte"] } });
  });

  test("letting me in when she holds João's mailbox asks first, naming whose access goes, and Cancel keeps it", async () => {
    const state = keptOut();
    state.mailLoss = {
      [ADA_ID]: [{ accountId: "mb-joao", address: "joao@acme.com", ownerUserId: "u-joao", ownerName: "João" }],
    };
    await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const allow = screen().getByRole("button", { name: /Quero falar com/ });
    await act(async () => fireEvent.click(allow));
    await settle(2);
    const ask = screen().getByRole("dialog", { name: "Tirar o acesso à caixa de email?" });
    expect(ask.textContent).toContain("Ada tem acesso à caixa de email de João.");
    await act(async () => fireEvent.click(within(ask).getByRole("button", { name: "Cancelar" })));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(state.calls.some((c) => c.method === "agents.update")).toBe(false);

    await act(async () => fireEvent.click(allow));
    await settle(2);
    const again = screen().getByRole("dialog", { name: "Tirar o acesso à caixa de email?" });
    await act(async () => fireEvent.click(within(again).getByRole("button", { name: "Continuar" })));
    await settle(2);
    expect(state.calls.filter((c) => c.method === "agents.update")).toHaveLength(1);
  });
});
