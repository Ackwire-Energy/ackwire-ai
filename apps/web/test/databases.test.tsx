import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeDatabasesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;

function databaseApi() {
  const state = seedState({ connections: [] });
  const api = createFakeApi(state);
  const databases = fakeDatabasesOf.get(api);
  if (!databases) throw new Error("no databases fake");
  return { state, api, databases };
}

const openCatalog = async (api: ReturnType<typeof createFakeApi>) => {
  await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
  await settle(8);
  await click(screen().getByRole("button", { name: "Adicionar conector" }));
  return screen().getByRole("dialog", { name: "Adicionar conector" });
};

describe("Conectores → Banco de dados", () => {
  test("the card is in Desenvolvimento, says how it connects, and no jargon", async () => {
    const { api } = databaseApi();
    const dialog = await openCatalog(api);
    await click(
      within(within(dialog).getByRole("group", { name: "Categorias" })).getByRole("button", {
        name: "Desenvolvimento",
      }),
    );
    const card = within(dialog).getByRole("button", { name: "Conectar Banco de dados" });
    expect(card.textContent).toContain("Endereço e senha");
    expect(card.textContent).toContain("só leitura");
    expect(dialog.textContent).not.toMatch(/MCP server|scope/i);
  });

  test("connect → o que faz → quem pode usar → regras, with plain errors and the read-only user help", async () => {
    const { api, state, databases } = databaseApi();
    const dialog = await openCatalog(api);
    await click(within(dialog).getByRole("button", { name: "Conectar Banco de dados" }));
    expect(flow().textContent).toContain("Conectar Banco de dados");
    // How to make a read-only user: the steps, the SQL to paste (with Copiar) and the provider's page.
    expect(flow().textContent).toContain("Como criar um usuário só de leitura?");
    expect(flow().textContent).toContain("create role agentes_leitura");
    expect(within(flow()).getByRole("button", { name: "Copiar" })).toBeTruthy();
    expect(within(flow()).getByRole("link", { name: "Abrir o Supabase" })).toBeTruthy();

    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    expect(flow().textContent).toContain("Cole um endereço que comece com postgres://");
    expect(state.calls.some((c) => c.method === "databases.connect")).toBe(false);

    await type(within(flow()).getByLabelText("Nome"), "Produção");
    await type(
      within(flow()).getByLabelText("Endereço do banco"),
      "postgres://agentes_leitura:pw@db.acme.com:6543/app",
    );
    databases.nextError = "blocked_host";
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(within(flow()).getByRole("alert").textContent).toContain("Esse servidor não é permitido.");

    databases.canWrite = true;
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "databases.connect").at(-1)?.args[1]).toMatchObject({
      provider: "supabase",
      label: "Produção",
    });
    // Step 2: the three tools, all "Consulta"; a user that can write gets the read-only recommendation.
    expect(screen().getByRole("dialog", { name: "O que Produção faz" })).toBeTruthy();
    expect(flow().textContent).toContain("Esse usuário pode alterar dados.");
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    // Step 3: only "Sem acesso" and "Ler".
    expect(screen().getByRole("dialog", { name: "Quem pode usar Produção" })).toBeTruthy();
    const ada = within(flow()).getByRole("radiogroup", { name: "Nível de Ada" });
    expect(
      within(ada)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Sem acesso", "Ler"]);
    await click(within(ada).getByRole("radio", { name: "Ler" }));
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    const granted = state.calls.find((c) => c.method === "databases.setAgent");
    expect(granted?.args[1]).toBe(ADA_ID);
    expect(granted?.args[3]).toEqual({
      level: "read",
      policy: { tables: [], hiddenColumns: ["public.customers.cpf"], dailyQueryCap: null, timeoutSeconds: 15 },
    });
    // Step 4: Ada's rules, starting from the sensitive columns already hidden.
    expect(screen().getByRole("dialog", { name: "Regras em Produção" })).toBeTruthy();
    expect(flow().textContent).toContain("public.customers.cpf");
    await click(within(flow()).getByLabelText("orders"));
    await click(within(flow()).getByRole("radio", { name: "30 segundos" }));
    await click(within(flow()).getByRole("button", { name: "Salvar regras" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "databases.setAgent").at(-1)?.args[3]).toEqual({
      level: "read",
      policy: {
        tables: ["public.orders"],
        hiddenColumns: ["public.customers.cpf"],
        dailyQueryCap: null,
        timeoutSeconds: 30,
      },
    });
    // The connected row: name, active, read-only, who reads it.
    const row = (await screen().findByText("Produção")).closest(".connected-row") as HTMLElement;
    expect(row.textContent).toContain("Só lê");
    expect(row.textContent).toContain("agentes_leitura@db.acme.com/app");
    expect(row.textContent).toContain("1 de");
  });
});

describe("the agent's database access", () => {
  test("Ler and the rules save on their own, from the sensitive columns hidden by default", async () => {
    const { api, state, databases } = databaseApi();
    await databases.client.connect(ORG_ID, { label: "Produção", url: "postgres://reader:pw@db.acme.com/app" });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(10);
    expect(screen().getByRole("heading", { name: "Bancos de dados" })).toBeTruthy();
    const level = screen().getByRole("radiogroup", { name: "Nível em Produção" });
    expect(
      within(level)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Sem acesso", "Ler"]);
    await click(within(level).getByRole("radio", { name: "Ler" }));
    const row = level.closest("li") as HTMLElement;
    await click(within(row).getByLabelText("Regras em Produção"));
    await settle(4);
    await type(within(row).getByRole("textbox", { name: "Colunas que ele nunca vê" }), "nada");
    await click(within(row).getByRole("button", { name: "Adicionar em Colunas que ele nunca vê" }));
    expect(row.textContent).toContain("Digite tabela.coluna");
    await type(within(row).getByRole("textbox", { name: "Colunas que ele nunca vê" }), "users.password_hash");
    await click(within(row).getByRole("button", { name: "Adicionar em Colunas que ele nunca vê" }));
    await type(within(row).getByLabelText("Consultas por dia"), "200");
    await click(within(row).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "databases.setAgent")?.args[3]).toEqual({
      level: "read",
      policy: {
        tables: [],
        hiddenColumns: ["public.customers.cpf", "public.users.password_hash"],
        dailyQueryCap: 200,
        timeoutSeconds: 15,
      },
    });
    expect(screen().getByText("Acesso de Ada ao banco salvo.")).toBeTruthy();
  });
});
