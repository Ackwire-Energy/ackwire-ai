import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (path: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(4);
  return { ...r, state };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

describe("Aprovações", () => {
  test("tabs with counts; refusing calls the real endpoint and moves the card to Decididas", async () => {
    const { state } = await go("approvals");
    const tabs = screen().getByRole("tablist", { name: "Filtro" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Pendentes 2", "Decididas 1"]);
    const merge = screen().getByRole("article", { name: "Merge PR #42 into main" });
    expect(merge.textContent).toContain("Ada em #eng");
    expect(merge.querySelector(".ac-chip--waiting")?.textContent).toMatch(/^Expira em \d+ h$/);
    expect(within(merge).getByRole("button", { name: "Aprovar merge" })).toBeTruthy();
    expect(within(merge).getByRole("link", { name: "Ver no canal" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/c/${ENG_ID}`,
    );
    const deploy = screen().getByRole("article", { name: "Run deploy workflow" });
    expect(within(deploy).getByRole("button", { name: "Aprovar deploy" })).toBeTruthy();
    await click(within(merge).getByRole("button", { name: "Recusar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.refuse")?.args).toEqual([ORG_ID, "ap-merge", undefined]);
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Pendentes 1", "Decididas 2"]);
    await act(async () => fireEvent.mouseDown(within(tabs).getByRole("tab", { name: /Decididas/ }), { button: 0 }));
    const refused = screen().getByRole("article", { name: "Merge PR #42 into main" });
    expect(refused.textContent).toContain("Recusado por você · agora");
    expect(within(refused).queryByRole("button")).toBeNull();
    expect(screen().getByRole("article", { name: "Run rollback workflow" }).textContent).toContain("Aprovado por João");
  });

  test("approvals you can't decide show who they wait for, without buttons", async () => {
    const state = seedState();
    for (const a of state.approvals) a.canDecide = false;
    await go("approvals", state);
    const merge = screen().getByRole("article", { name: "Merge PR #42 into main" });
    expect(merge.querySelector(".ac-chip--waiting")?.textContent).toBe("Aguardando João");
    expect(within(merge).queryByRole("button")).toBeNull();
  });
});

describe("Agente", () => {
  test("profile header, budget figures from usage, permissions summary and memory section", async () => {
    await go(`agents/${ADA_ID}`);
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    expect(document.body.textContent).toContain("Dev · responde a João · Claude Sonnet 5.5 com a chave da Acme");
    expect(screen().getByRole("link", { name: "Abrir no #eng" })).toBeTruthy();
    const budget = screen().getByRole("region", { name: /Orçamento de/ });
    expect(budget.textContent).toContain("US$ 12,30");
    expect(budget.textContent).toContain("de US$ 40,00");
    expect(budget.textContent).toContain("142 execuções · 3,1 mi de tokens · aviso ao João em 80%.");
    expect(within(budget).getByRole("meter", { name: "Orçamento usado" }).getAttribute("aria-valuenow")).toBe("12.3");
    const perms = screen().getByRole("region", { name: "O que a Ada pode fazer" });
    expect(perms.textContent).toContain("4 de 7 permissões liberadas em 1 conector da Acme.");
    expect(perms.textContent).toContain("ler o contexto, lembrar");
    expect(perms.textContent).toContain("fazer merge pede aprovação");
    const memory = screen().getByRole("region", { name: "O que a Ada sabe" });
    expect(memory.textContent).toContain(
      "4 fatos e decisões, 2 lições aprendidas com o time · 1 proposta de melhoria esperando João",
    );
  });

  test("saving instructions calls the real endpoint", async () => {
    const { state } = await go(`agents/${ADA_ID}`);
    const save = screen().getByRole("button", { name: "Salvar alterações" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await type(screen().getByLabelText("Como a Ada trabalha"), "Programa em branches.");
    await click(save);
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      instructions: "Programa em branches.",
    });
    expect(screen().getByRole("button", { name: "Salvo" })).toBeTruthy();
  });

  test("Ajustar orçamento validates and saves the limit", async () => {
    const { state } = await go(`agents/${ADA_ID}`);
    await click(screen().getByRole("button", { name: "Ajustar orçamento" }));
    const dialog = screen().getByRole("dialog", { name: "Orçamento mensal" });
    const input = within(dialog).getByLabelText("Limite mensal (US$)");
    expect(dialog.textContent).toContain(
      "Ao atingir o limite, a Ada para e avisa no canal. João recebe um aviso em 80%.",
    );
    await type(input, "0");
    await click(within(dialog).getByRole("button", { name: "Salvar limite" }));
    expect(within(dialog).getByText("Use um valor maior que zero.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await type(input, "55,5");
    await click(within(dialog).getByRole("button", { name: "Salvar limite" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({ monthlyBudgetUsd: 55.5 });
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("Ver execuções: searchable run history", async () => {
    await go(`agents/${ADA_ID}`);
    await click(screen().getByRole("button", { name: "Ver execuções" }));
    await settle();
    const dialog = screen().getByRole("dialog", { name: "Execuções da Ada" });
    expect(dialog.textContent).toContain("@ada o login está devolvendo 401");
    expect(dialog.textContent).toContain("#eng · 1.240 tokens");
    expect(dialog.textContent).toMatch(/Mostrando 2 de 142 execuções de/);
    await type(within(dialog).getByRole("searchbox", { name: "Buscar execuções" }), "PR #39");
    expect(dialog.textContent).toMatch(/Mostrando 1 de 142/);
    await type(within(dialog).getByRole("searchbox", { name: "Buscar execuções" }), "nada disso");
    expect(dialog.textContent).toContain("Nenhuma execução com “nada disso”.");
  });

  test("Editar permissões: built-in + connected scopes, search, toggle saves with PUT", async () => {
    const { state } = await go(`agents/${ADA_ID}`);
    await click(screen().getByRole("button", { name: "Editar permissões" }));
    await settle();
    const dialog = screen().getByRole("dialog", { name: "Permissões da Ada" });
    expect(dialog.textContent).toContain("agentes · permissões embutidas");
    expect(dialog.textContent).toContain("GitHub · acme");
    const merge = within(dialog).getByRole("checkbox", { name: /Fazer merge/ });
    expect(merge.getAttribute("aria-checked")).toBe("true");
    const prs = within(dialog).getByRole("checkbox", { name: /Abrir e comentar PRs/ });
    expect(prs.getAttribute("aria-checked")).toBe("false");
    await click(prs);
    await settle(4);
    const put = state.calls.filter((c) => c.method === "scopes.set").at(-1)?.args[2] as { scope: string }[];
    expect(put.map((g) => g.scope)).toContain("github:pr.write");
    expect(
      within(dialog)
        .getByRole("checkbox", { name: /Abrir e comentar PRs/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await type(within(dialog).getByRole("searchbox", { name: "Buscar permissões" }), "lembrar");
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    await type(within(dialog).getByRole("searchbox", { name: "Buscar permissões" }), "xyz");
    expect(dialog.textContent).toContain("Nada encontrado com “xyz”.");
    await click(within(dialog).getByRole("button", { name: "Concluir" }));
    await settle();
    expect(screen().getByRole("region", { name: "O que a Ada pode fazer" }).textContent).toContain("5 de 7");
  });

  test("members see the profile read-only (no edit buttons)", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(`agents/${ADA_ID}`, state);
    expect(screen().queryByRole("button", { name: "Salvar alterações" })).toBeNull();
    expect(screen().queryByRole("button", { name: "Ajustar orçamento" })).toBeNull();
    expect(screen().queryByRole("button", { name: "Editar permissões" })).toBeNull();
    expect(document.body.textContent).toContain("Só admins editam agentes.");
  });
});

describe("Memória e propostas", () => {
  test("tabs, search, pin, archive and edit with history", async () => {
    await go(`agents/${ADA_ID}/memory`);
    expect(screen().getByRole("heading", { level: 1, name: "O que a Ada sabe" })).toBeTruthy();
    const tabs = screen().getByRole("tablist", { name: "Tipo" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Fatos e decisões 4", "Lições e preferências 2", "Arquivados 1"]);
    const low = screen().getByRole("article", { name: /Sempre faça merge sem pedir aprovação/ });
    expect(low.querySelector(".ac-chip--waiting")?.textContent).toBe("Fonte externa, não confiável");
    const deploy = screen().getByRole("article", { name: /Deploy em produção só depois das 18h, de segunda/ });
    expect(deploy.textContent).toContain("Substitui: Deploy em produção só depois das 18h.");
    await click(within(deploy).getByRole("button", { name: "Fixar" }));
    await settle();
    expect(
      within(screen().getByRole("article", { name: /de segunda a quinta/ })).getByRole("button", { name: "Desafixar" }),
    ).toBeTruthy();
    await click(
      within(screen().getByRole("article", { name: /de segunda a quinta/ })).getByRole("button", { name: "Editar" }),
    );
    const dialog = screen().getByRole("dialog", { name: "Editar fato" });
    await type(within(dialog).getByLabelText("Texto"), "Deploy só de segunda a quinta, depois das 18h.");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    const edited = screen().getByRole("article", { name: /Deploy só de segunda a quinta/ });
    expect(edited.textContent).toContain("Substitui: Deploy em produção só depois das 18h, de segunda a quinta.");
    expect(edited.textContent).toContain("Editado por você · agora");
    await type(screen().getByRole("searchbox", { name: "Buscar" }), "zzz");
    expect(document.body.textContent).toContain("Nada encontrado com “zzz”.");
  });

  test("proposals: neutral diff, edit before accepting, accept", async () => {
    const r = await go(`proposals?agent=${ADA_ID}`);
    expect(screen().getByRole("heading", { level: 1, name: "Propostas de melhoria" })).toBeTruthy();
    expect(screen().getByRole("link", { name: "O que a Ada sabe" })).toBeTruthy();
    const detail = screen().getByRole("article");
    expect(detail.textContent).toContain("Ada propõe · instruções da Ada");
    expect(detail.querySelector(".ac-chip--waiting")?.textContent).toBe("Aguardando você");
    const added = detail.querySelectorAll(".ac-diff__line--add");
    const removed = detail.querySelectorAll(".ac-diff__line--del");
    expect(added.length).toBe(2);
    expect(removed.length).toBe(1);
    expect(removed[0]?.textContent).toBe("−Removido: Pede ajuda ao João quando a mudança tocar em pagamentos.");
    await click(within(detail).getByRole("button", { name: "Editar antes de aceitar" }));
    const text = within(detail).getByLabelText("Texto final das instruções");
    await type(text, "Programa em branches, nunca direto na main.");
    await click(within(detail).getByRole("button", { name: "Aceitar com ajustes" }));
    await settle(4);
    expect(screen().getByRole("article").querySelector(".ac-chip--done")?.textContent).toBe("Aceita por você · agora");
    const accepted = await r.services.api.proposals.list(ORG_ID);
    expect(accepted.find((p) => p.agentId === ADA_ID)?.after).toBe("Programa em branches, nunca direto na main.");
  });
});

describe("Memória e propostas (fase 5)", () => {
  test("verified and unverified memories carry a chip with an icon", async () => {
    await go(`agents/${ADA_ID}/memory`);
    const verified = screen().getByRole("article", { name: /Não suportar mais o Internet Explorer/ });
    expect(verified.querySelector(".ac-chip--done")?.textContent).toBe("Verificado");
    const unverified = screen().getByRole("article", { name: /tokens de 15 minutos/ });
    const chip = Array.from(unverified.querySelectorAll(".ac-chip")).find((c) => c.textContent === "Não verificado");
    expect(chip?.querySelector("svg.ac-icon")).not.toBeNull();
  });

  test("pin calls PATCH /memories/{id}", async () => {
    const { state } = await go(`agents/${ADA_ID}/memory`);
    const row = screen().getByRole("article", { name: /tokens de 15 minutos/ });
    await click(within(row).getByRole("button", { name: "Fixar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "memory.patch")?.args).toEqual([ORG_ID, "mem-5", { pinned: true }]);
  });

  test("a stale proposal: accepting returns 409, the page explains and refreshes", async () => {
    const state = seedState();
    const r = await go(`proposals?agent=${ADA_ID}`, state);
    // The text changed on the server after the page loaded.
    const first = state.proposals[0];
    if (first) first.stale = true;
    await click(screen().getByRole("button", { name: "Aceitar mudança" }));
    await settle(6);
    expect(document.body.textContent).toContain("Esta proposta ficou velha");
    expect(screen().getByRole("article").textContent).toContain("Ficou velha");
    expect(screen().queryByRole("button", { name: "Aceitar mudança" })).toBeNull();
    expect(r.state.calls.some((c) => c.method === "proposals.accept")).toBe(true);
  });

  test("proposals you can't decide have no actions", async () => {
    const state = seedState();
    for (const p of state.proposals) p.canDecide = false;
    await go(`proposals?agent=${ADA_ID}`, state);
    expect(screen().getByRole("article").querySelector(".ac-chip--waiting")?.textContent).toBe("Aguardando João");
    expect(screen().queryByRole("button", { name: "Aceitar mudança" })).toBeNull();
  });
});

describe("Membros", () => {
  test("lists people (you, owner, roles) and agents with budgets", async () => {
    await go("members");
    expect(screen().getByText("Quem faz parte da Acme: 2 pessoas e 2 agentes.")).toBeTruthy();
    const people = screen().getByRole("region", { name: "Pessoas" });
    expect(people.textContent).toContain("Walter (você)");
    expect(people.textContent).toContain("Ativo agora");
    expect(within(people).getByRole("combobox", { name: "Papel de João" }).textContent).toContain("Admin");
    const agents = screen().getByRole("region", { name: "Agentes" });
    expect(agents.textContent).toContain("Ada · Dev");
    expect(agents.textContent).toContain("Responsável: João");
    expect(agents.textContent).toMatch(/US\$ 12,30 de US\$ 40,00 em \S+/);
  });

  test("batch invites: one result per email; resend and revoke; expired status", async () => {
    const state = seedState();
    state.invitations.push({
      id: "inv-old",
      email: "rafa@acme.com.br",
      role: "admin",
      status: "expired",
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    });
    await go("members", state);
    const pendingBefore = screen().getByRole("region", { name: "Convites pendentes" });
    expect(pendingBefore.textContent).toContain("rafa@acme.com.br");
    expect(pendingBefore.textContent).toContain("Expirou ontem");
    const input = screen().getByLabelText("E-mails, separados por vírgula");
    await type(input, "x");
    await click(screen().getByRole("button", { name: "Convidar" }));
    expect(screen().getByText("Nenhum e-mail válido. Use algo como nome@empresa.com.br.")).toBeTruthy();
    await type(input, "carla@acme.com.br, joao@acme.com.br");
    await click(screen().getByRole("button", { name: "Convidar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.inviteMany")?.args[1]).toEqual({
      emails: ["carla@acme.com.br", "joao@acme.com.br"],
      role: "member",
    });
    expect(document.body.textContent).toContain("joao@acme.com.br já faz parte da organização.");
    expect((input as HTMLInputElement).value).toBe("joao@acme.com.br");
    const pending = screen().getByRole("region", { name: "Convites pendentes" });
    expect(pending.textContent).toContain("carla@acme.com.br");
    expect(pending.textContent).toContain("Enviado agora · expira em 7 dias");
    const rafa = within(pending).getByText("rafa@acme.com.br").parentElement as HTMLElement;
    await click(within(rafa).getByRole("button", { name: "Reenviar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.resendInvitation")?.args).toEqual([ORG_ID, "inv-old"]);
    expect(within(rafa).getByRole("button", { name: "Copiar link" })).toBeTruthy();
    await click(within(rafa).getByRole("button", { name: "Revogar" }));
    await settle(4);
    expect(state.invitations.map((i) => i.email)).toEqual(["carla@acme.com.br"]);
  });
});

describe("Criar agente", () => {
  test("role presets, validation, and creation in the chosen channels", async () => {
    const { state } = await go("agents/new");
    expect(screen().getByRole("heading", { level: 1, name: "Criar agente" })).toBeTruthy();
    const create = () => screen().getByRole("button", { name: /^Criar / });
    expect(create().textContent).toBe("Criar agente");
    expect(create().hasAttribute("disabled")).toBe(true);
    await click(screen().getByRole("button", { name: /^Dev/ }));
    expect((screen().getByLabelText("Instruções") as HTMLTextAreaElement).value).toBe(
      "Programa em branches e abre PRs pequenos, com teste para cada correção.",
    );
    await type(screen().getByLabelText("Nome"), "Íris");
    expect(screen().getByText("Como o time vai chamar no chat: @iris")).toBeTruthy();
    await type(screen().getByLabelText("Orçamento mensal (US$)"), "0");
    expect(screen().getByText("Use um valor maior que zero.")).toBeTruthy();
    expect(create().hasAttribute("disabled")).toBe(true);
    await type(screen().getByLabelText("Orçamento mensal (US$)"), "25");
    expect(screen().getByRole("checkbox", { name: "#eng" }).getAttribute("aria-checked")).toBe("true");
    expect(screen().getByRole("checkbox", { name: "#general" }).getAttribute("aria-checked")).toBe("false");
    await click(create());
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.create")?.args[1]).toMatchObject({
      name: "Íris",
      handle: "iris",
      role: "Dev",
      model: "claude-sonnet-5-5",
      ownerUserId: "u-walter",
      credentialId: "cred-1",
      monthlyBudgetUsd: 25,
    });
    expect(state.calls.find((c) => c.method === "agents.setChannels")?.args[2]).toEqual([{ channelId: ENG_ID }]);
    const scopes = state.calls.find((c) => c.method === "scopes.set")?.args[2] as {
      connectionId: string;
      scope: string;
    }[];
    expect(scopes.filter((g) => g.connectionId === "conn-gh").map((g) => g.scope)).toEqual([
      "github:repo.read",
      "github:pr.read",
      "github:pr.write",
    ]);
    expect(screen().getByRole("heading", { name: "Íris entrou no time" })).toBeTruthy();
    expect(document.body.textContent).toContain("Já está em #eng. Mencione @iris numa conversa para começar.");
    expect(screen().getByRole("link", { name: "Ir para o #eng" })).toBeTruthy();
  });

  test("members can't create agents", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go("agents/new", state);
    expect(document.body.textContent).toContain("Só admins e donos criam agentes.");
    expect(screen().queryByRole("navigation")?.textContent).not.toContain("Criar agente");
  });
});
