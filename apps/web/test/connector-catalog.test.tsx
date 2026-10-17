import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AccessInput } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { authKind, searchCatalog } from "@/components/ConnectorCatalog";
import { setNavigateAway } from "@/lib/navigate";
import { ADA_ID, ATLAS_ID, CATALOG, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const open = async (state = seedState({ connections: [] })) => {
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api: createFakeApi(state) });
  await settle(8);
  await click(screen().getByRole("button", { name: "Adicionar conector" }));
  return { state, dialog: screen().getByRole("dialog", { name: "Adicionar conector" }) };
};
const names = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole("listitem")
    .map((li) => li.querySelector(".catalog-card__name")?.textContent);

describe("Adicionar conector: one catalog", () => {
  test("cards with brand icon, one line and how it connects (one tag); categories and search", async () => {
    const { dialog } = await open();
    const notion = within(dialog).getByRole("button", { name: "Conectar Notion" });
    expect(notion.textContent).toContain("Páginas e bancos de dados.");
    // The category is the filter above, not a tag on the card: one tag, how it connects.
    expect(notion.textContent).not.toContain("Docs");
    expect(notion.querySelectorAll(".catalog-card__meta .ac-chip")).toHaveLength(1);
    expect(notion.textContent).toContain("Um clique");
    // The brand icon is a mask of our own file; Notion takes the ink, Linear its color.
    expect(notion.querySelector(".connector-icon__mark")?.getAttribute("style")).toContain("/connectors/notion.svg");
    const linear = within(dialog).getByRole("button", { name: "Conectar Linear" });
    expect(linear.querySelector(".connector-icon__mark")?.getAttribute("style")?.toLowerCase()).toContain("#5e6ad2");
    // No icon (Canva): a monogram.
    const canva = within(dialog).getByRole("button", { name: "Conectar Canva" });
    expect(canva.querySelector(".connector-icon--mono")?.textContent).toBe("C");
    expect(within(dialog).getByRole("button", { name: "Conectar GitHub" }).textContent).toContain("OAuth ou chave");
    expect(within(dialog).getByRole("button", { name: "Conectar Sentry" }).textContent).toContain("Chave de API");
    // Not configured on this server: last, "Em breve", can't be picked.
    const slack = within(dialog).getByRole("button", { name: "Conectar Slack" });
    expect(slack.textContent).toContain("Em breve");
    expect(slack.hasAttribute("disabled")).toBe(true);
    expect(names(dialog).slice(-2)).toEqual(["Slack", "Outro servidor MCP"]);

    const cats = within(dialog).getByRole("group", { name: "Categorias" });
    expect(
      within(cats)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Todos", "Desenvolvimento", "Produto", "Docs", "Pagamentos", "Suporte", "Marketing", "Automação"]);
    await click(within(cats).getByRole("button", { name: "Docs" }));
    expect(names(dialog)).toEqual(["Google Drive", "Notion", "Outro servidor MCP"]);
    await type(within(dialog).getByRole("searchbox", { name: "Buscar conector" }), "notion");
    expect(names(dialog)).toEqual(["Notion", "Outro servidor MCP"]);
    await type(within(dialog).getByRole("searchbox", { name: "Buscar conector" }), "zzz");
    expect(dialog.textContent).toContain("Nenhum conector encontrado com “zzz”.");
  });

  test("what's connected says so (a preset counts by its server address)", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.zapier.example/mcp/",
      label: "Zapier",
      returnTo: "/",
    });
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Adicionar conector" }));
    const dialog = screen().getByRole("dialog", { name: "Adicionar conector" });
    expect(within(dialog).getByRole("button", { name: "Conectar GitHub de novo" }).textContent).toContain("Conectado");
    expect(within(dialog).getByRole("button", { name: "Conectar Zapier de novo" }).textContent).toContain("Conectado");
    expect(within(dialog).getByRole("button", { name: "Conectar Notion" }).textContent).not.toContain("Conectado");
  });

  test("rules: how it connects, search", () => {
    const byId = (id: string) => CATALOG.connectors.find((d) => d.id === id);
    const kind = (id: string) => {
      const d = byId(id);
      return d ? authKind(d) : null;
    };
    expect([kind("linear"), kind("github"), kind("sentry")]).toEqual(["oneClick", "oauthOrKey", "key"]);
    expect(searchCatalog(CATALOG.connectors, "ciclos").map((d) => d.id)).toEqual(["linear"]);
  });
});

const REVIEW = "Revise o que o agente pode fazer sozinho";

