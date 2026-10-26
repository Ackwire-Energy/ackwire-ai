import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
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
  const pills = () =>
    within(screen().getByRole("radiogroup", { name: "Filtro" }))
      .getAllByRole("radio")
      .map((b) => b.textContent);

  test("waiting cards with the exact action; refusing sends the reason and moves it to the history", async () => {
    const { state } = await go("approvals");
    // A zero count isn't shown.
    expect(pills()).toEqual(["Esperando você2", "Aprovados1", "Recusados", "Expirados", "Todos3"]);
    const merge = screen().getByRole("article", { name: "Merge PR #42 into main" });
    expect(merge.textContent).toContain("Ada");
    expect(merge.textContent).toContain("#eng");
    expect(merge.querySelector(".ac-chip")?.textContent).toMatch(/\d+ h para decidir$/);
    expect(within(merge).getByRole("button", { name: "Aprovar merge" })).toBeTruthy();
    // Deploy is high risk: the button asks for a hold.
    const deploy = screen().getByRole("article", { name: "Run deploy workflow" });
    expect(within(deploy).getByRole("button", { name: "Aprovar deploy: segure para confirmar" })).toBeTruthy();
    expect(deploy.textContent).toContain("Produção");

    await click(within(merge).getByRole("button", { name: "Recusar" }));
    await click(within(merge).getByRole("button", { name: "Falta teste" }));
    await click(within(merge).getByRole("button", { name: /Recusar e avisar/ }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.refuse")?.args).toEqual([ORG_ID, "ap-merge", "Falta teste"]);
    expect(pills()).toEqual(["Esperando você1", "Aprovados1", "Recusados1", "Expirados", "Todos3"]);
    expect(screen().queryByRole("article", { name: "Merge PR #42 into main" })).toBeNull();
    expect(screen().getByText("Decididos há pouco")).toBeTruthy();
  });

  test("a normal-risk approval goes with one click", async () => {
    const { state } = await go("approvals");
    const merge = screen().getByRole("article", { name: "Merge PR #42 into main" });
    await click(within(merge).getByRole("button", { name: "Aprovar merge" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.approve")?.args[1]).toBe("ap-merge");
  });

  test("the details dialog shows the exact action and who may decide, kept in ?open=", async () => {
    const { router } = await go("approvals");
    const merge = screen().getByRole("article", { name: "Merge PR #42 into main" });
    await click(within(merge).getByRole("button", { name: "Detalhes" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Merge PR #42 into main" });
    expect(dialog.textContent).toContain("Pedido de aprovação");
    expect(within(dialog).getByRole("region", { name: "A ação exata" })).toBeTruthy();
    expect(within(dialog).getByRole("region", { name: "Quem pode decidir" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Aprovar merge" })).toBeTruthy();
    expect(router.state.location.search).toMatchObject({ open: "ap-merge" });
    await click(within(dialog).getByRole("button", { name: "Fechar" }));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(router.state.location.search).toEqual({});
  });

  test("a link with ?open= reopens the request's details; refusing works from the dialog", async () => {
    const { state } = await go("approvals?open=ap-merge");
    const dialog = screen().getByRole("dialog", { name: "Merge PR #42 into main" });
    await click(within(dialog).getByRole("button", { name: /^Recusar/ }));
    await click(within(dialog).getByRole("button", { name: "Falta teste" }));
    await click(within(dialog).getByRole("button", { name: /Recusar e avisar/ }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "approvals.refuse")?.args).toEqual([ORG_ID, "ap-merge", "Falta teste"]);
  });

  test("a connector tool that runs another by name reads as that action, in words, with the tool behind Detalhes técnicos", async () => {
    const state = seedState();
    const merge = state.approvals[0];
    if (!merge) throw new Error("no approval");
    state.approvals = [
      {
        ...merge,
        id: "ap-trace",
        tool: "sentry_execute_tool",
        scope: "custom:conn-sentry:write",
        title: "Sentry: Execute sentry tool",
        connector: "custom:conn-sentry",
        params: { name: "get_event_stacktrace", arguments: { issue: "ACME-177" } },
      },
    ];
    await go("approvals", state);
    const card = screen().getByRole("article", { name: "Ver stack trace do evento" });
    expect(card.textContent).toContain("Só lê");
    expect(card.textContent).toContain("Issue: ACME-177");
    expect(card.textContent).not.toContain("custom:");
    expect(card.textContent).not.toContain("get_event_stacktrace");
    await click(within(card).getByRole("button", { name: "Detalhes" }));
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Ver stack trace do evento" });
    expect(dialog.querySelector(".ap-exact__tech pre")?.textContent).toContain("get_event_stacktrace");
  });

  test("approvals you can't decide show who they wait for, without buttons", async () => {
    const state = seedState();
    for (const a of state.approvals) a.canDecide = false;
    await go("approvals", state);
    const merge = screen().getByRole("article", { name: "Merge PR #42 into main" });
    expect(merge.querySelector(".ac-chip")?.textContent).toBe("Aguardando João");
    expect(within(merge).queryByRole("button", { name: "Recusar" })).toBeNull();
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
    expect(agents.textContent).toMatch(/31% do orçamento de \S+/);
    expect(agents.textContent).not.toContain("US$");
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
    expect(screen().getByRole("heading", { level: 1, name: "Qual vai ser o papel?" })).toBeTruthy();
    // The page says what the button that opened it said.
    expect(document.querySelector(".newag__rail-title b")?.textContent).toBe("Criar agente");
    await click(screen().getByRole("button", { name: /^Dev/ }));
    await click(screen().getByRole("button", { name: "Continuar" }));
    // Dev starts as Ada, and @ada is taken: renamed here.
    await type(screen().getByLabelText("Nome"), "Íris");
    await type(screen().getByLabelText("No chat"), "iris");
    expect(screen().getByText("Mencione @iris para chamar.")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Continuar" }));
    expect((screen().getByLabelText("Instruções") as HTMLTextAreaElement).value).toStartWith(
      "Investiga primeiro: lê o código e as tarefas e erros relacionados antes de responder",
    );
    for (let i = 0; i < 3; i++) await click(screen().getByRole("button", { name: "Continuar" }));
    await type(screen().getByLabelText("Orçamento mensal (US$)"), "0");
    await click(screen().getByRole("button", { name: "Continuar" }));
    expect(screen().getAllByText("Use um valor maior que zero.").length).toBeGreaterThan(0);
    await type(screen().getByLabelText("Orçamento mensal (US$)"), "25");
    await click(screen().getByRole("button", { name: "Continuar" }));
    await click(screen().getByRole("button", { name: "Criar Íris" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.create")?.args[1]).toMatchObject({
      name: "Íris",
      handle: "iris",
      role: "Dev",
      model: "auto",
      ownerUserId: "u-walter",
      // "Chave padrão do workspace".
      credentialId: null,
      monthlyBudgetUsd: 25,
    });
    expect(state.calls.find((c) => c.method === "agents.setChannels")?.args[2]).toEqual([{ channelId: ENG_ID }]);
    // Dev writes on GitHub: one write, after creation.
    const access = state.calls.filter((c) => c.method === "access.set");
    expect(access).toHaveLength(1);
    expect((access[0]?.args[2] as { connectors?: Record<string, boolean> } | undefined)?.connectors).toEqual({
      "conn-gh": true,
    });
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

describe("Equipe", () => {
  test("agents in the sky grouped by their person; a tap opens what it does and how to reach it", async () => {
    await go("team");
    expect(screen().getByRole("heading", { name: "Equipe" })).toBeTruthy();
    expect(screen().getByText(/2 agentes, agrupados por quem cuida de cada um\./)).toBeTruthy();
    const sky = screen().getByRole("region", { name: /Agentes agrupados por pessoa responsável/ });
    expect(sky.textContent).toContain("João");
    await click(within(sky).getByRole("button", { name: "Ada, ver detalhes" }));
    const card = screen().getByRole("dialog", { name: "Detalhes de Ada" });
    expect(card.textContent).toContain("O que faz");
    expect(card.textContent).toContain("Arquivos");
    expect(within(card).getByRole("link", { name: "Conversar" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/dm/agent/${ADA_ID}`,
    );
    expect(screen().getByText("Nenhum agente pediu ajuda a outro nas últimas 24 h.")).toBeTruthy();
  });

  test("the card: what it does, available or with no AI, each ability named and drawn its own way", async () => {
    const state = seedState({
      aiStatus: {
        any: true,
        agents: [
          { agentId: ADA_ID, state: "ready" },
          { agentId: ATLAS_ID, state: "no_ai", reason: "no_key" },
        ],
      },
    });
    const imported = state.agents.find((a) => a.id === ADA_ID);
    if (imported)
      imported.instructions =
        "# SOUL.md - Quem você é\n\n_Você não é um chatbot. Você está se tornando alguém._\n\n## Verdades\n\n- **Ajude de verdade.**";
    const api = createFakeApi(state);
    const team = api.agents.team;
    api.agents.team = async (orgId) => {
      const t = await team(orgId);
      return {
        ...t,
        agents: t.agents.map((a) => ({ ...a, capabilities: ["sandbox", "desktop", "browser", "drive"] })),
      };
    };
    await renderApp(`/org/${ORG_ID}/team`, { api });
    await settle(4);
    // The same action as the sidebar's, in the same words.
    const head = document.querySelector(".team-head") as HTMLElement;
    expect(within(head).getByRole("link", { name: "Criar agente" })).toBeTruthy();
    const sky = screen().getByRole("region", { name: /Agentes agrupados por pessoa responsável/ });
    await click(within(sky).getByRole("button", { name: "Ada, ver detalhes" }));
    const ada = screen().getByRole("dialog", { name: "Detalhes de Ada" });
    // Its role is beside its name; what it does comes from its instructions, in plain words: their first line,
    // as its page starts.
    expect(ada.querySelector(".team-card__meta")?.textContent).toContain("Dev");
    expect(ada.querySelector(".team-card__call")?.textContent).toBe(
      "Você não é um chatbot. Você está se tornando alguém.",
    );
    expect(ada.querySelector(".team-card__status")?.textContent).toBe("Disponível");
    expect(ada.textContent).not.toContain("Livre");
    const chip = (name: string) =>
      Array.from(ada.querySelectorAll(".ac-chip")).find((c) => c.textContent === name) as HTMLElement;
    for (const name of ["Computador", "Tela", "Navegador", "Arquivos"]) expect(chip(name)).toBeTruthy();
    const drawn = new Set(["Computador", "Tela", "Navegador"].map((n) => chip(n).querySelector("svg")?.innerHTML));
    expect(drawn.size).toBe(3);
    await click(within(sky).getByRole("button", { name: "Atlas, ver detalhes" }));
    const atlas = screen().getByRole("dialog", { name: "Detalhes de Atlas" });
    expect(within(atlas).getByRole("button", { name: "Sem IA" })).toBeTruthy();
    expect(atlas.textContent).not.toContain("Disponível");
  });

  test("the card names another company's service by its own mark, from the connector catalog", async () => {
    const api = createFakeApi(seedState());
    const team = api.agents.team;
    api.agents.team = async (orgId) => {
      const t = await team(orgId);
      return {
        ...t,
        agents: t.agents.map((a) => ({ ...a, capabilities: ["github", "linear", "gdrive", "sentry", "browser"] })),
      };
    };
    await renderApp(`/org/${ORG_ID}/team`, { api });
    await settle(4);
    const sky = screen().getByRole("region", { name: /Agentes agrupados por pessoa responsável/ });
    await click(within(sky).getByRole("button", { name: "Ada, ver detalhes" }));
    const ada = screen().getByRole("dialog", { name: "Detalhes de Ada" });
    const mark = (name: string) => {
      const chip = Array.from(ada.querySelectorAll(".ac-chip")).find((c) => c.textContent === name);
      const el = chip?.querySelector<HTMLElement>(".connector-icon__mark");
      return el && [el.style.getPropertyValue("--connector-icon"), el.style.getPropertyValue("--connector-color")];
    };
    expect(mark("GitHub")).toEqual(['url("/connectors/github.svg")', ""]);
    expect(mark("Linear")).toEqual(['url("/connectors/linear.svg")', "#5E6AD2"]);
    expect(mark("Google Drive")).toEqual(['url("/connectors/googledrive.svg")', "#4285F4"]);
    // A service's mark sits beside the service's own name.
    expect(mark("Sentry")).toEqual(['url("/connectors/sentry.svg")', ""]);
    // Our own abilities keep their icons.
    expect(mark("Navegador")).toBeNull();
    const browser = Array.from(ada.querySelectorAll(".ac-chip")).find((c) => c.textContent === "Navegador");
    expect(browser?.querySelector("svg.ac-icon")).not.toBeNull();
  });

  test("the card of an agent waiting for its computer says neither Available nor No AI", async () => {
    await go("team", seedState({ aiStatus: { any: true, agents: [{ agentId: ADA_ID, state: "waiting" }] } }));
    const sky = screen().getByRole("region", { name: /Agentes agrupados por pessoa responsável/ });
    await click(within(sky).getByRole("button", { name: "Ada, ver detalhes" }));
    const ada = screen().getByRole("dialog", { name: "Detalhes de Ada" });
    expect(ada.querySelector(".team-card__status")).toBeNull();
    expect(within(ada).queryByRole("button", { name: "Sem IA" })).toBeNull();
    expect(ada.textContent).toContain("Instruções de Ada.");
  });
});
