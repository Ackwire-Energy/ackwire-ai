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
  test("profile: header with Conversar and '…', read-only summaries with one Editar each", async () => {
    await go(`agents/${ADA_ID}`);
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    const head = document.querySelector(".agent-head") as HTMLElement;
    expect(head.textContent).toContain("Dev");
    expect(head.textContent).toContain("Claude Sonnet 5.5");
    expect(head.textContent).toContain("Responsável: João");
    expect(within(head).getByRole("link", { name: "Conversar" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/dm/agent/${ADA_ID}`,
    );
    expect(within(head).getByRole("link", { name: "Conversar" }).className).toContain("ac-btn--primary");
    // No form fields on the page itself.
    expect(document.querySelector(".agent-page textarea, .agent-page select")).toBeNull();
    expect(document.querySelector(".agent-page [role='combobox']")).toBeNull();
    const budget = screen().getByRole("region", { name: /Orçamento de/ });
    expect(budget.textContent).toContain("US$ 12,30");
    expect(budget.textContent).toContain("de US$ 40,00");
    expect(budget.textContent).toContain("142 execuções · 3,1 mi de tokens · aviso ao João em 80%.");
    expect(within(budget).getByRole("meter", { name: "Orçamento usado" }).getAttribute("aria-valuenow")).toBe("12.3");
    expect(screen().getByRole("region", { name: "O que a Ada pode fazer" }).textContent).toContain(
      "5 de 15 ferramentas",
    );
    expect(screen().getByRole("region", { name: "Modelo e chave" }).textContent).toContain(
      "Claude Sonnet 5.5 · com a chave da Acme",
    );
    expect(screen().getByRole("region", { name: "Skills" }).textContent).toContain("1 skill: Revisão de PR");
    expect(screen().getByRole("region", { name: "O que a Ada sabe" }).textContent).toContain(
      "4 fatos e decisões, 2 lições aprendidas com o time · 1 proposta de melhoria esperando João",
    );
    for (const name of [
      "Editar Instruções",
      "Editar conhecimento",
      "Editar Modelo e chave",
      "Editar Responsável",
      "Editar permissões",
      "Editar Skills",
    ]) {
      expect(screen().getByRole("button", { name })).toBeTruthy();
    }
  });

  test("Instruções: a large editor in a dialog; Salvar only with changes; closing with changes asks first", async () => {
    const { state } = await go(`agents/${ADA_ID}`);
    await click(screen().getByRole("button", { name: "Editar Instruções" }));
    const dialog = screen().getByRole("dialog", { name: "Como a Ada trabalha" });
    expect(within(dialog).getByRole("button", { name: "Salvar" }).hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Instruções"), "Programa em branches.");
    expect(dialog.textContent).toContain("Alterações não salvas");
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(dialog.textContent).toContain("Descartar as alterações?");
    await click(within(dialog).getByRole("button", { name: "Continuar editando" }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({
      instructions: "Programa em branches.",
    });
    expect(screen().queryByRole("dialog", { name: "Como a Ada trabalha" })).toBeNull();
    expect(screen().getByText("Alterações da Ada salvas.")).toBeTruthy();
  });

  test("Modelo e chave: both in one dialog", async () => {
    const { state } = await go(`agents/${ADA_ID}`);
    await click(screen().getByRole("button", { name: "Editar Modelo e chave" }));
    const dialog = screen().getByRole("dialog", { name: "Modelo e chave" });
    expect(within(dialog).getByRole("combobox", { name: "Modelo" })).toBeTruthy();
    expect(within(dialog).getByRole("combobox", { name: "Chave" })).toBeTruthy();
    const model = within(dialog).getByRole("combobox", { name: "Modelo" });
    model.focus();
    await act(async () => fireEvent.keyDown(model, { key: "Enter" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await click(within(screen().getByRole("listbox")).getByRole("option", { name: /Opus/ }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({ model: "claude-opus-5-5" });
  });

  test("Conhecimento: what the agent knows, with search", async () => {
    await go(`agents/${ADA_ID}`);
    await click(screen().getByRole("button", { name: "Editar conhecimento" }));
    const dialog = screen().getByRole("dialog", { name: "O que a Ada sabe" });
    expect(dialog.querySelectorAll(".ac-list__row").length).toBeGreaterThan(0);
    await type(within(dialog).getByRole("searchbox", { name: "Buscar no que sabe" }), "zzz-nada");
    expect(dialog.textContent).toContain("Nada com “zzz-nada”.");
    expect(within(dialog).getByRole("link", { name: "Editar a memória" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/agents/${ADA_ID}/memory`,
    );
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
    await click(
      within(screen().getByRole("region", { name: /Orçamento de/ })).getByRole("button", { name: "Ver execuções" }),
    );
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

  test("Editar permissões: the tool tree (all tools, connector, deny) saves with PUT …/access", async () => {
    const { state } = await go(`agents/${ADA_ID}`);
    await click(screen().getByRole("button", { name: "Editar permissões" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Permissões da Ada" });
    expect(dialog.textContent).toContain("5 de 15 ferramentas");
    // Built-ins are grouped by area; only the memory tools are on, so the area is partial.
    const memory = within(dialog).getByRole("region", { name: "Contexto e memória" });
    expect(within(memory).getByRole("checkbox", { name: "Contexto e memória" }).getAttribute("aria-checked")).toBe(
      "mixed",
    );
    const github = within(dialog).getByRole("region", { name: "GitHub" });
    const merge = within(github).getByRole("checkbox", { name: "Fazer merge" });
    expect(merge.closest("li")?.textContent).toContain("pede aprovação");
    // One tool of the connector: the connector checkbox goes indeterminate.
    await click(within(github).getByRole("checkbox", { name: "Abrir PR" }));
    expect(within(github).getByRole("checkbox", { name: "Todas deste conector" }).getAttribute("aria-checked")).toBe(
      "mixed",
    );
    // All tools: children inherited; deny one.
    await click(within(dialog).getByRole("switch", { name: "Todas as ferramentas (atuais e futuras)" }));
    expect(dialog.textContent).toContain("Ações sensíveis continuam pedindo aprovação.");
    await click(within(github).getByRole("button", { name: "Bloquear Fazer merge" }));
    expect(merge.closest("li")?.textContent).toContain("Bloqueada");
    expect(dialog.textContent).toContain("14 de 15 ferramentas");
    await type(within(dialog).getByRole("searchbox", { name: "Buscar ferramenta" }), "merge");
    expect(
      within(dialog)
        .getAllByRole("checkbox")
        .filter((c) => c.closest("li")),
    ).toHaveLength(1);
    await click(within(dialog).getByRole("button", { name: "Salvar permissões" }));
    await settle(4);
    const put = state.calls.filter((c) => c.method === "access.set").at(-1)?.args[2] as {
      all: boolean;
      tools: { allow: { name: string }[]; deny: { name: string }[] };
    };
    expect(put.all).toBe(true);
    expect(put.tools.deny.map((x) => x.name)).toEqual(["github_merge_pull_request"]);
    expect(put.tools.allow.map((x) => x.name)).toContain("github_create_pull_request");
    expect(screen().getByText("Permissões da Ada salvas.")).toBeTruthy();
  });

  test("members see the profile read-only (no edit buttons)", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(`agents/${ADA_ID}`, state);
    expect(screen().queryByRole("button", { name: /^Editar/ })).toBeNull();
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
    const create = () => screen().getByRole("button", { name: /^Criar (agente|Íris)$/ });
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
      // "Chave padrão do workspace".
      credentialId: null,
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
