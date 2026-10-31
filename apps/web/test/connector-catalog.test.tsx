import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AccessInput, ConnectorDef } from "@agenteschat/client";
import { icons } from "@agenteschat/ui";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { authKind, searchCatalog } from "@/components/ConnectorCatalog";
import { setNavigateAway } from "@/lib/navigate";
import { pick, service } from "./catalog";
import { ADA_ID, ATLAS_ID, CATALOG, createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const open = async (state = seedState({ connections: [] }), api = createFakeApi(state)) => {
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
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
const pressEsc = (el: Element) => act(async () => fireEvent.keyDown(el, { key: "Escape" }));
/** Whether an icon is drawn as `name` (its shape's first path). */
const drawnAs = (svg: Element | null | undefined, name: keyof typeof icons) =>
  svg?.querySelector("path")?.getAttribute("d") === icons[name].find(([tag]) => tag === "path")?.[1].d;
/** A level's radio in the radiogroup named `group`. */
const levelIn = (inside: HTMLElement, group: string, level: string) =>
  within(within(inside).getByRole("radiogroup", { name: group })).getByRole("radio", { name: level });
/** The level checked in each radiogroup named in `groups` (null when none is). */
const levels = (inside: HTMLElement, groups: string[]) =>
  groups.map(
    (group) =>
      within(within(inside).getByRole("radiogroup", { name: group }))
        .queryAllByRole("radio")
        .find((r) => r.getAttribute("aria-checked") === "true")?.textContent ?? null,
  );
/** A backend whose catalog also lists Asana as the server does today: its vendor hasn't approved agentes.chat yet. */
const withSoonAsana = (state: FakeState) => {
  const api = createFakeApi(state);
  const asana: ConnectorDef = {
    ...(CATALOG.connectors.find((d) => d.id === "linear") as ConnectorDef),
    id: "asana",
    label: "Asana",
    description: "Asana tasks, projects and teams.",
    serverUrl: "https://mcp.asana.com/mcp",
    iconUrl: "/connectors/asana.svg",
    brandColor: "#F06A6A",
    available: false,
    soon: true,
  };
  api.connectors.catalog = async () => ({ ...CATALOG, connectors: [asana, ...CATALOG.connectors] });
  return api;
};
/** As the server leaves a first connection: every agent's, whole. */
const everyAgent = (api: ReturnType<typeof createFakeApi>, connectionId: string) =>
  (api.access as typeof api.access & { connected: (id: string, agents: string[]) => void }).connected(connectionId, [
    ADA_ID,
    ATLAS_ID,
  ]);

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
    // Canva's mark keeps its colors: drawn as it is, not as a mask. No icon (Slack here): a monogram.
    expect(within(dialog).getByRole("button", { name: "Canva" }).querySelector("img")?.getAttribute("src")).toBe(
      "/brands/canva.svg",
    );
    expect(
      within(dialog).getByRole("button", { name: "Slack" }).querySelector(".connector-icon--mono")?.textContent,
    ).toBe("S");
    // Not configured on this server: last before "Não achou?", and its service can't connect.
    expect(names(dialog).slice(-2)).toEqual(["Slack", "Não achou?"]);
    await click(within(dialog).getByRole("button", { name: "Slack" }));
    const slack = service("Slack");
    expect(within(slack).getByRole("button", { name: "Em breve" }).hasAttribute("disabled")).toBe(true);
    expect(`${dialog.textContent} ${slack.textContent}`).not.toMatch(/MCP/);
    await click(within(slack).getByRole("button", { name: "Fechar detalhe" }));

    // "Todos" and "Conectados", then the categories by name: in the list beside the grid, and in the phone's row.
    const order = [
      "Todos",
      "Conectados",
      "Automação",
      "Desenvolvimento",
      "Docs",
      "Marketing",
      "Pagamentos",
      "Produto",
      "Suporte",
    ];
    const cats = within(dialog).getByRole("radiogroup", { name: "Categorias" });
    expect(filterNames(cats)).toEqual(order);
    const list = within(dialog).getByRole("navigation", { name: "Categorias" });
    expect([...list.querySelectorAll(".catalog__cat-name")].map((el) => el.textContent)).toEqual(order);
    await click(within(cats).getByRole("radio", { name: /^Docs/ }));
    expect(names(dialog)).toEqual(["Google Drive", "Notion", "Não achou?"]);
    await type(within(dialog).getByRole("searchbox", { name: "Buscar conector" }), "notion");
    expect(names(dialog)).toEqual(["Notion", "Não achou?"]);
  });

  test("nothing found: one of our agents searching, with the way in by address", async () => {
    const { dialog } = await open();
    const search = within(dialog).getByRole("searchbox", { name: "Buscar conector" });
    const empty = () => dialog.querySelector<HTMLElement>(".catalog__empty");
    await type(search, " zzz ");
    // No grid behind it, not even "Não achou?": the empty state carries the way in.
    expect(names(dialog)).toEqual([]);
    const box = empty() as HTMLElement;
    expect(box.querySelector(".ac-empty__art[aria-hidden='true'] canvas.ac-searchpx")).not.toBeNull();
    expect(box.querySelector(".ac-empty__title")?.textContent).toBe("Nenhum conector com “zzz”");
    expect(box.querySelector(".ac-empty__text")?.textContent).toBe(
      "Você pode conectar qualquer serviço pelo endereço dele.",
    );
    // Its button opens what "Não achou?" opens.
    const byAddress = within(box).getByRole("button", { name: "Conectar pelo endereço" });
    expect(byAddress.getAttribute("aria-haspopup")).toBe("dialog");
    await click(byAddress);
    expect(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" })).toBeTruthy();
    await pressEsc(service("Outro serviço"));

    // A category with nothing in it: the same, in its own words.
    await type(search, "");
    expect(empty()).toBeNull();
    const cats = within(dialog).getByRole("radiogroup", { name: "Categorias" });
    await click(within(cats).getByRole("radio", { name: /^Conectados/ }));
    expect(names(dialog)).toEqual([]);
    expect(empty()?.querySelector(".ac-empty__title")?.textContent).toBe("Nenhum conector nesta categoria ainda");
    expect(within(empty() as HTMLElement).getByRole("button", { name: "Conectar pelo endereço" })).toBeTruthy();
  });

  test("a vendor that hasn't approved agentes.chat yet: greyed, a lock and 'Em breve', last, and its tile opens nothing", async () => {
    const state = seedState({ connections: [] });
    const { dialog } = await open(state, withSoonAsana(state));
    const tile = within(dialog).getByRole("button", { name: "Asana, em breve" }) as HTMLButtonElement;
    expect([tile.hasAttribute("data-soon"), tile.disabled, tile.hasAttribute("aria-haspopup")]).toEqual([
      true,
      true,
      false,
    ]);
    const chip = tile.querySelector(".ac-chip");
    expect(chip?.textContent).toBe("Em breve");
    expect(drawnAs(chip?.querySelector("svg"), "lock")).toBe(true);
    // In place of the description: the name keeps its whole row.
    expect(tile.querySelector(".catalog-tile__head")?.textContent).toBe("Asana");
    expect(tile.textContent).not.toContain("Tarefas, projetos e times.");
    // With what can't connect here, last before "Não achou?".
    expect(names(dialog).slice(-3)).toEqual(["Asana", "Slack", "Não achou?"]);
    await click(tile);
    expect(screen().queryByRole("dialog", { name: "Asana" })).toBeNull();
    expect(screen().getAllByRole("dialog")).toEqual([dialog]);
    const starts = ["customConnectors.connect", "connectors.startOAuth", "connectors.connectWithKey"];
    expect(state.calls.filter((c) => starts.includes(c.method))).toEqual([]);
  });

  test("a 'soon' one connected by its address (with a key) is a connection like any other: a check, no lock, it opens", async () => {
    const state = seedState({ connections: [] });
    const api = withSoonAsana(state);
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://mcp.asana.com/mcp",
      label: "Asana",
      apiKey: "asana_key_123456",
      returnTo: "/",
    });
    const { dialog } = await open(state, api);
    const tile = within(dialog).getByRole("button", { name: "Asana, conectado" }) as HTMLButtonElement;
    expect([tile.disabled, tile.hasAttribute("data-soon"), Boolean(tile.querySelector(".ac-chip"))]).toEqual([
      false,
      false,
      false,
    ]);
    expect(tile.querySelector(".catalog-icon__check")).toBeTruthy();
    expect(names(dialog).slice(-2)).toEqual(["Slack", "Não achou?"]);
    await click(tile);
    expect(
      within(service("Asana")).getByRole("button", { name: "Conectar Asana de novo" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  test("a tile opens its service over the catalog: what agents could do, what asks, how it connects; Esc closes the service first", async () => {
    const { dialog } = await open();
    const tile = within(dialog).getByRole("button", { name: "Notion" });
    // It opens a dialog, it isn't a toggle.
    expect([tile.getAttribute("aria-haspopup"), tile.hasAttribute("aria-pressed")]).toEqual(["dialog", false]);
    await click(tile);
    const notion = service("Notion");
    expect(notion.textContent).toContain("O que os agentes poderão fazer");
    expect(notion.textContent).toContain("Buscar e ler páginas");
    expect(notion.textContent).toContain("Um clique: você autoriza na página do serviço");
    // What connecting changes, as one line under what it can do (no heading of its own).
    expect(notion.textContent).toContain(
      "Ao conectar, todos os agentes podem usar. Em seguida, você escolhe o acesso de cada um.",
    );
    expect(within(notion).queryByRole("heading", { level: 4, name: "Depois de conectar" })).toBeNull();
    // × goes back to the catalog; another tile opens its own.
    await click(within(notion).getByRole("button", { name: "Fechar detalhe" }));
    expect(screen().queryByRole("dialog", { name: "Notion" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "GitHub" }));
    const github = service("GitHub");
    // What always asks for approval is marked.
    const asks = github.querySelector("[data-asks]");
    expect(asks?.textContent).toBe("Merge e deploy sempre pedem sua aprovação");
    expect(github.textContent).toContain("Você autoriza na página do serviço, ou usa uma chave de API");
    // Esc: the service closes, the catalog stays; again: the catalog closes.
    await pressEsc(github);
    expect(screen().queryByRole("dialog", { name: "GitHub" })).toBeNull();
    expect(screen().getByRole("dialog", { name: "Adicionar conector" })).toBe(dialog);
    await pressEsc(dialog);
    expect(screen().queryByRole("dialog", { name: "Adicionar conector" })).toBeNull();
  });

  test("from the keyboard: focus lands in the service; Esc closes only it, back on its tile, the catalog as it was", async () => {
    const { dialog } = await open();
    const search = within(dialog).getByRole("searchbox", { name: "Buscar conector" }) as HTMLInputElement;
    const docs = within(within(dialog).getByRole("radiogroup", { name: "Categorias" })).getByRole("radio", {
      name: /^Docs/,
    });
    await click(docs);
    await type(search, "notion");
    const list = within(dialog).getByRole("region", { name: "Conectores disponíveis" });
    list.scrollTop = 48;
    const tile = within(dialog).getByRole("button", { name: "Notion" });
    // Enter on a tile presses it with the focus on it.
    tile.focus();
    await click(tile);
    expect(service("Notion").contains(document.activeElement)).toBe(true);
    await pressEsc(document.activeElement as Element);
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Notion" })).toBeNull();
    expect(document.activeElement).toBe(tile);
    expect([search.value, docs.getAttribute("aria-checked"), list.scrollTop]).toEqual(["notion", "true", 48]);
    expect(names(dialog)).toEqual(["Notion", "Não achou?"]);
  });

  test("the service's Conectar starts its flow; 'Não achou?' connects by address", async () => {
    const { dialog } = await open();
    await pick(dialog, "Notion");
    expect(screen().getByRole("dialog", { name: "Conectar Notion" })).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Notion" })).toBeNull();
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
    const detail = service("GitHub");
    expect(detail.querySelector(".catalog-icon__check")).toBeTruthy();
    expect(detail.textContent).toContain("Já conectado");
    expect(within(detail).getByRole("button", { name: "Conectar GitHub de novo" }).textContent).toBe(
      "Conectar outra conta",
    );
    await pressEsc(detail);
    await click(
      within(dialog).getByRole("radiogroup", { name: "Categorias" }).querySelectorAll("[role=radio]")[1] as Element,
    );
    expect(names(dialog)).toEqual(["GitHub", "Zapier", "Não achou?"]);
  });

  test("what connecting does to who uses it: a new service is everyone's, again keeps it, a database starts with none", async () => {
    const api = createFakeApi(seedState());
    await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.zapier.example/mcp/",
      label: "Zapier",
      returnTo: "/",
    });
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    const catalog = async () => {
      await click(screen().getByRole("button", { name: "Adicionar conector" }));
      return screen().getByRole("dialog", { name: "Adicionar conector" });
    };
    let dialog = await catalog();
    const detail = async (tile: string, name: string) => {
      await click(within(dialog).getByRole("button", { name: tile }));
      const text = service(name).textContent;
      await pressEsc(service(name));
      return text;
    };
    const everyone = "Ao conectar, todos os agentes podem usar. Em seguida, você escolhe o acesso de cada um.";
    const keeps = "Os agentes mantêm o acesso que já têm. Em seguida, você pode mudar o de cada um.";
    expect(await detail("Notion", "Notion")).toContain(everyone);
    expect(await detail("GitHub, conectado", "GitHub")).toContain(keeps);
    expect(await detail("Zapier, conectado", "Zapier")).toContain(keeps);
    const database = await detail("Banco de dados", "Banco de dados");
    expect(database).toContain("Nenhum agente usa até você escolher.");
    expect(database).not.toContain(everyone);

    // Connecting another account: step 1 says the agents keep what they have.
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    await click(within(dialog).getByRole("button", { name: "GitHub, conectado" }));
    await click(within(service("GitHub")).getByRole("button", { name: "Conectar GitHub de novo" }));
    expect(screen().getByRole("dialog", { name: "Conectar GitHub" })).toBe(flow());
    expect(flow().textContent).toContain("Os agentes mantêm o acesso que já têm. Você muda isso no passo 3.");
    expect(flow().textContent).not.toContain("todos os agentes podem usar");
    await click(within(flow()).getByRole("button", { name: "Cancelar" }));

    // By address: the note follows the address typed (a server already connected is connected again).
    dialog = await catalog();
    await click(within(dialog).getByRole("button", { name: /Não achou/ }));
    await click(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" }));
    expect(flow().textContent).toContain("Ao conectar, todos os agentes podem usar. Você muda isso no passo 3.");
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.zapier.example/mcp");
    expect(flow().textContent).toContain("Os agentes mantêm o acesso que já têm. Você muda isso no passo 3.");
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

  test("the close sits on its big title's capitals' middle; a service's, in the corner, isn't lifted", async () => {
    const css = (await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const rule = (selector: string, from = css) => from.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".catalog .ac-dialog__head")).toContain("--title-cap-mid: 0.88px;");
    const phone = css.split("\n@media (max-width: 760px) {\n  .catalog__body {")[1] ?? "";
    expect(rule("  .catalog .ac-dialog__head", phone)).toContain("--title-cap-mid: 0.51px;");
    expect(rule(".catalog-svc .ac-dialog__acts")).toContain("translate: none");
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
    expect(flow().textContent).toContain("Ao conectar, todos os agentes podem usar. Você muda isso no passo 3.");

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
    expect(decide.textContent).toContain("Sugestão: muda coisas (não apaga nada nem gasta dinheiro)");
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

    // Step 3: everyone starts at "Ler e escrever" (the server gave it to every agent); then a level each.
    expect(screen().getByRole("dialog", { name: "Quem pode usar Linear" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de todos os agentes", "Ler"));
    await click(levelIn(flow(), "Nível de Ada", "Sem acesso"));
    expect(flow().textContent).toContain("1 ação sempre pede aprovação no chat.");
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const serverId = state.calls.find((c) => c.method === "customConnectors.saveTools")?.args[1] as string;
    const put = (agentId: string) =>
      state.calls.find((c) => c.method === "access.set" && c.args[1] === agentId)?.args[2] as AccessInput;
    // "Sem acesso": nothing of the server is left.
    expect(put(ADA_ID).connectors[serverId]).toBeUndefined();
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
    expect(section.textContent).toContain("1 de 2 agentes");
  });

  test("a server whose OAuth only lets in apps it approved says so, not 'no OAuth', and the key stays the way in", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    const connect = api.customConnectors.connect;
    api.customConnectors.connect = async (orgId, input) =>
      input.apiKey ? connect(orgId, input) : { status: "needs_key", reason: "not_approved" };
    const { dialog } = await open(state, api);
    await pick(dialog, "Linear");
    const flow = screen().getByRole("dialog", { name: "Conectar Linear" });
    await click(within(flow).getByRole("button", { name: "Continuar no Linear" }));
    await settle(4);
    expect(flow.textContent).toContain(
      "Linear só deixa entrar apps que aprovou, e o agentes.chat ainda não foi aprovado. Se ele te der uma chave de API, dá para conectar com ela.",
    );
    expect(flow.textContent).not.toContain("não aceita OAuth");
    expect(flow.querySelector("details.cflow__more")?.hasAttribute("open")).toBe(true);
    await type(within(flow).getByLabelText("Chave de API"), "lin_api_123456");
    await click(within(flow).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: REVIEW })).toBeTruthy();
  });

  test("'Todos os agentes' is a row like an agent's, on top and raised: it sets every agent, and shows none when they differ", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api: createFakeApi(state) });
    await settle(8);
    await click(screen().getByRole("button", { name: "Quem usa GitHub" }));
    await settle(4);
    const flow = screen().getByRole("dialog", { name: "Quem pode usar GitHub" });
    const everyone = "Nível de todos os agentes";
    const groups = [everyone, "Nível de Ada", "Nível de Atlas"];
    // Connected before, and nobody uses it yet.
    expect(levels(flow, groups)).toEqual(["Sem acesso", "Sem acesso", "Sem acesso"]);
    const all = within(flow).getByRole("radiogroup", { name: everyone }).closest(".cflow-agent") as HTMLElement;
    expect(all.classList.contains("cflow-agent--all")).toBe(true);
    expect(all.textContent).toContain("Todos os agentes");
    expect(all.textContent).toContain("2 agentes");
    const ada = within(flow).getByRole("radiogroup", { name: "Nível de Ada" });
    expect(all.compareDocumentPosition(ada) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(all.contains(ada)).toBe(false);

    await click(levelIn(flow, everyone, "Ler e escrever"));
    expect(levels(flow, groups)).toEqual(["Ler e escrever", "Ler e escrever", "Ler e escrever"]);
    await click(levelIn(flow, "Nível de Atlas", "Ler"));
    expect(levels(flow, groups)).toEqual([null, "Ler e escrever", "Ler"]);
    await click(within(flow).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const put = (agentId: string) =>
      state.calls.find((c) => c.method === "access.set" && c.args[1] === agentId)?.args[2] as AccessInput;
    // "Ler e escrever": the whole connection (sensitive tools still ask).
    expect(put(ADA_ID).connectors["conn-gh"]).toBe(true);
    expect(put(ATLAS_ID).connectors["conn-gh"]).toBeUndefined();
    expect(put(ATLAS_ID).scopes.filter((g) => g.connectionId === "conn-gh")).toEqual([
      { connectionId: "conn-gh", scope: "github:repo.read" },
    ]);
  });

  test("a new connection: every agent at 'Ler e escrever', read fresh after connecting, so Liberar only confirms", async () => {
    // GitHub is connected: the page already read every agent's access, from before the new server.
    const { state, dialog } = await open(seedState());
    await click(within(dialog).getByRole("button", { name: /Não achou/ }));
    await click(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" }));
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    await type(within(flow()).getByLabelText("Endereço do servidor MCP"), "https://oauth.suporte.example.com");
    await type(within(flow()).getByLabelText("Nome"), "Suporte");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Quem pode usar Suporte" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    // Sensitive actions still ask, and the dialog says so.
    expect(flow().textContent).toContain("1 ação sempre pede aprovação no chat.");
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    expect(state.calls.filter((c) => c.method === "access.set")).toEqual([]);
    expect(document.body.textContent).toContain("Suporte: 2 agentes podem usar.");
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

  test("ours by API key, from the catalog's Conectar: what it does, then who can use it, every agent as the server left it", async () => {
    const { state, dialog } = await open();
    await pick(dialog, "GitHub");
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    await click(within(flow()).getByText("Conectar com uma chave de API"));
    await type(within(flow()).getByLabelText("Chave de API"), "ghp_abcdef123456");
    await click(within(flow()).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "O que GitHub faz" })).toBeTruthy();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Quem pode usar GitHub" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de todos os agentes", "Ler"));
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const id = state.connections.find((c) => c.connector === "github")?.id ?? "";
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts.map((c) => c.args[1])).toEqual([ADA_ID, ATLAS_ID]);
    for (const put of puts) {
      const input = put.args[2] as AccessInput;
      expect(input.connectors[id]).toBeUndefined();
      expect(input.scopes.filter((s) => s.connectionId === id)).toEqual([
        { connectionId: id, scope: "github:repo.read" },
      ]);
    }
  });

  test("back from OAuth (`?connected=github`): what it does (read-only, by scope), then 'Ler' = its read scopes", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    everyAgent(api, "conn-gh");
    await renderApp(`/org/${ORG_ID}/settings/connectors?connected=github`, { api });
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
    expect(screen().getByRole("dialog", { name: "Quem pode usar GitHub" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de Ada", "Ler"));
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

  test("back from OAuth in the desktop app's window, Conectores already loaded: its tools, then who can use it", async () => {
    const state = seedState({ connections: [] });
    const api = createFakeApi(state);
    // As the server finishes it.
    api.connectors.completeOAuth = async (orgId, input) => {
      state.calls.push({ method: "connectors.completeOAuth", args: [orgId, input] });
      state.connections.push({
        id: "conn-new",
        connector: "github",
        label: "GitHub",
        serverUrl: "https://api.githubcopilot.com/mcp/",
        authType: "oauth",
        accountLabel: "acme",
        tokenExpiresAt: null,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      });
      everyAgent(api, "conn-new");
      return { connectionId: "conn-new", connector: "github", returnTo: `/org/${ORG_ID}/settings/connectors` };
    };
    const { router } = await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    expect(screen().getByRole("region", { name: "Conectores" }).textContent).toContain("Nenhum conector ainda.");
    // The window moves in the page (no reload): the lists read before the sign-in are still cached.
    await act(async () => router.history.push(`/desktop/connector?org=${ORG_ID}&state=s1&code=c1`));
    await settle(12);
    expect(state.calls.find((c) => c.method === "connectors.completeOAuth")?.args[1]).toEqual({
      state: "s1",
      code: "c1",
    });
    const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;
    expect(screen().getByRole("dialog", { name: "O que GitHub faz" })).toBeTruthy();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Quem pode usar GitHub" })).toBeTruthy();
    expect(levels(flow(), ["Nível de todos os agentes", "Nível de Ada", "Nível de Atlas"])).toEqual([
      "Ler e escrever",
      "Ler e escrever",
      "Ler e escrever",
    ]);
    await click(levelIn(flow(), "Nível de Atlas", "Sem acesso"));
    await click(within(flow()).getByRole("button", { name: "Liberar" }));
    await settle(8);
    const puts = state.calls.filter((c) => c.method === "access.set");
    expect(puts.map((c) => c.args[1])).toEqual([ATLAS_ID]);
    const input = puts[0]?.args[2] as AccessInput;
    expect(input.connectors["conn-new"]).toBeUndefined();
    expect(input.scopes.some((s) => s.connectionId === "conn-new")).toBe(false);
    expect(document.body.textContent).toContain("GitHub: 1 agente pode usar.");
  });

  test("any MCP server by address; back from its OAuth (`?connected=custom:{id}`) the review opens", async () => {
    const { state, dialog } = await open();
    await click(within(dialog).getByRole("button", { name: /Não achou/ }));
    await click(within(service("Outro serviço")).getByRole("button", { name: "Conectar pelo endereço" }));
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
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Quem pode usar himetrica" })).toBeTruthy();
    expect(levels(flow(), ["Nível de Ada", "Nível de Atlas"])).toEqual(["Ler e escrever", "Ler e escrever"]);
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
    // Connected, it was every agent's.
    expect(confirm.textContent).toContain("2 agentes perdem o acesso na hora.");
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "customConnectors.disconnect")?.args).toEqual([ORG_ID, res.server.id]);
    expect(section().textContent).toContain("Nenhum conector ainda.");
  });
});