describe("the connect flow: conectar → o que faz → quem pode usar", () => {
  test("a one-click server that asks for a key; tools reviewed by subject; a level per agent", async () => {
    const { state, dialog } = await open();
    await click(within(dialog).getByRole("button", { name: "Conectar Linear" }));
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(flow().textContent).toContain("Conectar Linear");
    const steps = within(flow()).getByRole("list", { name: "Passos" });
    expect(within(steps).getAllByRole("listitem")[0]?.getAttribute("aria-current")).toBe("step");
    expect(flow().textContent).toContain("Nada fica disponível para os agentes até o passo 3.");

    await click(within(flow()).getByRole("button", { name: "Continuar no Linear" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "customConnectors.connect")?.args[1]).toMatchObject({
      serverUrl: "https://mcp.linear.app/mcp",
      label: "Linear",
      returnTo: `/org/${ORG_ID}/settings/connectors`,
    });
    // This server wants a key: the key form opens.
    expect(flow().textContent).toContain("Este servidor não aceita OAuth. Conecte com uma chave de API.");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    expect(flow().textContent).toContain("Cole a chave de API (pelo menos 8 caracteres).");
    await type(within(flow()).getByLabelText("Chave de API"), "lin_api_123456");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);

    // Step 2: everything comes classified; only the ambiguous tool waits for a decision.
    expect(screen().getByRole("dialog", { name: REVIEW })).toBeTruthy();
    expect(flow().textContent).toContain("Classificamos as 5 ferramentas do Linear.");
    const decide = within(flow()).getByRole("region", { name: "Precisam da sua decisão · 1" });
    expect(decide.textContent).toContain("Fechar chamado");
    expect(decide.textContent).toContain("Sugestão: muda coisas — muda coisas, mas não apaga nada nem gasta dinheiro");
    expect(flow().textContent).toContain("Falta 1 decisão. Se continuar, vale a sugestão.");
    expect(within(flow()).queryByRole("region", { name: "Pronto. Tudo revisado." })).toBeNull();
    await click(within(decide).getByRole("button", { name: "Aceitar as sugestões" }));
    expect(within(flow()).queryByRole("region", { name: /Precisam da sua decisão/ })).toBeNull();
    const done = within(flow()).getByRole("region", { name: "Pronto. Tudo revisado." });
    expect(done.textContent).toContain("2 só consultam");
    expect(done.textContent).toContain("1 pede sua aprovação");
    expect(flow().textContent).toContain("Dá para mudar tudo isso depois.");

    // Sensitive: only "Aprovação" or "Desligada".
    await click(within(flow()).getByRole("button", { name: /^Clientes/ }));
    const del = within(flow()).getByRole("radiogroup", { name: "Nível de Apagar cliente" });
    expect(
      within(del)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Aprovação", "Desligada"]);
    await click(within(del).getByRole("radio", { name: "Desligada" }));
    await click(within(flow()).getByRole("button", { name: /^Chamados/ }));
    const create = within(flow()).getByRole("radiogroup", { name: "Nível de Criar chamado" });
    expect(
      within(create)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Consulta", "Muda", "Aprovação", "Desligada"]);
    await click(within(create).getByRole("radio", { name: "Aprovação" }));
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    const saved = state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[2] as {
      tools: { name: string; access: string; confirmed: boolean }[];
    };
    expect(Object.fromEntries(saved.tools.map((x) => [x.name, x.access]))).toEqual({
      list_tickets: "read",
      get_ticket: "read",
      create_ticket: "approval",
      close_ticket: "write",
      delete_customer: "off",
    });
    expect(saved.tools.every((x) => x.confirmed)).toBe(true);

    // Step 3: one level per agent, with shortcuts for everyone.
    expect(screen().getByRole("dialog", { name: "Quem pode usar Linear" })).toBeTruthy();
    await click(within(flow()).getByRole("button", { name: "Todos: Ler" }));
    await click(
      within(within(flow()).getByRole("radiogroup", { name: "Nível de Ada" })).getByRole("radio", {
        name: "Ler e escrever",
      }),
    );
    expect(flow().textContent).toContain("1 ação sempre pede aprovação no chat.");
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const serverId = state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[1] as string;
    const put = (agentId: string) =>
      state.calls.find((c) => c.method === "access.set" && c.args[1] === agentId)?.args[2] as AccessInput;
    // "Ler e escrever": the whole connection (sensitive tools still ask).
    expect(put(ADA_ID).connectors[serverId]).toBe(true);
    expect(put(ADA_ID).scopes.some((s) => s.connectionId === serverId)).toBe(false);
    // "Ler": its read scope, nothing else; the agent's other grants stay.
    expect(put(ATLAS_ID).connectors[serverId]).toBeUndefined();
    expect(put(ATLAS_ID).scopes).toContainEqual({ connectionId: serverId, scope: `custom:${serverId}:read` });
    expect(put(ATLAS_ID).scopes).toContainEqual({ connectionId: null, scope: "memory:write" });

    // The row: state, account, tools, who uses it.
    expect(screen().queryByRole("dialog")).toBeNull();
    const section = screen().getByRole("region", { name: "Conectores" });
    expect(section.textContent).toContain("Linear");
    expect(section.textContent).toContain("Ativo");
    expect(section.textContent).toContain("Conectado como mcp.linear.app");
    expect(section.textContent).toContain("4 ferramentas");
    expect(section.textContent).toContain("2 de 2 agentes");
  });

  test("ours with an OAuth app: 'Continuar no GitHub' leaves for GitHub and comes back to Conectores", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { state, dialog } = await open();
    await click(within(dialog).getByRole("button", { name: "Conectar GitHub" }));
    const flow = screen().getByRole("dialog", { name: "Conectar GitHub" });
    // A key is the other way in, folded away.
    expect(within(flow).getByText("Conectar com uma chave de API")).toBeTruthy();
    await click(within(flow).getByRole("button", { name: "Continuar no GitHub" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "connectors.startOAuth")?.args).toEqual([
      ORG_ID,
      "github",
      { returnTo: `/org/${ORG_ID}/settings/connectors`, serverUrl: undefined },
    ]);
    expect(left[0]).toStartWith("https://github.com/login/oauth/authorize");
  });

  test("back from OAuth (`?connected=github`): what it does (read-only, by scope), then 'Ler' = its read scopes", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings/connectors?connected=github`, { api: createFakeApi(state) });
    await settle(8);
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(screen().getByRole("dialog", { name: "O que GitHub faz" })).toBeTruthy();
    // Ours are classified by scope: read-only, by subject; each tool shows its level.
    await type(within(flow()).getByRole("searchbox", { name: "Buscar ferramenta" }), "merge");
    const merge = flow().querySelector('[data-row="merge_pull_request"]') as HTMLElement;
    expect(merge.textContent).toContain("Pede sua aprovação");
    expect(merge.getAttribute("title")).toContain("merge_pull_request");
    expect(within(flow()).queryByRole("radiogroup")).toBeNull();
    await type(within(flow()).getByRole("searchbox", { name: "Buscar ferramenta" }), "");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    await click(
      within(within(flow()).getByRole("radiogroup", { name: "Nível de Ada" })).getByRole("radio", { name: "Ler" }),
    );
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts.map((c) => c.args[1])).toEqual([ADA_ID]);
    const input = puts[0]?.args[2] as AccessInput;
    expect(input.connectors["conn-gh"]).toBeUndefined();
    expect(input.scopes.filter((s) => s.connectionId === "conn-gh")).toEqual([
      { connectionId: "conn-gh", scope: "github:repo.read" },
    ]);
  });

  test("any MCP server by address; back from its OAuth (`?connected=custom:{id}`) the review opens", async () => {
    const { state, dialog } = await open();
    await click(within(dialog).getByRole("button", { name: /Outro servidor MCP/ }));
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(screen().getByRole("dialog", { name: "Conectar servidor MCP" })).toBeTruthy();
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "http://inseguro");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    expect(flow().textContent).toContain("Use um endereço que comece com https://.");
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow()).getByLabelText("Nome"), "Suporte");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "customConnectors.connect")?.args[1]).toMatchObject({
      serverUrl: "https://oauth.suporte.example.com",
      label: "Suporte",
    });
    expect(screen().getByRole("dialog", { name: REVIEW }).textContent).toContain("ferramentas do Suporte");
    cleanup();

    const api = createFakeApi(seedState());
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.himetrica.com",
      label: "himetrica",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    await renderApp(`/org/${ORG_ID}/settings?connected=custom:${res.server.id}`, { api });
    await settle(8);
    expect(screen().getByRole("dialog", { name: REVIEW }).textContent).toContain("ferramentas do himetrica");
  });

  test("new tools on a reviewed server: the row asks for review; disconnecting always asks first", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.suporte.example.com",
      label: "Suporte",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    await api.customConnectors.saveTools(ORG_ID, res.server.id, {
      label: "Suporte",
      tools: res.server.tools.map((x) => ({ name: x.name, access: x.sensitive ? "off" : "read", label: x.name })),
    });
    await api.customConnectors.refresh(ORG_ID, res.server.id);
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    const section = () => screen().getByRole("region", { name: "Conectores" });
    expect(section().textContent).toContain("1 ferramenta nova para revisar");
    await click(within(section()).getByRole("button", { name: "Revisar Suporte" }));
    const review = screen().getByRole("dialog", { name: REVIEW });
    // The new tool comes classified (the server says it only reads), in its subject.
    await type(within(review).getByRole("searchbox", { name: "Buscar ferramenta" }), "exportar");
    const fresh = review.querySelector('[data-row="export_tickets"]') as HTMLElement;
    expect(fresh.textContent).toContain("Exportar chamados");
    await click(within(review).getByRole("button", { name: "Cancelar" }));
    await settle(2);

    await click(within(section()).getByRole("button", { name: "Desconectar Suporte" }));
    const confirm = screen().getByRole("dialog", { name: "Desconectar Suporte?" });
    expect(confirm.textContent).toContain("Nenhum agente usa agora.");
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "customConnectors.disconnect")?.args).toEqual([ORG_ID, res.server.id]);
    expect(section().textContent).toContain("Nenhum conector ainda.");
  });
});
