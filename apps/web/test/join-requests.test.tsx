import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { InvitationPreview, JoinRequest, JoinStatus, Member, NotificationLatest } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { icons } from "@agenteschat/ui";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { ADA_ID, ADMIN_ROLE_ID, ATLAS_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { hintOf } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  setSystemTime();
  cleanup();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const button = (name: string | RegExp) => screen().getByRole("button", { name });
const heading = () => screen().getByRole("heading", { level: 1 }).textContent;
const text = () => document.body.textContent ?? "";

const LINK: InvitationPreview = {
  orgName: "Acme",
  email: "",
  role: "member",
  kind: "link",
  invitedBy: "Marina Alves",
  agents: [
    { id: ADA_ID, name: "Ada", appearance: null },
    { id: ATLAS_ID, name: "Atlas", appearance: null },
  ],
};
const you = (patch: Partial<JoinStatus> = {}): JoinStatus => ({
  member: false,
  email: "walter@acme.com.br",
  request: null,
  ...patch,
});

/** The link's page, signed out (`me: null`) or as the fake's Walter (confirmed unless `unconfirmed`). */
async function openLink(
  preview: InvitationPreview,
  options: {
    signedIn?: boolean;
    unconfirmed?: boolean;
    askError?: ApiError;
    sendCodeError?: ApiError;
    emails?: boolean;
  } = {},
) {
  const state = seedState({
    previews: { lnk: preview },
    askError: options.askError,
    sendCodeError: options.sendCodeError,
    authConfig: { passwordReset: options.emails ?? true },
  });
  if (!options.signedIn) state.me = null;
  else if (state.me) state.me.user.emailVerified = !options.unconfirmed;
  const r = await renderApp("/invite/lnk", { api: createFakeApi(state) });
  await settle(4);
  return { ...r, state };
}

/** The Verify slot's four labels share one cell; only the current one shows. */
const slot = () => {
  const [verify, resend, wait] = [...document.querySelectorAll<HTMLElement>(".invite-ask__slot > .ac-btn")];
  const shows = (el: HTMLElement | undefined) => !!el && el.style.visibility !== "hidden";
  const status = document.querySelector(".invite-ask__slot [role=status]")?.textContent;
  if (status) return `status:${status}`;
  return shows(verify)
    ? "verify"
    : shows(resend)
      ? "resend"
      : `wait:${wait?.textContent} ${wait?.getAttribute("aria-label")}`;
};
const codeField = () => screen().queryByLabelText("Código do e-mail") as HTMLInputElement | null;

describe("an invitation link asks to join", () => {
  test("signed out: who shared it and who works there, the form, then sent (the answer comes by email)", async () => {
    const { state } = await openLink(LINK, { emails: false });
    expect(heading()).toBe("Pedir para entrar na Acme");
    expect(text()).toContain("Marina compartilhou este link. Um admin aprova cada pessoa nova.");
    expect(text()).toContain("Ada e Atlas já trabalham lá.");
    // Their faces lead the line, on its first line when the names wrap.
    const agents = screen().getByText("Ada e Atlas já trabalham lá.").parentElement;
    expect(agents?.classList.contains("ac-iconline")).toBe(true);
    expect(screen().getByRole("link", { name: "Entrar" }).getAttribute("href")).toBe("/login?redirect=%2Finvite%2Flnk");
    const send = button("Pedir para entrar");
    expect(send.hasAttribute("disabled")).toBe(true);

    await type(screen().getByLabelText("Seu nome"), "  Ana Souza ");
    await type(screen().getByLabelText("Seu e-mail"), "ana@gmial.com");
    // No line under it: the sent screen names the address.
    expect(screen().getByLabelText("Seu e-mail").hasAttribute("aria-describedby")).toBe(false);
    // The answer goes to that address: a likely typo is offered first.
    await click(button("Você quis dizer ana@gmail.com?"));
    // Signing in instead takes the address typed here along.
    expect(screen().getByRole("link", { name: "Entrar" }).getAttribute("href")).toBe(
      "/login?redirect=%2Finvite%2Flnk&email=ana%40gmail.com",
    );
    const note = screen().getByLabelText("Algo que eles devam saber? (opcional)");
    expect(note.getAttribute("placeholder")).toBe("Quem é você e quem te convidou");
    expect(note.hasAttribute("aria-describedby")).toBe(false);
    await type(note, "Designer nova da Paula");
    expect(send.hasAttribute("disabled")).toBe(false);
    await click(send);
    await settle(4);
    expect(state.calls.find((c) => c.method === "invites.ask")?.args).toEqual([
      "lnk",
      { name: "Ana Souza", email: "ana@gmail.com", note: "Designer nova da Paula" },
    ]);
    expect(heading()).toBe("Pedido enviado");
    // One line: where the answer goes. Nothing about closing the page.
    expect([...document.querySelectorAll(".invite-ask__outcome-text p")].map((p) => p.textContent)).toEqual([
      "Avisamos em ana@gmail.com quando um admin responder.",
    ]);
  });

  test("signed out, on a server that sends email: Verify, the code typed back, then Ask carries it", async () => {
    const { state } = await openLink(LINK);
    await type(screen().getByLabelText("Seu nome"), "Ana Souza");
    expect(button("Verificar").hasAttribute("disabled")).toBe(true);
    await type(screen().getByLabelText("Seu e-mail"), "ana@gmial.com");
    // The suggestion comes with the address, before Verify, which would send the code to the typo.
    const row = [...(screen().getByLabelText("Seu e-mail").parentElement?.children ?? [])];
    expect(row.map((el) => el.className.split(" ")[0])).toEqual(["ac-input", "auth__fix", "invite-ask__slot"]);
    await click(button("Você quis dizer ana@gmail.com?"));
    const send = button("Pedir para entrar");
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(codeField()).toBeNull();

    await click(button("Verificar"));
    await settle(4);
    expect(state.calls.find((c) => c.method === "invites.sendCode")?.args).toEqual(["lnk", { email: "ana@gmail.com" }]);
    // The code field takes the focus, and the slot counts down to Resend.
    const code = codeField() as HTMLInputElement;
    expect(document.activeElement).toBe(code);
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    expect(code.getAttribute("inputmode")).toBe("numeric");
    expect(slot()).toMatch(/^wait:[01]:\d\d Reenviar em \d+ segundos$/);
    expect(send.hasAttribute("disabled")).toBe(true);

    // A wrong code: said under the field, which empties for another try.
    await type(code, "000000");
    await settle(4);
    expect(screen().getByRole("alert").textContent).toBe("Código errado. Tente de novo.");
    expect(code.value).toBe("");
    expect(document.activeElement).toBe(code);

    // The sixth digit checks at once; spaces and dashes don't count.
    await type(code, "123 45");
    expect(code.value).toBe("12345");
    expect(state.calls.filter((c) => c.method === "invites.checkCode")).toHaveLength(1);
    await type(code, "123-456");
    await settle(4);
    expect(state.calls.filter((c) => c.method === "invites.checkCode").at(-1)?.args).toEqual([
      "lnk",
      { email: "ana@gmail.com", code: "123456" },
    ]);
    expect(slot()).toBe("status:Verificado");
    expect(codeField()).toBeNull();
    expect(screen().queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(screen().getByLabelText("Algo que eles devam saber? (opcional)"));
    expect(send.hasAttribute("disabled")).toBe(false);
    await click(send);
    await settle(4);
    expect(state.calls.find((c) => c.method === "invites.ask")?.args).toEqual([
      "lnk",
      { name: "Ana Souza", email: "ana@gmail.com", code: "123456" },
    ]);
    expect(heading()).toBe("Pedido enviado");
  });

  test("editing the email starts over; Resend after the countdown; a code sent a moment ago counts down", async () => {
    const { state } = await openLink(LINK);
    await type(screen().getByLabelText("Seu nome"), "Ana Souza");
    await type(screen().getByLabelText("Seu e-mail"), "ana@acme.com");
    await click(button("Verificar"));
    await settle(4);
    await type(codeField() as HTMLInputElement, "123456");
    await settle(4);
    expect(slot()).toBe("status:Verificado");

    await type(screen().getByLabelText("Seu e-mail"), "ana@acme.co");
    expect(slot()).toBe("verify");
    expect(codeField()).toBeNull();
    expect(button("Pedir para entrar").hasAttribute("disabled")).toBe(true);
    // The address the code went to, typed again: its proof still holds.
    await type(screen().getByLabelText("Seu e-mail"), "ana@acme.com");
    expect(slot()).toBe("status:Verificado");

    await type(screen().getByLabelText("Seu e-mail"), "bia@acme.com");
    await click(button("Verificar"));
    await settle(4);
    expect(slot()).toMatch(/^wait:/);
    setSystemTime(new Date(Date.now() + 61_000));
    await type(codeField() as HTMLInputElement, "1");
    expect(slot()).toBe("resend");
    await click(button("Reenviar"));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "invites.sendCode")).toHaveLength(3);
    cleanup();

    // Reopened inside the minute: the code already sent is the one to type.
    const retry = new ApiError(429, "join.code_wait", "wait", { retryIn: 42 });
    await openLink(LINK, { sendCodeError: retry });
    await type(screen().getByLabelText("Seu e-mail"), "ana@acme.com");
    await click(button("Verificar"));
    await settle(4);
    expect(slot()).toBe("wait:0:42 Reenviar em 42 segundos");
    expect(codeField()).toBeTruthy();
    expect(screen().queryByRole("alert")).toBeNull();
  });

  test("at phone width the email takes its row and Verify's slot goes under it, after a typo's suggestion", async () => {
    const css = (await Bun.file(new URL("../src/pages/invite.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const phone = css.split("\n@media (max-width: 480px) {")[1]?.split("\n}")[0] ?? "";
    const rule = (selector: string, sheet = css) =>
      new RegExp(`\\n *${selector.replace(/[.>]/g, "\\$&")} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? "";
    // Wider, the suggestion takes a row of its own under the address and the slot.
    expect(rule(".invite-ask__verify")).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(rule(".invite-ask__verify > .auth__fix")).toMatch(/grid-row: 2;\s*grid-column: 1 \/ -1;/);
    // On a phone one column, in the markup's order: the address, the suggestion, then the slot.
    expect(rule(".invite-ask__verify", phone)).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(rule(".invite-ask__verify > .auth__fix", phone)).toContain("grid-row: auto");
  });

  test("every refusal of a code is said in both languages, never in the server's English", () => {
    const codes = ["wrong", "expired", "tries", "limit", "wait", "needed"];
    for (const lng of ["pt-BR", "en"] as const) {
      const { t } = createI18n(lng);
      const said = codes.map((c) => errorText(t, new ApiError(409, `join.code_${c}`, "SERVER WORDS")));
      expect(said.filter((s) => s === "SERVER WORDS" || s.startsWith("errors."))).toEqual([]);
    }
    expect(errorText(createI18n("en").t, new ApiError(400, "join.code_wrong", "x"))).toBe("Wrong code. Try again.");
  });

  test("too many codes for an address is said under the email, and Verify and Resend go off for it", async () => {
    const limit = new ApiError(429, "join.code_limit", "limit");
    const { state } = await openLink(LINK, { sendCodeError: limit });
    await type(screen().getByLabelText("Seu e-mail"), "ana@acme.com");
    await click(button("Verificar"));
    await settle(4);
    expect(text()).toContain("Muitos códigos para este e-mail. Tente de novo mais tarde.");
    expect(codeField()).toBeNull();
    expect(slot()).toBe("verify");
    expect(button("Verificar").hasAttribute("disabled")).toBe(true);

    // Another address gets one. At its cap Resend goes off, and the code already sent stays good.
    state.sendCodeError = undefined;
    await type(screen().getByLabelText("Seu e-mail"), "bia@acme.com");
    expect(button("Verificar").hasAttribute("disabled")).toBe(false);
    await click(button("Verificar"));
    await settle(4);
    setSystemTime(new Date(Date.now() + 61_000));
    await type(codeField() as HTMLInputElement, "1");
    state.sendCodeError = limit;
    await click(button("Reenviar"));
    await settle(4);
    expect(slot()).toBe("resend");
    expect(button("Reenviar").hasAttribute("disabled")).toBe(true);
    expect(state.calls.filter((c) => c.method === "invites.sendCode")).toHaveLength(3);
    await type(codeField() as HTMLInputElement, "123456");
    await settle(4);
    expect(slot()).toBe("status:Verificado");
  });

  test("signed in with an email not confirmed: the account's address, read-only, with Verify", async () => {
    const { state } = await openLink({ ...LINK, you: you() }, { signedIn: true, unconfirmed: true });
    const email = screen().getByLabelText("Seu e-mail") as HTMLInputElement;
    expect(email.value).toBe("walter@acme.com.br");
    expect(email.readOnly).toBe(true);
    // "Not you? Sign out" beside the label, so the address shows once.
    expect(email.closest(".ac-field")?.querySelector(".ac-field__label-row")?.textContent).toContain(
      "Não é você? Sair",
    );
    expect(text()).not.toContain("Você vai pedir como");
    await click(button("Verificar"));
    await settle(4);
    expect(state.calls.find((c) => c.method === "invites.sendCode")?.args).toEqual(["lnk", {}]);
    await type(codeField() as HTMLInputElement, "123456");
    await settle(4);
    await click(button("Pedir para entrar"));
    await settle(4);
    expect(state.calls.find((c) => c.method === "invites.ask")?.args).toEqual(["lnk", { code: "123456" }]);
  });

  test("signed in: one tap as the account; the page follows the answer", async () => {
    const { state, services } = await openLink({ ...LINK, you: you() }, { signedIn: true });
    expect(text()).toContain("Você vai pedir como walter@acme.com.br.");
    expect(button("Não é você? Sair")).toBeTruthy();
    expect(screen().queryByLabelText("Seu e-mail")).toBeNull();
    await click(button("Pedir para entrar"));
    await settle(4);
    expect(state.calls.find((c) => c.method === "invites.ask")?.args).toEqual(["lnk", {}]);
    expect(heading()).toBe("Pedido enviado");
    expect(text()).toContain("Você entra assim que um admin aprovar.");

    // Approved: the next check finds them in.
    state.previews = {
      lnk: {
        ...LINK,
        you: you({ member: true, orgId: ORG_ID, request: { status: "approved", reason: null } }),
      },
    };
    await act(() => services.queryClient.invalidateQueries());
    await settle(4);
    expect(heading()).toBe("Você entrou na Acme");
    expect(button("Abrir Acme")).toBeTruthy();
  });

  test("the answers: denied with the admin's note, approved by invitation, already in, a link that no longer works", async () => {
    await openLink(
      { ...LINK, you: you({ request: { status: "denied", reason: "Só a <i>equipe</i> do estúdio" } }) },
      { signedIn: true },
    );
    expect(heading()).toBe("Seu pedido não foi aprovado");
    // As in the email: the label in bold, their words in quotes, as typed.
    const note = document.querySelector(".invite-ask__reason");
    expect(note?.textContent).toBe("Recado: “Só a <i>equipe</i> do estúdio”");
    expect(note?.querySelector("b")?.textContent).toBe("Recado:");
    expect(note?.querySelector("i")).toBeNull();
    expect(text()).toContain("Se acha que foi engano, peça a alguém da Acme para convidar você.");
    cleanup();

    await openLink({ ...LINK, you: you({ request: { status: "approved", reason: null } }) }, { signedIn: true });
    expect(heading()).toBe("Aprovado");
    expect(text()).toContain("Para terminar, abra o convite que mandamos para walter@acme.com.br.");
    cleanup();

    // A server that sends no email: the admin hands them the link.
    await openLink(
      { ...LINK, you: you({ request: { status: "approved", reason: null } }) },
      { signedIn: true, emails: false },
    );
    expect(heading()).toBe("Aprovado");
    expect(text()).toContain("Um admin vai mandar um link para você terminar.");
    expect(text()).not.toContain("convite que mandamos");
    cleanup();

    await openLink({ ...LINK, you: you({ member: true, orgId: ORG_ID }) }, { signedIn: true });
    expect(heading()).toBe("Você já está na Acme");
    cleanup();

    await openLink({ ...LINK, invitedBy: null, agents: [], closed: true });
    expect(heading()).toBe("Este link não funciona mais");
    expect(text()).toContain("Peça um novo a quem mandou.");
    expect(screen().queryByRole("button", { name: "Pedir um novo convite" })).toBeNull();
    expect(screen().queryByLabelText("Seu nome")).toBeNull();
    cleanup();

    // A member opening a link that no longer works: they're in, with the way there.
    await openLink(
      { ...LINK, invitedBy: null, agents: [], closed: true, you: you({ member: true, orgId: ORG_ID }) },
      { signedIn: true },
    );
    expect(heading()).toBe("Você já está na Acme");
    expect(button("Abrir Acme")).toBeTruthy();
  });

  test("whoever works there is counted: the first four by name, then how many more", async () => {
    const agents = ["Ada", "Atlas", "Lia", "Theo"].map((name, i) => ({ id: `a${i}`, name, appearance: null }));
    await openLink({ ...LINK, agents, moreAgents: 2 });
    expect(text()).toContain("Ada, Atlas, Lia, Theo e mais 2 já trabalham lá.");
    expect(document.querySelectorAll(".invite-ask__agents .ac-avatar")).toHaveLength(4);
  });

  test("a full workspace or too many asks, from here or through the link: said in the form, which stays", async () => {
    for (const [error, words] of [
      [new ApiError(409, "join.full", "full"), "Este workspace tem muitos pedidos esperando."],
      [new ApiError(429, "join.rate_limited", "slow down"), "Muitos pedidos daqui. Tente de novo daqui a uma hora."],
      [new ApiError(429, "join.link_busy", "busy"), "Muita gente pediu por este link na última hora."],
    ] as const) {
      await openLink({ ...LINK, you: you() }, { signedIn: true, askError: error });
      await click(button("Pedir para entrar"));
      await settle(4);
      expect(screen().getByRole("alert").textContent).toContain(words);
      expect(heading()).toBe("Pedir para entrar na Acme");
      cleanup();
    }
  });

  test("the workspace's logo in place of its initial, on a link and an invitation alike; the initial without one", async () => {
    const mark = () => document.querySelector<HTMLImageElement>(".invite-card img.org-mark");
    const initial = () => document.querySelector(".invite-card .org-badge");
    const logo = "/api/app/invitations/lnk/logo/0123456789abcdef.png";
    await openLink({ ...LINK, logo });
    expect(mark()?.getAttribute("src")).toBe(logo);
    expect(initial()).toBeNull();
    cleanup();

    const invitation: InvitationPreview = { orgName: "Acme", email: "ana@acme.com.br", role: "member", kind: "email" };
    const state = seedState({
      me: null,
      previews: { inv: { ...invitation, logo: "/api/app/invitations/inv/logo/a.png" } },
    });
    await renderApp("/invite/inv", { api: createFakeApi(state) });
    await settle(4);
    expect(mark()?.getAttribute("src")).toBe("/api/app/invitations/inv/logo/a.png");
    expect(initial()).toBeNull();
    cleanup();

    await openLink(LINK);
    expect(mark()).toBeNull();
    expect(initial()?.textContent).toBe("A");
  });
});

/** Mid-day: a request made 2 h ago is still today, so it reads "há 2 h" and never "ontem". */
const MIDDAY = new Date(2026, 9, 21, 12);

const requests = (): JoinRequest[] => [
  {
    id: "r1",
    name: "Ana Souza",
    email: "ana@estudio.com",
    note: "Designer nova da Paula",
    verified: true,
    confirmed: true,
    createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() + 12 * 86_400_000).toISOString(),
  },
  {
    id: "r2",
    name: "Bruno Lima",
    email: "bruno@lima.dev",
    note: null,
    verified: false,
    confirmed: false,
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    expiresAt: new Date(Date.now() + 13 * 86_400_000).toISOString(),
  },
];

async function members(query = "", patch: Parameters<typeof seedState>[0] = {}) {
  setSystemTime(MIDDAY);
  const state = seedState({ joinRequests: requests(), ...patch });
  const r = await renderApp(`/org/${ORG_ID}/settings/members${query}`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
}
const card = (name: string) => screen().getByRole("group", { name: `${name} pede para entrar` });

describe("Members › Requests to join", () => {
  test("each card keeps who asks and the answer; approve with a role, or an invitation goes out", async () => {
    const { state } = await members();
    const section = screen().getByRole("region", { name: "Pedidos para entrar 2" });
    const ana = within(section).getByRole("group", { name: "Ana Souza pede para entrar" });
    expect(ana.textContent).toContain("Ana Souza pede para entrar");
    expect(ana.textContent).toContain("ana@estudio.com");
    expect(ana.textContent).toContain("“Designer nova da Paula”");
    // The top and the bottom only: no proof line, no closing date.
    expect(ana.querySelector(".ac-approval__detail")).toBeNull();
    expect(ana.textContent).not.toMatch(/E-mail (não )?confirmado|Fecha em/);
    const chips = (el: HTMLElement) => [...el.querySelectorAll(".ac-chip")].map((c) => c.textContent);
    expect(chips(ana)).toEqual(["Pediu há 2 h"]);
    // Nobody proved Bruno's address: "Not verified" beside "Asked …", the only hint approving can't add him at once.
    const bruno = card("Bruno Lima");
    expect(chips(bruno)).toEqual(["Não verificado", expect.stringMatching(/^Pediu em \d/)]);
    expect(bruno.querySelector(".jr-chips")?.children).toHaveLength(2);

    const sidebarCount = () => document.querySelector(".sidebar__org-meta")?.textContent;
    expect(sidebarCount()).toBe("2 membros · 2 agentes");
    // Roles to give (ADR 0085): a menu that stays open, one switch per role below the approver's.
    const roles = within(ana).getByRole("button", { name: "Papéis para Ana Souza" });
    roles.focus();
    await act(async () => fireEvent.keyDown(roles, { key: "Enter" }));
    await click(screen().getByRole("menuitemcheckbox", { name: "Admin" }));
    await act(async () => fireEvent.keyDown(screen().getByRole("menu"), { key: "Escape" }));
    expect(roles.textContent).toContain("Admin");
    await click(within(ana).getByRole("button", { name: "Aprovar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "joinRequests.approve")?.args).toEqual([ORG_ID, "r1", [ADMIN_ROLE_ID]]);
    expect(text()).toContain("Ana Souza entrou.");
    // She counts in the workspace's line too, without a reload.
    expect(sidebarCount()).toBe("3 membros · 2 agentes");

    await click(within(card("Bruno Lima")).getByRole("button", { name: "Aprovar" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "joinRequests.approve").at(-1)?.args).toEqual([ORG_ID, "r2", []]);
    expect(text()).toContain("Convite enviado para bruno@lima.dev.");
    expect(screen().queryByRole("region", { name: /Pedidos para entrar/ })).toBeNull();
  });

  test("on a server without email, approving hands the admin the invitation to send", async () => {
    await members("", {
      approval: { outcome: "invited", url: "http://localhost:3000/invite/tok-r2", emailed: false },
    });
    await click(within(card("Bruno Lima")).getByRole("button", { name: "Aprovar" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Mande este link para Bruno Lima" });
    expect(dialog.textContent).toContain("Este servidor não manda e-mail. O link vale por 7 dias.");
    expect((within(dialog).getByRole("textbox") as HTMLInputElement).value).toBe("http://localhost:3000/invite/tok-r2");
  });

  test("someone let in elsewhere (another admin, another tab) shows at once: in the people and the sidebar's count", async () => {
    const { state, sockets } = await members();
    const socket = sockets.last();
    await act(async () => socket.open());
    const sidebarCount = () => document.querySelector(".sidebar__org-meta")?.textContent;
    expect(sidebarCount()).toBe("2 membros · 2 agentes");
    const joao = state.members[1] as Member;
    state.members.push({ ...joao, userId: "u-carla", name: "Carla Dias", email: "carla@acme.com.br", handle: "carla" });
    await act(async () => socket.push({ type: "event", scope: "org", event: { type: "org.members" } }));
    await settle(6);
    expect(sidebarCount()).toBe("3 membros · 2 agentes");
    expect(text()).toContain("Carla Dias");
  });

  test("deny: an optional reason they read in the email; someone else answering first is said", async () => {
    const { state } = await members();
    await click(within(card("Ana Souza")).getByRole("button", { name: "Recusar" }));
    const dialog = screen().getByRole("dialog", { name: "Recusar o pedido de Ana Souza?" });
    expect(dialog.textContent).toContain("Opcional. A pessoa lê no e-mail.");
    await type(within(dialog).getByLabelText("Diga o motivo"), "  Só a equipe do estúdio ");
    await click(within(dialog).getByRole("button", { name: "Recusar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "joinRequests.deny")?.args).toEqual([
      ORG_ID,
      "r1",
      "Só a equipe do estúdio",
    ]);
    expect(text()).toContain("Pedido recusado.");
    expect(screen().queryByRole("group", { name: "Ana Souza pede para entrar" })).toBeNull();

    state.answerError = new ApiError(409, "join.answered", "answered");
    await click(within(card("Bruno Lima")).getByRole("button", { name: "Aprovar" }));
    await settle(4);
    expect(text()).toContain("Alguém já respondeu este pedido.");
  });

  test("the email's links: Deny opens its dialog, Approve focuses its button, a gone request says so", async () => {
    await members("?request=r2&do=deny");
    expect(screen().getByRole("dialog", { name: "Recusar o pedido de Bruno Lima?" })).toBeTruthy();
    cleanup();

    await members("?request=r1&do=approve");
    expect(document.activeElement).toBe(within(card("Ana Souza")).getByRole("button", { name: "Aprovar" }));
    cleanup();

    await members("?request=r9&do=approve");
    expect(screen().getByRole("status").textContent).toContain("Alguém já respondeu este pedido, ou ele expirou.");
  });
});

test("a name typed with markup reads as typed, in Members and in the inbox", async () => {
  const name = "Ana <strong>CEO</strong><br/>x";
  await members("", { joinRequests: [{ ...(requests()[0] as JoinRequest), name }] });
  const who = card(name).querySelector(".ac-approval__who b");
  expect(who?.textContent).toBe(name);
  expect(who?.children.length).toBe(0);
  cleanup();

  const state = seedState({
    notifications: [
      notification({
        id: "n-join",
        kind: "join_request",
        waiting: true,
        count: 1,
        source: { label: "Acme" },
        latest: { title: name },
      }),
    ],
  });
  await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
  await settle(6);
  const notice = document.querySelector('[data-n="n-join"]') as HTMLElement;
  expect(notice.getAttribute("aria-label")).toBe(`${name} pede para entrar, não lida`);
  const headline = notice.querySelector(".nt-what b");
  expect(headline?.textContent).toBe(name);
  expect(headline?.children.length).toBe(0);
});

describe("Members › Invite people", () => {
  test("says no agent answers someone invited now, as the Team step does, while every agent with an AI is only yours", async () => {
    const note = async (audience: "owner" | "everyone") => {
      cleanup();
      const state = seedState({ joinRequests: [] });
      for (const a of state.agents) {
        a.ownerUserId = state.me?.user.id ?? null;
        a.audience = { mode: "owner", userIds: [] };
      }
      const first = state.agents[0];
      if (first) first.audience = { mode: audience, userIds: [] };
      await renderApp(`/org/${ORG_ID}/settings/members`, { api: createFakeApi(state) });
      await settle(6);
      const invite = screen().getByRole("region", { name: "Convidar pessoas" });
      return { invite, line: within(invite).queryByText("Seus agentes só atendem você.")?.closest(".setup-line") };
    };
    const { invite, line } = await note("owner");
    expect(line).toBeTruthy();
    expect(hintOf("Seus agentes só atendem você.", invite).text).toBe(
      "Num plano, você pode deixar cada um atender outras pessoas na página dele.",
    );
    // Under the card's title, before the invitations it's about.
    const emails = within(invite).getByLabelText("E-mails, separados por vírgula");
    expect((line as Element).compareDocumentPosition(emails) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(invite.querySelector(".ac-card__title + .setup-line")).toBe(line as Element);
    // One agent that answers everyone: someone invited gets an answer, so nothing to say.
    expect((await note("everyone")).line).toBeFalsy();
  });
});

describe("Members › Invite people, by email when the server sends it", () => {
  const inviteCard = async (state: ReturnType<typeof seedState>) => {
    await renderApp(`/org/${ORG_ID}/settings/members`, { api: createFakeApi(state) });
    await settle(6);
    return screen().getByRole("region", { name: "Convidar pessoas" });
  };

  test("no email to send invitations with: the link is the only way in, without the hairline over it", async () => {
    const invite = await inviteCard(seedState({ joinRequests: [], authConfig: { passwordReset: false } }));
    expect(within(invite).queryByLabelText("E-mails, separados por vírgula")).toBeNull();
    expect(within(invite).queryByRole("button", { name: "Convidar" })).toBeNull();
    expect(invite.querySelector(".jr-link--alone")).toBeTruthy();
  });

  test("a self-hosted server that sends email invites by email too, the link under it", async () => {
    const invite = await inviteCard(
      seedState({ joinRequests: [], edition: "selfhost", authConfig: { passwordReset: true } }),
    );
    expect(within(invite).getByLabelText("E-mails, separados por vírgula")).toBeTruthy();
    expect(within(invite).getByRole("button", { name: "Convidar" })).toBeTruthy();
    expect(invite.querySelector(".jr-link:not(.jr-link--alone)")).toBeTruthy();
  });
});

describe("Members › Invitation link", () => {
  test("Turn off's word ends where Copy ends above it: the text button's padding hangs past the edge", async () => {
    const read = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();
    expect(await read("../src/pages/members.css")).toMatch(
      /\.jr-link__foot > \.ac-btn--ghost \{\s*margin: 0 calc\(-1 \* var\(--control-px-sm\)\) 0 auto;\s*\}/,
    );
    const ui = await read("../../../packages/ui/src/styles/components.css");
    expect(ui.split("\n.ac-btn--sm {").at(-1)?.split("}")[0]).toContain("padding: 0 var(--control-px-sm);");
  });

  test("the link to copy, what it does, turning it off with its requests, an earlier link, making a new one", async () => {
    const until = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const { state } = await members("", {
      joinRequests: [],
      inviteLinks: [
        {
          id: "link-1",
          url: "http://localhost:3000/invite/k3J",
          expiresAt: until,
          createdAt: new Date().toISOString(),
          createdBy: "Walter",
          waiting: 2,
        },
        {
          id: "link-0",
          url: null,
          expiresAt: until,
          createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          createdBy: "João",
          waiting: 0,
        },
      ],
    });
    const invite = screen().getByRole("region", { name: "Convidar pessoas" });
    // Inviting by email lets people straight in: the Emails field's ⓘ says so, and describes the field.
    const about = within(invite).getByRole("button", { name: "Sobre E-mails, separados por vírgula" });
    const joins = document.getElementById(about.getAttribute("aria-describedby") ?? "");
    expect(joins?.textContent).toBe("Quem você convida por e-mail entra direto.");
    expect(within(invite).getByLabelText("E-mails, separados por vírgula").getAttribute("aria-describedby")).toBe(
      joins?.id ?? null,
    );
    expect((within(invite).getByLabelText("Link de convite") as HTMLInputElement).value).toBe(
      "http://localhost:3000/invite/k3J",
    );
    // Copied: the word and its icon both say it.
    const writes: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (s: string) => void writes.push(s) },
    });
    try {
      await click(within(invite).getByRole("button", { name: "Copiar" }));
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
    const copied = within(invite).getByRole("button", { name: "Copiado" });
    expect(writes).toEqual(["http://localhost:3000/invite/k3J"]);
    expect(copied.querySelector("svg path")?.getAttribute("d")).toBe(icons.check[0]?.[1].d);
    // Who can get in through a shared link stays on screen, not behind an ⓘ.
    const linkLine = within(invite).getByText(/^Um admin aprova cada pessoa que pedir\. Vale até \S+/);
    expect(linkLine.closest("[hidden]")).toBeNull();
    expect(invite.textContent).toMatch(/Link anterior, criado por João .+\. Vale até /);

    const [turnOff] = within(invite).getAllByRole("button", { name: "Desativar" });
    await click(turnOff as HTMLElement);
    const dialog = screen().getByRole("dialog", { name: "Desativar o link?" });
    expect(dialog.textContent).toContain(
      "Ninguém mais consegue pedir com ele, e os 2 pedidos feitos por ele fecham também.",
    );
    await click(within(dialog).getByRole("button", { name: "Desativar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "invites.turnOff")?.args).toEqual([ORG_ID, "link-1"]);
    await click(within(invite).getByRole("button", { name: "Criar link" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "invites.createLink")).toBe(true);
    expect((within(invite).getByLabelText("Link de convite") as HTMLInputElement).value).toMatch(
      /^http:\/\/localhost:3000\/invite\/link-/,
    );
  });
});

test("the admins' notice: who asks, a Members chip, and it opens Members, from Abrir or the row itself", async () => {
  const notice = async () => {
    const state = seedState({
      notifications: [
        notification({
          id: "n-join",
          kind: "join_request",
          waiting: true,
          count: 2,
          source: { label: "Acme" },
          latest: { title: "Bruno Lima", names: ["Ana Souza", "Bruno Lima"] },
        }),
      ],
    });
    const { router } = await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
    await settle(6);
    return { router, row: document.querySelector('[data-n="n-join"]') as HTMLElement };
  };
  const { router, row } = await notice();
  // Two people: both by name, the first to ask first, as the notice's face and time are hers.
  expect(row.getAttribute("aria-label")).toBe("Ana Souza e Bruno Lima pedem para entrar, não lida");
  expect(row.textContent).toContain("Ana Souza e Bruno Lima pedem para entrar");
  expect(row.querySelector(".nt-face")?.textContent).toBe("AS");
  expect(row.querySelector(".ac-chip")?.textContent).toBe("Membros");
  await click(within(row).getByRole("button", { name: "Abrir" }));
  await settle(6);
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/members`);
  cleanup();

  const again = await notice();
  await click(again.row.querySelector(".nt-what") as HTMLElement);
  await settle(6);
  expect(again.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/members`);
});

test("the admins' notice names the first two who asked and counts the rest", async () => {
  const cases: [NotificationLatest, number, string][] = [
    [
      { title: "Carla Dias", names: ["Ana Souza", "Bruno Lima"] },
      3,
      "Ana Souza, Bruno Lima e mais 1 pedem para entrar",
    ],
    // Kept from before the notice held names: the newest one's, and how many more.
    [{ title: "Bruno Lima" }, 2, "Bruno Lima e mais 1 pedem para entrar"],
  ];
  for (const [latest, count, said] of cases) {
    const state = seedState({
      notifications: [
        notification({ id: "n-join", kind: "join_request", waiting: true, count, source: { label: "Acme" }, latest }),
      ],
    });
    await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
    await settle(6);
    const notice = document.querySelector('[data-n="n-join"]') as HTMLElement;
    expect(notice.getAttribute("aria-label")).toBe(`${said}, não lida`);
    expect(notice.querySelector(".nt-wr__l1")?.textContent).toContain(said);
    cleanup();
  }
});
