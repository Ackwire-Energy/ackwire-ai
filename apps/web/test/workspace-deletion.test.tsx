import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, keys, type OrgDeletion, type OrgSummary, type Role } from "@agenteschat/client";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, meAsAdmin, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const BETA_ID = "00000000-0000-4000-8000-0000000000b2";
const DAY = 86_400_000;
const soon = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const meEvery = (qc: QueryClient) =>
  qc
    .getQueryCache()
    .find({ queryKey: keys.me })
    ?.observers.map((o) => o.options.refetchInterval);

/** Acme with this person's role (and its deletion or standing, when there is one), and Beta, at `path`. */
async function open(
  path: string,
  {
    role = "owner",
    name = "Acme",
    deletion,
    standing,
    beta = { id: BETA_ID, name: "Beta", role: "member" },
    state = seedState(),
  }: {
    role?: Role;
    name?: string;
    deletion?: OrgDeletion;
    standing?: OrgSummary["standing"];
    beta?: OrgSummary;
    state?: ReturnType<typeof seedState>;
  } = {},
) {
  if (!state.me) throw new Error("signed in");
  state.me.organizations = [
    { id: ORG_ID, name, role, ...(deletion ? { deletion } : {}), ...(standing ? { standing } : {}) },
    beta,
  ];
  const r = await renderApp(path, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
}

describe("deleting a workspace (Configurações › Geral)", () => {
  test("only its owners get the card", async () => {
    await open(`/org/${ORG_ID}/settings`);
    const card = screen().getByRole("region", { name: "Apagar workspace" });
    expect(card.textContent).toContain("Fecha Acme para todos agora. Ele é apagado de vez depois de 7 dias.");
    expect(within(card).getByRole("button", { name: "Apagar workspace…" })).toBeTruthy();
    for (const admin of [true, false]) {
      cleanup();
      const state = seedState();
      if (admin) meAsAdmin(state);
      // Not even from the address the phone opens.
      await open(`/org/${ORG_ID}/settings/general?delete=1`, { role: "member", state });
      expect(screen().queryByRole("region", { name: "Apagar workspace" })).toBeNull();
      expect(screen().queryByRole("dialog")).toBeNull();
    }
  });

  test("the name, typed with its invisible characters ignored, then the code from the email, before it deletes", async () => {
    // A co-owner put a zero-width space in the name: typing it plainly still confirms.
    const { state, router } = await open(`/org/${ORG_ID}/settings`, { name: "Ac\u200bme" });
    const email = state.me?.user.email ?? "";
    await click(screen().getByRole("button", { name: "Apagar workspace…" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Apagar Ac\u200bme?" });
    expect(dialog.textContent).toContain("Qualquer dono pode restaurar até");
    expect(dialog.textContent).toContain("Todos perdem o acesso agora e recebem um email");
    expect(dialog.textContent).toContain(`Vamos mandar um código para ${email} para confirmar que é você.`);
    const send = within(dialog).getByRole("button", { name: "Enviar código" });
    expect(send.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Digite Ac\u200bme para confirmar"), "acm");
    expect(send.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Digite Ac\u200bme para confirmar"), " ACME ");
    await click(send);
    await settle(4);
    expect(state.calls.filter((c) => c.method === "orgs.deletionCode").map((c) => c.args)).toEqual([[ORG_ID]]);
    expect(dialog.textContent).toContain(`Mandamos para ${email}. Vale por 10 minutos.`);
    // Another code only after a minute.
    expect(
      within(dialog)
        .getByRole("button", { name: /^Enviar outro em \d:\d\d$/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    const submit = within(dialog).getByRole("button", { name: "Apagar workspace" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    // Pasted with its space: the digits are what count.
    await type(within(dialog).getByLabelText("Código do email"), "482 913");
    expect(submit.hasAttribute("disabled")).toBe(false);
    await click(submit);
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.deleteWorkspace")?.args).toEqual([ORG_ID, { code: "482913" }]);
    // Its closing screen takes its place at once.
    expect(screen().getByRole("heading", { name: "Ac\u200bme está sendo apagado" })).toBeTruthy();
    expect(screen().queryByRole("dialog")).toBeNull();
    // Out of the address too: restored, Geral doesn't open the dialog again.
    expect(router.state.location.search).not.toHaveProperty("delete");
  });

  test("a code refused says why under its field, which empties for the next one", async () => {
    const state = seedState({ deletionError: new ApiError(400, "reauth.code_wrong", "That code isn't right.") });
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state });
    const dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    await type(within(dialog).getByLabelText("Digite Acme para confirmar"), "Acme");
    await click(within(dialog).getByRole("button", { name: "Enviar código" }));
    await settle(4);
    await type(within(dialog).getByLabelText("Código do email"), "111111");
    await click(within(dialog).getByRole("button", { name: "Apagar workspace" }));
    await settle(6);
    expect(dialog.textContent).toContain("Código errado. Tente de novo.");
    expect((within(dialog).getByLabelText("Código do email") as HTMLInputElement).value).toBe("");
    expect(within(dialog).queryByRole("alert", { name: /Código errado/ })).toBeNull();
  });

  test("a server that sends no email asks for the password; an account without one adds it first", async () => {
    const state = seedState({ authConfig: { passwordReset: false } });
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state });
    let dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).not.toContain("Vamos mandar um código");
    expect(dialog.textContent).toContain("Todos perdem o acesso agora");
    await type(within(dialog).getByLabelText("Digite Acme para confirmar"), "Acme");
    const submit = within(dialog).getByRole("button", { name: "Apagar workspace" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Sua senha"), "correct horse battery");
    await click(submit);
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.deleteWorkspace")?.args).toEqual([
      ORG_ID,
      { password: "correct horse battery" },
    ]);

    cleanup();
    const none = seedState({ authConfig: { passwordReset: false } });
    if (!none.me) throw new Error("signed in");
    none.me.user = { ...none.me.user, hasPassword: false };
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state: none });
    dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).toContain(
      "Este servidor não manda email. Adicione uma senha para confirmar que é você.",
    );
    expect(within(dialog).queryByRole("button", { name: "Apagar workspace" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Adicionar uma senha" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Adicionar uma senha" })).toBeTruthy();
  });
});

describe("a workspace being deleted: a screen of its own", () => {
  const deletion = (dueAt: string | null): OrgDeletion => ({
    dueAt,
    requestedAt: new Date(Date.now() - DAY).toISOString(),
    requestedBy: { id: "u-joao", name: "João" },
  });

  test("its owners restore it before the date, and it opens again", async () => {
    const { state, services } = await open(`/org/${ORG_ID}/settings`, { deletion: deletion(soon(6)) });
    expect(screen().getByRole("heading", { name: "Acme está sendo apagado" })).toBeTruthy();
    expect(document.body.textContent).toContain("João apagou em");
    expect(document.body.textContent).toContain("Ele some de vez em");
    // Its socket is refused: GET /me is asked again every 30 s.
    expect(meEvery(services.queryClient)).toContain(30_000);
    expect(
      within(screen().getByRole("navigation", { name: "Seus outros workspaces" })).getByRole("link", { name: "Beta" }),
    ).toBeTruthy();
    // Someone whose only workspace is going isn't stuck there for 7 days.
    expect(screen().getByRole("link", { name: "Novo workspace" }).getAttribute("href")).toBe("/onboarding");
    await click(screen().getByRole("button", { name: "Restaurar workspace" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "orgs.restore")).toHaveLength(1);
    expect(screen().queryByRole("heading", { name: "Acme está sendo apagado" })).toBeNull();
    expect(meEvery(services.queryClient)).not.toContain(30_000);
  });

  test("members read that only an owner can; past the date nobody restores, and no date shows", async () => {
    await open(`/org/${ORG_ID}`, { role: "member", deletion: deletion(soon(6)) });
    expect(screen().queryByRole("button", { name: "Restaurar workspace" })).toBeNull();
    expect(document.body.textContent).toContain("Só um dono pode restaurar.");
    expect(screen().getByRole("button", { name: "Sair" })).toBeTruthy();

    cleanup();
    await open(`/org/${ORG_ID}`, { deletion: deletion(null) });
    expect(screen().getByRole("heading", { name: "Acme está sendo apagado" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Restaurar workspace" })).toBeNull();
    expect(document.body.textContent).not.toContain("some de vez");
    expect(document.body.textContent).not.toContain("Só um dono");
  });
});

describe("a workspace being deleted, at its end and in the desktop app", () => {
  const deleted = (dueAt: string | null): OrgDeletion => ({ dueAt, requestedAt: soon(-1), requestedBy: null });

  test("deleted for good, it leaves for the person's start, never a page saying they aren't in it", async () => {
    const { state, services, router } = await open(`/org/${ORG_ID}`, { deletion: deleted(null) });
    if (!state.me) throw new Error("signed in");
    state.me = { ...state.me, organizations: state.me.organizations.filter((o) => o.id !== ORG_ID) };
    await act(async () => {
      await services.queryClient.refetchQueries({ queryKey: keys.me });
    });
    await settle(8);
    expect(router.state.location.pathname).toStartWith(`/org/${BETA_ID}`);
    expect(document.body.textContent).not.toContain("Você não faz parte deste workspace");
  });

  test("in the desktop app, the window drags from the top of the closing screen, which has no title bar", async () => {
    const app = window as { __agentesDesktop?: unknown };
    app.__agentesDesktop = { version: "0.6.0" };
    try {
      await open(`/org/${ORG_ID}`, { deletion: deleted(soon(6)) });
      expect(screen().getByRole("heading", { name: "Acme está sendo apagado" })).toBeTruthy();
      expect(document.querySelector(".titlebar-strip")).not.toBeNull();
    } finally {
      delete app.__agentesDesktop;
    }
  });
});

describe("adding a password (the account menu)", () => {
  test("its dialog is kept in the address, so signing in again comes back to it", async () => {
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.user = { ...state.me.user, hasPassword: false };
    await open(`/org/${ORG_ID}/issues?account=password`, { state });
    expect(screen().getByRole("dialog", { name: "Adicionar uma senha" })).toBeTruthy();
  });
});

describe("deleting your account (the account menu)", () => {
  test("a workspace that still needs you comes first, with its two ways out", async () => {
    const state = seedState({
      deletionPlan: {
        closes: [],
        leaves: [{ id: BETA_ID, name: "Beta", role: "owner" }],
        soleOwner: [{ id: BETA_ID, name: "Beta" }],
        computers: [],
        staysBehind: [],
        serverOwner: false,
      },
    });
    await open(`/org/${ORG_ID}/issues`, { state });
    await click(screen().getByRole("button", { name: /^Conta: / }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const menu = screen().getAllByRole("menu")[0] as HTMLElement;
    await click(within(menu).getByRole("menuitem", { name: "Apagar conta" }));
    await settle(6);
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta?" });
    expect(dialog.textContent).toContain("Antes de apagar");
    expect(dialog.textContent).toContain(
      "Você é a única pessoa dona de Beta. Torne outra pessoa dona, ou apague Beta.",
    );
    expect(within(dialog).getByRole("link", { name: "Abrir Pessoas" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/members`,
    );
    expect(within(dialog).getByRole("link", { name: "Apagar Beta" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/general?delete=1`,
    );
    expect(within(dialog).queryByRole("button", { name: "Apagar conta" })).toBeNull();
  });

  test("one still being set up has no People yet: its onboarding finishes it or deletes it", async () => {
    const state = seedState({
      deletionPlan: {
        closes: [],
        leaves: [{ id: BETA_ID, name: "Beta", role: "owner" }],
        soleOwner: [{ id: BETA_ID, name: "Beta" }],
        computers: [],
        staysBehind: [],
        serverOwner: false,
      },
    });
    const beta: OrgSummary = {
      id: BETA_ID,
      name: "Beta",
      role: "owner",
      onboarding: { step: "agents", generalChannelId: "c-beta" },
    };
    await open(`/org/${ORG_ID}/issues?account=delete`, { state, beta });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta?" });
    expect(dialog.textContent).toContain(
      "Você é a única pessoa dona de Beta. Termine de configurar para tornar outra pessoa dona, ou apague Beta.",
    );
    expect(within(dialog).getByRole("link", { name: "Terminar a configuração" }).getAttribute("href")).toBe(
      "/onboarding",
    );
    expect(within(dialog).getByRole("link", { name: "Apagar Beta" }).getAttribute("href")).toBe("/onboarding?delete=1");
  });

  test("where there is no account menu: a workspace being deleted, one suspended, and the onboarding", async () => {
    const ask = async () => {
      await click(screen().getByRole("button", { name: "Apagar conta" }));
      await settle(6);
      expect(screen().getByRole("dialog", { name: "Apagar a sua conta?" })).toBeTruthy();
    };
    const { router } = await open(`/org/${ORG_ID}`, {
      deletion: { dueAt: soon(6), requestedAt: soon(-1), requestedBy: null },
    });
    await ask();
    // Kept in the address: a sign-in again comes back to it.
    expect(router.state.location.search).toMatchObject({ account: "delete" });

    cleanup();
    await open(`/org/${ORG_ID}`, { standing: { state: "suspended", reason: null } });
    expect(screen().getByRole("heading", { name: "Este workspace está indisponível" })).toBeTruthy();
    await ask();

    cleanup();
    const state = seedState();
    if (!state.me) throw new Error("signed in");
    state.me.organizations = [];
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(8);
    await ask();
  });

  test("what closes, what you leave, what stays; the code from the email, then out to the sign-in", async () => {
    const state = seedState({
      deletionPlan: {
        closes: [
          { id: ORG_ID, name: "Acme" },
          { id: "00000000-0000-4000-8000-0000000000c3", name: "Rascunho", deletion: { dueAt: soon(3) } },
        ],
        leaves: [{ id: BETA_ID, name: "Beta", role: "member" }],
        soleOwner: [],
        computers: [{ orgId: BETA_ID, id: "m1", name: "MacBook" }],
        staysBehind: [
          { orgId: BETA_ID, kind: "mailbox", name: "ana@beta.com" },
          { orgId: BETA_ID, kind: "key", name: "Chave da Ana" },
        ],
        serverOwner: false,
      },
    });
    state.authConfig = { ...state.authConfig, billingUrl: "https://billing.example.com" };
    // Kept in the address: a sign-in again comes back to it.
    const { router } = await open(`/org/${ORG_ID}/issues?account=delete`, { state });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta?" });
    for (const line of [
      "Acme fecha agora e é apagado de vez em",
      // Being deleted already, on its own date.
      "Rascunho já está sendo apagado. Ele some de vez em",
      "Você sai de Beta.",
      "Seu computador conectado a Beta sai de lá: MacBook.",
      "O que você adicionou em Beta continua lá. Desconecte antes o que for seu.",
      // Where plans are billed.
      "Os planos que você paga param de renovar. Nada é reembolsado.",
      "Suas mensagens ficam nos workspaces sem o seu nome.",
    ])
      expect(dialog.textContent).toContain(line);
    // Each thing that stays behind, to where it's disconnected.
    expect(within(dialog).getByRole("link", { name: "Desconectar ana@beta.com" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/connectors`,
    );
    expect(within(dialog).getByRole("link", { name: "Desconectar Chave da Ana" }).getAttribute("href")).toBe(
      `/org/${BETA_ID}/settings/keys`,
    );
    expect(within(dialog).queryByRole("button", { name: "Apagar conta" })).toBeNull();
    await click(within(dialog).getByRole("button", { name: "Enviar código" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "account.deletionCode")).toHaveLength(1);
    const submit = within(dialog).getByRole("button", { name: "Apagar conta" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Código do email"), "482913");
    await click(submit);
    await settle(8);
    expect(state.calls.find((c) => c.method === "account.delete")?.args).toEqual([{ code: "482913" }]);
    expect(router.state.location.pathname).toBe("/login");
    expect(document.body.textContent).toContain("Conta apagada");
  });
});

describe("an invitation into a workspace being deleted", () => {
  test("reads as closed, as its links do: nobody to join, no form to sign up", async () => {
    const state = seedState({
      previews: {
        tok: { orgName: "Acme", email: "", role: "member", kind: "email", invitedBy: null, agents: [], closed: true },
      },
    });
    state.me = null;
    await renderApp("/invite/tok", { api: createFakeApi(state) });
    await settle(6);
    expect(screen().getByRole("heading", { level: 1 }).textContent).toBe("Este link não funciona mais");
    expect(document.body.textContent).toContain("Peça um novo a quem mandou.");
    expect(screen().queryByLabelText("Seu nome")).toBeNull();
  });
});
