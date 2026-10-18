import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { MailAccount, RoutineInput } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { setNavigateAway } from "@/lib/navigate";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeMailOf, ORG_ID, seedState } from "./fake-api";
import { MAIL_PROVIDERS } from "./fakes/mail";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const flow = () => screen().getAllByRole("dialog").at(-1) as HTMLElement;

/** A client with email on (Gmail/Outlook and IMAP), optionally with mailboxes already connected. */
function mailApi(accounts: Partial<MailAccount>[] = []) {
  const state = seedState({ connections: [] });
  const api = createFakeApi(state);
  const mail = fakeMailOf.get(api);
  if (!mail) throw new Error("no mail fake");
  mail.providers = structuredClone(MAIL_PROVIDERS);
  mail.accounts = accounts.map((a, i) => ({
    id: `mail-${i + 1}`,
    provider: "imap",
    via: "imap",
    address: `caixa${i + 1}@acme.com.br`,
    offActions: [],
    askActions: [],
    label: `caixa${i + 1}@acme.com.br`,
    status: "active",
    lastError: null,
    preset: "icloud",
    createdAt: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
    agents: [],
    ...a,
  }));
  return { state, api, mail };
}

const openCatalog = async (api: ReturnType<typeof createFakeApi>, url = `/org/${ORG_ID}/settings/connectors`) => {
  await renderApp(url, { api });
  await settle(8);
  await click(screen().getByRole("button", { name: "Adicionar conector" }));
  return screen().getByRole("dialog", { name: "Adicionar conector" });
};

