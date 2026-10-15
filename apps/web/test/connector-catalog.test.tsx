import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { isAvailable, searchCatalog, usesOAuth } from "@/components/ConnectorCatalog";
import { CATALOG, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const open = async (state = seedState({ connections: [] })) => {
  const api = createFakeApi(state);
  const connect = api.customConnectors.connect;
  api.customConnectors.connect = (orgId, input) => {
    state.calls.push({ method: "customConnectors.connect", args: [orgId, input] });
    return connect(orgId, input);
  };
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
  await click(screen().getByRole("button", { name: "Adicionar conector" }));
  return { state, dialog: screen().getByRole("dialog", { name: "Adicionar conector" }) };
};
const names = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole("listitem")
    .map((li) => li.querySelector(".catalog-card__name")?.textContent);

describe("Adicionar conector: the catalog", () => {
  test("cards with name, one line, OAuth badge; categories filter; 'Em breve' can't connect", async () => {
    const { dialog } = await open();
    const notion = within(dialog).getByText("Notion").closest("li") as HTMLElement;
    expect(notion.textContent).toContain("Páginas e bancos de dados.");
    expect(notion.textContent).toContain("OAuth");
    expect(within(notion).getByRole("button", { name: "Conectar Notion" })).toBeTruthy();
    // Slack isn't configured on this server: last, "Em breve", no button.
    const slack = within(dialog).getByText("Slack").closest("li") as HTMLElement;
    expect(slack.textContent).toContain("Em breve");
    expect(within(slack).queryByRole("button")).toBeNull();
    expect(names(dialog).at(-1)).toBe("Slack");
    // Sentry has no OAuth app here (API key): no badge.
    expect((within(dialog).getByText("Sentry").closest("li") as HTMLElement).textContent).not.toContain("OAuth");

    const cats = within(dialog).getByRole("group", { name: "Categorias" });
    expect(
      within(cats)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Todos", "Desenvolvimento", "Produto", "Docs", "Suporte"]);
    await click(within(cats).getByRole("button", { name: "Docs" }));
    expect(names(dialog)).toEqual(["Google Drive", "Notion"]);
    await type(within(dialog).getByRole("searchbox", { name: "Buscar conector" }), "notion");
    expect(names(dialog)).toEqual(["Notion"]);
  });

  test("an official remote MCP server: one click, a key when it asks, then the tools review", async () => {
    const { state, dialog } = await open();
    await click(within(dialog).getByRole("button", { name: "Conectar Linear" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "customConnectors.connect")?.args[1]).toMatchObject({
      serverUrl: "https://mcp.linear.app/mcp",
      label: "Linear",
    });
    // This server wants a key: the connect form opens filled in.
    const connect = screen().getByRole("dialog", { name: "Conectar Linear" });
    expect((within(connect).getByLabelText("Endereço do servidor MCP") as HTMLInputElement).value).toBe(
      "https://mcp.linear.app/mcp",
    );
    await type(within(connect).getByLabelText("Chave de API"), "lin_api_123456");
    await click(within(connect).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Ferramentas de Linear" })).toBeTruthy();
  });

  test("rules: availability, OAuth, search", () => {
    const byId = (id: string) => CATALOG.connectors.find((d) => d.id === id);
    const slack = byId("slack");
    const sentry = byId("sentry");
    const linear = byId("linear");
    expect(slack && isAvailable(slack)).toBe(false);
    expect(sentry && isAvailable(sentry)).toBe(true);
    expect(sentry && usesOAuth(sentry)).toBe(false);
    expect(linear && usesOAuth(linear)).toBe(true);
    expect(searchCatalog(CATALOG.connectors, "ciclos").map((d) => d.id)).toEqual(["linear"]);
  });
});
