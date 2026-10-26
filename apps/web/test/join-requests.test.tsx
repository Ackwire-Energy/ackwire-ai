import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { InvitationPreview, JoinRequest, JoinStatus } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

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

/** The link's page, signed out (`me: null`) or as the fake's Walter. */
async function openLink(
  preview: InvitationPreview,
  options: { signedIn?: boolean; askError?: ApiError; emails?: boolean } = {},
) {
  const state = seedState({
    previews: { lnk: preview },
    askError: options.askError,
    authConfig: { passwordReset: options.emails ?? true },
  });
  if (!options.signedIn) state.me = null;
  else if (state.me) state.me.user.emailVerified = true;
  const r = await renderApp("/invite/lnk", { api: createFakeApi(state) });
  await settle(4);
  return { ...r, state };
}

describe("an invitation link asks to join", () => {
  test("signed out: who shared it and who works there, the form, then sent (the answer comes by email)", async () => {
    const { state } = await openLink(LINK);
    expect(heading()).toBe("Pedir para entrar na Acme");
    expect(text()).toContain("Marina compartilhou este link. Um admin da Acme aprova cada pessoa nova.");
    expect(text()).toContain("Ada e Atlas já trabalham lá.");
    // Their faces lead the line, on its first line when the names wrap.
    const agents = screen().getByText("Ada e Atlas já trabalham lá.").parentElement;
    expect(agents?.classList.contains("ac-iconline")).toBe(true);
    expect(screen().getByRole("link", { name: "Entrar" }).getAttribute("href")).toBe("/login?redirect=%2Finvite%2Flnk");
    const send = button("Pedir para entrar");
    expect(send.hasAttribute("disabled")).toBe(true);

    await type(screen().getByLabelText("Seu nome"), "  Ana Souza ");
    await type(screen().getByLabelText("Seu e-mail"), "ana@gmial.com");
    expect(screen().getByText("A resposta chega neste e-mail.")).toBeTruthy();
    // The answer goes to that address: a likely typo is offered first.
    await click(button("Você quis dizer ana@gmail.com?"));
    await type(screen().getByLabelText("Algo que eles devam saber?"), "Designer nova da Paula");
    expect(send.hasAttribute("disabled")).toBe(false);
    await click(send);
    await settle(4);
    expect(state.calls.find((c) => c.method === "invites.ask")?.args).toEqual([
      "lnk",
      { name: "Ana Souza", email: "ana@gmail.com", note: "Designer nova da Paula" },
    ]);
    expect(heading()).toBe("Pedido enviado");
    expect(text()).toContain("Os admins da Acme já podem ver. Quando um deles responder, avisamos em ana@gmail.com.");
    expect(text()).toContain("Pode fechar esta página. Pedido sem resposta fecha em 14 dias.");
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
    expect(text()).toContain("Você entra assim que um deles aprovar.");

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
      { ...LINK, you: you({ request: { status: "denied", reason: "Só a equipe do estúdio" } }) },
      { signedIn: true },
    );
    expect(heading()).toBe("Seu pedido não foi aprovado");
    expect(text()).toContain("Recado: Só a equipe do estúdio");
    expect(text()).toContain("Se acha que foi engano, peça a alguém da Acme para convidar você por e-mail.");
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
  });

  test("a full workspace or too many asks: said in the form, which stays", async () => {
    for (const [error, words] of [
      [new ApiError(409, "join.full", "full"), "Este workspace tem muitos pedidos esperando."],
      [new ApiError(429, "join.rate_limited", "slow down"), "Muitos pedidos daqui. Tente de novo daqui a uma hora."],
    ] as const) {
      await openLink({ ...LINK, you: you() }, { signedIn: true, askError: error });
      await click(button("Pedir para entrar"));
      await settle(4);
      expect(screen().getByRole("alert").textContent).toContain(words);
      expect(heading()).toBe("Pedir para entrar na Acme");
      cleanup();
    }
  });
});

const REQUESTS: JoinRequest[] = [
  {
    id: "r1",
    name: "Ana Souza",
    email: "ana@estudio.com",
    note: "Designer nova da Paula",
    confirmed: true,
    createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() + 12 * 86_400_000).toISOString(),
  },
  {
    id: "r2",
    name: "Bruno Lima",
    email: "bruno@lima.dev",
    note: null,
    confirmed: false,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() + 13 * 86_400_000).toISOString(),
  },
];