describe("Conectores → Email", () => {
  test("the Email group: Gmail, Outlook, iCloud and Outro email, each with how it connects", async () => {
    const { api } = mailApi();
    const dialog = await openCatalog(api);
    const cats = within(dialog).getByRole("group", { name: "Categorias" });
    await click(within(cats).getByRole("button", { name: "Email" }));
    const names = within(dialog)
      .getAllByRole("listitem")
      .map((li) => li.querySelector(".catalog-card__name")?.textContent);
    expect(names).toEqual(["Gmail", "Outlook", "iCloud", "Outro email", "Outro servidor MCP"]);
    const gmail = within(dialog).getByRole("button", { name: "Conectar Gmail" });
    expect(gmail.textContent).toContain("Um clique");
    expect(gmail.querySelector(".connector-icon__mark")?.getAttribute("style")).toContain("/connectors/gmail.svg");
    expect(within(dialog).getByRole("button", { name: "Conectar iCloud" }).textContent).toContain("Senha de app");
    // No internal names in the copy.
    expect(dialog.textContent).not.toMatch(/Composio|IMAP/);
  });

  test("a server without email shows no Email group", async () => {
    const state = seedState({ connections: [] });
    const dialog = await openCatalog(createFakeApi(state));
    expect(within(dialog).queryByRole("button", { name: "Conectar Gmail" })).toBeNull();
    expect(
      within(within(dialog).getByRole("group", { name: "Categorias" })).queryByRole("button", { name: "Email" }),
    ).toBeNull();
  });

  test("Gmail: 'Conectar com Google' leaves for the provider's page", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { api, state } = mailApi();
    const dialog = await openCatalog(api);
    await click(within(dialog).getByRole("button", { name: "Conectar Gmail" }));
    expect(flow().textContent).toContain("Conectar Gmail");
    await click(within(flow()).getByRole("button", { name: "Conectar com Google" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "mail.connectComposio")?.args[1]).toEqual({ provider: "gmail" });
    expect(left).toEqual(["https://composio.example/connect/gmail"]);
  });

  test("iCloud: address and app password; a 422 says why in plain words; then o que faz → quem pode usar", async () => {
    const { api, state, mail } = mailApi();
    const dialog = await openCatalog(api);
    await click(within(dialog).getByRole("button", { name: "Conectar iCloud" }));
    // What an app password is, the steps and the provider's page; the hint for a dedicated mailbox.
    expect(flow().textContent).toContain("O que é uma senha de app?");
    expect(within(flow()).getByRole("link", { name: "Abrir a página de iCloud" }).getAttribute("href")).toBe(
      "https://account.apple.com/account/manage",
    );
    expect(flow().textContent).toContain("Dica: prefira um email só para os agentes.");
    expect(within(flow()).queryByText("Avançado")).toBeNull();

    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    expect(flow().textContent).toContain("Digite um email válido");
    expect(flow().textContent).toContain("Cole a senha de app.");
    expect(state.calls.some((c) => c.method === "mail.connectImap")).toBe(false);

    await type(within(flow()).getByLabelText("Endereço de email"), "ana@icloud.com");
    await type(within(flow()).getByLabelText("Senha de app"), "abcd-efgh-ijkl-mnop");
    mail.nextError = "auth";
    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    expect(within(flow()).getByRole("alert").textContent).toBe(
      "O email ou a senha de app não conferem. Confira e tente de novo.",
    );
    // No error toast on top of the inline message.
    expect(screen().queryByText("auth")).toBeNull();

    await click(within(flow()).getByRole("button", { name: "Conectar" }));
    await settle(4);
    const connect = state.calls.filter((c) => c.method === "mail.connectImap").at(-1);
    expect(connect?.args[1]).toEqual({ preset: "icloud", address: "ana@icloud.com", password: "[redacted]" });
    // Step 2: what it does, in the standard tool review (nothing to decide: all sorted).
    expect(screen().getByRole("dialog", { name: "O que ana@icloud.com faz" })).toBeTruthy();
    expect(within(flow()).getByRole("button", { name: /^E-mails/ })).toBeTruthy();
    expect(within(flow()).getByRole("button", { name: /^Pastas/ })).toBeTruthy();
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    // Step 3: a level per agent.
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Quem pode usar ana@icloud.com" })).toBeTruthy();
    await click(
      within(within(flow()).getByRole("radiogroup", { name: "Nível de Ada" })).getByRole("radio", {
        name: "Ler e escrever",
      }),
    );
    await click(
      within(within(flow()).getByRole("radiogroup", { name: "Nível de Atlas" })).getByRole("radio", { name: "Ler" }),
    );
    await click(within(flow()).getByRole("button", { name: "Continuar" }));
    await settle(6);
    const sets = state.calls
      .filter((c) => c.method === "mail.setAgent")
      .map((c) => [c.args[1], (c.args[3] as { level: string }).level]);
    expect(sets).toEqual([
      [ADA_ID, "read_write"],
      [ATLAS_ID, "read"],
    ]);
    // Step 4: the rules, one agent at a time; Atlas only reads the inbox.
    expect(screen().getByRole("dialog", { name: "Regras em ana@icloud.com" })).toBeTruthy();
    await click(
      within(within(flow()).getByRole("radiogroup", { name: "Agente" })).getByRole("radio", { name: "Atlas" }),
    );
    await settle(4);
    await click(within(flow()).getByRole("checkbox", { name: "Caixa de entrada" }));
    await click(within(flow()).getByRole("button", { name: "Salvar regras" }));
    await settle(6);
    const rules = state.calls.filter((c) => c.method === "mail.setAgent").at(-1);
    expect(rules?.args[1]).toBe(ATLAS_ID);
    expect(rules?.args[3]).toEqual(
      expect.objectContaining({ level: "read", policy: expect.objectContaining({ folders: ["INBOX"] }) }),
    );
    // The new row: the mailbox, active, used by 2 agents.
    const row = screen()
      .getByRole("button", { name: "Quem usa ana@icloud.com" })
      .closest(".connected-row") as HTMLElement;
    expect(row.textContent).toContain("iCloud");
    expect(row.textContent).toContain("Ativo");
    expect(row.textContent).toContain("Conectado como ana@icloud.com");
  });

  test("each connect error has its own message", async () => {
    const { api, mail } = mailApi();
    const dialog = await openCatalog(api);
    await click(within(dialog).getByRole("button", { name: "Conectar iCloud" }));
    await type(within(flow()).getByLabelText("Endereço de email"), "ana@icloud.com");
    await type(within(flow()).getByLabelText("Senha de app"), "x");
    const said: string[] = [];
    for (const code of ["imap_unreachable", "smtp_unreachable", "tls", "blocked_host", "unknown"] as const) {
      mail.nextError = code;
      await click(within(flow()).getByRole("button", { name: "Conectar" }));
      await settle(3);
      said.push(within(flow()).getByRole("alert").textContent ?? "");
    }
    expect(new Set(said).size).toBe(5);
    expect(said[0]).toContain("servidor de entrada");
    expect(said[1]).toContain("servidor de saída");
  });

  test("back from Gmail (`?mail=connected`): 'O que faz' for the newest mailbox; `failed` says so", async () => {
    const { api } = mailApi([
      { address: "old@acme.com.br" },
      { provider: "gmail", via: "composio", preset: null, address: "new@gmail.com" },
    ]);
    await renderApp(`/org/${ORG_ID}/settings/connectors?mail=connected`, { api });
    await settle(8);
    expect(screen().getByRole("dialog", { name: "O que new@gmail.com faz" })).toBeTruthy();
    cleanup();
    const other = mailApi();
    await renderApp(`/org/${ORG_ID}/settings/connectors?mail=failed`, { api: other.api });
    await settle(8);
    expect(screen().getByText("Não deu para conectar o email. Tente de novo.")).toBeTruthy();
  });

  test("'O que faz': the standard review; reads only Consulta · Desligada, sends only Aprovação · Desligada", async () => {
    const { api, state } = mailApi([{ provider: "gmail", via: "composio", preset: null, address: "new@gmail.com" }]);
    await renderApp(`/org/${ORG_ID}/settings/connectors?mail=connected`, { api });
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: "O que new@gmail.com faz" });
    await click(within(dialog).getByRole("button", { name: /^E-mails/ }));
    const levels = (name: string) =>
      within(within(dialog).getByRole("radiogroup", { name: `Nível de ${name}` }))
        .getAllByRole("radio")
        .map((r) => r.textContent);
    expect(levels("Ler emails")).toEqual(["Consulta", "Desligada"]);
    expect(levels("Enviar")).toEqual(["Aprovação", "Desligada"]);
    expect(levels("Organizar")).toEqual(["Muda", "Aprovação", "Desligada"]);
    const pick = (name: string, level: string) =>
      click(
        within(within(dialog).getByRole("radiogroup", { name: `Nível de ${name}` })).getByRole("radio", {
          name: level,
        }),
      );
    await pick("Enviar", "Desligada");
    await pick("Organizar", "Aprovação");
    await click(within(dialog).getByRole("button", { name: "Continuar" }));
    expect(state.calls.find((c) => c.method === "mail.update")?.args.slice(1)).toEqual([
      "mail-1",
      { offActions: ["send"], askActions: ["organize"] },
    ]);
  });

  test("'Precisa reconectar': a new app password (PATCH), or Gmail signs in again", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const { api, state } = mailApi([
      { address: "ana@icloud.com", status: "needs_reconnect" },
      { provider: "gmail", via: "composio", preset: null, address: "bia@gmail.com", status: "needs_reconnect" },
    ]);
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    const row = screen()
      .getByRole("button", { name: "Quem usa ana@icloud.com" })
      .closest(".connected-row") as HTMLElement;
    expect(row.textContent).toContain("Precisa reconectar");
    await click(within(row).getByRole("button", { name: "Reconectar ana@icloud.com" }));
    const dialog = screen().getByRole("dialog", { name: "Reconectar ana@icloud.com" });
    await type(within(dialog).getByLabelText("Senha de app"), "nova-senha");
    await click(within(dialog).getByRole("button", { name: "Reconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "mail.update")?.args.slice(1)).toEqual([
      "mail-1",
      { password: "[redacted]" },
    ]);
    await click(screen().getByRole("button", { name: "Reconectar bia@gmail.com" }));
    await settle(4);
    expect(left).toEqual(["https://composio.example/connect/gmail"]);
  });

  test("Desconectar asks first", async () => {
    const { api, state } = mailApi([{ address: "ana@icloud.com" }]);
    await renderApp(`/org/${ORG_ID}/settings/connectors`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Desconectar ana@icloud.com" }));
    const confirm = screen().getByRole("dialog", { name: "Desconectar ana@icloud.com?" });
    await click(within(confirm).getByRole("button", { name: "Desconectar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "mail.disconnect")?.args[1]).toBe("mail-1");
  });
});

describe("the agent's email rules", () => {
  test("'Enviar sem pedir aprovação' waits for 'Só enviar para'; Salvar sends level, delete and rules", async () => {
    const { api, state } = mailApi([{ address: "ana@icloud.com" }]);
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(10);
    const level = screen().getByRole("radiogroup", { name: "Nível em ana@icloud.com" });
    await click(within(level).getByRole("radio", { name: "Ler e escrever" }));
    const row = level.closest("li") as HTMLElement;
    // Sends ask by default.
    expect(row.textContent).toContain("Enviar pede aprovação");
    await click(within(row).getByRole("switch", { name: /Pode apagar emails/ }));
    await click(within(row).getByLabelText("Regras de ana@icloud.com"));
    await settle(4);
    const auto = within(row).getByRole("switch", { name: /Enviar sem pedir aprovação/ });
    expect(auto.hasAttribute("disabled")).toBe(true);
    expect(row.textContent).toContain("Preencha “Só enviar para” antes.");
    // Folders come from the mailbox.
    await click(within(row).getByRole("checkbox", { name: "Clientes" }));
    // A wrong address is refused; an address and a domain go in.
    await type(within(row).getByLabelText("Só enviar para"), "nada");
    await click(within(row).getByRole("button", { name: "Adicionar em Só enviar para" }));
    expect(row.textContent).toContain("Use um email ou @dominio.com.");
    await type(within(row).getByLabelText("Só enviar para"), "joao@cliente.com, @acme.com.br");
    await click(within(row).getByRole("button", { name: "Adicionar em Só enviar para" }));
    expect(within(row).getByRole("list", { name: "Só enviar para" }).textContent).toContain("@acme.com.br");
    expect(auto.hasAttribute("disabled")).toBe(false);
    await click(auto);
    // Reads from anyone and sends without asking: the warning.
    expect(row.textContent).toContain("um email malicioso pode tentar enganar o agente");
    await type(within(row).getByLabelText("Limite de envios por dia"), "10");
    await click(within(row).getByRole("button", { name: "Salvar" }));
    await settle(4);
    const call = state.calls.find((c) => c.method === "mail.setAgent");
    expect(call?.args.slice(1, 3)).toEqual([ADA_ID, "mail-1"]);
    expect(call?.args[3]).toEqual({
      level: "read_write",
      canDelete: true,
      policy: {
        folders: ["Clientes"],
        senders: [],
        windowDays: null,
        allowedRecipients: ["joao@cliente.com", "@acme.com.br"],
        dailySendCap: 10,
        sendWithoutAsking: true,
        fromAddress: null,
      },
    });
    expect(screen().getByText("Email de Ada salvo.")).toBeTruthy();
  });

  test("removing the last recipient turns 'Enviar sem pedir aprovação' off", async () => {
    const { api, mail } = mailApi([{ address: "ana@icloud.com" }]);
    await mail.client.setAgent(ORG_ID, ADA_ID, "mail-1", {
      level: "read_write",
      canDelete: false,
      policy: {
        folders: [],
        senders: ["@acme.com.br"],
        windowDays: 30,
        allowedRecipients: ["@acme.com.br"],
        dailySendCap: 25,
        sendWithoutAsking: true,
        fromAddress: null,
      },
    });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api });
    await settle(10);
    const row = screen().getByRole("radiogroup", { name: "Nível em ana@icloud.com" }).closest("li") as HTMLElement;
    // 4 rules: senders, window, recipients, send without asking.
    expect(within(row).getByLabelText("Regras de ana@icloud.com").textContent).toContain("4");
    await click(within(row).getByLabelText("Regras de ana@icloud.com"));
    const auto = within(row).getByRole("switch", { name: /Enviar sem pedir aprovação/ });
    expect(auto.getAttribute("aria-checked")).toBe("true");
    const recipients = within(row).getByRole("list", { name: "Só enviar para" });
    await click(within(recipients).getByRole("button", { name: "Remover @acme.com.br" }));
    expect(auto.getAttribute("aria-checked")).toBe("false");
    expect(auto.hasAttribute("disabled")).toBe(true);
  });
});

