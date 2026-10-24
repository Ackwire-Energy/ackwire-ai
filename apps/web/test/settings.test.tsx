import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (state = seedState(), path = "settings") => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(5);
  return { ...r, state };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

/** Picks a service in "Adicionar conector" (its tile) and presses Conectar in its detail pane. */
const pick = async (dialog: HTMLElement, name: string) => {
  await click(within(dialog).getByRole("button", { name }));
  const pane = within(dialog).getByRole("complementary", { name: `Sobre ${name}` });
  await click(within(pane).getByRole("button", { name: `Conectar ${name}` }));
};

describe("Configurações da organização", () => {
  test("organization context saves by itself with PATCH /settings (no save button)", async () => {
    const { state } = await go();
    expect(screen().getByRole("heading", { level: 2, name: "Geral" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Salvar organização" })).toBeNull();
    const field = screen().getByLabelText("Contexto da organização");
    await type(field, "A Acme faz um app para clínicas.");
    await act(async () => fireEvent.blur(field));
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.updateSettings")?.args[1]).toMatchObject({
      context: "A Acme faz um app para clínicas.",
    });
  });

  test("connected connectors are listed; disconnect asks first", async () => {
    const { state } = await go(seedState(), "settings/connectors");
    const section = screen().getByRole("region", { name: "Conectores" });
    expect(section.textContent).toContain("GitHub");
    expect(section.textContent).toContain("Ativo");
    expect(section.textContent).toContain("Conectado como acme");
    expect(section.textContent).toContain("3 ferramentas");
    expect(section.textContent).toContain("Nenhum agente ainda");
    await click(within(section).getByRole("button", { name: "Desconectar GitHub" }));
    const dialog = screen().getByRole("dialog", { name: "Desconectar GitHub?" });
    expect(dialog.textContent).toContain("Nenhum agente usa agora.");
    await click(within(dialog).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "connectors.disconnect")?.args).toEqual([ORG_ID, "conn-gh"]);
    expect(screen().getByRole("region", { name: "Conectores" }).textContent).toContain("Nenhum conector ainda.");
  });

  test("add a connector from the searchable catalog with an API key, then review what it does", async () => {
    const { state } = await go(seedState(), "settings/connectors");
    await click(screen().getByRole("button", { name: "Adicionar conector" }));
    const add = screen().getByRole("dialog", { name: "Adicionar conector" });
    expect(add.textContent).toContain("Código, PRs, issues e Actions.");
    await type(within(add).getByRole("searchbox", { name: "Buscar conector" }), "sentry");
    // Sentry, and the card for any other MCP server.
    expect(within(add).getAllByRole("listitem")).toHaveLength(2);
    await pick(add, "Sentry");
    const connect = screen().getByRole("dialog", { name: "Conectar Sentry" });
    // Sentry has no OAuth app on this server: API key only.
    expect(within(connect).queryByRole("button", { name: "Continuar no Sentry" })).toBeNull();
    await click(within(connect).getByRole("button", { name: "Conectar com a chave" }));
    expect(connect.textContent).toContain("Cole a chave de API (pelo menos 8 caracteres).");
    await type(within(connect).getByLabelText("Chave de API"), "sntrys_abcdef123");
    await click(within(connect).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "connectors.connectWithKey")?.args[1]).toEqual({
      connector: "sentry",
      apiKey: "[redacted]",
      serverUrl: undefined,
    });
    const tools = screen().getByRole("dialog", { name: "O que Sentry faz" });
    // Built-in connector: the tools read-only, grouped by subject, readable names first.
    const issues = within(tools).getByRole("region", { name: "Issues" });
    expect(issues.textContent).toContain("1 ferramenta");
    // The technical name only shows up when searched for.
    await type(within(tools).getByRole("searchbox", { name: "Buscar ferramenta" }), "search_issues");
    const hit = within(tools).getByRole("region", { name: "Issues" });
    expect(hit.textContent).toContain("Buscar issues");
    expect(hit.textContent).toContain("search_issues");
    await click(within(tools).getByRole("button", { name: "Cancelar" }));
    await settle(2);
    expect(screen().getByRole("region", { name: "Conectores" }).textContent).toContain("Sentry");
  });

  test("a connector without a default server asks for an https address", async () => {
    await go(seedState({ connections: [] }), "settings/connectors");
    await click(screen().getByRole("button", { name: "Adicionar conector" }));
    const add = screen().getByRole("dialog", { name: "Adicionar conector" });
    await type(within(add).getByRole("searchbox", { name: "Buscar conector" }), "drive");
    await pick(add, "Google Drive");
    const connect = screen().getByRole("dialog", { name: "Conectar Google Drive" });
    await type(within(connect).getByLabelText("Endereço do servidor MCP"), "http://inseguro");
    await type(within(connect).getByLabelText("Chave de API"), "chave-longa-123");
    await click(within(connect).getByRole("button", { name: "Conectar com a chave" }));
    expect(connect.textContent).toContain("Use um endereço que comece com https://.");
  });

  test("a key that isn't the chosen provider's: it asks whose it is (any sk- key could be several) and saves it there", async () => {
    const { state } = await go(seedState(), "settings/keys");
    const keys = screen().getByRole("region", { name: "Chaves de provedor" });
    await click(within(keys).getByRole("button", { name: "Adicionar chave" }));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    const choose = async (name: string) => {
      const trigger = within(add).getByRole("combobox", { name: "Provedor" });
      trigger.focus();
      await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
      await act(async () => fireEvent.click(screen().getByRole("option", { name })));
      await settle();
    };
    const field = within(add).getByLabelText("Chave da API");

    // MiniMax also sells a plan: the help says its key won't do, and its sk-cp- keys are refused.
    await choose("MiniMax");
    expect(add.textContent).toContain("Use uma chave de pagamento por uso");
    await type(field, "sk-cp-abcdefghijklmnopqrst");
    await click(within(add).getByRole("button", { name: "Salvar chave" }));
    expect(add.textContent).toContain("As que começam com sk-cp- são do plano");

    // A DeepSeek key while Anthropic is chosen: whose is it?
    await choose("Anthropic");
    await type(field, "sk-0123456789abcdef0123456789abcdef");
    expect(add.textContent).toContain("As chaves da Anthropic começam com sk-ant-.");
    expect(add.textContent).toContain("É de outro provedor?");
    for (const name of ["OpenAI", "DeepSeek", "Kimi", "MiniMax"])
      expect(within(add).getByRole("button", { name })).toBeTruthy();
    await click(within(add).getByRole("button", { name: "DeepSeek" }));
    expect(add.textContent).not.toContain("É de outro provedor?");
    expect(within(add).getByRole("link", { name: "Crie a chave em platform.deepseek.com/api_keys." })).toBeTruthy();
    await click(within(add).getByRole("button", { name: "Salvar chave" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.addCredential")?.args[1]).toMatchObject({
      provider: "deepseek",
      label: "DeepSeek",
    });
  });

  test("provider keys: default marked; rotate keeps the key; the default can't be deleted; usage by kind", async () => {
    const { state, router } = await go(seedState(), "settings/keys");
    const keys = () => screen().getByRole("region", { name: "Chaves de provedor" });
    expect(keys().textContent).toContain("Anthropic da Acme");
    expect(keys().textContent).toContain("Anthropic · Termina em 7f2a");
    expect(keys().textContent).toContain("Padrão do workspace");
    // Platform key not offered by this server: not mentioned.
    expect(keys().textContent).not.toContain("chave do agentes");
    const del = within(keys()).getByRole("button", { name: "Apagar" });
    expect(del.hasAttribute("disabled")).toBe(true);
    expect(keys().textContent).toContain("Escolha outra chave padrão antes de apagar esta.");
    await click(within(keys()).getByRole("button", { name: "Trocar a chave" }));
    const rotate = screen().getByRole("dialog", { name: "Trocar a chave Anthropic da Acme" });
    await type(within(rotate).getByLabelText("Chave da API"), "sk-ant-api03-new-key-9999");
    await click(within(rotate).getByRole("button", { name: "Trocar a chave" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.rotateCredential")?.args[1]).toBe("cred-1");
    expect(keys().textContent).toContain("Termina em 9999");

    // Another provider's key, then make it the default and delete the old one.
    await click(within(keys()).getByRole("button", { name: "Adicionar chave" }));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    const trigger = within(add).getByRole("combobox", { name: "Provedor" });
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    await act(async () => fireEvent.click(screen().getByRole("option", { name: "OpenAI" })));
    await settle();
    await type(within(add).getByLabelText("Chave da API"), "sk-ant-errado-0000000000");
    await click(within(add).getByRole("button", { name: "Salvar chave" }));
    expect(add.textContent).toContain("As chaves da OpenAI começam com sk-.");
    await type(within(add).getByLabelText("Chave da API"), "sk-proj-abcdefghijklmnop1234");
    await click(within(add).getByRole("button", { name: "Salvar chave" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.addCredential")?.args[1]).toMatchObject({
      provider: "openai",
      label: "OpenAI",
    });
    const openaiRow = within(keys()).getByText("OpenAI").closest(".ac-list__row") as HTMLElement;
    await click(within(openaiRow).getByRole("button", { name: "Tornar padrão" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "orgs.updateSettings").at(-1)?.args[1]).toEqual({
      defaultCredentialId: state.credentials[1]?.id,
    });
    const anthropicRow = within(keys()).getByText("Anthropic da Acme").closest(".ac-list__row") as HTMLElement;
    const delOld = within(anthropicRow).getByRole("button", { name: "Apagar" });
    expect(delOld.hasAttribute("disabled")).toBe(false);
    await click(delOld);
    await click(
      within(screen().getByRole("dialog", { name: /Apagar a chave/ })).getByRole("button", { name: "Apagar" }),
    );
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.removeCredential")?.args).toEqual([ORG_ID, "cred-1", true]);
    await act(() =>
      router.navigate({ to: "/org/$orgId/settings/$section", params: { orgId: ORG_ID, section: "usage" } }),
    );
    await settle(4);
    const usage = screen().getByRole("region", { name: "Uso deste mês" });
    expect(usage.textContent).toContain("Agentes154 chamadasUS$ 15,40");
    expect(usage.textContent).toContain("Roteador80 chamadasUS$ 0,50");
    // The one place with money: each agent's spend against its budget, and the default budget.
    const byAgent = screen().getByRole("region", { name: "Por agente" });
    expect(byAgent.textContent).toContain("US$ 12,30 de US$ 40,00");
    expect(within(byAgent).getByRole("meter", { name: "Orçamento usado de Ada" }).getAttribute("aria-valuenow")).toBe(
      "30.8",
    );
    const fallback = screen().getByRole("region", { name: "Orçamento padrão dos agentes" });
    const field = within(fallback).getByLabelText("Orçamento mensal por agente (US$)") as HTMLInputElement;
    expect(field.value).toBe("50");
    await act(async () => fireEvent.change(field, { target: { value: "80" } }));
    await click(within(fallback).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.findLast((c) => c.method === "orgs.updateSettings")?.args[1]).toEqual({
      defaultAgentBudgetUsd: 80,
    });
    // Jev / the router's own key is internal: never in the UI.
    expect(document.body.textContent).not.toMatch(/jev|typesafe/i);
  });

  test("members see settings read-only, without the workspace's keys or usage (their own plans, yes)", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    expect(document.body.textContent).toContain("Só admins mudam as configurações.");
    // The sub-nav only lists what a member can open.
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Geral", "Membros e convites", "Conectores", "Computadores", "Contas de IA"]);
    cleanup();
    await go(state, "settings/connectors");
    expect(screen().queryByRole("button", { name: "Adicionar conector" })).toBeNull();
    cleanup();
    // Contas de IA: their own plans, never the workspace's keys.
    await go(state, "settings/keys");
    expect(screen().getByRole("region", { name: "Seus planos" })).toBeTruthy();
    expect(screen().queryByRole("region", { name: "Chaves de provedor" })).toBeNull();
    cleanup();
    // A section they can't open falls back to Geral.
    await go(state, "settings/usage");
    expect(screen().queryByRole("region", { name: "Uso deste mês" })).toBeNull();
  });
});

describe("budget alerts over the WebSocket", () => {
  test("the agent owner gets a toast at 80%", async () => {
    const { sockets } = await go(seedState(), "members");
    const socket = sockets.last();
    await act(async () => socket.open());
    await act(async () =>
      socket.push({
        type: "event",
        scope: "user",
        event: {
          type: "budget.warning",
          agentId: "00000000-0000-4000-8000-0000000000a1",
          percent: 80.4,
        },
      }),
    );
    await settle();
    expect(screen().getByRole("alert").textContent).toContain("Ada usou 80% do orçamento do mês.");
  });
});

describe("Buscar no workspace", () => {
  test("search as you type: results grouped by kind, with channel and author, linking to the channel", async () => {
    const { state } = await go(seedState(), "search");
    const box = screen().getByRole("searchbox", { name: "Buscar" });
    expect(document.body.textContent).toContain("Busque mensagens, decisões, fatos e resumos");
    await type(box, "login");
    await act(() => new Promise((r) => setTimeout(r, 300)));
    await settle(4);
    expect(state.calls.find((c) => c.method === "search.query")?.args[1]).toEqual({
      q: "login",
      kinds: ["message", "context_item"],
      limit: 50,
    });
    const messages = screen().getByRole("region", { name: "Mensagens" });
    const link = within(messages).getAllByRole("link")[0] as HTMLElement;
    expect(link.textContent).toContain("o login está devolvendo 401");
    expect(link.textContent).toContain("João · em #eng");
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/c/00000000-0000-4000-8000-0000000000c2`);
    expect(screen().getByRole("region", { name: "Contexto" }).textContent).toContain("tokens de 15 minutos");
    await type(box, "nada-disso");
    await act(() => new Promise((r) => setTimeout(r, 300)));
    await settle(4);
    expect(document.body.textContent).toContain("Nada encontrado com “nada-disso”.");
  });
});
