import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { pick, service } from "./catalog";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeDatabasesOf, ORG_ID, seedState } from "./fake-api";
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
      // The categories, each with its count ("Desenvolvimento 3").
      within(within(dialog).getByRole("radiogroup", { name: "Categorias" })).getByRole("radio", {
        name: /^Desenvolvimento/,
      }),
    );
    const card = within(dialog).getByRole("button", { name: "Banco de dados" });
    expect(card.textContent).toContain("só leitura");
    // How it connects, and that it never changes anything, in its dialog.
    await click(card);
    const detail = service("Banco de dados");
    expect(detail.textContent).toContain("Precisa do endereço do banco e de uma senha");
    expect(detail.textContent).toContain("Nunca altera nada");
    expect(`${dialog.textContent} ${detail.textContent}`).not.toMatch(/MCP server|scope/i);
  });

  test("connect → o que faz → quem pode usar → regras, with plain errors and the read-only user help", async () => {
    const { api, state, databases } = databaseApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "Banco de dados");
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

describe("Regras em: remove all, copy to other agents", () => {
  test("Remover tudo empties the hidden columns with Desfazer, Copiar regras gives Atlas Ada's rules", async () => {
    const { api, state } = databaseApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "Banco de dados");
    await type(within(flow()).getByLabelText("Nome"), "Produção");
    await type(within(flow()).getByLabelText("Endereço do banco"), "postgres://reader:pw@db.acme.com:6543/app");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    for (const name of ["Ada", "Atlas"]) {
      const level = within(flow()).getByRole("radiogroup", { name: `Nível de ${name}` });
      await click(within(level).getByRole("radio", { name: "Ler" }));
    }
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Regras em Produção" })).toBeTruthy();
    const hidden = () => within(flow()).queryAllByRole("button", { name: /^Remover public\./ });

    // One chip: no "Remover tudo" yet.
    expect(within(flow()).queryByRole("button", { name: "Remover tudo de Colunas que ele nunca vê" })).toBeNull();
    await type(within(flow()).getByRole("textbox", { name: "Colunas que ele nunca vê" }), "users.password_hash");
    await click(within(flow()).getByRole("button", { name: "Adicionar em Colunas que ele nunca vê" }));
    expect(hidden()).toHaveLength(2);
    // The live regions are there, empty, before anything is announced.
    const [clearStatus, copyStatus] = within(flow()).getAllByRole("status");
    expect(clearStatus?.textContent).toBe("");
    expect(copyStatus?.textContent).toBe("");
    await click(within(flow()).getByRole("button", { name: "Remover tudo de Colunas que ele nunca vê" }));
    expect(hidden()).toHaveLength(0);
    expect(clearStatus?.textContent).toContain("2 itens removidos.");
    expect(document.activeElement?.textContent).toBe("Desfazer");
    await click(within(flow()).getByRole("button", { name: "Desfazer" }));
    expect(hidden()).toHaveLength(2);
    await click(within(flow()).getByRole("button", { name: "Remover tudo de Colunas que ele nunca vê" }));
    await click(within(flow()).getByLabelText("orders"));

    // Copy Ada's rules to Atlas: Atlas's tab shows them, and both save.
    const copy = within(flow()).getByRole("button", { name: "Copiar regras" }) as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    await click(within(flow()).getByLabelText("Atlas"));
    await click(copy);
    expect(flow().textContent).toContain("Copiadas para Atlas. Salve para aplicar.");
    await click(within(flow()).getByRole("radio", { name: "Atlas" }));
    await settle(4);
    expect(hidden()).toHaveLength(0);
    await click(within(flow()).getByRole("button", { name: "Salvar regras" }));
    await settle(6);
    const saves = state.calls.filter((c) => c.method === "databases.setAgent").slice(-2);
    const policy = { tables: ["public.orders"], hiddenColumns: [], dailyQueryCap: null, timeoutSeconds: 15 };
    expect(saves.map((c) => c.args[1]).sort()).toEqual([ADA_ID, ATLAS_ID].sort());
    for (const c of saves) expect(c.args[3]).toEqual({ level: "read", policy });
  });
});

describe("Regras em: undo a copy", () => {
  test("Desfazer after Copiar regras gives Atlas back its own unsaved edits", async () => {
    const { api, state } = databaseApi();
    const dialog = await openCatalog(api);
    await pick(dialog, "Banco de dados");
    await type(within(flow()).getByLabelText("Nome"), "Produção");
    await type(within(flow()).getByLabelText("Endereço do banco"), "postgres://reader:pw@db.acme.com:6543/app");
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(4);
    for (const name of ["Ada", "Atlas"]) {
      const level = within(flow()).getByRole("radiogroup", { name: `Nível de ${name}` });
      await click(within(level).getByRole("radio", { name: "Ler" }));
    }
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    // Atlas's own edit, then Ada's rules copied over it.
    await click(within(flow()).getByRole("radio", { name: "Atlas" }));
    await settle(4);
    await click(within(flow()).getByLabelText("orders"));
    await click(within(flow()).getByRole("radio", { name: "Ada" }));
    await settle(4);
    await click(within(flow()).getByLabelText("Atlas"));
    await click(within(flow()).getByRole("button", { name: "Copiar regras" }));
    const status = within(flow()).getAllByRole("status").at(-1) as HTMLElement;
    expect(status.textContent).toContain("Copiadas para Atlas.");
    await click(within(status).getByRole("button", { name: "Desfazer" }));
    expect(status.textContent).toBe("");
    await click(within(flow()).getByRole("button", { name: "Salvar regras" }));
    await settle(6);
    const atlas = state.calls.filter((c) => c.method === "databases.setAgent" && c.args[1] === ATLAS_ID).at(-1);
    expect((atlas?.args[3] as { policy?: { tables: string[] } } | undefined)?.policy?.tables).toEqual([
      "public.orders",
    ]);
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