describe("Rotinas: quando chegar um email", () => {
  test("mailbox, inbox by default and filters; the card shows the mailbox and 'Precisa reconectar'", async () => {
    const { api, state } = mailApi([{ address: "ana@icloud.com" }]);
    const created: RoutineInput[] = [];
    const real = api.routines.create;
    api.routines.create = (orgId, input) => {
      created.push(input);
      return real(orgId, input);
    };
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    await click(within(dialog).getByRole("radio", { name: "Quando chegar um email" }));
    await settle(4);
    expect(within(dialog).getByRole("combobox", { name: "Caixa de email" }).textContent).toContain("ana@icloud.com");
    expect(within(dialog).getByRole("combobox", { name: "Pasta" }).textContent).toContain("Caixa de entrada");
    await type(within(dialog).getByLabelText("De"), "@cliente.com");
    await click(within(dialog).getByRole("button", { name: "Adicionar em De" }));
    await type(within(dialog).getByLabelText("Assunto contém"), " pedido ");
    await type(within(dialog).getByLabelText("O que fazer"), "Responda com o status do pedido.");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(6);
    expect(created[0]?.trigger).toEqual({
      type: "email",
      accountId: "mail-1",
      folder: "INBOX",
      filter: { from: ["@cliente.com"], subject: "pedido" },
    });
    expect(state.calls.some((c) => c.method === "mail.folders")).toBe(true);
  });

  test("an email routine in the list: mail icon, the mailbox in words, 'Precisa reconectar'", async () => {
    const { api } = mailApi([{ address: "ana@icloud.com" }]);
    const real = api.routines.list;
    api.routines.list = async (orgId) => {
      const list = await real(orgId);
      const first = list[0];
      if (!first) return list;
      return [
        {
          ...first,
          id: "r-mail",
          name: "Pedidos por email",
          trigger: {
            type: "email",
            accountId: "mail-1",
            folder: "Clientes",
            filter: {},
            status: "needs_reconnect",
          },
          nextRunAt: null,
        },
        ...list.slice(1),
      ];
    };
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    const card = screen().getByRole("article", { name: "Pedidos por email" });
    expect(card.textContent).toContain("Quando chegar um email em ana@icloud.com (Clientes)");
    expect(card.textContent).toContain("Precisa reconectar");
  });
});