async function members(query = "", patch: Parameters<typeof seedState>[0] = {}) {
  const state = seedState({ joinRequests: structuredClone(REQUESTS), ...patch });
  const r = await renderApp(`/org/${ORG_ID}/settings/members${query}`, { api: createFakeApi(state) });
  await settle(6);
  return { ...r, state };
}
const card = (name: string) => screen().getByRole("group", { name: `${name} pede para entrar` });

describe("Members › Requests to join", () => {
  test("each request says what approving does; approve with a role, or an invitation goes out", async () => {
    const { state } = await members();
    const section = screen().getByRole("region", { name: "Pedidos para entrar 2" });
    const ana = within(section).getByRole("group", { name: "Ana Souza pede para entrar" });
    expect(ana.textContent).toContain("Ana Souza pede para entrar");
    expect(ana.textContent).toContain("ana@estudio.com");
    expect(ana.textContent).toContain("E-mail confirmado: a pessoa entra quando você aprovar.");
    const proof = within(ana).getByText("E-mail confirmado: a pessoa entra quando você aprovar.").parentElement;
    expect(proof?.classList.contains("ac-iconline")).toBe(true);
    expect(ana.textContent).toContain("“Designer nova da Paula”");
    expect(ana.textContent).toMatch(/Pelo link de convite · fecha em /);
    expect(ana.querySelector(".ac-chip")?.textContent).toBe("Pediu há 2 h");
    expect(card("Bruno Lima").textContent).toContain("E-mail não confirmado: aprovar manda um convite para ele.");

    const role = within(ana).getByRole("combobox", { name: "Papel de Ana Souza" });
    role.focus();
    await act(async () => fireEvent.keyDown(role, { key: "Enter" }));
    await click(screen().getByRole("option", { name: /^Admin/ }));
    await click(within(ana).getByRole("button", { name: "Aprovar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "joinRequests.approve")?.args).toEqual([ORG_ID, "r1", "admin"]);
    expect(text()).toContain("Ana Souza entrou.");

    await click(within(card("Bruno Lima")).getByRole("button", { name: "Aprovar" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "joinRequests.approve").at(-1)?.args).toEqual([
      ORG_ID,
      "r2",
      "member",
    ]);
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
    expect(dialog.textContent).toContain("Este servidor não manda e-mail.");
    expect((within(dialog).getByRole("textbox") as HTMLInputElement).value).toBe("http://localhost:3000/invite/tok-r2");
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
  await members("", { joinRequests: [{ ...(REQUESTS[0] as JoinRequest), name }] });
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
  expect(notice.getAttribute("aria-label")).toBe(`${name} pede para entrar`);
  const headline = notice.querySelector(".nt-meta b");
  expect(headline?.textContent).toBe(name);
  expect(headline?.children.length).toBe(0);
});

describe("Members › Invitation link", () => {
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
    expect(invite.textContent).toContain("Quem você convida por e-mail entra direto.");
    expect((within(invite).getByLabelText("Link de convite") as HTMLInputElement).value).toBe(
      "http://localhost:3000/invite/k3J",
    );
    expect(invite.textContent).toMatch(
      /Quem tiver o link pode pedir para entrar, e um admin aprova cada pessoa · vale até \S+/,
    );
    expect(invite.textContent).toMatch(/Link anterior · criado .+ por João · vale até /);

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

test("the admins' notice: who asks, a Members chip, and it opens Members", async () => {
  const state = seedState({
    notifications: [
      notification({
        id: "n-join",
        kind: "join_request",
        waiting: true,
        count: 2,
        source: { label: "Acme" },
        latest: { title: "Bruno Lima" },
      }),
    ],
  });
  const { router } = await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
  await settle(6);
  const notice = document.querySelector('[data-n="n-join"]') as HTMLElement;
  expect(notice.getAttribute("aria-label")).toBe("Bruno Lima e outras pessoas pedem para entrar");
  expect(notice.textContent).toContain("Bruno Lima e outras pessoas pedem para entrar");
  expect(notice.querySelector(".ac-chip")?.textContent).toBe("Membros");
  await click(within(notice).getByRole("button", { name: "Abrir" }));
  await settle(6);
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/members`);
});
