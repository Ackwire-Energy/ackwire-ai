import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, keys, type OrgDeletion, type Role } from "@agenteschat/client";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const BETA_ID = "00000000-0000-4000-8000-0000000000b2";
const DAY = 86_400_000;
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const meEvery = (qc: QueryClient) =>
  qc
    .getQueryCache()
    .find({ queryKey: keys.me })
    ?.observers.map((o) => o.options.refetchInterval);

/** Acme with this person's role (and its deletion, when there is one) at `path`. */
async function open(
  path: string,
  {
    role = "owner",
    name = "Acme",
    deletion,
    state = seedState(),
  }: {
    role?: Role;
    name?: string;
    deletion?: OrgDeletion;
    state?: ReturnType<typeof seedState>;
  } = {},
) {
  if (!state.me) throw new Error("signed in");
  state.me.organizations = [
    { id: ORG_ID, name, role, ...(deletion ? { deletion } : {}) },
    { id: BETA_ID, name: "Beta", role: "member" },
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
    for (const role of ["admin", "member"] as const) {
      cleanup();
      // Not even from the address the phone opens.
      await open(`/org/${ORG_ID}/settings/general?delete=1`, { role });
      expect(screen().queryByRole("region", { name: "Apagar workspace" })).toBeNull();
      expect(screen().queryByRole("dialog")).toBeNull();
    }
  });

  test("the name, typed with its invisible characters ignored, then the proof, before it deletes", async () => {
    // A co-owner put a zero-width space in the name: typing it plainly still confirms.
    const { state } = await open(`/org/${ORG_ID}/settings`, { name: "Ac​me" });
    await click(screen().getByRole("button", { name: "Apagar workspace…" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Apagar Ac​me?" });
    expect(dialog.textContent).toContain("Qualquer dono pode restaurar até");
    expect(dialog.textContent).toContain("Todos perdem o acesso agora e recebem um email");
    const submit = within(dialog).getByRole("button", { name: "Apagar workspace" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Digite Ac​me para confirmar"), "acm");
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Digite Ac​me para confirmar"), " ACME ");
    // No sign-in in the last 10 minutes: the password too.
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Sua senha"), "correct horse battery");
    expect(submit.hasAttribute("disabled")).toBe(false);
    await click(submit);
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.deleteWorkspace")?.args).toEqual([
      ORG_ID,
      { password: "correct horse battery" },
    ]);
    // Its closing screen takes its place at once.
    expect(screen().getByRole("heading", { name: "Ac​me está sendo apagado" })).toBeTruthy();
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("a fresh sign-in needs no password; an account without one and an old session signs in again", async () => {
    const fresh = seedState({
      deletionPlan: {
        password: false,
        freshUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        closes: [],
        leaves: [],
        soleOwner: [],
        computers: [],
        staysBehind: [],
        serverOwner: false,
      },
    });
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state: fresh });
    let dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(within(dialog).queryByLabelText("Sua senha")).toBeNull();
    await type(within(dialog).getByLabelText("Digite Acme para confirmar"), "Acme");
    expect(within(dialog).getByRole("button", { name: "Apagar workspace" }).hasAttribute("disabled")).toBe(false);

    cleanup();
    const old = seedState({ deletionError: new ApiError(403, "reauth.sign_in", "Sign in again to confirm it's you") });
    old.deletionPlan = { ...(fresh.deletionPlan as NonNullable<typeof fresh.deletionPlan>), freshUntil: null };
    await open(`/org/${ORG_ID}/settings/general?delete=1`, { state: old });
    dialog = screen().getByRole("dialog", { name: "Apagar Acme?" });
    expect(dialog.textContent).toContain("Entre de novo para confirmar que é você.");
    expect(within(dialog).queryByRole("button", { name: "Apagar workspace" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Entrar de novo" })).toBeTruthy();
  });
});

describe("a workspace being deleted: a screen of its own", () => {
  const soon = (days: number) => new Date(Date.now() + days * DAY).toISOString();
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

describe("deleting your account (the account menu)", () => {
  test("a workspace that still needs you comes first, with its two ways out", async () => {
    const state = seedState({
      deletionPlan: {
        password: true,
        freshUntil: null,
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

  test("what closes, what you leave, what stays; the password, then out to the sign-in", async () => {
    const state = seedState({
      deletionPlan: {
        password: true,
        freshUntil: null,
        closes: [{ id: ORG_ID, name: "Acme" }],
        leaves: [{ id: BETA_ID, name: "Beta", role: "member" }],
        soleOwner: [],
        computers: [{ orgId: BETA_ID, id: "m1", name: "MacBook" }],
        staysBehind: [{ orgId: BETA_ID, kind: "mailbox", name: "ana@beta.com" }],
        serverOwner: false,
      },
    });
    // Kept in the address: a sign-in again comes back to it.
    const { router } = await open(`/org/${ORG_ID}/issues?account=delete`, { state });
    const dialog = screen().getByRole("dialog", { name: "Apagar a sua conta?" });
    for (const line of [
      "Acme fecha agora e é apagado de vez em",
      "Você sai de Beta.",
      "Seu computador conectado a Beta sai de lá: MacBook.",
      "O que você adicionou em Beta continua lá: ana@beta.com.",
      "Suas mensagens ficam nos workspaces sem o seu nome.",
    ])
      expect(dialog.textContent).toContain(line);
    const submit = within(dialog).getByRole("button", { name: "Apagar conta" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Sua senha"), "correct horse battery");
    await click(submit);
    await settle(8);
    expect(state.calls.find((c) => c.method === "account.delete")?.args).toEqual([
      { password: "correct horse battery" },
    ]);
    expect(router.state.location.pathname).toBe("/login");
    expect(document.body.textContent).toContain("Conta apagada");
  });
});
