import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { AccessInput, CustomServer } from "@/api/types";
import { defaultAccess, draftFrom, exposedTools, humanize, toolsToReview } from "@/lib/custom-tools";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};

describe("classification model", () => {
  const server = (reviewedAt: string | null, accesses: (null | "read")[]): CustomServer => ({
    id: "s",
    serverUrl: "https://mcp.example.com",
    label: "Suporte",
    authType: "api_key",
    reviewedAt,
    createdAt: "",
    tools: accesses.map((access, i) => ({
      name: `tool_${i}`,
      description: "",
      readOnlyHint: i === 0 ? true : null,
      access,
      label: "",
      firstSeenAt: "",
    })),
  });

  test("read-only tools start as Leitura; everything else asks for approval", () => {
    expect(defaultAccess({ readOnlyHint: true })).toBe("read");
    expect(defaultAccess({ readOnlyHint: false })).toBe("approval");
    expect(defaultAccess({ readOnlyHint: null })).toBe("approval");
    expect(draftFrom(server(null, [null, null])).map((d) => d.access)).toEqual(["read", "approval"]);
    expect(humanize("list_tickets")).toBe("List tickets");
  });

  test("nothing is exposed before a save; new tools stay hidden until classified", () => {
    expect(exposedTools(server(null, ["read", "read"]))).toEqual([]);
    const reviewed = server("2026-10-14", ["read", null]);
    expect(exposedTools(reviewed).map((t) => t.name)).toEqual(["tool_0"]);
    expect(toolsToReview(reviewed)).toBe(1);
    expect(draftFrom(reviewed).map((d) => d.isNew)).toEqual([false, true]);
  });
});

