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
/** The names of the tiles in the grid (the suggestions on top aren't tiles). */
const names = (dialog: HTMLElement) => [...dialog.querySelectorAll(".catalog-tile__name")].map((el) => el.textContent);
/** The category choices' words (without their counts). */
const filterNames = (cats: HTMLElement) =>
  within(cats)
    .getAllByRole("radio")
    .map((b) => b.firstChild?.textContent);
/** The detail pane of the service picked. */
const pane = (dialog: HTMLElement, name: string) =>
  within(dialog).getByRole("complementary", { name: `Sobre ${name}` });
/** Picks a service (its tile or suggestion) and presses the pane's Conectar: the connect flow opens. */
const pick = async (dialog: HTMLElement, name: string) => {
  await click(within(dialog).getByRole("button", { name }));
  await click(within(pane(dialog, name)).getByRole("button", { name: `Conectar ${name}` }));
};

describe("Adicionar conector: one catalog", () => {
  test("even tiles with no tags; suggestions on top; categories with counts and search", async () => {
    const { dialog } = await open();
    // Suggested first (not connected yet, in a fixed order); they leave the grid below.
    const suggested = within(dialog).getByRole("region", { name: "Sugeridos para a Acme" });
    expect(
      within(suggested)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["GitHub", "Banco de dados", "Linear"]);
    const notion = within(dialog).getByRole("button", { name: "Notion" });
    expect(notion.textContent).toContain("Páginas e bancos de dados.");
    // No tags on a card: no category, no "Um clique".
    expect(notion.querySelectorAll(".ac-chip")).toHaveLength(0);
    expect(notion.textContent).not.toContain("Um clique");
    expect(notion.textContent).not.toContain("Docs");
    // The brand icon is a mask of our own file; Notion takes the ink, Linear its color.
    expect(notion.querySelector(".connector-icon__mark")?.getAttribute("style")).toContain("/connectors/notion.svg");
    const linear = within(dialog).getByRole("button", { name: "Linear" });
    expect(linear.querySelector(".connector-icon__mark")?.getAttribute("style")?.toLowerCase()).toContain("#5e6ad2");
    // No icon (Canva): a monogram.
    expect(
      within(dialog).getByRole("button", { name: "Canva" }).querySelector(".connector-icon--mono")?.textContent,
    ).toBe("C");
    // Not configured on this server: last before "Não achou?", and its pane can't connect.
    expect(names(dialog).slice(-2)).toEqual(["Slack", "Não achou?"]);
    await click(within(dialog).getByRole("button", { name: "Slack" }));
    expect(within(pane(dialog, "Slack")).getByRole("button", { name: "Em breve" }).hasAttribute("disabled")).toBe(true);
    expect(dialog.textContent).not.toMatch(/MCP/);

    const cats = within(dialog).getByRole("radiogroup", { name: "Categorias" });
    expect(filterNames(cats)).toEqual([
      "Todos",
      "Conectados",
      "Desenvolvimento",
      "Produto",
      "Docs",
      "Pagamentos",
      "Suporte",
      "Marketing",
      "Automação",
    ]);
    await click(within(cats).getByRole("radio", { name: /^Docs/ }));
    expect(names(dialog)).toEqual(["Google Drive", "Notion", "Não achou?"]);
    await type(within(dialog).getByRole("searchbox", { name: "Buscar conector" }), "notion");
    expect(names(dialog)).toEqual(["Notion", "Não achou?"]);
    await type(within(dialog).getByRole("searchbox", { name: "Buscar conector" }), "zzz");
    expect(dialog.textContent).toContain("Nenhum conector encontrado com “zzz”.");
  });

  test("a tile opens its detail: what agents could do, what asks, how it connects; Esc closes the pane first", async () => {
    const { dialog } = await open();
    await click(within(dialog).getByRole("button", { name: "Notion" }));
    expect(within(dialog).getByRole("button", { name: "Notion" }).getAttribute("aria-pressed")).toBe("true");
    const notion = pane(dialog, "Notion");
    expect(notion.textContent).toContain("O que os agentes poderão fazer");
    expect(notion.textContent).toContain("Buscar e ler páginas");
    expect(notion.textContent).toContain("Um clique: você autoriza na página do serviço");
    // What connecting changes, as one line under what it can do (no heading of its own).
    expect(notion.textContent).toContain("Nenhum agente usa até você escolher.");
    expect(within(notion).queryByRole("heading", { level: 4, name: "Depois de conectar" })).toBeNull();
    // The same tile again closes it; another tile swaps it.
    await click(within(dialog).getByRole("button", { name: "Notion" }));
    expect(within(dialog).queryByRole("complementary")).toBeNull();
    await click(within(dialog).getByRole("button", { name: "GitHub" }));
    const github = pane(dialog, "GitHub");
    // What always asks for approval is marked.
    const asks = github.querySelector("[data-asks]");
    expect(asks?.textContent).toBe("Merge e deploy sempre pedem sua aprovação");
    expect(github.textContent).toContain("Você autoriza na página do serviço, ou usa uma chave de API");
    // Esc: the pane closes, the catalog stays; again: the catalog closes.
    await act(async () => fireEvent.keyDown(dialog, { key: "Escape" }));
    expect(within(dialog).queryByRole("complementary")).toBeNull();
    expect(screen().getByRole("dialog", { name: "Adicionar conector" })).toBeTruthy();
    await act(async () => fireEvent.keyDown(dialog, { key: "Escape" }));
    expect(screen().queryByRole("dialog", { name: "Adicionar conector" })).toBeNull();
  });

  test("the pane's Conectar starts that service's flow; 'Não achou?' connects by address", async () => {
    const { dialog } = await open();
    await pick(dialog, "Notion");
    expect(screen().getByRole("dialog", { name: "Conectar Notion" })).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Adicionar conector" })).toBeNull();
  });

  test("what's connected has a check on its icon and connects another account (a preset counts by its address)", async () => {
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
    const github = within(dialog).getByRole("button", { name: "GitHub, conectado" });
    expect(github.querySelector(".catalog-icon__check")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Zapier, conectado" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Notion" }).querySelector(".catalog-icon__check")).toBeNull();
    await click(github);
    const detail = pane(dialog, "GitHub");
    expect(detail.textContent).toContain("Já conectado");
    expect(within(detail).getByRole("button", { name: "Conectar GitHub de novo" }).textContent).toBe(
      "Conectar outra conta",
    );
    await click(
      within(dialog).getByRole("radiogroup", { name: "Categorias" }).querySelectorAll("[role=radio]")[1] as Element,
    );
    expect(names(dialog)).toEqual(["GitHub", "Zapier", "Não achou?"]);
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
    await pick(dialog, "Linear");
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
    expect(decide.textContent).toContain("Sugestão: muda coisas, porque muda coisas, mas não apaga nada nem gasta dinheiro");
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
    await pick(dialog, "GitHub");
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
    await click(within(dialog).getByRole("button", { name: /Não achou/ }));
    await click(within(pane(dialog, "Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" }));
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
