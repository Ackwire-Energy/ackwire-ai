import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { setNavigateAway } from "@/lib/navigate";
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

describe("Configurações da organização", () => {
  test("organization context is saved with PATCH /settings", async () => {
    const { state } = await go();
    expect(screen().getByRole("heading", { level: 1, name: "Configurações da organização" })).toBeTruthy();
    const save = screen().getByRole("button", { name: "Salvar organização" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await type(screen().getByLabelText("Contexto da organização"), "A Acme faz um app para clínicas.");
    await click(save);
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.updateSettings")?.args[1]).toMatchObject({
      name: "Acme",
      context: "A Acme faz um app para clínicas.",
      timezone: "America/Sao_Paulo",
    });
  });

  test("connected connectors are listed; disconnect asks first", async () => {
    const { state } = await go();
    const section = screen().getByRole("region", { name: "Conectores" });
    expect(section.textContent).toContain("GitHub");
    expect(section.textContent).toContain("Conectado como acme · por OAuth");
    await click(within(section).getByRole("button", { name: "Desconectar" }));
    const dialog = screen().getByRole("dialog", { name: "Desconectar GitHub" });
    expect(dialog.textContent).toContain("Os agentes perdem as permissões do GitHub na hora.");
    await click(within(dialog).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "connectors.disconnect")?.args).toEqual([ORG_ID, "conn-gh"]);
    expect(screen().getByRole("region", { name: "Conectores" }).textContent).toContain("Nenhum conector ainda.");
  });

  test("add a connector from the searchable catalog with an API key", async () => {
    const { state } = await go();
    await click(screen().getByRole("button", { name: "Adicionar conector" }));
    const add = screen().getByRole("dialog", { name: "Adicionar conector" });
    expect(add.textContent).toContain("Repositórios, PRs, issues e Actions.");
    await type(within(add).getByRole("searchbox", { name: "Buscar conector" }), "sentry");
    expect(within(add).getAllByRole("button", { name: "Conectar" })).toHaveLength(1);
    await click(within(add).getByRole("button", { name: "Conectar" }));
    const connect = screen().getByRole("dialog", { name: "Conectar Sentry" });
    // Sentry has no OAuth app on this server: API key only.
    expect(within(connect).queryByRole("button", { name: "Conectar com Sentry" })).toBeNull();
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
    expect(screen().getByRole("region", { name: "Conectores" }).textContent).toContain("Sentry");
  });

  test("OAuth: starts on the server and leaves for the provider, coming back to settings", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const state = seedState({ connections: [] });
    await go(state);
    await click(screen().getByRole("button", { name: "Adicionar conector" }));
    const add = screen().getByRole("dialog", { name: "Adicionar conector" });
    await type(within(add).getByRole("searchbox", { name: "Buscar conector" }), "github");
    await click(within(add).getByRole("button", { name: "Conectar" }));
    const connect = screen().getByRole("dialog", { name: "Conectar GitHub" });
    await click(within(connect).getByRole("button", { name: "Conectar com GitHub" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "connectors.startOAuth")?.args).toEqual([
      ORG_ID,
      "github",
      { returnTo: `/org/${ORG_ID}/settings`, serverUrl: undefined },
    ]);
    expect(left[0]).toStartWith("https://github.com/login/oauth/authorize");
  });

  test("a connector without a default server asks for an https address", async () => {
    await go(seedState({ connections: [] }));
    await click(screen().getByRole("button", { name: "Adicionar conector" }));
    const add = screen().getByRole("dialog", { name: "Adicionar conector" });
    await type(within(add).getByRole("searchbox", { name: "Buscar conector" }), "drive");
    await click(within(add).getByRole("button", { name: "Conectar" }));
    const connect = screen().getByRole("dialog", { name: "Conectar Google Drive" });
    await type(within(connect).getByLabelText("Endereço do servidor MCP"), "http://inseguro");
    await type(within(connect).getByLabelText("Chave de API"), "chave-longa-123");
    await click(within(connect).getByRole("button", { name: "Conectar com a chave" }));
    expect(connect.textContent).toContain("Use um endereço que comece com https://.");
  });

  test("provider keys: rotate keeps the key, delete asks first; usage by kind", async () => {
    const { state } = await go();
    const keys = screen().getByRole("region", { name: "Chaves de provedor" });
    expect(keys.textContent).toContain("Anthropic da Acme");
    expect(keys.textContent).toContain("Termina em 7f2a");
    expect(keys.textContent).toContain("A chave do agentes também está disponível neste servidor.");
    await click(within(keys).getByRole("button", { name: "Trocar a chave" }));
    const rotate = screen().getByRole("dialog", { name: "Trocar a chave Anthropic da Acme" });
    await type(within(rotate).getByLabelText("Chave da API"), "sk-ant-new-9999");
    await click(within(rotate).getByRole("button", { name: "Trocar a chave" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.rotateCredential")?.args[1]).toBe("cred-1");
    expect(screen().getByRole("region", { name: "Chaves de provedor" }).textContent).toContain("Termina em 9999");
    await click(
      within(screen().getByRole("region", { name: "Chaves de provedor" })).getByRole("button", { name: "Apagar" }),
    );
    await click(
      within(screen().getByRole("dialog", { name: /Apagar a chave/ })).getByRole("button", { name: "Apagar" }),
    );
    await settle(4);
    expect(state.calls.find((c) => c.method === "agents.removeCredential")?.args).toEqual([ORG_ID, "cred-1", true]);
    const usage = screen().getByRole("region", { name: "Uso deste mês" });
    expect(usage.textContent).toContain("Agentes154 chamadasUS$ 15,40");
    expect(usage.textContent).toContain("Roteador80 chamadasUS$ 0,50");
  });

  test("members see settings read-only, without keys or usage", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    expect(document.body.textContent).toContain("Só admins mudam as configurações.");
    expect(screen().queryByRole("button", { name: "Adicionar conector" })).toBeNull();
    expect(screen().queryByRole("region", { name: "Chaves de provedor" })).toBeNull();
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
          spentNanoUsd: 32e9,
          budgetNanoUsd: 40e9,
        },
      }),
    );
    await settle();
    expect(screen().getByRole("alert").textContent).toContain(
      "Ada passou de 80% do orçamento do mês: US$ 32,00 de US$ 40,00.",
    );
  });
});