describe("Conectar outro servidor MCP", () => {
  test("URL → API key → classify → save; new tools later ask for review", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api: createFakeApi(state) });
    await settle(5);
    await click(screen().getByRole("button", { name: "Conectar outro servidor MCP" }));
    const connect = screen().getByRole("dialog", { name: "Conectar outro servidor MCP" });
    await type(within(connect).getByLabelText("Endereço do servidor MCP"), "http://inseguro");
    await click(within(connect).getByRole("button", { name: "Continuar" }));
    expect(connect.textContent).toContain("Use um endereço que comece com https://.");
    await type(within(connect).getByLabelText("Endereço do servidor MCP"), "https://mcp.suporte.example.com");
    await type(within(connect).getByLabelText("Nome"), "Suporte");
    await click(within(connect).getByRole("button", { name: "Continuar" }));
    await settle(3);
    // No OAuth on this server: ask for a key.
    expect(connect.textContent).toContain("Este servidor não aceita OAuth. Conecte com uma chave de API.");
    await type(within(connect).getByLabelText("Chave de API"), "chave-secreta-123");
    await click(within(connect).getByRole("button", { name: "Conectar com a chave" }));
    await settle(4);

    const review = screen().getByRole("dialog", { name: "Ferramentas de Suporte" });
    expect(review.textContent).toContain("Nada fica disponível para os agentes até você salvar.");
    const accessOf = (name: string) => within(review).getByRole("combobox", { name: `Uso de ${name}` });
    expect(accessOf("list_tickets").textContent).toContain("Leitura");
    expect(accessOf("create_ticket").textContent).toContain("Sempre pede aprovação");
    expect(accessOf("delete_customer").textContent).toContain("Sempre pede aprovação");
    // Our own select (keyboard): create_ticket → Escrita.
    const trigger = accessOf("create_ticket");
    trigger.focus();
    await key(trigger, "Enter");
    const listbox = screen().getByRole("listbox");
    await click(within(listbox).getByRole("option", { name: /Escrita/ }));
    await settle();
    expect(accessOf("create_ticket").textContent).toContain("Escrita");
    await type(within(review).getByLabelText("Nome em português de list_tickets"), "Listar chamados");
    await type(within(review).getByRole("searchbox", { name: "Buscar ferramenta" }), "delete");
    expect(within(review).getAllByRole("combobox")).toHaveLength(1);
    await type(within(review).getByRole("searchbox", { name: "Buscar ferramenta" }), "");
    // Behind the modal (aria-hidden), the row already says it waits for classification.
    expect(screen().getByRole("region", { name: "Conectores", hidden: true }).textContent).toContain(
      "Aguardando classificação",
    );
    await click(within(review).getByRole("button", { name: "Salvar classificação" }));
    await settle(4);
    // Straight to "who can use it": each checked agent gets the whole connector.
    const grant = screen().getByRole("dialog", { name: "Quais agentes podem usar o Suporte?" });
    await click(within(grant).getByRole("checkbox", { name: /Ada/ }));
    await click(within(grant).getByRole("button", { name: "Liberar para os escolhidos" }));
    await settle(6);
    const put = state.calls.find((c) => c.method === "access.set")?.args as [string, string, AccessInput];
    expect(put[1]).toBe(ADA_ID);
    expect(Object.values(put[2].connectors)).toContain(true);
    const section = screen().getByRole("region", { name: "Conectores" });
    expect(section.textContent).toContain("5 ferramentas disponíveis");

    // The server gains a tool: it shows up for review and stays hidden.
    await click(within(section).getByRole("button", { name: "Buscar ferramentas novas" }));
    await settle(4);
    expect(screen().getByRole("region", { name: "Conectores" }).textContent).toContain(
      "1 ferramenta nova para revisar",
    );
    await click(
      within(screen().getByRole("region", { name: "Conectores" })).getByRole("button", {
        name: "Revisar e liberar ferramentas",
      }),
    );
    const again = screen().getByRole("dialog", { name: "Ferramentas de Suporte" });
    const fresh = within(again).getByText("export_tickets").closest(".tool-row") as HTMLElement;
    expect(fresh.textContent).toContain("Nova");
    expect(within(again).getByLabelText("Nome em português de list_tickets")).toHaveProperty(
      "value",
      "Listar chamados",
    );
    expect(within(again).getByRole("combobox", { name: "Uso de create_ticket" }).textContent).toContain("Escrita");
  });

  test("labels can't be empty", async () => {
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api: createFakeApi(seedState()) });
    await settle(5);
    await click(screen().getByRole("button", { name: "Conectar outro servidor MCP" }));
    const connect = screen().getByRole("dialog", { name: "Conectar outro servidor MCP" });
    // URLs with "oauth" connect at once in the mock (OAuth discovery/DCR on the real backend).
    await type(within(connect).getByLabelText("Endereço do servidor MCP"), "https://oauth.mcp.example.com");
    await click(within(connect).getByRole("button", { name: "Continuar" }));
    await settle(4);
    const review = screen().getByRole("dialog", { name: "Ferramentas de oauth.mcp.example.com" });
    await type(within(review).getByLabelText("Nome em português de get_ticket"), " ");
    await click(within(review).getByRole("button", { name: "Salvar classificação" }));
    expect(review.textContent).toContain("Dê um nome em português para cada ferramenta.");
  });

  test("back from OAuth: the classification opens; the pending card calls to action; Aceitar sugestão", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const res = await api.customConnectors.connect(ORG_ID, {
      serverUrl: "https://oauth.himetrica.com",
      label: "himetrica",
      returnTo: "/",
    });
    if (res.status !== "connected") throw new Error("expected connected");
    // The backend suggests per tool (read-only → Leitura, destructive → approval, else Escrita).
    for (const t of res.server.tools) t.suggestedAccess = t.readOnlyHint ? "read" : "write";
    const list = api.customConnectors.list.bind(api.customConnectors);
    api.customConnectors.list = async (orgId) =>
      (await list(orgId)).map((s) =>
        s.id === res.server.id
          ? { ...s, tools: s.tools.map((t, i) => ({ ...t, suggestedAccess: res.server.tools[i]?.suggestedAccess })) }
          : s,
      );
    await renderApp(`/org/${ORG_ID}/settings?connected=custom&review=1`, { api });
    await settle(8);
    const review = screen().getByRole("dialog", { name: "Ferramentas de himetrica" });
    await click(within(review).getByRole("button", { name: "Aceitar sugestão" }));
    expect(within(review).getByRole("combobox", { name: "Uso de get_ticket" }).textContent).toContain("Leitura");
    await click(within(review).getByRole("button", { name: "Cancelar" }));
    await settle(2);
    const section = screen().getByRole("region", { name: "Conectores" });
    expect(section.textContent).toContain("Os agentes só usam as ferramentas depois que você revisar.");
    const cta = within(section).getByRole("button", { name: "Revisar e liberar ferramentas" });
    expect(cta.className).toContain("ac-btn--primary");
  });

  test("Aceitar sugestão is hidden when the backend sends no suggestion", async () => {
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api: createFakeApi(seedState()) });
    await settle(5);
    await click(screen().getByRole("button", { name: "Conectar outro servidor MCP" }));
    const connect = screen().getByRole("dialog", { name: "Conectar outro servidor MCP" });
    await type(within(connect).getByLabelText("Endereço do servidor MCP"), "https://oauth.mcp.example.com");
    await click(within(connect).getByRole("button", { name: "Continuar" }));
    await settle(4);
    const review = screen().getByRole("dialog", { name: "Ferramentas de oauth.mcp.example.com" });
    expect(within(review).queryByRole("button", { name: "Aceitar sugestão" })).toBeNull();
  });
});
