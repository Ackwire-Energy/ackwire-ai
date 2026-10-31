import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { InvitationWithStatus } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { undoWindow } from "@/pages/MembersPage";
import { ADA_ID, ADMIN_ROLE_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * Bringing a teammate in (ADR 0090): the one invite dialog and where it opens from, the invitations sent, a member's
 * suggestions, and a newcomer's first #general.
 */

const UNDO_MS = undoWindow.ms;
afterEach(() => {
  undoWindow.ms = UNDO_MS;
  localStorage.clear();
  cleanup();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const text = () => document.body.textContent ?? "";
const dialog = () => screen().getByRole("dialog", { name: "Convidar para a Acme" });
const chipsIn = (el: HTMLElement) => [...el.querySelectorAll(".email-chip__email")].map((c) => c.textContent);

/** Acme's Members (as its owner, who may invite, unless the state says otherwise). */
async function members(state = seedState()) {
  const r = await renderApp(`/org/${ORG_ID}/settings/members`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
}
/** The page's own "Convidar pessoas" (the first of that name). */
async function openInvite() {
  const [open] = screen().getAllByRole("button", { name: "Convidar pessoas" });
  await click(open as HTMLElement);
  await settle(2);
  return dialog();
}
/** Opens a select or a menu from its trigger, by keyboard. */
async function openFrom(trigger: HTMLElement) {
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
}
/** Swaps the clipboard for one that keeps what's written, while `run` runs. */
async function withClipboard(run: () => Promise<unknown>) {
  const writes: string[] = [];
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (s: string) => void writes.push(s) },
  });
  try {
    await run();
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
  return writes;
}
const invitation = (
  over: Partial<InvitationWithStatus> & Pick<InvitationWithStatus, "id" | "email">,
): InvitationWithStatus => ({
  role: "member",
  roleIds: [],
  status: "pending",
  expiresAt: new Date(Date.now() + 5 * 86_400_000 + 60_000).toISOString(),
  createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  invitedBy: "Walter",
  url: `http://localhost:3000/invite/tok-${over.id}`,
  ...over,
});

describe("the invite dialog", () => {
  test("a pasted address book: a role per address, channels and a note for all; who's in or invited already stays out", async () => {
    const state = seedState();
    state.invitations.push(
      invitation({ id: "inv-bia", email: "bia@acme.com" }),
      invitation({
        id: "inv-rafa",
        email: "rafa@acme.com",
        status: "expired",
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    );
    await members(state);
    const invite = await openInvite();
    const emails = within(invite).getByLabelText("E-mails");
    // As a mail app copies them: names around the addresses, one in quotes with a comma.
    const pasted = 'Ana Silva <ana@acme.com>, "Silva, Bia" <bia@acme.com>; João <joao@acme.com.br>, rafa@acme.com x@y';
    await act(async () => fireEvent.paste(emails, { clipboardData: { getData: () => pasted } }));
    expect(chipsIn(invite)).toEqual(["ana@acme.com", "bia@acme.com", "joao@acme.com.br", "rafa@acme.com", "x@y"]);
    const chip = (email: string) => within(invite).getByText(email).closest(".email-chip") as HTMLElement;
    // Someone in already, someone with an invitation waiting, an address to check: said, and not sent.
    expect(chip("joao@acme.com.br").textContent).toContain("já está na Acme");
    expect(chip("bia@acme.com").textContent).toContain("já convidado");
    expect(chip("x@y").textContent).toContain("confira");
    expect(chip("x@y").getAttribute("data-invalid")).toBe("true");
    expect(invite.textContent).toContain("Confira os e-mails marcados: eles não recebem convite.");
    // An expired invitation can be sent again: rafa counts.
    expect(within(invite).getByRole("button", { name: "Convidar 2 pessoas" })).toBeTruthy();

    // Each address with its role: Membro, or a role this person may give.
    const role = within(invite).getByRole("combobox", { name: "Papel de ana@acme.com" });
    expect(role.textContent).toContain("Membro");
    await openFrom(role);
    await click(screen().getByRole("option", { name: /^Admin/ }));
    await settle(2);
    expect(role.textContent).toContain("Admin");

    // Channels and a note, folded until wanted. #general always, and never sent: everyone joins it.
    await click(within(invite).getByRole("button", { name: /^Canais e recado/ }));
    const chans = within(invite).getByRole("group", { name: "Entram também em" });
    const general = within(chans).getByRole("button", { name: "#general" });
    expect(general.getAttribute("aria-pressed")).toBe("true");
    expect(general.hasAttribute("disabled")).toBe(true);
    const eng = within(chans).getByRole("button", { name: "#eng" });
    expect(eng.getAttribute("aria-pressed")).toBe("false");
    await click(eng);
    expect(eng.getAttribute("aria-pressed")).toBe("true");
    await type(within(invite).getByLabelText("Recado no e-mail (opcional)"), "  Vem para a Acme  ");
    // Folded again, the choices say themselves beside it.
    await click(within(invite).getByRole("button", { name: /^Canais e recado/ }));
    expect(invite.querySelector(".invite-more__sum")?.textContent).toBe("· #eng · com recado");

    await click(within(invite).getByRole("button", { name: "Convidar 2 pessoas" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.inviteMany")?.args).toEqual([
      ORG_ID,
      {
        invites: [
          { email: "ana@acme.com", roleIds: [ADMIN_ROLE_ID] },
          { email: "rafa@acme.com", roleIds: [] },
        ],
        channelIds: [ENG_ID],
        note: "Vem para a Acme",
      },
    ]);
    // Each outcome said: the one sent (and where else they go), and the one the server answers is invited already.
    expect(text()).toContain("Convite enviado para ana@acme.com.");
    expect(text()).toContain("Entram também em #eng.");
    expect(text()).toContain("rafa@acme.com já tem um convite pendente. Use Reenviar.");
    // Only what's left to fix stays; nothing to fix closes it.
    expect(chipsIn(dialog())).toEqual(["x@y"]);
    await click(within(dialog()).getByRole("button", { name: "Remover x@y" }));
    expect(within(dialog()).getByRole("button", { name: "Convidar" }).hasAttribute("disabled")).toBe(true);
    await click(within(dialog()).getByRole("button", { name: "Cancelar" }));
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Convidar para a Acme" })).toBeNull();
    const list = screen().getByRole("region", { name: "Convites enviados" });
    const sent = within(list).getByRole("group", { name: "Convite para ana@acme.com" });
    expect(sent.textContent).toContain("Admin · agora");
    expect(sent.textContent).toMatch(/Expira em \d dias/);
  });

  test("typed: Enter, a comma or leaving the field makes chips; Backspace takes the last back; Enter on nothing sends", async () => {
    const { state } = await members();
    const invite = await openInvite();
    const emails = within(invite).getByLabelText("E-mails");
    await type(emails, "Nova@Acme.com");
    await act(async () => fireEvent.keyDown(emails, { key: "," }));
    await type(emails, "outra@acme.com");
    await act(async () => fireEvent.blur(emails));
    expect(chipsIn(invite)).toEqual(["nova@acme.com", "outra@acme.com"]);
    expect(emails.getAttribute("placeholder")).toBe("Mais e-mails…");
    await act(async () => fireEvent.keyDown(emails, { key: "Backspace" }));
    expect(chipsIn(invite)).toEqual(["nova@acme.com"]);
    await act(async () => fireEvent.keyDown(emails, { key: "Enter" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.inviteMany")?.args[1]).toEqual({
      invites: [{ email: "nova@acme.com", roleIds: [] }],
      channelIds: [],
    });
    expect(text()).toContain("Convite enviado para nova@acme.com.");
    expect(screen().queryByRole("dialog", { name: "Convidar para a Acme" })).toBeNull();
  });

  test("one dialog from everywhere: the workspace menu and ⌘K open it over the page; who may not invite has neither", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(seedState()) });
    await settle(6);
    await click(screen().getByRole("button", { name: "Menu do workspace Acme" }));
    await settle(1);
    await click(screen().getByRole("menuitem", { name: /^Convidar pessoas/ }));
    await settle(2);
    expect(dialog()).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/issues`);
    await click(within(dialog()).getByRole("button", { name: "Cancelar" }));
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Convidar para a Acme" })).toBeNull();

    // ⌘K: "convidar" (or "invite") finds it; Enter opens it.
    for (const words of ["convidar", "invite"]) {
      await act(async () => fireEvent.keyDown(window, { key: "k", metaKey: true }));
      const palette = screen().getByRole("combobox", { name: "Ir para, ou pedir a um agente" });
      await type(palette, words);
      const first = within(screen().getByRole("listbox", { name: "Resultados" })).getAllByRole("option")[0];
      expect(first?.textContent).toContain("Convidar pessoas");
      expect(first?.textContent).toContain("por e-mail ou link");
      await act(async () => fireEvent.keyDown(palette, { key: "Enter" }));
      await settle(2);
      expect(dialog()).toBeTruthy();
      await click(within(dialog()).getByRole("button", { name: "Cancelar" }));
      await settle(2);
    }
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/issues`);
    cleanup();

    const member = seedState();
    if (member.me?.organizations[0]) member.me.organizations[0].role = "member";
    await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(member) });
    await settle(6);
    await act(async () => fireEvent.keyDown(window, { key: "k", metaKey: true }));
    await type(screen().getByRole("combobox", { name: "Ir para, ou pedir a um agente" }), "convidar");
    expect(screen().queryByRole("option", { name: /Convidar pessoas/ })).toBeNull();
  });

  test("a channel's Adicionar: an address nobody here has invites them to the workspace and that channel", async () => {
    const state = seedState();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    await click(screen().getByRole("button", { name: "Detalhes do canal" }));
    await settle(3);
    const details = screen().getByRole("dialog", { name: "#eng" });
    await click(within(details).getByRole("button", { name: "Adicionar pessoa ou agente" }));
    const add = screen().getByRole("dialog", { name: "Adicionar a #eng" });
    const search = within(add).getByRole("searchbox", { name: "Buscar pessoa ou agente" });
    // Someone in the workspace already: nothing to invite.
    await type(search, "joao@acme.com.br");
    expect(within(add).queryByRole("button", { name: /^Convidar / })).toBeNull();
    await type(search, " Nova@Estudio.com ");
    await click(within(add).getByRole("button", { name: "Convidar nova@estudio.com para a Acme e para #eng" }));
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Adicionar a #eng" })).toBeNull();
    // The dialog opens with that address and that channel chosen.
    const invite = dialog();
    expect(chipsIn(invite)).toEqual(["nova@estudio.com"]);
    expect(invite.querySelector(".invite-more__sum")?.textContent).toBe("· #eng");
    await click(within(invite).getByRole("button", { name: "Convidar 1 pessoa" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.inviteMany")?.args[1]).toEqual({
      invites: [{ email: "nova@estudio.com", roleIds: [] }],
      channelIds: [ENG_ID],
    });
  });
});

describe("Members › Convites enviados", () => {
  test("copy a link at any time, Reenviar keeps it, change the role; Cancelar waits for Desfazer, then revokes", async () => {
    const state = seedState();
    state.invitations.push(
      invitation({ id: "inv-rafa", email: "rafael@acme.com", invitedBy: "João" }),
      invitation({
        id: "inv-soon",
        email: "soon@acme.com",
        expiresAt: new Date(Date.now() + 20 * 3_600_000 + 60_000).toISOString(),
        createdAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
        url: null,
      }),
      invitation({
        id: "inv-old",
        email: "old@acme.com",
        status: "expired",
        expiresAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        createdAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      }),
    );
    await members(state);
    const sent = () => screen().getByRole("region", { name: "Convites enviados" });
    const row = (email: string) => within(sent()).getByRole("group", { name: `Convite para ${email}` });
    // Expiring within two days: said in the attention tone. One sent before links could be copied again: no Copy.
    const soon = row("soon@acme.com").querySelector(".members-row__state") as HTMLElement;
    expect(soon.textContent).toBe("Expira em 20 h");
    expect(soon.getAttribute("data-tone")).toBe("soon");
    expect(within(row("soon@acme.com")).queryByRole("button", { name: "Copiar link" })).toBeNull();

    // Copy at any time: the same link as the email's.
    const rafael = () => row("rafael@acme.com");
    const writes = await withClipboard(() => click(within(rafael()).getByRole("button", { name: "Copiar link" })));
    expect(writes).toEqual(["http://localhost:3000/invite/tok-inv-rafa"]);
    expect(text()).toContain("Link do convite de rafael@acme.com copiado. É o mesmo do e-mail.");
    expect(within(rafael()).getByRole("button", { name: "Copiado" })).toBeTruthy();

    // Reenviar: the same link, 7 more days.
    await click(within(rafael()).getByRole("button", { name: "Reenviar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.resendInvitation")?.args).toEqual([ORG_ID, "inv-rafa"]);
    expect(text()).toMatch(/Mandei de novo para rafael@acme\.com\. O link é o mesmo e vale até \d+ \S+\./);
    expect(rafael().querySelector(".members-row__state")?.textContent).toMatch(/^Mandado de novo · vale até \d+ \S+$/);
    expect(within(rafael()).getByRole("button", { name: "Reenviar" }).hasAttribute("disabled")).toBe(true);
    expect(state.invitations.find((i) => i.id === "inv-rafa")?.url).toBe("http://localhost:3000/invite/tok-inv-rafa");

    // Mudar o papel: nothing is sent, the link stays.
    const more = () => within(rafael()).getByRole("button", { name: "Mais ações para rafael@acme.com" });
    await openFrom(more());
    await click(screen().getByRole("menuitem", { name: "Mudar o papel" }));
    await settle(2);
    const roles = screen().getByRole("dialog", { name: "Papel de rafael@acme.com" });
    expect(roles.textContent).toContain("Muda o que a pessoa recebe ao entrar. O link continua o mesmo.");
    await openFrom(within(roles).getByRole("button", { name: "Papel de rafael@acme.com" }));
    await click(screen().getByRole("menuitemcheckbox", { name: "Admin" }));
    await act(async () => fireEvent.keyDown(screen().getByRole("menu"), { key: "Escape" }));
    await click(within(roles).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.setInvitationRoles")?.args).toEqual([
      ORG_ID,
      "inv-rafa",
      [ADMIN_ROLE_ID],
    ]);
    expect(text()).toContain("rafael@acme.com entra como Admin.");
    expect(rafael().textContent).toContain("Admin · convite de João");
    expect(state.calls.filter((c) => c.method === "orgs.resendInvitation")).toHaveLength(1);

    // Cancelar convite: off the list at once; Desfazer within the toast's time brings it back, nothing revoked.
    undoWindow.ms = 600;
    await openFrom(more());
    await click(screen().getByRole("menuitem", { name: "Cancelar convite" }));
    expect(within(sent()).queryByRole("group", { name: "Convite para rafael@acme.com" })).toBeNull();
    const toast = screen().getByText("Convite de rafael@acme.com cancelado.").closest(".ac-toast") as HTMLElement;
    await click(within(toast).getByRole("button", { name: "Desfazer" }));
    expect(rafael()).toBeTruthy();
    await wait(700);
    expect(state.calls.some((c) => c.method === "orgs.revokeInvitation")).toBe(false);

    // Left alone, it goes when the toast does.
    undoWindow.ms = 40;
    await openFrom(more());
    await click(screen().getByRole("menuitem", { name: "Cancelar convite" }));
    await wait(120);
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.revokeInvitation")?.args).toEqual([ORG_ID, "inv-rafa"]);
    expect(within(sent()).queryByRole("group", { name: "Convite para rafael@acme.com" })).toBeNull();

    // An expired one: Renovar or Tirar, which waits for Desfazer the same way.
    const old = row("old@acme.com");
    expect(old.textContent).toMatch(/enviado em \d+ \S+/);
    expect(old.querySelector(".members-row__state")?.textContent).toMatch(/^Expirou em \d+ \S+$/);
    await click(within(old).getByRole("button", { name: "Tirar" }));
    expect(text()).toContain("old@acme.com saiu da lista.");
    await wait(120);
    await settle(4);
    expect(state.calls.filter((c) => c.method === "orgs.revokeInvitation").at(-1)?.args).toEqual([ORG_ID, "inv-old"]);
  });

  test("the menu says Reenviar keeps the link, so cancel a leaked one; an older one gets a new link", async () => {
    const state = seedState();
    state.invitations.push(
      invitation({ id: "inv-rafa", email: "rafael@acme.com" }),
      // Sent before links lasted: nothing to copy, and sending it again changes its link.
      invitation({ id: "inv-before", email: "before@acme.com", url: null }),
    );
    await members(state);
    const sent = () => screen().getByRole("region", { name: "Convites enviados" });
    const row = (email: string) => within(sent()).getByRole("group", { name: `Convite para ${email}` });
    /** The row's "⋯" menu, open; the note under Cancelar convite, if any; then closed again. */
    const noteIn = async (email: string) => {
      await openFrom(within(row(email)).getByRole("button", { name: `Mais ações para ${email}` }));
      const menu = screen().getByRole("menu");
      const note = menu.querySelector(".ac-menu__note")?.textContent ?? null;
      await act(async () => fireEvent.keyDown(menu, { key: "Escape" }));
      await settle(2);
      return note;
    };
    const lasts = "O link não muda ao reenviar. Se ele foi parar com quem não devia, cancele e convide de novo.";

    // A link that lasts: where Cancelar convite is, the menu says resending won't stop one that reached someone else.
    expect(await noteIn("rafael@acme.com")).toBe(lasts);
    await click(within(row("rafael@acme.com")).getByRole("button", { name: "Reenviar" }));
    await settle(4);
    expect(text()).toMatch(/Mandei de novo para rafael@acme\.com\. O link é o mesmo e vale até \d+ \S+\./);

    // One sent before: no such note, and Reenviar says its link is new and the old one stops opening.
    expect(await noteIn("before@acme.com")).toBeNull();
    await click(within(row("before@acme.com")).getByRole("button", { name: "Reenviar" }));
    await settle(4);
    expect(text()).toMatch(/Mandei de novo para before@acme\.com, com um link novo que vale até \d+ \S+\./);
    expect(text()).toContain("O link anterior não abre mais.");
    expect(text()).not.toMatch(/before@acme\.com\. O link é o mesmo/);
    // From then on it lasts like the others: a link to copy, and the note.
    expect(within(row("before@acme.com")).getByRole("button", { name: "Copiar link" })).toBeTruthy();
    expect(await noteIn("before@acme.com")).toBe(lasts);
    // In English too.
    expect(createI18n("en").t("members.invitations.linkStays")).toBe(
      "Resending keeps the link. If it reached the wrong person, cancel and invite again.",
    );
  });
});

describe("Members › a member who may not invite", () => {
  /** Walter as a plain member: João (Admin) is who invites. */
  const asMember = () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const walter = state.members.find((m) => m.userId === "u-walter");
    if (walter) walter.role = "member";
    return state;
  };

  test("suggests someone: the card, the dialog, its refusals in our words; then theirs, waiting, to take back", async () => {
    const { state } = await members(asMember());
    expect(screen().queryByRole("button", { name: "Convidar pessoas" })).toBeNull();
    expect(screen().queryByRole("region", { name: "Convites enviados" })).toBeNull();
    const card = screen().getByRole("region", { name: "Quer trazer alguém para a Acme?" });
    expect(card.textContent).toContain(
      "Quem convida aqui é João. Sugira a pessoa: a sugestão chega e é aprovada com um clique.",
    );
    await click(within(card).getByRole("button", { name: "Sugerir pessoa" }));
    await settle(2);
    const suggest = () => screen().getByRole("dialog", { name: "Sugerir alguém para a Acme" });
    const email = within(suggest()).getByLabelText("E-mail");
    const send = () => click(within(suggest()).getByRole("button", { name: "Mandar para os admins" }));
    await type(email, "otto@estudio");
    await send();
    expect(suggest().textContent).toContain("Confira o e-mail: algo como nome@empresa.com.br.");
    expect(state.calls.some((c) => c.method === "joinRequests.suggest")).toBe(false);

    // Refused: about the person suggested, never the generic "Você já está neste workspace."
    state.suggestError = new ApiError(409, "join.member", "Already in this workspace");
    await type(email, "Joao@acme.com.br");
    await send();
    await settle(4);
    expect(suggest().textContent).toContain("joao@acme.com.br já está na Acme.");
    expect(text()).not.toContain("Você já está neste workspace.");
    state.suggestError = new ApiError(409, "join.waiting", "Someone already asked for this person");
    await type(email, "otto@estudio.com");
    await send();
    await settle(4);
    expect(suggest().textContent).toContain("otto@estudio.com já está esperando um admin.");

    state.suggestError = undefined;
    await type(within(suggest()).getByLabelText("Quem é (opcional)"), " Freelancer de design ");
    await send();
    await settle(6);
    expect(state.calls.filter((c) => c.method === "joinRequests.suggest").at(-1)?.args).toEqual([
      ORG_ID,
      { email: "otto@estudio.com", note: "Freelancer de design" },
    ]);
    expect(text()).toContain("Sugestão enviada. João vê em Membros e convites.");
    expect(screen().queryByRole("dialog", { name: "Sugerir alguém para a Acme" })).toBeNull();

    const mine = screen().getByRole("region", { name: "Suas sugestões" });
    const row = within(mine).getByRole("group", { name: "Sugestão de otto@estudio.com" });
    expect(row.textContent).toContain("Freelancer de design");
    expect(row.textContent).toContain("Esperando um admin · agora");
    await click(within(row).getByRole("button", { name: "Cancelar a sugestão de otto@estudio.com" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "joinRequests.cancel")?.args).toEqual([ORG_ID, "sug-1"]);
    expect(text()).toContain("Sugestão cancelada.");
    expect(screen().queryByRole("region", { name: "Suas sugestões" })).toBeNull();
  });

  test("a suggestion's refusals are said about the person, in both languages", () => {
    for (const lng of ["pt-BR", "en"] as const) {
      const { t } = createI18n(lng);
      for (const refusal of ["member", "invited", "waiting", "full", "invalid"] as const) {
        const said = t(`members.suggest.refused.${refusal}`, { email: "ana@acme.com", org: "Acme" });
        expect({ refusal, said: said.startsWith("members.") }).toEqual({ refusal, said: false });
      }
    }
    const en = createI18n("en").t;
    expect(en("members.suggest.refused.member", { email: "ana@acme.com", org: "Acme" })).toBe(
      "ana@acme.com is already in Acme.",
    );
    expect(en("members.suggest.refused.invited", { email: "ana@acme.com", org: "Acme" })).toBe(
      "ana@acme.com already has an invitation waiting.",
    );
  });
});

describe("a newcomer's first #general", () => {
  /** Walter, let in `minutes` ago as a member. */
  const newcomer = (minutes = 60) => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const walter = state.members.find((m) => m.userId === "u-walter");
    if (walter) {
      walter.role = "member";
      walter.joinedAt = new Date(Date.now() - minutes * 60_000).toISOString();
    }
    return state;
  };
  const welcome = () => screen().queryByRole("region", { name: "Boas-vindas à Acme, Walter" });
  const open = async (state: ReturnType<typeof seedState>, channelId = GENERAL_ID) => {
    const r = await renderApp(`/org/${ORG_ID}/c/${channelId}`, { api: createFakeApi(state) });
    await settle(6);
    return r;
  };

  test("the welcome on a sky, with who works there; Dizer oi goes to the composer; closed, it stays closed", async () => {
    await open(newcomer());
    const card = welcome() as HTMLElement;
    expect(card.querySelector("h2")?.textContent).toBe("Boas-vindas à Acme, Walter");
    expect(card.textContent).toContain(
      "Aqui o time e os agentes trabalham juntos: escreva no #general ou chame um agente pelo nome.",
    );
    // The people, then the agents, by their first names.
    expect([...card.querySelectorAll(".welcome-card__name")].map((n) => n.textContent)).toEqual([
      "João",
      "Ada",
      "Atlas",
    ]);
    await click(within(card).getByRole("button", { name: "Dizer oi no #general" }));
    expect(document.activeElement).toBe(screen().getByRole("combobox", { name: "Mensagem para #general" }));
    await click(within(card).getByRole("button", { name: "Fechar" }));
    expect(welcome()).toBeNull();
    expect(localStorage.getItem(`agentes.arrival.closed.u-walter.${ORG_ID}`)).toBe("1");
    cleanup();

    await open(newcomer());
    expect(welcome()).toBeNull();
  });

  test("its ways in: a conversation with the first agent, the team", async () => {
    const first = await open(newcomer());
    await click(within(welcome() as HTMLElement).getByRole("button", { name: "Conversar com Ada" }));
    await settle(4);
    expect(first.router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    cleanup();

    const second = await open(newcomer());
    await click(within(welcome() as HTMLElement).getByRole("button", { name: "Ver a equipe" }));
    await settle(4);
    expect(second.router.state.location.pathname).toBe(`/org/${ORG_ID}/team`);
  });

  test("only someone who just came in, in #general: not the owner, not after a day, not in another channel", async () => {
    for (const [state, channelId] of [
      [seedState(), GENERAL_ID],
      [newcomer(25 * 60), GENERAL_ID],
      [newcomer(), ENG_ID],
    ] as const) {
      await open(state, channelId);
      expect(document.querySelector(".welcome-card")).toBeNull();
      cleanup();
    }
  });
});
