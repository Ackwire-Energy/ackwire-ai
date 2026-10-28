import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { pick } from "./catalog";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (state = seedState(), path = "settings") => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(5);
  return { ...r, state };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
/** The texts an element is described by, in order (an ⓘ's hidden text, a line under it). */
const describedBy = (el: Element) =>
  (el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
/** The ⓘ named `About <label>`, and the hidden text it holds. */
const hintOf = (label: string, inside: HTMLElement = document.body) => {
  const button = screen()
    .getAllByRole("button", { name: `Sobre ${label}` })
    .find((b) => inside.contains(b));
  if (!button) throw new Error(`no ⓘ for ${label}`);
  const text = document.getElementById(button.getAttribute("aria-describedby") ?? "");
  return { button, text: text?.textContent, hidden: text?.hidden };
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

  test("Geral: each row is its label and control; what a setting means is behind its ⓘ", async () => {
    await go();
    const org = screen().getByRole("region", { name: "Organização" });
    expect(org.querySelectorAll(".settings-row__help")).toHaveLength(0);
    expect(hintOf("Fuso horário", org)).toMatchObject({
      text: "As rotinas e os resumos usam este fuso.",
      hidden: true,
    });
    // The context card: what it is and how to write it, in the title's ⓘ; no line under the title or the field.
    const context = screen().getByRole("region", { name: "O que os agentes sabem da Acme" });
    expect(hintOf("O que os agentes sabem da Acme", context).text).toBe(
      "Todo agente lê isto antes de cada conversa. Escreva como se explicasse a Acme para alguém que começou hoje.",
    );
    expect(context.querySelector(".ac-card__sub, .ac-card__foot")).toBeNull();
    // Each tile: the area's name and how it is now, nothing more.
    const tiles = screen().getByRole("region", { name: "Tudo da organização" });
    expect(tiles.querySelectorAll(".settings-tile").length).toBeGreaterThan(0);
    expect(tiles.querySelector(".ac-card__sub")).toBeNull();
  });

  test("agents check what the team already did: on by default, one switch turns it off", async () => {
    const { state } = await go();
    const toggle = screen().getByRole("switch", { name: "Agentes conferem o que o time já fez" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // What it does is the switch's description, from its ⓘ.
    const hint = hintOf("Agentes conferem o que o time já fez");
    expect(describedBy(toggle)).toEqual([hint.text]);
    expect(hint.text).toContain("Antes de mandar e-mail, mensagem ou abrir PR");
    expect(hint.hidden).toBe(true);
    await click(toggle);
    await settle(4);
    expect(state.calls.findLast((c) => c.method === "orgs.updateSettings")?.args[1]).toEqual({ actionCheck: false });
  });

  test("usage statistics: the installation's owner gets the switch and sees exactly what is sent", async () => {
    const { state } = await go(
      seedState({ telemetry: { enabled: true, envOff: false, report: { report: 1, people: { total: 3 } } } }),
    );
    const card = screen().getByRole("region", { name: "Estatísticas de uso" });
    const toggle = within(card).getByRole("switch", { name: "Enviar estatísticas de uso anônimas ao agentes.chat" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    // What is counted is the ⓘ's; no line under the switch while it can be changed.
    expect(describedBy(toggle)).toEqual([
      "Contagens como pessoas, agentes, tamanho das máquinas, tokens de IA usados e o volume de dados que os navegadores dos agentes enviam e recebem. Nunca mensagens, arquivos, nomes ou sites.",
    ]);
    expect(card.querySelector(".settings-row__help")).toBeNull();
    await click(toggle);
    await settle(4);
    expect(state.calls.findLast((c) => c.method === "system.setTelemetry")?.args).toEqual([false]);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await click(within(card).getByRole("button", { name: "Ver o que é enviado" }));
    const dialog = screen().getByRole("dialog", { name: "O que é enviado" });
    expect(dialog.textContent).toContain('"total": 3');
  });

  test("usage statistics: with TELEMETRY=off the switch is off and the card says why; others never see it", async () => {
    await go(seedState({ telemetry: { enabled: true, envOff: true, report: { report: 1 } } }));
    const card = screen().getByRole("region", { name: "Estatísticas de uso" });
    const toggle = within(card).getByRole("switch", { name: "Enviar estatísticas de uso anônimas ao agentes.chat" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.hasAttribute("disabled")).toBe(true);
    // Locked: one line says where it was turned off.
    expect(card.querySelector(".settings-row__help")?.textContent).toBe(
      "Desligado nas configurações deste servidor (TELEMETRY=off).",
    );
    expect(describedBy(toggle)).toEqual([
      "Contagens como pessoas, agentes, tamanho das máquinas, tokens de IA usados e o volume de dados que os navegadores dos agentes enviam e recebem. Nunca mensagens, arquivos, nomes ou sites.",
      "Desligado nas configurações deste servidor (TELEMETRY=off).",
    ]);
    cleanup();
    // Run by the desktop app on its own computer: the switch that turned it off is in the app.
    await go(seedState({ telemetry: { enabled: true, envOff: true, report: { report: 1, install: "desktop" } } }));
    const desktop = screen().getByRole("region", { name: "Estatísticas de uso" });
    expect(desktop.querySelector(".settings-row__help")?.textContent).toBe(
      "Desligado no app do agentes.chat no computador deste servidor (Preferências\u00a0›\u00a0Servidores).",
    );
    expect(desktop.textContent).not.toContain("TELEMETRY=off");
    cleanup();
    await go();
    expect(screen().queryByRole("region", { name: "Estatísticas de uso" })).toBeNull();
  });

  test("connected connectors are listed; disconnect asks first", async () => {
    const { state } = await go(
      seedState({ githubApp: { installable: true, installations: [] } }),
      "settings/connectors",
    );
    const section = screen().getByRole("region", { name: "Conectores" });
    // The card's head is its title and Add; the GitHub app's purpose is its title's ⓘ.
    expect(section.querySelector("#sec-conn")?.parentElement?.textContent).toBe("ConectoresAdicionar conector");
    const github = screen().getByRole("region", { name: "Repositórios do GitHub" });
    expect(hintOf("Repositórios do GitHub", github).text).toBe(
      "Instale o app do GitHub nas contas e repositórios que os agentes podem usar para código e pull requests. Só a Acme usa o que você instalar daqui.",
    );
    expect(
      within(github)
        .getAllByText(/^Instale o app do GitHub/)
        .map((el) => el.hidden),
    ).toEqual([true]);
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
    // Where the keys are kept is the title's ⓘ, not a line under it.
    expect(hintOf("Chaves de provedor", keys).text).toBe(
      "Ficam cifradas no servidor e nunca aparecem no navegador. Os agentes usam a chave que você escolher.",
    );
    expect(
      within(keys)
        .getAllByText(/^Ficam cifradas/)
        .map((el) => el.hidden),
    ).toEqual([true]);
    await click(within(keys).getByRole("button", { name: "Adicionar chave" }));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    // Claude: the key's line says where to create it; the workspace ID is explained by its ⓘ, and its empty field
    // says it can stay empty.
    expect(add.textContent).toContain("Crie a chave em platform.claude.com/settings/keys.");
    expect(add.textContent).not.toContain("ninguém vê depois");
    expect(hintOf("ID do workspace no Claude Console", add).text).toBe(
      "Só para uma chave que vale em mais de um workspace. O ID começa com wrkspc_.",
    );
    expect(within(add).getByLabelText("ID do workspace no Claude Console").getAttribute("placeholder")).toBe(
      "Opcional",
    );
    const choose = async (name: string) => {
      const trigger = within(add).getByRole("combobox", { name: "Provedor" });
      trigger.focus();
      await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
      await act(async () => fireEvent.click(screen().getByRole("option", { name })));
      await settle();
    };
    const field = within(add).getByLabelText("Chave da API");
    // The name's example is the chosen provider's; the key's, how its keys start where the maker publishes it.
    const name = () => within(add).getByLabelText("Nome da chave");
    expect(name().getAttribute("placeholder")).toBe("Ex.: Claude da Acme");
    expect(field.getAttribute("placeholder")).toBe("sk-ant-…");

    // MiniMax also sells a plan: the help says its key won't do, and its sk-cp- keys are refused.
    await choose("MiniMax");
    expect(name().getAttribute("placeholder")).toBe("Ex.: MiniMax da Acme");
    expect(field.hasAttribute("placeholder")).toBe(false);
    expect(add.textContent).toContain("Use uma chave de pagamento por uso");
    await type(field, "sk-cp-abcdefghijklmnopqrst");
    await click(within(add).getByRole("button", { name: "Salvar chave" }));
    expect(add.textContent).toContain("As que começam com sk-cp- são do plano");

    // A DeepSeek key while Claude is chosen: whose is it?
    await choose("Claude");
    await type(field, "sk-0123456789abcdef0123456789abcdef");
    expect(add.textContent).toContain("As chaves de API do Claude começam com sk-ant-.");
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

  test("a Gemini key pasted while Claude is chosen: only Gemini is offered; its line says where and to turn on billing", async () => {
    const { state } = await go(seedState(), "settings/keys");
    const keys = screen().getByRole("region", { name: "Chaves de provedor" });
    await click(within(keys).getByRole("button", { name: "Adicionar chave" }));
    const add = screen().getByRole("dialog", { name: "Adicionar chave de API" });
    const field = within(add).getByLabelText("Chave da API");
    const save = () => click(within(add).getByRole("button", { name: "Salvar chave" }));
    await type(field, "AQ.Ab8RN6LxSampleOnlyKey_0123456789");
    await save();
    expect(add.textContent).toContain("As chaves de API do Claude começam com sk-ant-.");
    expect(add.textContent).toContain("É de outro provedor?");
    for (const name of ["OpenAI", "DeepSeek", "Kimi", "Z.ai", "MiniMax"])
      expect(within(add).queryByRole("button", { name })).toBeNull();
    await click(within(add).getByRole("button", { name: "Gemini" }));
    expect(add.textContent).not.toContain("É de outro provedor?");
    expect(within(add).getByRole("link", { name: "Crie a chave em aistudio.google.com/api-keys." })).toBeTruthy();
    expect(add.textContent).toContain(
      "Ative o faturamento no projeto da chave. Sem faturamento, o Google pode usar o que os agentes enviam.",
    );
    expect(field.getAttribute("placeholder")).toBe("AQ.…");
    // Gemini chosen, a key that isn't one: its own line.
    await type(field, "sk-ant-api03-abcdefghijklmnop");
    expect(add.textContent).toContain("As chaves de API do Gemini começam com AQ. ou AIza. Confira e cole de novo.");
    await type(field, "AIzaSyD-sample0only1key2for3tests4567");
    await save();
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.addCredential")?.args[1]).toMatchObject({
      provider: "gemini",
      label: "Gemini",
    });
  });

  test("provider keys: default marked; rotate keeps the key; the default can't be deleted; usage by kind", async () => {
    const { state, router } = await go(seedState(), "settings/keys");
    const keys = () => screen().getByRole("region", { name: "Chaves de provedor" });
    expect(keys().textContent).toContain("Claude da Acme");
    expect(keys().textContent).toContain("Claude · Termina em 7f2a");
    expect(keys().textContent).toContain("Padrão do workspace");
    // Platform key not offered by this server: not mentioned.
    expect(keys().textContent).not.toContain("chave do Claude deste servidor");
    const del = within(keys()).getByRole("button", { name: "Apagar" });
    expect(del.hasAttribute("disabled")).toBe(true);
    expect(keys().textContent).toContain("Escolha outra chave padrão antes de apagar esta.");
    await click(within(keys()).getByRole("button", { name: "Trocar a chave" }));
    const rotate = screen().getByRole("dialog", { name: "Trocar a chave Claude da Acme" });
    expect(rotate.textContent).toContain("Os agentes que usam esta chave passam para a nova na hora.");
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
    const anthropicRow = within(keys()).getByText("Claude da Acme").closest(".ac-list__row") as HTMLElement;
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
    // The plan accounts by computer, each window with every agent's part, then the API per agent (ADR 0063).
    const plans = screen().getByRole("region", { name: "Contas dos planos" });
    expect(plans.textContent).toContain("MacBook");
    expect(plans.textContent).toContain("A conta que os seus agentes dividemMax");
    expect(plans.textContent).toContain("Claude Code · de Walter");
    expect(within(plans).getByRole("meter", { name: "Semana" }).getAttribute("aria-valuenow")).toBe("41");
    expect(plans.textContent).toContain("Ada ≈ 30% · Atlas ≈ 11%");
    expect(plans.textContent).toContain("5,1 mi tokens este mês · ≈ US$ 92,00 pela API");
    const api = screen().getByRole("region", { name: "API da organização" });
    expect(api.textContent).toContain("23% do orçamento");
    expect(api.textContent).toContain("US$ 11,50 de US$ 50,00 (padrão do workspace)");
    expect(within(api).getByRole("meter", { name: "Orçamento usado de Atlas" }).getAttribute("aria-valuenow")).toBe(
      "23",
    );
    // Admins also see the API's spend by kind, and the default budget.
    const usage = screen().getByRole("region", { name: "Gastos da API por tipo" });
    expect(usage.textContent).toContain("Agentes154 chamadasUS$ 15,40");
    expect(usage.textContent).toContain("Roteador80 chamadasUS$ 0,50");
    const fallback = screen().getByRole("region", { name: "Orçamento padrão dos agentes" });
    const field = within(fallback).getByLabelText("Orçamento mensal por agente (US$)") as HTMLInputElement;
    expect(field.value).toBe("50");
    // Who it applies to and who sees amounts: the field's ⓘ, which also describes the field.
    expect(describedBy(field)).toEqual([
      "Agentes sem orçamento próprio usam este. O de cada agente muda na página dele. Admins veem valores e membros veem porcentagens.",
    ]);
    await act(async () => fireEvent.change(field, { target: { value: "80" } }));
    await click(within(fallback).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.findLast((c) => c.method === "orgs.updateSettings")?.args[1]).toEqual({
      defaultAgentBudgetUsd: 80,
    });
    // An admin who isn't the server's owner: no Jev anywhere (its key is the owner's, jev.test.tsx).
    expect(document.body.textContent).not.toMatch(/jev|typesafe/i);
  });

  test("on the Cloud, Jev is named only in who picks the agents: no card, no TypeSafe", async () => {
    const state = seedState({
      aiStatus: {
        any: true,
        agents: [],
        routing: { by: "jev", mine: "jev", model: null, noSmallModel: null },
        apiKey: true,
      },
    });
    await go(state, "settings/keys");
    const section = screen().getByRole("region", { name: "Quem escolhe os agentes" });
    expect(section.textContent).toBe(
      "Quem escolhe os agentesComo os agentes são escolhidosO Jev escolhe quem responde cada mensagem sem menção.",
    );
    expect(screen().queryByRole("region", { name: "Jev" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/typesafe/i);
    // A workspace with no AI says nothing about who picks.
    cleanup();
    state.aiStatus = { ...(state.aiStatus as NonNullable<typeof state.aiStatus>), any: false };
    await go(state, "settings/keys");
    expect(screen().queryByRole("region", { name: "Quem escolhe os agentes" })).toBeNull();
    // Members don't read it.
    cleanup();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    state.aiStatus = { ...(state.aiStatus as NonNullable<typeof state.aiStatus>), any: true };
    await go(state, "settings/keys");
    expect(screen().queryByRole("region", { name: "Quem escolhe os agentes" })).toBeNull();
  });

  test("who picks, as ai-status says: a small model by its name, Kimi's missing one, the router off", async () => {
    const routing = (r: Partial<NonNullable<ReturnType<typeof seedState>["aiStatus"]>["routing"]>) =>
      seedState({
        aiStatus: {
          any: true,
          agents: [],
          routing: { by: "rules", mine: "rules", model: null, noSmallModel: null, ...r },
          apiKey: true,
        },
      });
    const line = () => screen().getByRole("region", { name: "Quem escolhe os agentes" }).querySelector(".who-line");
    await go(routing({ by: "model", mine: "model", model: "claude-haiku-5-5" }), "settings/keys");
    expect(line()?.textContent).toBe("O Claude Haiku 5.5 escolhe quem responde cada mensagem sem menção.");
    cleanup();
    await go(routing({ noSmallModel: "moonshot" }), "settings/keys");
    expect(line()?.textContent).toBe(
      "Kimi não tem um modelo pequeno para isso. Os agentes respondem a menções, respostas e continuações.",
    );
    cleanup();
    await go(routing({ by: "off", mine: "off" }), "settings/keys");
    expect(line()?.textContent).toBe("Os agentes só respondem quando mencionados.");
  });

  test("members see settings read-only, without the workspace's keys or money (their own plans, usage in percentages)", async () => {
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
    ).toEqual(["Geral", "Membros e convites", "Conectores", "Computadores", "Orçamento e uso", "Contas de IA"]);
    cleanup();
    await go(state, "settings/connectors");
    expect(screen().queryByRole("button", { name: "Adicionar conector" })).toBeNull();
    cleanup();
    // Contas de IA: their own plans, never the workspace's keys.
    await go(state, "settings/keys");
    expect(screen().getByRole("region", { name: "Seus planos" })).toBeTruthy();
    expect(screen().queryByRole("region", { name: "Chaves de provedor" })).toBeNull();
    cleanup();
    // Orçamento e uso: the plans and the API in tokens and percentages, never money.
    await go(state, "settings/usage");
    const plans = screen().getByRole("region", { name: "Contas dos planos" });
    expect(within(plans).getByRole("meter", { name: "5 horas" }).getAttribute("aria-valuenow")).toBe("62");
    expect(screen().getByRole("region", { name: "API da organização" }).textContent).toContain("23% do orçamento");
    expect(screen().queryByRole("region", { name: "Gastos da API por tipo" })).toBeNull();
    expect(screen().queryByRole("region", { name: "Orçamento padrão dos agentes" })).toBeNull();
    expect(document.body.textContent).not.toContain("US$");
    cleanup();
    // A section they can't open falls back to Geral.
    await go(state, "settings/storage");
    expect(screen().getByRole("heading", { level: 2, name: "Geral" })).toBeTruthy();
    expect(screen().queryByRole("region", { name: "Armazenamento" })).toBeNull();
  });

  test("budget and usage: the plans' estimate is their title's ⓘ, no card has a subtitle or footer; no plans, one line", async () => {
    await go(seedState(), "settings/usage");
    const plans = screen().getByRole("region", { name: "Contas dos planos" });
    expect(hintOf("Contas dos planos", plans)).toMatchObject({
      text: "Os planos só dizem quanto a conta inteira usou. A parte de cada agente é uma estimativa, pelo que cada um gastou nela.",
      hidden: true,
    });
    expect(shownText(plans)).not.toContain("estimativa");
    for (const card of [plans, screen().getByRole("region", { name: "API da organização" })])
      expect(card.querySelector(".ac-card__sub, .ac-card__foot")).toBeNull();
    cleanup();
    const api = createFakeApi(seedState());
    api.orgs.planUsage = async () => ({ month: "2026-10", money: true, accounts: [], api: [] });
    await renderApp(`/org/${ORG_ID}/settings/usage`, { api });
    await settle(5);
    expect(shownText(screen().getByRole("region", { name: "Contas dos planos" }))).toBe(
      "Contas dos planosNenhum agente pensa com um plano ainda.",
    );
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
    const seeded = seedState();
    seeded.teamActions = [
      {
        kind: "action",
        sourceId: "00000000-0000-4000-8000-0000000000a1",
        channelIds: ["00000000-0000-4000-8000-0000000000c2"],
        title: "open_pull_request",
        snippet: "GitHub · Corrige o login com Google",
        score: 1,
        createdAt: new Date().toISOString(),
        author: { type: "agent", id: "agent-ada", name: "Ada" },
      },
    ];
    const { state } = await go(seeded, "search");
    const box = screen().getByRole("searchbox", { name: "Buscar" });
    expect(box.getAttribute("placeholder")).toBe("Mensagens, decisões, resumos…");
    expect(document.body.textContent).toContain("Busca nos canais em que você está.");
    await type(box, "login");
    await act(() => new Promise((r) => setTimeout(r, 300)));
    await settle(4);
    expect(state.calls.find((c) => c.method === "search.query")?.args[1]).toEqual({
      q: "login",
      kinds: ["action", "message", "context_item"],
      limit: 50,
    });
    // What the team already did comes first: who did it, where, never the tool's id.
    const regions = screen()
      .getAllByRole("region")
      .map((r) => r.getAttribute("aria-label"));
    expect(regions.indexOf("Ações do time")).toBeLessThan(regions.indexOf("Mensagens"));
    const done = screen().getByRole("region", { name: "Ações do time" });
    expect(done.textContent).toContain("GitHub · Corrige o login com Google");
    expect(done.textContent).toContain("Ada · em #eng");
    expect(done.textContent).not.toContain("open_pull_request");
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
