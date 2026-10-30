import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type ImportInput, type InvitationPreview, type SignInOptions } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeMachinesOf, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { installTurnstile, removeTurnstile } from "./fake-turnstile";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const type = (label: string, value: string) =>
  act(async () => fireEvent.change(screen().getByLabelText(label), { target: { value } }));

/** A fake API whose sign-in screen answers `options` for any e-mail (and "forgot password" when `reset`). */
const authApi = (options: SignInOptions, { reset = false, state = seedState({ me: null }) } = {}) => {
  const api = createFakeApi(state);
  api.account.signInOptions = async (input) => {
    state.calls.push({ method: "account.signInOptions", args: [input] });
    return options;
  };
  const config = api.account.authConfig;
  api.account.authConfig = async () => ({ ...(await config()), passwordReset: reset });
  return { api, state };
};
const press = async (name: string | RegExp, rounds = 6) => {
  await act(async () => fireEvent.click(screen().getByRole("button", { name })));
  await settle(rounds);
};
const heading = () => screen().getByRole("heading").textContent;
/** The line under the question, or null where the step has none. */
const lead = () => document.querySelector(".auth__lead")?.textContent ?? null;
const ACCOUNT: SignInOptions = { account: true, password: true, providers: [], canSignUp: false };
const NEW: SignInOptions = { account: false, password: false, providers: [], canSignUp: true };

describe("Entrar (e-mail primeiro)", () => {
  test("the e-mail has a password: a wrong one frowns and offers a link; the right one enters", async () => {
    const state = seedState({ me: null });
    const signedIn = seedState().me;
    let tries = 0;
    const { auth, calls } = createFakeAuth({ onSignIn: () => (state.me = signedIn) });
    const signIn = auth.signIn;
    auth.signIn = async (input) => {
      if (++tries > 1) return signIn(input);
      calls.push({ method: "signIn", args: [input] });
      return { ok: false, status: 401, message: "Invalid" };
    };
    const { api } = authApi(ACCOUNT, { reset: true, state });
    const { router } = await renderApp(`/login?redirect=/org/${ORG_ID}/drive`, { api, auth });
    expect(heading()).toBe("Oi. Qual é o seu e-mail?");
    // auth-config of the fake: GitHub only.
    expect(screen().queryByRole("button", { name: /Continuar com Google/ })).toBeNull();
    expect(screen().getByRole("button", { name: /Continuar com GitHub/ })).toBeTruthy();
    expect(
      screen()
        .getByRole("button", { name: /^Continuar(?! com)/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    await type("E-mail", "marina@acme.com.br");
    await press(/^Continuar(?! com)/);
    expect(state.calls.find((c) => c.method === "account.signInOptions")?.args).toEqual([
      { email: "marina@acme.com.br" },
    ]);
    expect(heading()).toBe("Bom te ver de novo.");
    expect(screen().getByText("marina@acme.com.br")).toBeTruthy();

    await type("Senha", "senha-errada");
    await press(/^Entrar/);
    expect(heading()).toBe("Hmm, essa senha não bateu.");
    // The field, Entrar and "Esqueci a senha" sit right under it: no line between.
    expect(lead()).toBeNull();
    expect(screen().getByLabelText("Senha").getAttribute("aria-invalid")).toBe("true");
    expect(screen().getByRole("button", { name: "Esqueci a senha" })).toBeTruthy();

    await type("Senha", "correct horse");
    await press(/^Entrar/);
    expect(calls.filter((c) => c.method === "signIn").map((c) => c.args[0])).toEqual([
      { email: "marina@acme.com.br", password: "senha-errada" },
      { email: "marina@acme.com.br", password: "correct horse" },
    ]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/drive`);
  });

  test("signed in from an email's deep link: back on that page, its query and all", async () => {
    const state = seedState({ me: null });
    const signedIn = seedState().me;
    const { auth } = createFakeAuth({ onSignIn: () => (state.me = signedIn) });
    const { api } = authApi(ACCOUNT, { state });
    const target = `/org/${ORG_ID}/agents/${ADA_ID}?tab=settings&sec=budget`;
    const { router } = await renderApp(`/login?redirect=${encodeURIComponent(target)}`, { api, auth });
    await type("E-mail", "marina@acme.com.br");
    await press(/^Continuar(?! com)/);
    await type("Senha", "correct horse");
    await press(/^Entrar/);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${ADA_ID}`);
    expect(router.state.location.search).toEqual({ tab: "settings", sec: "budget" });
  });

  test("signed in from the ready email's Connect your AI: #general with Connect an AI open, the computer ready", async () => {
    const state = seedState({
      me: null,
      aiStatus: { any: false, agents: [{ agentId: ADA_ID, state: "no_ai" } as const] },
    });
    for (const a of state.agents) if (a.id === ADA_ID) a.ownerUserId = "u-walter";
    const signedIn = seedState().me;
    const { auth } = createFakeAuth({ onSignIn: () => (state.me = signedIn) });
    const { api } = authApi(ACCOUNT, { state });
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "machine_1" });
    const brain = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({ ...(await brain(orgId, agentId)), ownSignIn: false });
    const { router } = await renderApp(`/login?redirect=${encodeURIComponent(`/org/${ORG_ID}?connect=ai`)}`, {
      api,
      auth,
    });
    await type("E-mail", "marina@acme.com.br");
    await press(/^Continuar(?! com)/);
    await type("Senha", "correct horse");
    await press(/^Entrar/, 10);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    expect(router.state.location.search).toEqual({});
    const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("O computador está pronto.");
  });

  test("an account without a password: only the provider it signs in with", async () => {
    const { api } = authApi({ account: true, password: false, providers: ["github"], canSignUp: false });
    const { auth, calls } = createFakeAuth();
    await renderApp("/login", { api, auth });
    await type("E-mail", "marina@acme.com.br");
    await press(/^Continuar(?! com)/);
    expect(heading()).toBe("Você entra com GitHub.");
    expect(screen().queryByLabelText("Senha")).toBeNull();
    await press(/Continuar com GitHub/);
    expect(calls[0]).toEqual({ method: "signInSocial", args: ["github", "/"] });
  });

  test("a misspelled webmail domain gets a one-click fix", async () => {
    const { api } = authApi(ACCOUNT);
    await renderApp("/login", { api, auth: createFakeAuth().auth });
    await type("E-mail", "marina@gmial.com");
    await press("Você quis dizer marina@gmail.com?", 1);
    expect((screen().getByLabelText("E-mail") as HTMLInputElement).value).toBe("marina@gmail.com");
  });

  test("forgot password: sends the link in place and opens the webmail", async () => {
    const { api } = authApi(ACCOUNT, { reset: true });
    const { auth, calls } = createFakeAuth();
    await renderApp("/login", { api, auth });
    await type("E-mail", "marina@gmail.com");
    await press(/^Continuar(?! com)/);
    await press("Esqueci a senha", 2);
    expect(heading()).toBe("Te mando um link para criar outra senha.");
    await press(/^Enviar link/);
    expect(calls[0]?.method).toBe("requestPasswordReset");
    expect((calls[0]?.args[0] as { email: string } | undefined)?.email).toBe("marina@gmail.com");
    expect(heading()).toBe("Pronto. Mandei o link para marina@gmail.com.");
    expect(lead()).toBe("Não chegou em 1 minuto? Veja o spam.");
    expect(screen().getByRole("link", { name: "Abrir o Gmail" }).getAttribute("href")).toBe("https://mail.google.com");
  });

  test("without e-mail on the server, no 'forgot password'", async () => {
    const { api } = authApi(ACCOUNT, { reset: false });
    await renderApp("/login", { api, auth: createFakeAuth().auth });
    await type("E-mail", "marina@acme.com.br");
    await press(/^Continuar(?! com)/);
    expect(screen().queryByRole("button", { name: "Esqueci a senha" })).toBeNull();
  });

  test("a blocked account is told so; another refusal keeps the server's words", async () => {
    for (const [signIn, says] of [
      [
        { ok: false, status: 403, message: "This account can't sign in.", code: "ACCOUNT_BLOCKED" },
        "Esta conta não pode entrar.",
      ],
      [{ ok: false, status: 403, message: "Invalid origin" }, "Invalid origin"],
    ] as const) {
      const { api } = authApi(ACCOUNT);
      await renderApp("/login", { api, auth: createFakeAuth({ signIn }).auth });
      await type("E-mail", "marina@acme.com.br");
      await press(/^Continuar(?! com)/);
      await type("Senha", "correct horse");
      await press(/^Entrar/);
      expect(screen().getByRole("alert").textContent).toContain(says);
      cleanup();
    }
  });

  test("on agentes.chat Cloud a blocked account reads why by the block's kind, and how to contest it", async () => {
    const contest = "Para contestar, escreva para legal@agentes.chat.";
    for (const [block, says] of [
      [
        { kind: "abuse", cloud: true },
        `Esta conta está bloqueada. As nossas verificações a ligaram a uma conta encerrada por abuso (Termos, seção 5). ${contest}`,
      ],
      [
        { kind: "legal", cloud: true },
        "Esta conta está bloqueada enquanto guardamos os dados dela por uma questão legal. Para perguntar sobre isso, escreva para legal@agentes.chat.",
      ],
      [{ kind: "other", cloud: true }, `Esta conta não pode entrar. ${contest}`],
      // A self-hosted server: the line it always had.
      [{}, "Esta conta não pode entrar."],
    ] as const) {
      const signIn = {
        ok: false as const,
        status: 403,
        message: "This account can't sign in.",
        code: "ACCOUNT_BLOCKED",
        ...block,
      };
      const { api } = authApi(ACCOUNT);
      await renderApp("/login", { api, auth: createFakeAuth({ signIn }).auth });
      await type("E-mail", "marina@acme.com.br");
      await press(/^Continuar(?! com)/);
      await type("Senha", "correct horse");
      await press(/^Entrar/);
      expect(screen().getByRole("alert").textContent).toBe(says);
      cleanup();
    }
  });
});

describe("Entrar a caminho de algum lugar: a página diz para onde", () => {
  const LINK: InvitationPreview = {
    orgName: "Acme",
    email: "",
    role: "member",
    kind: "link",
    invitedBy: null,
    agents: [],
  };
  const at = (redirect: string, email?: string) =>
    `/login?${new URLSearchParams({ redirect, ...(email ? { email } : {}) })}`;

  test("from an invitation link's Sign in: its workspace, and the address typed there already filled in", async () => {
    const { api } = authApi(ACCOUNT, { state: seedState({ me: null, previews: { lnk: LINK } }) });
    await renderApp(at("/invite/lnk"), { api, auth: createFakeAuth().auth });
    expect(heading()).toBe("Oi. Qual é o seu e-mail?");
    expect(lead()).toBe("Para pedir para entrar na Acme.");
    cleanup();

    await renderApp(at("/invite/lnk", "marina@acme.com.br"), { api, auth: createFakeAuth().auth });
    await settle(4);
    expect(heading()).toBe("Bom te ver de novo.");
    expect(lead()).toBe("Para pedir para entrar na Acme.");
    expect(screen().getByText("marina@acme.com.br")).toBeTruthy();
  });

  test("an email invitation's: to join; the ready email's Connect your AI and Create an agent: to do that", async () => {
    const { api } = authApi(ACCOUNT, { state: seedState({ me: null }) });
    await renderApp(at("/invite/valid"), { api, auth: createFakeAuth().auth });
    expect(lead()).toBe("Para entrar na Acme.");
    cleanup();

    await renderApp(at(`/org/${ORG_ID}?connect=ai`), { api, auth: createFakeAuth().auth });
    expect(heading()).toBe("Oi. Qual é o seu e-mail?");
    expect(lead()).toBe("Para conectar sua IA.");
    cleanup();

    await renderApp(at(`/org/${ORG_ID}/agents/new`), { api, auth: createFakeAuth().auth });
    expect(heading()).toBe("Oi. Qual é o seu e-mail?");
    expect(lead()).toBe("Para criar um agente.");
  });

  test("a link that no longer works, an unknown one, or anywhere else: the general line", async () => {
    const { api } = authApi(ACCOUNT, {
      state: seedState({ me: null, previews: { off: { ...LINK, closed: true } } }),
    });
    // The ready email's button to the workspace itself included: it leads nowhere in particular.
    for (const redirect of ["/invite/off", "/invite/nope", `/org/${ORG_ID}/drive`, `/org/${ORG_ID}`]) {
      await renderApp(at(redirect), { api, auth: createFakeAuth().auth });
      expect(lead()).toBe("Vale para entrar ou para criar uma conta.");
      cleanup();
    }
  });
});

describe("Criar conta (e-mail novo)", () => {
  test("name, then a password with live help; creating the account goes to onboarding", async () => {
    const { api } = authApi(NEW);
    const { auth, calls } = createFakeAuth();
    const { router } = await renderApp("/signup", { api, auth });
    expect(heading()).toBe("Vamos criar sua conta. Qual é o seu e-mail de trabalho?");
    expect(lead()).toBeNull();
    await type("E-mail", "walter@acme.com.br");
    await press(/^Continuar(?! com)/);
    expect(heading()).toBe("Prazer. Esse e-mail é novo por aqui.");
    await type("Seu nome", "Walter Souza");
    await press(/^Continuar(?! com)/, 2);
    expect(heading()).toBe("Boa, Walter. Agora uma senha.");
    // What a password needs is said once, under the field, and turns into the count as it's typed.
    expect(lead()).toBeNull();
    expect(screen().getByText("Pelo menos 8 caracteres.")).toBeTruthy();
    await type("Crie uma senha", "curta");
    expect(screen().getByText("Faltam 3 caracteres (mínimo de 8).")).toBeTruthy();
    expect(
      screen()
        .getByRole("button", { name: /Criar conta/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    await type("Crie uma senha", "senha-longa");
    expect(screen().getByText("Senha ok.")).toBeTruthy();
    await press(/Criar conta/);
    expect(calls[0]?.args[0]).toEqual({ name: "Walter Souza", email: "walter@acme.com.br", password: "senha-longa" });
    // This server sends no email, so no confirmation link went anywhere.
    expect(sessionStorage.getItem("agentes.confirmation.sent")).toBeNull();
    // Signed out in the fake, so onboarding sends back to sign-in.
    expect(router.state.location.pathname).toBe("/login");
  });

  test("a server that emails: the onboarding learns where the confirmation went; the name isn't spell-checked", async () => {
    const { api } = authApi(NEW, { reset: true });
    const { auth } = createFakeAuth();
    await renderApp("/signup", { api, auth });
    await type("E-mail", "Walter@Acme.com.br");
    await press(/^Continuar(?! com)/);
    expect(screen().getByLabelText("Seu nome").getAttribute("spellcheck")).toBe("false");
    await type("Seu nome", "Walter Souza");
    await press(/^Continuar(?! com)/, 2);
    await type("Crie uma senha", "senha-longa");
    try {
      await press(/Criar conta/);
      expect(sessionStorage.getItem("agentes.confirmation.sent")).toBe("walter@acme.com.br");
    } finally {
      sessionStorage.clear();
    }
  });

  test("sign-up closed for that e-mail: says so and offers another e-mail", async () => {
    const { api } = authApi({ ...NEW, canSignUp: false });
    await renderApp("/login", { api, auth: createFakeAuth().auth });
    await type("E-mail", "stranger@acme.com.br");
    await press(/^Continuar(?! com)/);
    expect(heading()).toBe("Esse e-mail ainda não tem conta.");
    await press("Usar outro e-mail", 2);
    expect(heading()).toBe("Oi. Qual é o seu e-mail?");
  });

  test("the terms line shows only when the server has both links, and links to them", async () => {
    const terms = "https://example.com/terms";
    await renderApp("/signup", { api: createFakeApi(seedState({ me: null, authConfig: { termsUrl: terms } })) });
    expect(screen().queryByText(/Ao continuar/)).toBeNull();
    cleanup();
    const both = { termsUrl: terms, privacyUrl: "https://example.com/privacy" };
    await renderApp("/signup", { api: createFakeApi(seedState({ me: null, authConfig: both })) });
    expect(screen().getByRole("link", { name: "Termos" }).getAttribute("href")).toBe(terms);
    expect(screen().getByRole("link", { name: "Política de privacidade" }).getAttribute("href")).toBe(
      "https://example.com/privacy",
    );
  });
});

describe("Acesso antecipado (o link do convite)", () => {
  const ACCESS = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v";
  const lookups = (state: ReturnType<typeof seedState>) =>
    state.calls.filter((c) => c.method === "account.signInOptions").map((c) => c.args[0]);

  test("the address filled in and looked up with the link's token; the sign-up and a provider carry it", async () => {
    const { api, state } = authApi(NEW);
    const { auth, calls } = createFakeAuth();
    await renderApp(`/signup?email=ana%40acme.com&access=${ACCESS}`, { api, auth });
    await settle(6);
    expect(lookups(state)).toEqual([{ email: "ana@acme.com", access: ACCESS }]);
    expect(heading()).toBe("Prazer. Esse e-mail é novo por aqui.");
    await type("Seu nome", "Ana Lima");
    await press(/^Continuar(?! com)/, 2);
    await type("Crie uma senha", "senha-longa");
    await press(/Criar conta/);
    expect(calls[0]?.args[0]).toEqual({
      name: "Ana Lima",
      email: "ana@acme.com",
      password: "senha-longa",
      access: ACCESS,
    });
  });

  test("a provider's sign-up from the link carries its token too", async () => {
    const { api } = authApi(NEW);
    const { auth, calls } = createFakeAuth();
    await renderApp(`/signup?email=ana%40acme.com&access=${ACCESS}`, { api, auth });
    await settle(6);
    await press("Trocar", 2);
    await press(/Continuar com GitHub/);
    expect(calls.at(-1)).toEqual({ method: "signInSocial", args: ["github", "/", ACCESS] });
  });

  test("a token in any other shape is dropped", async () => {
    const { api, state } = authApi(NEW);
    const { auth, calls } = createFakeAuth();
    await renderApp("/signup?email=ana%40acme.com&access=short", { api, auth });
    await settle(6);
    expect(lookups(state)).toEqual([{ email: "ana@acme.com" }]);
    await press("Trocar", 2);
    await press(/Continuar com GitHub/);
    expect(calls.at(-1)).toEqual({ method: "signInSocial", args: ["github", "/"] });
  });

  test("a link for another address says so in place, never as a closed sign-up", async () => {
    const { api } = authApi(NEW);
    const { auth } = createFakeAuth({
      signUp: {
        ok: false,
        status: 403,
        code: "EARLY_ACCESS_OTHER_EMAIL",
        message: "This invitation is for another address. Sign up with the address it was sent to.",
      },
    });
    await renderApp(`/signup?email=bia%40acme.com&access=${ACCESS}`, { api, auth });
    await settle(6);
    await type("Seu nome", "Bia");
    await press(/^Continuar(?! com)/, 2);
    await type("Crie uma senha", "senha-longa");
    await press(/Criar conta/);
    expect(heading()).toBe("Boa, Bia. Agora uma senha.");
    expect(screen().getByRole("alert").textContent).toBe(
      "Este convite é para outro endereço. Cadastre-se com o endereço que recebeu o convite.",
    );
  });

  test("an expired link: says so, and where to ask for a new one", async () => {
    for (const [supportEmail, says] of [
      ["suporte@agentes.chat", "Peça um novo em suporte@agentes.chat."],
      [null, "Peça um novo a quem convidou você."],
    ] as const) {
      const { api } = authApi({ ...NEW, canSignUp: false, accessExpired: true });
      const config = api.account.authConfig;
      api.account.authConfig = async () => ({ ...(await config()), supportEmail });
      await renderApp(`/signup?email=ana%40acme.com&access=${ACCESS}`, { api, auth: createFakeAuth().auth });
      await settle(6);
      expect([heading(), lead()]).toEqual(["Este convite expirou.", says]);
      expect(screen().getByRole("button", { name: "Usar outro e-mail" })).toBeTruthy();
      cleanup();
    }
  });

  test("a provider's sign-up refused comes back with its reason, in the person's words; other codes say nothing", async () => {
    const { api } = authApi(NEW);
    await renderApp("/login?error=EARLY_ACCESS_EMAIL_UNVERIFIED&error_description=x", {
      api,
      auth: createFakeAuth().auth,
    });
    expect(screen().getByRole("alert").textContent).toBe(
      "Seu provedor de login não confirmou este endereço. Confirme lá, ou cadastre-se com uma senha.",
    );
    cleanup();
    await renderApp("/login?error=SIGNUP_CLOSED&error_description=x", { api, auth: createFakeAuth().auth });
    expect(screen().getByRole("alert").textContent).toBe(
      "O cadastro está fechado. Peça um convite a quem administra a sua organização.",
    );
    cleanup();
    await renderApp("/login?error=state_mismatch", { api, auth: createFakeAuth().auth });
    expect(screen().queryByRole("alert")).toBeNull();
  });
});

describe("Senha nova (link do e-mail)", () => {
  test("saves the new password with the link's token", async () => {
    const { auth, calls } = createFakeAuth();
    await renderApp("/reset-password?token=tok-1", { api: createFakeApi(seedState({ me: null })), auth });
    expect(heading()).toBe("Crie uma senha nova.");
    expect(lead()).toBeNull();
    expect(screen().getByText("Pelo menos 8 caracteres.")).toBeTruthy();
    await type("Crie uma senha nova.", "senha-nova-1");
    await press(/Salvar senha/);
    expect(calls[0]).toEqual({ method: "resetPassword", args: [{ token: "tok-1", newPassword: "senha-nova-1" }] });
    expect(heading()).toBe("Senha nova salva.");
    expect(lead()).toBe("Saímos das suas outras sessões.");
  });

  test("an expired link (no token) asks for another", async () => {
    await renderApp("/reset-password?error=INVALID_TOKEN", {
      api: createFakeApi(seedState({ me: null })),
      auth: createFakeAuth().auth,
    });
    expect(heading()).toBe("Esse link expirou.");
    expect(lead()).toBe("Os links valem por 1 hora.");
    expect(screen().getByRole("link", { name: "Pedir outro link" }).getAttribute("href")).toBe("/login");
  });
});

describe("Aceitar convite", () => {
  test("valid invitation: email is fixed; sign up then accept and enter the org", async () => {
    const state = seedState({ me: null });
    const { auth, calls } = createFakeAuth();
    const api = createFakeApi(state);
    await renderApp("/invite/valid", { api, auth });
    expect(screen().getByRole("heading", { name: "Você foi convidado para a Acme" })).toBeTruthy();
    expect(screen().getByText("membro").tagName).toBe("B");
    const email = screen().getByLabelText("E-mail") as HTMLInputElement;
    expect(email.value).toBe("marina@acme.com.br");
    expect(email.readOnly).toBe(true);
    // Why it can't change is behind its ⓘ; the password keeps what it needs under the field.
    expect(email.getAttribute("aria-describedby")).toBe("inv-email-hint");
    expect(document.getElementById("inv-email-hint")?.textContent).toBe("O convite vale só para este e-mail.");
    expect(screen().getByRole("button", { name: "Sobre E-mail" })).toBeTruthy();
    expect([...document.querySelectorAll(".ac-field__help")].map((h) => h.textContent)).toEqual([
      "Pelo menos 8 caracteres.",
    ]);
    const accept = screen().getByRole("button", { name: "Aceitar e entrar na Acme" });
    expect(accept.hasAttribute("disabled")).toBe(true);
    await type("Seu nome", "Marina");
    await type("Crie uma senha", "senha-exemplo");
    await act(async () => fireEvent.click(accept));
    await settle(6);
    expect(calls[0]?.args[0]).toEqual({ name: "Marina", email: "marina@acme.com.br", password: "senha-exemplo" });
    expect(state.calls.find((c) => c.method === "orgs.acceptInvitation")?.args).toEqual(["valid"]);
  });

  test("expired invitation offers to ask for a new one", async () => {
    await renderApp("/invite/expired", { api: createFakeApi(seedState({ me: null })) });
    expect(screen().getByRole("heading", { name: "Este convite expirou" })).toBeTruthy();
    expect(document.querySelector(".page-sub")?.textContent).toBe("Convites valem por 7 dias.");
    const ask = screen().getByRole("button", { name: "Pedir um novo convite" });
    await act(async () => fireEvent.click(ask));
    await settle();
    expect(screen().getByRole("button", { name: "Pedido enviado" }).hasAttribute("disabled")).toBe(true);
  });

  test("expired, on a server that sends no email: whom to ask, and no button for a request nobody would get", async () => {
    const state = seedState({ me: null, authConfig: { passwordReset: false } });
    await renderApp("/invite/expired", { api: createFakeApi(state) });
    expect(screen().getByRole("heading", { name: "Este convite expirou" })).toBeTruthy();
    expect(document.querySelector(".page-sub")?.textContent).toBe(
      "Convites valem por 7 dias. Peça um novo a quem mandou.",
    );
    expect(screen().queryByRole("button", { name: "Pedir um novo convite" })).toBeNull();
    expect(state.calls.some((c) => c.method === "invites.requestNew")).toBe(false);
  });

  test("signed in with another email: explains and offers to sign out", async () => {
    await renderApp("/invite/valid", { api: createFakeApi() });
    expect(screen().getByRole("status").textContent).toContain("Este convite foi enviado para marina@acme.com.br");
    expect(screen().getByRole("button", { name: "Sair" })).toBeTruthy();
  });
});

describe("A verificação contra robôs (agentes.chat Cloud)", () => {
  const SITE_KEY = "1x00000000000000000000BB";
  afterEach(removeTurnstile);

  /** A fake API with the bot check on, and the sign-in options' calls recorded with their token. */
  const checkedApi = (options: SignInOptions, refuse?: ApiError) => {
    const state = seedState({ me: null, authConfig: { turnstileSiteKey: SITE_KEY, passwordReset: true } });
    const api = createFakeApi(state);
    api.account.signInOptions = async (input, humanCheck) => {
      state.calls.push({ method: "account.signInOptions", args: [input, humanCheck] });
      if (refuse) throw refuse;
      return options;
    };
    return { api, state };
  };
  const lookups = (state: { calls: { method: string; args: unknown[] }[] }) =>
    state.calls.filter((c) => c.method === "account.signInOptions").map((c) => c.args);

  test("no site key: nothing loads from Cloudflare, and calls go without a token", async () => {
    installTurnstile();
    const { api, state } = authApi(NEW);
    const { auth, calls } = createFakeAuth();
    await renderApp("/signup", { api, auth });
    await type("E-mail", "walter@acme.com.br");
    await press(/^Continuar(?! com)/);
    await type("Seu nome", "Walter");
    await press(/^Continuar(?! com)/, 2);
    await type("Crie uma senha", "senha-longa");
    await press(/Criar conta/);
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    expect(document.querySelector(".human-check")).toBeNull();
    expect(lookups(state)).toEqual([[{ email: "walter@acme.com.br" }]]);
    expect(calls.find((c) => c.method === "signUp")?.args.length).toBe(1);
  });

  test("with a site key: Cloudflare's script once, a widget per step for its action, its token on each call, then a fresh one", async () => {
    const cf = installTurnstile();
    const { api, state } = checkedApi(ACCOUNT);
    const { auth, calls } = createFakeAuth({ signIn: { ok: false, status: 401, message: "Invalid" } });
    await renderApp("/login", { api, auth });
    await settle();
    expect(cf.scripts().map((s) => s.getAttribute("src"))).toEqual([
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    ]);
    expect(cf.widgets[0]?.options).toMatchObject({
      sitekey: SITE_KEY,
      action: "email-lookup",
      appearance: "interaction-only",
      size: "flexible",
      language: "pt-br",
      "refresh-expired": "auto",
      "response-field": false,
    });

    await type("E-mail", "marina@acme.com.br");
    await press(/^Continuar(?! com)/);
    expect(lookups(state)).toEqual([[{ email: "marina@acme.com.br" }, "w1-1"]]);
    // A token passes one check: the widget was reset. The password step has its own, for signing in.
    expect(cf.resets).toEqual(["w1"]);
    expect(cf.widgets.map((w) => [w.options.action, w.removed])).toEqual([
      ["email-lookup", true],
      ["sign-in", false],
    ]);
    await type("Senha", "senha-errada");
    await press(/^Entrar/);
    expect(calls.at(-1)?.args).toEqual([{ email: "marina@acme.com.br", password: "senha-errada" }, "w2-1"]);
    expect(cf.resets).toEqual(["w1", "w2"]);
    await type("Senha", "senha-certa");
    await press(/^Entrar/);
    expect(calls.at(-1)?.args[1]).toBe("w2-2");
    // Still one script for the whole page.
    expect(cf.scripts().length).toBe(1);
  });

  test("the script doesn't load (a blocker): the call says so, and the server's refusal reads plainly", async () => {
    installTurnstile({ loads: false });
    const blocked = new ApiError(
      403,
      "human_check_blocked",
      "The bot check didn't load. Try another browser or network.",
    );
    const { api, state } = checkedApi(ACCOUNT, blocked);
    await renderApp("/login", { api, auth: createFakeAuth().auth });
    await type("E-mail", "marina@acme.com.br");
    await press(/^Continuar(?! com)/);
    // Sent once: another try can't load the check either.
    expect(lookups(state)).toEqual([[{ email: "marina@acme.com.br" }, "unavailable"]]);
    expect(screen().getByRole("alert").textContent).toContain(
      "A verificação não carregou. Tente outro navegador ou outra rede.",
    );
    expect(heading()).toBe("Oi. Qual é o seu e-mail?");
  });

  test("sign-up refused by the check: tried once more with a fresh token, then said plainly, never as a closed sign-up", async () => {
    const cf = installTurnstile();
    const { api } = checkedApi(NEW);
    const { auth, calls } = createFakeAuth({
      signUp: { ok: false, status: 403, code: "human_check", message: "Couldn't confirm a person is asking." },
    });
    await renderApp("/signup", { api, auth });
    await type("E-mail", "walter@acme.com.br");
    await press(/^Continuar(?! com)/);
    await type("Seu nome", "Walter");
    await press(/^Continuar(?! com)/, 2);
    await type("Crie uma senha", "senha-longa");
    await press(/Criar conta/);
    expect(calls.filter((c) => c.method === "signUp").map((c) => c.args[1])).toEqual(["w2-1", "w2-2"]);
    expect(screen().getByRole("alert").textContent).toContain(
      "Não conseguimos confirmar que você é uma pessoa. Tente de novo.",
    );
    expect(heading()).toBe("Boa, Walter. Agora uma senha.");
    expect(cf.widgets.at(-1)?.options.action).toBe("sign-up");
  });

  test("too many tries reads in the person's words, not the server's", async () => {
    installTurnstile();
    const { api } = checkedApi(NEW);
    const { auth } = createFakeAuth({ signUp: { ok: false, status: 429, message: "Too many requests" } });
    await renderApp("/signup", { api, auth });
    await type("E-mail", "walter@acme.com.br");
    await press(/^Continuar(?! com)/);
    await type("Seu nome", "Walter");
    await press(/^Continuar(?! com)/, 2);
    await type("Crie uma senha", "senha-longa");
    await press(/Criar conta/);
    expect(screen().getByRole("alert").textContent).toContain(
      "Muitas tentativas. Espere alguns minutos e tente de novo.",
    );
  });

  test("an email invitation's sign-up, and an invitation link's code, carry the token", async () => {
    installTurnstile();
    const state = seedState({ me: null, authConfig: { turnstileSiteKey: SITE_KEY, passwordReset: true } });
    const { auth, calls } = createFakeAuth();
    await renderApp("/invite/valid", { api: createFakeApi(state), auth });
    await settle();
    expect(document.querySelector(".invite-card .human-check")).toBeTruthy();
    await type("Seu nome", "Marina");
    await type("Crie uma senha", "senha-exemplo");
    await press("Aceitar e entrar na Acme");
    expect(calls.find((c) => c.method === "signUp")?.args[1]).toBe("w1-1");
    cleanup();
    removeTurnstile();

    const cf = installTurnstile();
    state.previews = { lnk: { orgName: "Acme", email: "", role: "member", kind: "link", invitedBy: "Marina" } };
    await renderApp("/invite/lnk", { api: createFakeApi(state) });
    await settle();
    await type("Seu e-mail", "walter@acme.com.br");
    await press("Verificar");
    expect(state.calls.find((c) => c.method === "invites.sendCode")?.args).toEqual([
      "lnk",
      { email: "walter@acme.com.br" },
      "w1-1",
    ]);
    expect(cf.widgets.map((w) => w.options.action)).toEqual(["ask-code"]);
  });

  test("an email invitation's sign-up is busy while the check waits for its token: a second press signs up nobody", async () => {
    const cf = installTurnstile({ gives: false });
    const state = seedState({ me: null, authConfig: { turnstileSiteKey: SITE_KEY, passwordReset: true } });
    const { auth, calls } = createFakeAuth();
    await renderApp("/invite/valid", { api: createFakeApi(state), auth });
    await settle();
    await type("Seu nome", "Marina");
    await type("Crie uma senha", "senha-exemplo");
    await press("Aceitar e entrar na Acme");
    const accept = screen().getByRole("button", { name: "Aceitar e entrar na Acme" });
    expect(accept.getAttribute("aria-busy")).toBe("true");
    expect(accept.hasAttribute("disabled")).toBe(true);
    // A submit that reaches the form anyway, as Enter would.
    await act(async () => fireEvent.submit(accept.closest("form") as HTMLFormElement));
    expect(calls.filter((c) => c.method === "signUp")).toEqual([]);

    cf.give("w1");
    await settle(6);
    expect(calls.filter((c) => c.method === "signUp").map((c) => c.args[1])).toEqual(["w1-1"]);
    expect(state.calls.filter((c) => c.method === "orgs.acceptInvitation").length).toBe(1);
  });
});

describe("Onboarding", () => {
  /** `claudeSignedIn`: each computer the person connects has Claude Code signed in there (its own sign-in). */
  const start = async (patch: Partial<ReturnType<typeof seedState>> = {}, { claudeSignedIn = true } = {}) => {
    const state = seedState(patch);
    if (state.me) state.me.organizations = [];
    // A server where people connect their own computers says so before any workspace exists.
    state.authConfig = { workspaceComputer: false, ...patch.authConfig };
    const api = createFakeApi(state);
    // Each agent's view as the server makes it: the computer it was given (none until then), and that computer's
    // own sign-in where whoever connected it owns the agent (this server's own computer has nobody).
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => {
      const target = state.calls.filter((c) => c.method === "sandbox.setTarget" && c.args[1] === agentId).at(-1);
      const machine = target ? fakeMachinesOf.get(api)?.peek(String(target.args[2])) : undefined;
      return {
        ...(await viewOf(orgId, agentId)),
        computer: machine ? { machineId: machine.id, name: machine.name, online: machine.online } : null,
        machines: [],
        ownSignIn: machine !== undefined && machine.kind !== "host",
      };
    };
    // Each computer's row as the server makes it: its own Claude Code sign-in, where it is signed in there.
    api.machines.aiAccounts = async () => ({
      accounts: [],
      computers: (fakeMachinesOf.get(api)?.all() ?? []).map((m) => ({
        machineId: m.id,
        name: m.name,
        online: m.online,
        mine: m.kind !== "host",
        canAdd: true,
        keys: true,
        brains: { claude_code: true, codex: true },
        own: claudeSignedIn && m.kind !== "host" ? { claude_code: {} } : {},
      })),
    });
    const r = await renderApp("/onboarding", { api });
    return { ...r, api, state };
  };
  const button = (name: string | RegExp) => screen().getByRole("button", { name });
  const click = async (el: HTMLElement, rounds = 4) => {
    await act(async () => fireEvent.click(el));
    await settle(rounds);
  };
  const next = () => click(button("Continuar"), 6);
  const skip = () => click(button("Pular esta etapa"), 6);
  const calls = (state: ReturnType<typeof seedState>, method: string) => state.calls.filter((c) => c.method === method);
  /** Leaves only these presets picked besides Ada (the guide, always on the team). */
  const keepOnly = async (...keep: string[]) => {
    for (const name of ["Theo · PM", "Lia · Pesquisa", "Atlas · Ops"]) {
      const card = button(new RegExp(name));
      if ((card.getAttribute("aria-pressed") === "true") !== keep.includes(name)) await click(card, 1);
    }
  };

  const progress = () => document.querySelector(".onb__progress")?.textContent;
  const railStep = (name: RegExp) =>
    within(screen().getByRole("navigation", { name: "Passos para começar" })).getByRole("button", { name });

  /** Workspace → Contexto, up to the import step. */
  const throughContext = async (state: ReturnType<typeof seedState>) => {
    // How many are left, said once.
    expect(progress()).toBe("Faltam 6 etapas");
    expect(screen().getByRole("heading", { name: "Como se chama o seu workspace?" })).toBeTruthy();
    // The host introduces itself the first time it asks.
    expect(document.body.textContent).toContain("Oi, eu sou a Ada. Vou montar tudo com você.");
    // People connect their own computer here: a choice from the first step on.
    expect(railStep(/^Trazer seus agentes/).textContent).toContain("opcional");
    expect(railStep(/^Computador/).textContent).toContain("opcional");
    // A name is no misspelling.
    expect(screen().getByLabelText("Nome").getAttribute("spellcheck")).toBe("false");
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    await type("Nome", "Acme Saúde");
    await next();
    expect(railStep(/^Computador/).textContent).toContain("opcional");
    // The workspace exists after step 1 (so the logo can be sent); the time zone goes to its settings.
    expect(calls(state, "orgs.create")[0]?.args[0]).toEqual({ name: "Acme Saúde" });
    const zone = calls(state, "orgs.updateSettings")[0]?.args[1] as { timezone?: unknown };
    expect(typeof zone.timezone).toBe("string");

    expect(screen().getByRole("heading", { name: "O que a empresa faz?" })).toBeTruthy();
    await type("Contexto", "A Acme Saúde faz um app para clínicas.");
    await next();
    expect(calls(state, "orgs.updateSettings")[1]?.args[1]).toEqual({
      context: "A Acme Saúde faz um app para clínicas.",
    });
    expect(screen().getByRole("heading", { name: "Já usa agentes em outro app?" })).toBeTruthy();
    expect(screen().getByText("Faltam 4 etapas")).toBeTruthy();
    // Continue waits for a read file or link; not using another app is "Pular esta etapa".
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
  };

  /** Workspace → Contexto → (import skipped) → Computador, before the agents. */
  const throughImport = async (state: ReturnType<typeof seedState>) => {
    await throughContext(state);
    await skip();
    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
    expect(screen().getByText("Faltam 3 etapas")).toBeTruthy();
  };

  /** The AI step's picker, and one of its options. */
  const picker = () => screen().getByRole("group", { name: "Qual IA eles vão usar?" });
  const option = (name: RegExp) => within(picker()).getByRole("button", { name });

  /** … → (no computer) → Agentes (Ada and Theo, made as the team is kept), then the API key, saved. */
  const throughAgents = async (state: ReturnType<typeof seedState>) => {
    await throughImport(state);
    await skip();

    expect(screen().getByRole("heading", { name: "Fica com esse time?" })).toBeTruthy();
    // Ada is already on the team (her lead says so): no card to leave her out. The others start picked.
    expect(document.querySelector(".onb__lead")?.textContent).toBe("Eu já estou no time: desmarque quem não quiser.");
    expect(screen().queryByRole("button", { name: /Ada · Dev/ })).toBeNull();
    expect(button(/Theo · PM/).textContent).toContain("Organiza tarefas e cuida do fórum.");
    expect(button(/Lia · Pesquisa/).getAttribute("aria-pressed")).toBe("true");
    await keepOnly("Theo · PM");
    expect(button(/Lia · Pesquisa/).getAttribute("aria-pressed")).toBe("false");
    expect(button(/Atlas · Ops/).getAttribute("aria-pressed")).toBe("false");
    expect(button(/Theo · PM/).getAttribute("aria-pressed")).toBe("true");
    // The team is made as it's kept, before any AI: leaving the next screen leaves a whole team.
    await click(button(/Criar 1 agente/), 8);
    expect(calls(state, "agents.create")).toHaveLength(2);
    expect(calls(state, "agents.addCredential")).toHaveLength(0);
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    // No computer here: the API key first, and the plans (all six, dimmed) wait for one.
    expect(document.body.textContent).toContain(
      "Os agentes pensam com uma chave\u00a0de\u00a0API, ou com o seu plano de IA num computador que você conectar.",
    );
    expect(option(/^Chave de API/).getAttribute("aria-pressed")).toBe("true");
    for (const name of [/^Claude$/, /^ChatGPT$/, /^GLM Coding$/, /^Kimi Code$/, /^MiniMax$/, /^OpenCode Go$/])
      expect(option(name).querySelector(".ac-brand--off")).not.toBeNull();
    // No "Avançado": the Claude workspace ID stays in Settings' key dialog.
    expect(screen().queryByRole("button", { name: "Avançado" })).toBeNull();
    expect(document.body.textContent).not.toContain("ID do workspace");
    // Where a key is made is a button in its step, never link text.
    const keys = screen().getByRole("region", { name: "Chave de API" });
    const makers = within(keys).getByRole("group", { name: "Provedor" });
    expect(within(makers).getByRole("button", { name: "Claude" }).getAttribute("aria-pressed")).toBe("true");
    expect(keys.textContent).toContain("Crie a sua chave de API do Claude");
    const site = within(keys).getByRole("link", { name: "Abrir platform.claude.com" });
    expect(site.getAttribute("href")).toBe("https://platform.claude.com/settings/keys");
    expect(site.className).toContain("ac-btn");
    // The platform key isn't offered by this server.
    expect(within(makers).queryByRole("button", { name: "Este servidor" })).toBeNull();
    // Nothing connected yet: Continue waits; "Conectar depois" is the way on without one.
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    // Who charges the API and what happens at the limit: behind the limit's ⓘ, with nothing under the card.
    const budget = screen().getByRole("region", { name: "Limite de gasto por agente" });
    expect(budget.querySelector(".ac-card__sub, .ac-card__foot")).toBeNull();
    const limit = within(budget).getByRole("button", { name: "Sobre Limite de gasto por agente" });
    expect(document.getElementById(limit.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Vale só para o uso da API, cobrado pelo provedor da chave, não pelo agentes.chat. Quando um agente chega no limite, ele para e te avisa. Planos não contam aqui.",
    );
    expect(document.body.textContent).not.toContain("Começa no Automático");
    await type("Cole aqui", "sk-errado");
    await act(async () => fireEvent.blur(screen().getByLabelText("Cole aqui")));
    expect(document.body.textContent).toContain("As chaves de API do Claude começam com sk-ant-.");
    const save = () => button("Salvar e continuar");
    expect(save().hasAttribute("disabled")).toBe(true);
    await type("Cole aqui", "sk-ant-api03-abcdefghijklmnop");
    await click(save(), 6);
    await settle(4);
    expect(calls(state, "agents.addCredential")[0]?.args[1]).toEqual({
      provider: "anthropic",
      label: "Claude",
      apiKey: "[redacted]",
    });
    const cred = state.credentials[state.credentials.length - 1];
    expect(
      calls(state, "orgs.updateSettings").some(
        (c) => (c.args[1] as { defaultCredentialId?: string }).defaultCredentialId === cred?.id,
      ),
    ).toBe(true);
  };

  /** … → (no computer) → these join Ada, with no AI yet ("Conectar depois") → Time skipped: Done. */
  const toDone = async (state: ReturnType<typeof seedState>, ...keep: string[]) => {
    await throughImport(state);
    await skip();
    await keepOnly(...keep);
    await click(button(keep.length ? /^Criar \d+ agentes?$/ : "Continuar"), 8);
    await click(button("Conectar depois"), 8);
    await skip();
    expect(screen().getByRole("heading", { name: "Boas-vindas à Acme Saúde" })).toBeTruthy();
  };
  /** Done: the welcome's sentences, the first message's box, who offers it, and the line under it. */
  const welcome = () => document.querySelector(".onb__welcome-lead")?.textContent;
  const ASK = "Sua primeira mensagem no #general";
  const askBox = () => screen().getByRole("textbox", { name: ASK }) as HTMLTextAreaElement;
  const asker = () => document.querySelector(".onb__answer .onb__host-name")?.textContent;
  const askLine = () => document.querySelector(".onb__first-line")?.textContent ?? null;
  const agentId = (state: ReturnType<typeof seedState>, name: string) =>
    state.agents.find((a) => a.name === name)?.id ?? "";
  /** What each post of the first message sent: its text, and the `clientId` that tells a resend from a new one. */
  const posted = (state: ReturnType<typeof seedState>) =>
    calls(state, "chat.post").map((c) => c.args[2] as { body: string; clientId: string });
  const THEO_ASKS = "@theo Monte o plano da nossa primeira semana: o que cada um de nós faz primeiro?";
  /** The workspace named, then an Obsidian vault of two notes picked in Contexto; `read`: and read. */
  const pickVault = async ({ read = true } = {}) => {
    await type("Nome", "Acme Saúde");
    await next();
    const vault = screen().getByRole("region", { name: "Já tem documentação no Obsidian?" });
    await act(async () => {
      fireEvent.change(within(vault).getByLabelText("Escolher .zip ou .md"), {
        target: { files: [new File(["Veja [[Clientes]]."], "Início.md"), new File(["Lista."], "Clientes.md")] },
      });
    });
    await settle(8);
    if (!read) return;
    await act(() => new Promise((r) => setTimeout(r, 700)));
    await settle(4);
  };

  test("where new workspaces take an invitation: says so, with whom to ask, and doesn't continue", async () => {
    const seeded = seedState();
    const user = { ...(seeded.me?.user ?? { id: "u", name: "Ana", email: "ana@acme.com", image: null }) };
    const { state } = await start({
      me: { user: { ...user, canCreateWorkspace: false }, organizations: [] },
      authConfig: { supportEmail: "suporte@agentes.chat" },
    });
    expect(document.querySelector(".onb__note")?.textContent).toBe(
      "Novos workspaces precisam de convite por enquanto. Peça um em suporte@agentes.chat.",
    );
    await type("Nome", "Acme Saúde");
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    await act(async () => fireEvent.keyDown(screen().getByLabelText("Nome"), { key: "Enter" }));
    await settle(4);
    expect(calls(state, "orgs.create")).toEqual([]);
  });

  test("a workspace refused: why, with how to contest it on agentes.chat Cloud; elsewhere the plain line", async () => {
    for (const [cloud, says] of [
      [
        true,
        "Você não pode criar um workspace enquanto a sua conta ou um dos seus workspaces estiver com restrição. Para contestar, escreva para legal@agentes.chat.",
      ],
      [false, "Você não pode criar um workspace agora."],
    ] as const) {
      const { api } = await start();
      api.orgs.create = async () => {
        throw new ApiError(403, "org.create_refused", "You can't create a workspace right now", {
          ...(cloud ? { cloud } : {}),
        });
      };
      await type("Nome", "Acme Saúde");
      await next();
      expect(document.querySelector(".ac-toast")?.textContent).toContain(says);
      expect(screen().getByRole("heading", { name: "Como se chama o seu workspace?" })).toBeTruthy();
      cleanup();
    }
  });

  test("the step's actions: a bar always in view, Continue first, the text button after it, notes above it", async () => {
    sessionStorage.setItem("agentes.confirmation.sent", "walter@acme.com.br");
    await start();
    const bar = document.querySelector(".onb__actions") as HTMLElement;
    // Where the link went is the step's last line, above the bar, so the bar stays two controls tall.
    const note = screen()
      .getByText(/Mandamos um link de confirmação/)
      .closest(".onb__note") as HTMLElement;
    expect(bar.contains(note)).toBe(false);
    expect(note.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await type("Nome", "Acme Saúde");
    await next();
    await type("Contexto", "A Acme Saúde faz um app para clínicas.");
    await next();
    // An optional step: Continue, then Skip beside it, in one bar.
    const actions = [...(document.querySelector(".onb__actions") as HTMLElement).children].map((b) => b.textContent);
    expect(actions[0]).toMatch(/^Continuar/);
    expect(actions[1]).toBe("Pular esta etapa");
    // It holds the screen's bottom while the step is longer, clear of a phone's home bar, and a field being typed in
    // scrolls clear of it.
    const css = readFileSync(join(import.meta.dir, "../src/pages/onboarding.css"), "utf8");
    const rule = (selector: string, from = 0) => css.slice(css.indexOf(`${selector} {`, from)).split("}")[0] ?? "";
    expect(rule("\n.onb__actions")).toContain("position: sticky");
    expect(rule("\n.onb__actions")).toContain("bottom: 0");
    // On a short step too: the column is the screen's height at least (no auto margin centres it any more) and the
    // bar's own auto top margin takes the room left, so it rests at the bottom, in the same place on every step.
    expect(rule("\n.onb__body")).not.toMatch(/(^|\n)\s*margin:/);
    expect(rule("\n.onb__actions")).toContain("margin: auto calc(-1 * var(--onb-gutter)) 0");
    // The room above the step is the one the page pins as the step opens (computer-setup.test.tsx).
    expect(rule("\n.onb__body::before")).toContain("margin-block: var(--onb-lead, auto) -24px");
    // A text button that doesn't fit beside Continue goes above it: Continue keeps its place on every step.
    expect(rule("\n.onb__actions")).toContain("flex-wrap: wrap-reverse");
    // Its ground spans the column's gutters, and its bottom clears the home bar at every width.
    expect(rule("\n.onb__body")).toContain("--onb-gutter: clamp(16px, 4vw, 32px)");
    expect(rule("\n.onb__actions")).toContain(
      "padding: 0 var(--onb-gutter) calc(env(safe-area-inset-bottom, 0px) + 24px)",
    );
    expect(rule("\n.onb__actions")).toContain("background: var(--pane)");
    const phone = css.indexOf("@media (max-width: 760px) {\n  .onb__actions");
    expect(phone).toBeGreaterThan(-1);
    expect(rule("  .onb__actions", phone)).toContain("safe-area-inset-bottom");
    expect(rule("\nhtml:has(.onb)")).toContain("scroll-padding-bottom: 104px");
    expect(rule("  html:has(.onb)", phone)).toContain(
      "scroll-padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 140px)",
    );
  });

  test("context: an Obsidian vault is read in the step and imported into the wiki on continue", async () => {
    const { state } = await start();
    await type("Nome", "Acme Saúde");
    await next();
    const card = screen().getByRole("region", { name: "Já tem documentação no Obsidian?" });
    const input = within(card).getByLabelText("Escolher .zip ou .md") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(["Veja [[Clientes]]."], "Início.md"), new File(["Lista."], "Clientes.md")] },
      });
    });
    await settle(8);
    await act(() => new Promise((r) => setTimeout(r, 700)));
    await settle(4);
    expect(card.textContent).toContain("Pronta");
    expect(card.textContent).toContain("2notas");
    await next();
    await settle(8);
    const call = calls(state, "wiki.import")[0];
    // Into the workspace made in step 1.
    expect(typeof call?.args[0]).toBe("string");
    expect(call?.args[1]).toMatchObject({
      source: { type: "obsidian" },
      notes: [{ title: "Início" }, { title: "Clientes" }],
    });
  });

  test("every chosen preset is created with its own look and joins #general", async () => {
    const { state } = await start();
    await throughAgents(state);
    const created = calls(state, "agents.create").map((c) => c.args[1] as Record<string, unknown>);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      name: "Theo",
      handle: "theo",
      role: "PM",
      model: "auto",
      credentialId: null,
      appearance: { color: "indigo", eyes: "round", accessory: "cap" },
    });
    expect(created[1]).toMatchObject({
      name: "Ada",
      handle: "ada",
      role: "Dev",
      credentialId: null,
      appearance: { color: "green", eyes: "wide", accessory: "headphones" },
    });
    expect(calls(state, "chat.addMember")).toHaveLength(2);
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    expect(screen().getByText("Falta 1 etapa")).toBeTruthy();
  });

  test("team: each field's reason behind its ⓘ, the link's approval in view, a line only for emails to check", async () => {
    const { state } = await start();
    await throughAgents(state);
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    expect(document.querySelector(".onb__lead")?.textContent).toBe("Convide por e-mail ou compartilhe o link.");
    const hintOf = (name: string) =>
      document.getElementById(button(name).getAttribute("aria-describedby") ?? "")?.textContent;
    expect(hintOf("Sobre E-mails")).toBe("Cada pessoa recebe um convite por e-mail e entra direto.");
    expect(hintOf("Sobre Link de convite")).toBe("Vale por 30 dias. Dá para desativar em Membros.");
    const emails = screen().getByLabelText("E-mails");
    expect(emails.getAttribute("aria-describedby")).toBe("invite-emails-hint");
    // What makes sharing the link in a group safe stays in view, under it.
    expect(screen().getByLabelText("Link de convite").getAttribute("aria-describedby")).toBe(
      "invite-link-hint invite-link-help",
    );
    expect(document.getElementById("invite-link-help")?.textContent).toBe("Você aprova cada pessoa que pedir.");
    // Nothing under the emails until one needs a look.
    expect(document.getElementById("invite-emails-help")).toBeNull();
    await act(async () => fireEvent.change(emails, { target: { value: "nao-e-email" } }));
    await act(async () => fireEvent.keyDown(emails, { key: "Enter" }));
    expect(document.getElementById("invite-emails-help")?.textContent).toBe(
      "Confira os e-mails marcados: eles não recebem convite.",
    );
    expect(emails.getAttribute("aria-describedby")).toBe("invite-emails-hint invite-emails-help");
  });

  test("team on a server that sends no email: the link alone, and Done promises no email", async () => {
    const { state } = await start({ authConfig: { passwordReset: false } });
    await throughAgents(state);
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    expect(document.querySelector(".onb__lead")?.textContent).toBe("Compartilhe o link de convite com eles.");
    // No emails to type: an invitation by email would never arrive.
    expect(screen().queryByLabelText("E-mails")).toBeNull();
    expect((screen().getByLabelText("Link de convite") as HTMLInputElement).value).toMatch(
      /^http:\/\/localhost:3000\/invite\/link-/,
    );
    expect(document.getElementById("invite-link-help")?.textContent).toBe("Você aprova cada pessoa que pedir.");
    expect(button("Continuar")).toBeTruthy();
    await next();
    expect(screen().getByRole("heading", { name: "Boas-vindas à Acme Saúde" })).toBeTruthy();
    expect(welcome()).not.toMatch(/Mandamos|e-mail/);
    expect(calls(state, "orgs.invite")).toHaveLength(0);
  });

  test("Conectar depois: the agents are there without an AI, and answer once one is connected", async () => {
    const { state } = await start();
    await throughImport(state);
    await skip();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    // Nothing under "Conectar depois": Done says what it means for the first message.
    expect(button("Conectar depois").nextElementSibling).toBeNull();
    // A key typed and then left for later isn't saved.
    await type("Cole aqui", "sk-ant-api03-abcdefghijklmnop");
    await click(button("Conectar depois"), 8);
    expect(calls(state, "agents.addCredential")).toHaveLength(0);
    expect(calls(state, "agents.create")).toHaveLength(2);
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
  });

  describe("Jev, for the server's owner, once an AI is connected", () => {
    const OFF = { source: null, hint: null, state: "off" as const, month: { decisions: 0, costUsd: 0 } };
    const TEAM = "Quem mais trabalha com você?";
    const toJev = async (patch: Parameters<typeof start>[0] = {}) => {
      const r = await start({ jev: OFF, ...patch });
      await throughAgents(r.state);
      return r;
    };
    const heading = () => screen().getByRole("heading", { level: 1 });

    test("its own screen after the AI: optional, why, the steps; Continue with nothing typed asks nothing", async () => {
      const { state } = await toJev();
      expect(heading().textContent).toBe("Ajude os agentes a trabalhar em equipeopcional");
      expect(document.querySelector(".onb__lead")?.textContent).toContain(
        "O Jev, da TypeSafe, toma decisões rápidas por eles.",
      );
      // What happens without it is behind the lead's ⓘ, never on the screen.
      const hint = button("Sobre Jev");
      expect(document.getElementById(hint.getAttribute("aria-describedby") ?? "")?.hidden).toBe(true);
      expect(document.getElementById(hint.getAttribute("aria-describedby") ?? "")?.textContent).toContain(
        "Sem o Jev, um modelo pequeno numa das suas chaves de API escolhe quem responde.",
      );
      expect(document.body.textContent).toContain("Escolhe quem responde Mesmo sem @menção.");
      expect(screen().getByRole("link", { name: "Abrir a TypeSafe" }).getAttribute("href")).toBe(
        "https://console.typesafe.ai",
      );
      // The big button saves: no button of the field's own.
      expect(screen().queryByRole("button", { name: "Salvar chave" })).toBeNull();
      // Its place on the rail is the AI's: Agentes e IA, still.
      expect(railStep(/^Agentes e IA/).getAttribute("aria-current")).toBe("step");
      expect(button("Continuar").hasAttribute("disabled")).toBe(false);
      await next();
      expect(calls(state, "system.saveJev")).toHaveLength(0);
      expect(screen().getByRole("heading", { name: TEAM })).toBeTruthy();
    });

    test("with the server's router off, no reason says Jev picks who answers", async () => {
      const routing = { by: "off", mine: "off", model: null, noSmallModel: null } as const;
      await toJev({ aiStatus: { any: true, agents: [], routing, apiKey: true } });
      expect([...document.querySelectorAll(".jev-why b")].map((b) => b.textContent)).toEqual([
        "Organiza a memória",
        "Enxerga a tela",
      ]);
    });

    test("Save and continue keeps a key TypeSafe accepts, and moves on", async () => {
      const { state } = await toJev();
      await type("Cole aqui", "ts_1234");
      expect(button("Salvar e continuar").hasAttribute("disabled")).toBe(true);
      await type("Cole aqui", "ts_live_9f2c");
      await click(button("Salvar e continuar"), 8);
      expect(calls(state, "system.saveJev").map((c) => c.args)).toEqual([["ts_live_9f2c"]]);
      expect(screen().getByRole("heading", { name: TEAM })).toBeTruthy();
    });

    test("a key TypeSafe refuses stays, with why under it; then Continue moves on without asking again", async () => {
      const { state } = await toJev({ jevVerdicts: { ts_wrong_0000: "invalid" } });
      await type("Cole aqui", "ts_wrong_0000");
      await click(button("Salvar e continuar"), 8);
      expect(heading().textContent).toContain("Ajude os agentes a trabalhar em equipe");
      const field = screen().getByLabelText("Cole aqui");
      expect(field.getAttribute("aria-invalid")).toBe("true");
      expect(document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
        "A TypeSafe não aceitou esta chave. Copie de novo na página de chaves.",
      );
      await click(button("Continuar"), 8);
      expect(calls(state, "system.saveJev")).toHaveLength(1);
      expect(state.jev?.source).toBeNull();
      expect(screen().getByRole("heading", { name: TEAM })).toBeTruthy();
    });

    test("a limit is no refusal: its words stay under the field, and the same key is saved on the next try", async () => {
      const { state } = await toJev({ jevVerdicts: { ts_live_9f2c: "rate_limited" } });
      await type("Cole aqui", "ts_live_9f2c");
      await click(button("Salvar e continuar"), 8);
      const field = screen().getByLabelText("Cole aqui");
      // In the person's language, never the server's English.
      expect(document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
        "Muitas tentativas. Tente de novo mais tarde.",
      );
      // Never a way past a key that wasn't kept.
      expect(screen().queryByRole("button", { name: "Continuar" })).toBeNull();
      await click(button("Salvar e continuar"), 8);
      expect(calls(state, "system.saveJev").map((c) => c.args)).toEqual([["ts_live_9f2c"], ["ts_live_9f2c"]]);
      expect(state.jev?.source).toBe("settings");
      expect(screen().getByRole("heading", { name: TEAM })).toBeTruthy();
    });

    test("a key with no credit is kept, and the screen says so before moving on", async () => {
      const { state } = await toJev({ jevVerdicts: { ts_empty_5555: "no_credit" } });
      await type("Cole aqui", "ts_empty_5555");
      await click(button("Salvar e continuar"), 8);
      expect(state.jev?.state).toBe("no_credit");
      expect(document.body.textContent).toContain("Salva. Adicione crédito na TypeSafe e o Jev começa sozinho.");
      await click(button("Continuar"), 8);
      expect(calls(state, "system.saveJev")).toHaveLength(1);
      expect(screen().getByRole("heading", { name: TEAM })).toBeTruthy();
    });

    test("Back goes to the AI; never after Conectar depois, with a key in the server's settings, or for anyone else", async () => {
      await toJev();
      await click(button(/Voltar/), 6);
      expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
      cleanup();

      const later = await start({ jev: OFF });
      await throughImport(later.state);
      await skip();
      await keepOnly("Theo · PM");
      await click(button(/Criar 1 agente/), 8);
      await click(button("Conectar depois"), 8);
      expect(screen().getByRole("heading", { name: TEAM })).toBeTruthy();
      cleanup();

      for (const jev of [{ ...OFF, source: "env" as const, hint: "9f2c", state: "ok" as const }, undefined]) {
        const { state } = await start({ jev });
        await throughAgents(state);
        expect(screen().getByRole("heading", { name: TEAM })).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/typesafe/i);
        cleanup();
      }
    });
  });

  test("no computer yet: a plan's panel says where it signs in, and goes back to the computer step", async () => {
    const { state } = await start();
    await throughImport(state);
    await skip();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    await click(option(/^Claude$/), 6);
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("As contas ficam num computador conectado. Conecte um seu primeiro.");
    await click(within(panel).getByRole("button", { name: "Conectar um computador" }), 6);
    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
    expect(button(/Outro computador/)).toBeTruthy();
  });

  test("this server's own computer comes first and already picked; the agents go to it", async () => {
    const { state, api } = await start();
    const host = fakeMachinesOf.get(api)?.pair({ name: "srv-1", kind: "host" });
    await throughImport(state);
    const card = button(/Computador deste servidor/);
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(card.textContent).toContain("Onde o agentes.chat está instalado, um usuário por agente.");
    expect(button(/^Outro computador/).textContent).toContain("Um Mac, um PC ou um servidor, conectado com um código.");
    expect(document.body.textContent).toContain(
      "Os agentes trabalham num computador, e ações sensíveis continuam pedindo a sua aprovação.",
    );
    expect(document.body.textContent).toContain("Os agentes escolhidos vão trabalhar no computador deste servidor.");
    expect(button("Continuar").hasAttribute("disabled")).toBe(false);
    await next();

    expect(screen().queryByRole("heading", { name: "Quem pensa" })).toBeNull();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    // They go to it as they're made.
    expect(calls(state, "sandbox.setTarget").map((c) => c.args[2])).toEqual([host?.id, host?.id]);
    // A computer that takes plans: every plan, then the key, with Claude chosen and its sign-in open, for Ada first.
    for (const name of [
      /^Claude$/,
      /^ChatGPT$/,
      /^GLM Coding$/,
      /^Kimi Code$/,
      /^MiniMax$/,
      /^OpenCode Go$/,
      /^Chave de API/,
    ])
      expect(option(name)).toBeTruthy();
    expect(option(/^Claude$/).getAttribute("aria-pressed")).toBe("true");
    // "sem chave de API" stays on one line.
    expect(document.querySelector(".onb__lead")?.textContent).toBe(
      "Entre com o seu plano de IA: sem\u00a0chave\u00a0de\u00a0API.",
    );
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    // For Ada, whose face asks the step's question, before Theo (made first, the team's first with no AI).
    expect(within(panel).getByRole("combobox", { name: "Agentes que usam este plano" }).textContent).toBe("Ada");
    expect(screen().queryByRole("button", { name: "Avançado" })).toBeNull();
    // Ada picked: another plan's tile keeps her while she has none.
    const agent = () => screen().getByRole("combobox", { name: "Agentes que usam este plano" });
    agent().focus();
    await act(async () => fireEvent.keyDown(agent(), { key: "Enter" }));
    await click(screen().getByRole("option", { name: "Ada" }));
    await click(option(/^ChatGPT$/), 6);
    expect(agent().textContent).toContain("Ada");
    await click(button("Conectar depois"), 8);
    expect(calls(state, "agents.setBrain")).toHaveLength(0);
  });

  test("a plan for Ada, who asks: she thinks with it once signed in; Who thinks shows the others, and one key covers them", async () => {
    const { state, api } = await start();
    const host = fakeMachinesOf.get(api)?.pair({ name: "srv-1", kind: "host" });
    // The computer finishes the sign-in as soon as the code goes.
    fakeMachinesOf.get(api)?.endLogin("login_1", {
      state: "done",
      account: {
        id: "acct_max",
        kind: "claude_code",
        label: "Claude Max",
        email: "walter@acme.com.br",
        plan: "max",
        status: "active",
        ownerId: "u-walter",
        ownerName: "Walter",
        mine: true,
        usedBy: [],
        usage: null,
        provider: null,
        keyHint: null,
      },
    });
    await throughImport(state);
    await next();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(
        within(screen().getByRole("region", { name: "Seu plano do Claude" })).getByRole("button", {
          name: "Entrar com Claude",
        }),
      );
      await settle(6);
    } finally {
      window.open = realOpen;
    }
    await settle(6);
    // No "Usar" to click: Ada thinks with it as soon as it's in.
    expect(calls(state, "agents.setBrain").map((c) => c.args[2])).toEqual([
      { brain: "claude_code", account: "acct_max" },
    ]);
    expect(document.body.textContent).toContain("Ada agora pensa com Claude Max.");
    // In the team's order, as the workspace lists them.
    const who = screen().getByRole("region", { name: "Quem pensa" });
    expect([...who.querySelectorAll(".ai-who__row")].map((r) => r.textContent)).toEqual([
      "TheoSem IA",
      "AdaClaude Max",
    ]);
    expect(who.textContent).not.toContain("Cada plano pensa por um agente.");
    const keyFor = within(who).getByRole("button", { name: "Chave de API para Theo" });
    expect([...keyFor.querySelectorAll(".ac-brand-stack > .ac-brand")].map((m) => m.getAttribute("data-mark"))).toEqual(
      ["claude", "openai"],
    );
    await click(keyFor, 4);
    expect(option(/^Chave de API/).getAttribute("aria-pressed")).toBe("true");
    // A plan is in: the step can be done now, the key or not.
    expect(button("Continuar").hasAttribute("disabled")).toBe(false);
    expect(screen().queryByRole("button", { name: "Conectar depois" })).toBeNull();
    await next();
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    expect(calls(state, "sandbox.setTarget").map((c) => c.args[2])).toEqual([host?.id, host?.id]);
  });

  test("a computer connected after the team is made: the agents move to it, and its plans sign in for them", async () => {
    const { state, api, services } = await start();
    await throughImport(state);
    await skip();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    await click(option(/^Claude$/), 6);
    await click(button("Conectar um computador"), 6);
    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
    // This server's own computer connects meanwhile, and is picked.
    const host = fakeMachinesOf.get(api)?.pair({ name: "srv-1", kind: "host" });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(6);
    expect(button(/Computador deste servidor/).getAttribute("aria-pressed")).toBe("true");
    await next();
    expect(calls(state, "sandbox.setTarget").map((c) => c.args[2])).toEqual([host?.id, host?.id]);
    // The team kept: the ones made stay picked, and there's nothing left to make.
    expect(button(/Theo · PM/).getAttribute("aria-pressed")).toBe("true");
    await click(button(/Theo · PM/), 1);
    expect(button(/Theo · PM/).getAttribute("aria-pressed")).toBe("true");
    await next();
    expect(calls(state, "agents.create")).toHaveLength(2);
    expect(option(/^Claude$/).querySelector(".ac-brand--off")).toBeNull();
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
  });

  test("the team made on a computer, then the Computer step skipped: the agents leave it, as the AI step says", async () => {
    const { state, api } = await start();
    const host = fakeMachinesOf.get(api)?.pair({ name: "srv-1", kind: "host" });
    await throughImport(state);
    await next();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    expect(calls(state, "sandbox.setTarget").map((c) => c.args[2])).toEqual([host?.id, host?.id]);
    // Back to the Computer step, and on without one this time.
    await click(button("Voltar"), 4);
    await click(button("Voltar"), 4);
    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
    await skip();
    expect(calls(state, "sandbox.setTarget").map((c) => c.args[2])).toEqual([host?.id, host?.id, null, null]);
    await next();
    // No computer for them now: the key first, the plans dimmed, and Claude's panel asks for one.
    expect(option(/^Chave de API/).getAttribute("aria-pressed")).toBe("true");
    await click(option(/^Claude$/), 6);
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("As contas ficam num computador conectado. Conecte um seu primeiro.");
    expect(within(panel).queryByRole("button", { name: "Entrar com Claude" })).toBeNull();
  });

  test("a computer's own sign-in that some agents can't switch to: the toast names the plan and the computer", async () => {
    const { state, api, services } = await start();
    await throughImport(state);
    await click(button(/Outro computador/), 8);
    fakeMachinesOf.get(api)?.pair({ name: "MacBook do Walter", os: "darwin" });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(6);
    await next();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    api.agents.setBrain = async () => {
      throw new Error("offline");
    };
    await next();
    await settle(4);
    expect(document.body.textContent).toContain(
      "Alguns agentes não conseguiram passar a usar a conta do Claude no MacBook do Walter. Dá para trocar na página de cada um.",
    );
  });

  test("where the server offers its own key: a seventh maker, by our mark, and nothing to paste", async () => {
    const { state } = await start({ platformKey: true });
    await throughImport(state);
    await skip();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    const panel = screen().getByRole("region", { name: "Chave de API" });
    const makers = within(panel).getByRole("group", { name: "Provedor" });
    const ours = within(makers).getByRole("button", { name: "Este servidor" });
    // The makers' 30 px tile, so every tile is as tall.
    expect(ours.querySelector(".ac-brand--sm .ac-logo__mark")).not.toBeNull();
    const PAYS = "Você paga pelo uso, direto ao provedor.";
    expect(panel.textContent).toContain(PAYS);
    await click(ours, 2);
    expect(screen().queryByLabelText("Cole aqui")).toBeNull();
    // Our key isn't paid to a provider: its own line says what it is.
    expect(panel.textContent).not.toContain(PAYS);
    expect(panel.textContent).toContain("Sem chave sua: os agentes usam a chave do Claude deste servidor.");
    expect(button("Continuar").hasAttribute("disabled")).toBe(false);
  });

  test("an imported agent gets its own model back once a key that runs it is saved", async () => {
    const { state } = await start();
    await throughContext(state);
    const input = screen().getByLabelText("Pasta para importar") as HTMLInputElement;
    const root = join(import.meta.dir, "fixtures", "agent-import", "paperclip-company");
    const walk = (dir: string): string[] =>
      readdirSync(dir)
        .sort()
        .flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    const files = walk(root).map((path) => {
      const file = new File([readFileSync(path)], path.slice(path.lastIndexOf("/") + 1));
      Object.defineProperty(file, "webkitRelativePath", { value: `paperclip-company/${path.slice(root.length + 1)}` });
      return file;
    });
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => fireEvent.change(input));
    await settle(10);
    await next();
    await skip();
    await keepOnly();
    await keyAndCreate(/Criar 2 agentes/);
    // Made on Automático with the team (no key yet), then the one whose model the Claude key runs gets it back.
    const applied = calls(state, "imports.apply")
      .map((c) => c.args[1] as ImportInput)
      .filter((i) => !i.dryRun);
    expect(applied[0]?.bundle.agents.map((a) => a.model)).toEqual(["auto", "auto"]);
    expect(calls(state, "agents.update").map((c) => c.args[2])).toEqual([{ model: "claude-sonnet-5-5" }]);
  });

  test("this server's computer not connected yet: offered, but not picked for you", async () => {
    const { state, api } = await start();
    fakeMachinesOf.get(api)?.pair({ name: "srv-1", kind: "host", online: false });
    await throughImport(state);
    expect(button(/Computador deste servidor/).getAttribute("aria-pressed")).toBe("false");
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    await click(button(/Computador deste servidor/), 4);
    expect(document.body.textContent).toContain("Ele conecta em até um minuto.");
    expect(button("Continuar").hasAttribute("disabled")).toBe(false);
  });

  test("computer before the agents: it connects live, its Claude Code thinks for them (no key); team invites go out", async () => {
    const { state, api, services, router } = await start();
    await throughImport(state);

    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    await click(button(/Outro computador/), 8);
    // No code made on the site anymore: the computer makes it and the person confirms on /conectar.
    expect(calls(state, "machines.createPairing")).toHaveLength(0);
    expect(document.body.textContent).toContain("O app ainda não está disponível. Por enquanto, use o comando abaixo.");
    await click(button("Outras formas: servidor ou Linux"), 2);
    expect(document.querySelector(".machine-command__code")?.textContent).toBe(
      "curl -fsSL http://localhost:3000/api/machines/install.sh | sh",
    );
    expect(document.body.textContent).toContain("Esperando o computador conectar…");

    // The computer connects; the list refreshes (polling, or an invalidation like here).
    fakeMachinesOf.get(api)?.pair({ name: "MacBook do Walter", os: "darwin" });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(6);
    expect(document.body.textContent).toContain("MacBook do Walter (macOS) conectado.");
    // Choosing a plan asks nothing: only letting others talk to an agent on it does (ADR 0059 §5).
    expect(screen().queryByRole("dialog")).toBeNull();
    await next();

    expect(screen().getByRole("heading", { name: "Fica com esse time?" })).toBeTruthy();
    expect(screen().queryByRole("heading", { name: "Quem pensa" })).toBeNull();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    // Both agents use the connected computer.
    expect(calls(state, "sandbox.setTarget")).toHaveLength(2);
    // The AI step: the account their agents share, chosen, thinks for every agent; nothing to sign in.
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    const own = within(panel).getByRole("button", { name: "A conta que os seus agentes dividem" });
    expect(own.getAttribute("aria-pressed")).toBe("true");
    expect(within(panel).queryByRole("combobox", { name: "Agentes que usam este plano" })).toBeNull();
    // Who they reply to: off, each only the person. Switched on here, the save says everyone (ADR 0059 §5).
    const replies = within(panel).getByRole("switch", { name: "Respondem a todos" });
    expect(replies.getAttribute("aria-checked")).toBe("false");
    await click(replies);
    expect(replies.getAttribute("aria-checked")).toBe("true");
    expect(calls(state, "agents.setBrain")).toHaveLength(0);
    expect(button("Continuar").hasAttribute("disabled")).toBe(false);
    await next();
    await settle(4);
    expect(calls(state, "agents.addCredential")).toHaveLength(0);
    expect(calls(state, "agents.setBrain").map((c) => c.args[2])).toEqual([
      { brain: "claude_code", fallback: true, onlyOwner: false },
      { brain: "claude_code", fallback: true, onlyOwner: false },
    ]);

    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    const link = screen().getByLabelText("Link de convite") as HTMLInputElement;
    expect(link.value).toMatch(/^http:\/\/localhost:3000\/invite\/link-/);
    const emails = screen().getByLabelText("E-mails");
    await act(async () =>
      // A one-line field drops line breaks as you type (pasting with new lines goes through onPaste).
      fireEvent.change(emails, { target: { value: "Marina@acme.com.br, joao@acme.com.br nao-e-email" } }),
    );
    await act(async () => fireEvent.keyDown(emails, { key: "Enter" }));
    expect(button("Remover marina@acme.com.br")).toBeTruthy();
    expect(button("Remover joao@acme.com.br")).toBeTruthy();
    expect(button("Remover nao-e-email")).toBeTruthy();
    expect(screen().getByText("confira")).toBeTruthy();
    expect(button(/Convidar 2 pessoas/)).toBeTruthy();
    await click(button("Remover joao@acme.com.br"), 1);
    await click(button(/Convidar 1 pessoa/), 8);
    // Only the valid addresses are invited.
    expect(calls(state, "orgs.invite").map((c) => c.args[1])).toEqual([
      { email: "marina@acme.com.br", role: "member" },
    ]);

    expect(screen().getByRole("heading", { name: "Boas-vindas à Acme Saúde" })).toBeTruthy();
    expect(welcome()).toBe("Theo e Ada já estão no #general. Mandamos 1 convite por e-mail.");
    // Their computer ends the row of faces, as it is.
    expect(screen().getByRole("img", { name: "MacBook do Walter" }).getAttribute("data-state")).toBe("online");
    // Lia, who'd browse on it, isn't on the team: Theo offers the first message, sent in one click.
    expect(asker()).toBe("Theo");
    await click(button("Enviar para Theo"), 8);
    const posts = calls(state, "chat.post");
    expect(posted(state)).toEqual([{ body: THEO_ASKS, clientId: expect.any(String) }]);
    expect(router.state.location.pathname).toBe(`/org/${posts[0]?.args[0]}/c/${posts[0]?.args[1]}`);
  });

  test("computer before the agents, the switch left off: each replies only to the person, as the Team step says", async () => {
    const { state, api, services } = await start({ agents: [] });
    await throughImport(state);
    await click(button(/Outro computador/), 8);
    fakeMachinesOf.get(api)?.pair({ name: "MacBook do Walter", os: "darwin" });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(6);
    await next();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    // Whoever creates an agent owns it, as the server makes them.
    for (const a of state.agents) a.ownerUserId = "u-walter";
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(within(panel).getByRole("switch", { name: "Respondem a todos" }).getAttribute("aria-checked")).toBe("false");
    await next();
    await settle(4);
    expect(calls(state, "agents.setBrain").map((c) => c.args[2])).toEqual([
      { brain: "claude_code", fallback: true },
      { brain: "claude_code", fallback: true },
    ]);
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    expect(screen().getByText("Seus agentes só respondem a você.")).toBeTruthy();
  });

  test("a computer whose Claude Code isn't signed in: no account to share, Claude's sign-in instead, nothing saved on Continue", async () => {
    const { state, api, services } = await start({}, { claudeSignedIn: false });
    await throughImport(state);
    await click(button(/Outro computador/), 8);
    fakeMachinesOf.get(api)?.pair({ name: "MacBook do Walter", os: "darwin" });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(6);
    await next();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(within(panel).queryByRole("button", { name: /^A conta que os seus agentes dividem/ })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    // Continue would point every agent at a sign-in that isn't there: it waits for one.
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    expect(calls(state, "agents.setBrain")).toHaveLength(0);
  });

  test("optional steps can be skipped: no computer, no invites", async () => {
    // This tab's sign-up was emailed a link: done setting up, a later onboarding says nothing of it.
    sessionStorage.setItem("agentes.confirmation.sent", "walter@acme.com.br");
    const { state } = await start();
    await throughAgents(state);
    expect(calls(state, "machines.createPairing")).toHaveLength(0);
    expect(calls(state, "sandbox.setTarget")).toHaveLength(0);
    expect(calls(state, "agents.setBrain")).toHaveLength(0);

    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    await skip();
    expect(calls(state, "orgs.invite")).toHaveLength(0);
    expect(screen().getByRole("heading", { name: "Boas-vindas à Acme Saúde" })).toBeTruthy();
    // No cards repeating the rail and the faces, and nothing said of what was skipped: no invitations, no computer.
    // No line over the title either: the welcome says it, and so does the rail's "Tudo certo" where it shows.
    expect(document.querySelector(".onb__summary, .onb__stat, .onb__body > .ac-card, .onb__eyebrow")).toBeNull();
    expect(welcome()).toBe("Theo e Ada já estão no #general.");
    expect(document.querySelector(".onb__crew-computer")).toBeNull();
    // The rail marks the steps done and lets you go back.
    const steps = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(steps.querySelectorAll("li[data-done]")).toHaveLength(6);
    expect(progress()).toBe("Tudo certo");

    // Back to Team: it's open again, so one step is left until it's answered again, and it was no less
    // optional before: its row keeps no "opcional".
    await click(button("Voltar"), 4);
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    expect(progress()).toBe("Falta 1 etapa");
    expect(railStep(/^Time/).textContent).not.toContain("opcional");
    await skip();
    expect(progress()).toBe("Tudo certo");
    expect(sessionStorage.getItem("agentes.confirmation.sent")).toBe("walter@acme.com.br");
    // The quiet way out opens #general and sends nothing.
    await click(button("Abrir o #general sem enviar"), 8);
    expect(calls(state, "chat.post")).toHaveLength(0);
    expect(sessionStorage.getItem("agentes.confirmation.sent")).toBeNull();
  });

  test("Done: with no computer to browse on, Theo offers the first message, having read the context; Send posts it once and opens #general", async () => {
    const { state, router } = await start();
    await toDone(state, "Theo · PM", "Lia · Pesquisa");
    expect(document.querySelector(".onb__summary, .onb__stat")).toBeNull();
    expect(welcome()).toBe("Theo, Ada e Lia já estão no #general.");
    // Lia's research needs a computer's browser: with none, Theo asks.
    expect(asker()).toBe("Theo");
    expect(
      screen().getByRole("region", { name: "Li o que você escreveu sobre a Acme Saúde. Posso começar por isto?" }),
    ).toBeTruthy();
    expect(askBox().value).toBe(THEO_ASKS);
    // Not focused: Enter anywhere does what the big button's ↵ says.
    expect(document.activeElement).not.toBe(askBox());
    expect(askLine()).toBe("Theo começa na hora, no #general.");
    expect(document.querySelector(".onb__first-line")?.getAttribute("role")).toBe("status");
    expect(button("Abrir o #general sem enviar")).toBeTruthy();
    await click(button("Enviar para Theo"), 8);
    const posts = calls(state, "chat.post");
    expect(posted(state)).toEqual([{ body: THEO_ASKS, clientId: expect.any(String) }]);
    expect(router.state.location.pathname).toBe(`/org/${posts[0]?.args[0]}/c/${posts[0]?.args[1]}`);
  });

  test("who asks first: Lia once a ready computer gives the agents a browser, its portrait after the faces; Ada when she's alone", async () => {
    const first = await start();
    fakeMachinesOf.get(first.api)?.pair({ name: "srv-1", kind: "host" });
    await throughImport(first.state);
    await next();
    await keepOnly("Theo · PM", "Lia · Pesquisa");
    await click(button(/^Criar 2 agentes$/), 8);
    await click(button("Conectar depois"), 8);
    await skip();
    expect(asker()).toBe("Lia");
    expect(askBox().value).toBe(
      "@lia Quem são os nossos 5 concorrentes mais próximos, e o que eles fazem melhor que a gente?",
    );
    expect(button("Enviar para Lia")).toBeTruthy();
    expect(screen().getByRole("img", { name: "Computador deste servidor" }).getAttribute("data-state")).toBe("online");
    // Each face says who it is under the pointer; screen readers have the lead's names instead.
    const faces = [...document.querySelectorAll(".onb__crew .ac-avatar")];
    expect(faces.map((f) => [f.getAttribute("title"), f.getAttribute("aria-hidden")])).toEqual([
      ["Theo · PM", "true"],
      ["Ada · Dev", "true"],
      ["Lia · Pesquisa", "true"],
    ]);
    cleanup();

    const alone = await start();
    await toDone(alone.state);
    expect(asker()).toBe("Ada");
    expect(askBox().value).toBe("@ada O que você poderia construir ou automatizar para a gente primeiro?");
    expect(button("Enviar para Ada")).toBeTruthy();
  });

  test("the first message as it's edited: whoever it names speaks and gets it; naming nobody, #general; emptied, the agent asks for one and nothing goes", async () => {
    const { state, router } = await start();
    await toDone(state, "Theo · PM", "Lia · Pesquisa");
    await type(ASK, "@Lia e os preços deles?");
    expect(asker()).toBe("Lia");
    expect(button("Enviar para Lia")).toBeTruthy();
    expect(askLine()).toBe("Lia começa na hora, no #general.");
    // Naming nobody: the router picks who answers, and every agent here has an AI.
    await type(ASK, "Bom dia, time");
    expect(asker()).toBe("Theo");
    expect(button("Enviar no #general")).toBeTruthy();
    expect(askLine()).toBeNull();
    // Emptied: no offer of "this" over an empty box, only the way into #general, and nothing to open it "without
    // sending".
    await type(ASK, "  ");
    expect(screen().getByRole("region", { name: "Por onde eu começo?" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Abrir o #general sem enviar" })).toBeNull();
    expect(askLine()).toBeNull();
    await click(button("Abrir o #general"), 8);
    expect(calls(state, "chat.post")).toHaveLength(0);
    expect(router.state.location.pathname).toMatch(/^\/org\/org-\d+\/c\/chan-\d+$/);
  });

  test("the first message's box: Enter sends; Shift+Enter, Enter ending an input method's word and a phone's return key don't; going Back keeps what was written", async () => {
    const { state } = await start();
    await toDone(state, "Theo · PM");
    await type(ASK, "@theo o que fazemos hoje?");
    await click(button("Voltar"), 4);
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    await skip();
    expect(askBox().value).toBe("@theo o que fazemos hoje?");
    const enter = async (init: KeyboardEventInit = {}) => {
      await act(async () => fireEvent.keyDown(askBox(), { key: "Enter", ...init }));
      await settle(4);
    };
    await enter({ shiftKey: true });
    await enter({ isComposing: true });
    // A phone, touch first: its return key is a new line, as in the chat, and the big button sends.
    const touches = Object.getOwnPropertyDescriptor(navigator, "maxTouchPoints");
    const matchMedia = window.matchMedia;
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
    window.matchMedia = ((query: string) =>
      query === "(pointer: coarse)"
        ? ({ matches: true, media: query } as MediaQueryList)
        : matchMedia.call(window, query)) as typeof window.matchMedia;
    try {
      await enter();
    } finally {
      window.matchMedia = matchMedia;
      if (touches) Object.defineProperty(navigator, "maxTouchPoints", touches);
      else delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
    }
    expect(calls(state, "chat.post")).toHaveLength(0);
    expect(screen().getByRole("heading", { name: "Boas-vindas à Acme Saúde" })).toBeTruthy();
    await enter();
    await settle(4);
    expect(posted(state)).toEqual([{ body: "@theo o que fazemos hoje?", clientId: expect.any(String) }]);
  });

  test("the first message goes once: two presses at once are one message; while it's on its way, Enter and the button send nothing more", async () => {
    const { state, router } = await start();
    await toDone(state, "Theo · PM");
    let land = () => {};
    state.holdPosts = new Promise<void>((done) => {
      land = done;
    });
    const send = button("Enviar para Theo");
    // Two presses before the page shows it's sending: the same message twice, which the server writes once.
    await act(async () => {
      fireEvent.click(send);
      fireEvent.click(send);
    });
    await settle(2);
    await act(async () => fireEvent.keyDown(askBox(), { key: "Enter" }));
    await act(async () => fireEvent.keyDown(document.querySelector(".onb__main") as HTMLElement, { key: "Enter" }));
    await click(send, 2);
    const [one, two, ...more] = posted(state);
    expect(two).toEqual(one);
    expect(more).toEqual([]);
    state.holdPosts = undefined;
    await act(async () => land());
    await settle(8);
    expect(state.messages.filter((m) => m.body === THEO_ASKS)).toHaveLength(1);
    expect(router.state.location.pathname).toMatch(/^\/org\/org-\d+\/c\/chan-\d+$/);
  });

  test("sent again after its answer was lost on the way back, the first message is written once; changed, it's a new one", async () => {
    const { state, api, router } = await start();
    await toDone(state, "Theo · PM");
    // Each post is written, but the first two answers never come back (a proxy's 502).
    const post = api.chat.post;
    let lost = 2;
    api.chat.post = async (...args: Parameters<typeof post>) => {
      const message = await post(...args);
      if (lost-- > 0) throw new ApiError(502, "bad_gateway", "Bad gateway");
      return message;
    };
    await click(button("Enviar para Theo"), 8);
    expect(screen().getByRole("heading", { name: "Boas-vindas à Acme Saúde" })).toBeTruthy();
    await type(ASK, "@theo o que fazemos hoje?");
    await click(button("Enviar para Theo"), 8);
    await click(button("Enviar para Theo"), 8);
    const [first, changed, again] = posted(state);
    expect(changed?.clientId).not.toBe(first?.clientId);
    expect(again).toEqual(changed);
    const bodies = [THEO_ASKS, "@theo o que fazemos hoje?"];
    expect(state.messages.filter((m) => bodies.includes(m.body)).map((m) => m.body)).toEqual(bodies);
    expect(router.state.location.pathname).toMatch(/^\/org\/org-\d+\/c\/chan-\d+$/);
  });

  test("a first message that can't be posted stays on Done with its text, and says why", async () => {
    const { state, router } = await start();
    await toDone(state, "Theo · PM");
    state.failPosts = true;
    await click(button("Enviar para Theo"), 8);
    expect(document.querySelector(".ac-toast")?.textContent).toContain("Try again");
    expect(screen().getByRole("heading", { name: "Boas-vindas à Acme Saúde" })).toBeTruthy();
    expect(askBox().value).toBe("@theo Monte o plano da nossa primeira semana: o que cada um de nós faz primeiro?");
    state.failPosts = false;
    await click(button("Enviar para Theo"), 8);
    expect(calls(state, "chat.post")).toHaveLength(2);
    expect(router.state.location.pathname).toMatch(/^\/org\/org-\d+\/c\/chan-\d+$/);
  });

  test("the welcome says what went out and came in: invitations once sent, the wiki while it arrives and once it's in", async () => {
    const { api } = await start();
    // The vault's notes take their time: Done opens before they're in.
    let release = () => {};
    const wikiImport = api.wiki.import;
    api.wiki.import = async (...args: Parameters<typeof wikiImport>) => {
      await new Promise<void>((done) => {
        release = done;
      });
      return wikiImport(...args);
    };
    await pickVault();
    await next();
    await skip();
    await skip();
    await keepOnly("Theo · PM");
    await click(button(/^Criar 1 agente$/), 8);
    await click(button("Conectar depois"), 8);
    const emails = screen().getByLabelText("E-mails");
    await act(async () => fireEvent.change(emails, { target: { value: "marina@acme.com.br, bia@acme.com.br" } }));
    await act(async () => fireEvent.keyDown(emails, { key: "Enter" }));
    await click(button(/Convidar 2 pessoas/), 8);
    expect(welcome()).toBe(
      "Theo e Ada já estão no #general. Mandamos 2 convites por e-mail. As notas do Obsidian ainda estão chegando na wiki.",
    );
    // Nothing was written about the company: the offer doesn't say it was read.
    expect(
      screen().getByRole("region", { name: "Posso começar por isto? Pergunto o que precisar saber." }),
    ).toBeTruthy();
    await act(async () => release());
    await settle(8);
    expect(welcome()).toBe(
      "Theo e Ada já estão no #general. Mandamos 2 convites por e-mail. A wiki tem 2 páginas do Obsidian.",
    );
  });

  test("notes that aren't coming aren't said to be arriving: Continue waits for the vault to be read, and a failed import says nothing on Done", async () => {
    const { api } = await start();
    let imports = 0;
    api.wiki.import = async () => {
      imports++;
      throw new ApiError(500, "internal", "Internal error");
    };
    await pickVault({ read: false });
    // Continue is what brings the vault in: it waits until the vault is read.
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    await act(() => new Promise((r) => setTimeout(r, 700)));
    await settle(4);
    await next();
    await settle(4);
    expect(imports).toBe(1);
    await skip();
    await skip();
    await keepOnly("Theo · PM");
    await click(button(/^Criar 1 agente$/), 8);
    await click(button("Conectar depois"), 8);
    await skip();
    expect(welcome()).toBe("Theo e Ada já estão no #general.");
  });

  test("with no AI yet, the line says to send anyway, for the agent named or every agent; one connected on a way back counts", async () => {
    const { state } = await start();
    await throughImport(state);
    await skip();
    await keepOnly("Theo · PM");
    await click(button(/^Criar 1 agente$/), 8);
    await click(button("Conectar depois"), 8);
    state.aiStatus = {
      any: false,
      agents: state.agents.map((a) => ({ agentId: a.id, state: "no_ai" as const, reason: "no_key" as const })),
    };
    await skip();
    expect(askLine()).toBe("Ainda sem IA conectada: Theo responde quando você conectar uma.");
    expect(document.querySelector(".onb__first-line")?.getAttribute("data-state")).toBe("no_ai");
    expect(button("Enviar para Theo")).toBeTruthy();
    await type(ASK, "Bom dia, time");
    expect(askLine()).toBe("Ainda sem IA conectada: os agentes respondem quando você conectar uma.");
    // An AI connected after going back: Done says so as soon as it's open again.
    await type(ASK, "@theo bom dia");
    state.aiStatus = { any: true, agents: state.agents.map((a) => ({ agentId: a.id, state: "ready" as const })) };
    await click(button("Voltar"), 4);
    await skip();
    expect(askLine()).toBe("Theo começa na hora, no #general.");
  });

  test("an agent whose computer is away: the line waits for it, asked about again every 5 s, until it can start", async () => {
    const { state, api, services } = await start();
    await throughImport(state);
    await click(button(/Outro computador/), 8);
    const mac = fakeMachinesOf.get(api)?.pair({ name: "MacBook do Walter", os: "darwin" });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(6);
    await next();
    await keepOnly("Theo · PM");
    await click(button(/^Criar 1 agente$/), 8);
    // Its own sign-in thinks for them.
    await next();
    // The Mac went to sleep meanwhile.
    const theo = agentId(state, "Theo");
    state.aiStatus = { any: true, agents: [{ agentId: theo, state: "waiting" }] };
    fakeMachinesOf.get(api)?.patch(mac?.id ?? "", { online: false });
    await skip();
    expect(screen().getByRole("img", { name: "MacBook do Walter" }).getAttribute("data-state")).toBe("offline");
    expect(asker()).toBe("Theo");
    expect(askLine()).toBe("Theo começa assim que o MacBook do Walter voltar.");
    const interval = () => {
      const query = services.queryClient
        .getQueryCache()
        .findAll()
        .find((q) => q.queryKey.at(-1) === "ai-status" && q.getObserversCount() > 0);
      const every = query?.observers[0]?.options.refetchInterval;
      return typeof every === "function" && query ? every(query) : every;
    };
    expect(interval()).toBe(5000);
    state.aiStatus = { any: true, agents: [{ agentId: theo, state: "ready" }] };
    await act(async () => services.queryClient.invalidateQueries());
    await settle(6);
    expect(askLine()).toBe("Theo começa na hora, no #general.");
    expect(interval()).toBe(false);
  });

  test("import: one line on what comes along, no way out inside it (Pular esta etapa is); each app by its official logo and name", async () => {
    const { state } = await start();
    await throughContext(state);
    const bubble = document.querySelector(".onb__bubble") as HTMLElement;
    expect(bubble.querySelector(".onb__lead")?.textContent).toBe(
      "Eles chegam com instruções, skills, rotinas e memória.",
    );
    expect(within(bubble).queryByRole("button")).toBeNull();
    // Each app's own logo, never letters or a generic icon; only "Outro app", which names many, keeps one. No line
    // under the name: where each app keeps its file is the tip under the cards, once one is picked.
    expect(document.querySelector(".imp-source .ac-option__desc")).toBeNull();
    const tiles = [...document.querySelectorAll(".imp-source")].map((card) => [
      card.querySelector(".ac-option__title")?.textContent,
      card.querySelector(".imp-mark img")?.getAttribute("src") ?? card.querySelector(".imp-mark svg")?.tagName,
    ]);
    // The most used apps first; "Outro app" always last.
    expect(tiles).toEqual([
      ["Grok Bot", "/brands/grok-bot.svg"],
      ["ChatGPT dots", "/brands/chatgpt-dots.svg"],
      ["OpenBot.run", "/brands/openbotrun.svg"],
      ["OpenMausBot", "/brands/openmausbot.svg"],
      ["Hermes Agent", "/brands/hermes.svg"],
      ["OpenClaw", "/brands/openclaw.svg"],
      ["Paperclip", "/brands/paperclip.svg"],
      ["agentes.chat", "/favicon.svg"],
      ["Outro app", "svg"],
    ]);
    await skip();
    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
    expect(railStep(/^Trazer seus agentes/).textContent).toContain("Pulado");
  });

  test("the confirmation email: where it went, a new link, and once it's confirmed no line", async () => {
    const state = seedState();
    if (!state.me) throw new Error("no me");
    state.me.organizations = [];
    state.me.user.emailVerified = false;
    // This tab signed up with this address.
    sessionStorage.setItem("agentes.confirmation.sent", "walter@acme.com.br");
    try {
      const { auth, calls } = createFakeAuth();
      await renderApp("/onboarding", { api: createFakeApi(state), auth });
      await settle(4);
      const note = () => document.querySelector(".onb__note")?.textContent;
      expect(note()).toBe("Mandamos um link de confirmação para walter@acme.com.br.Mandar outro link");
      // Nothing waits for it.
      expect(button("Continuar").hasAttribute("disabled")).toBe(true);
      await type("Nome", "Acme");
      expect(button("Continuar").hasAttribute("disabled")).toBe(false);

      // Didn't get it, or it ran out: a new one, once.
      await click(button("Mandar outro link"), 4);
      expect(calls).toEqual([{ method: "sendVerificationEmail", args: ["walter@acme.com.br"] }]);
      expect(document.body.textContent).toContain("Mandamos outro link para walter@acme.com.br.");
      expect(note()).toBe("Mandamos um link de confirmação para walter@acme.com.br.");

      // The link opened in another tab, which said so: back here the line is gone, and this tab forgets it was sent.
      state.me = { ...state.me, user: { ...state.me.user, emailVerified: true } };
      await act(async () => window.dispatchEvent(new Event("visibilitychange")));
      await settle(6);
      expect(document.querySelector(".onb__note")).toBeNull();
      expect(sessionStorage.getItem("agentes.confirmation.sent")).toBeNull();
    } finally {
      sessionStorage.clear();
    }
  });

  test("no confirmation line where this tab sent none (a Google sign-up, another tab)", async () => {
    const state = seedState();
    if (!state.me) throw new Error("no me");
    state.me.organizations = [];
    state.me.user.emailVerified = false;
    await renderApp("/onboarding", { api: createFakeApi(state) });
    await settle(4);
    expect(screen().getByRole("heading", { name: "Como se chama o seu workspace?" })).toBeTruthy();
    expect(document.querySelector(".onb__note")).toBeNull();
  });

  test("workspace: the time zone in words, its reason behind its ⓘ, with no line under the field", async () => {
    await start();
    // Its name as people say it (the IANA id goes to the API only).
    const zone = [...document.querySelectorAll(".onb__help")].find((p) => p.textContent?.startsWith("Fuso horário"));
    expect(zone?.textContent).toMatch(/^Fuso horário: .+ · trocar$/);
    expect(zone?.textContent).not.toMatch(/\w\/\w/);
    await click(button("trocar"), 2);
    const about = button("Sobre Fuso horário");
    const why = document.getElementById(about.getAttribute("aria-describedby") ?? "");
    expect(why?.textContent).toBe("Para rotinas e lembretes. Detectado pelo seu navegador.");
    expect(why?.hidden).toBe(true);
    expect(document.querySelector(".ac-field__help")).toBeNull();
  });

  const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "agent-import", name), "utf8");
  const pickFiles = async (files: File[]) => {
    const input = document.querySelector('.onb__main input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => fireEvent.change(input));
    await settle(8);
  };
  /** Keeps the team (`count`: its button), then saves a Claude key for it. */
  const keyAndCreate = async (count: RegExp) => {
    await click(button(count), 8);
    await type("Cole aqui", "sk-ant-api03-abcdefghijklmnop");
    await click(button("Salvar e continuar"), 6);
    await settle(4);
  };

  test("import: an OpenMausBot team file → the server's plan to pick from → the agents step prefilled → one apply with the key's model", async () => {
    const { state } = await start();
    await throughContext(state);
    await click(button(/OpenMausBot/), 1);
    expect(button(/OpenMausBot/).getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Compartilhar time… → Salvar arquivo");

    await pickFiles([new File([fixture("sales-desk.openmaus.json")], "sales-desk.openmaus.json")]);
    expect(screen().getByRole("heading", { name: "Sales desk" })).toBeTruthy();
    const bring = (name: string) => screen().getByRole("checkbox", { name: `Trazer ${name}` });
    for (const name of ["Morgan", "Scout", "Quill"]) expect(bring(name).getAttribute("aria-checked")).toBe("true");
    const text = document.body.textContent ?? "";
    // Skills, the room and the routines come along; connections are to-dos after importing.
    for (const name of ["pricing-policy", "research-brief", "objection-handling", "#deal-desk", "Daily digest"]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("Conectar CRM (mcp.example.com)");
    expect(text).toContain("O que não vem junto");
    expect(text).toContain("Chaves, senhas e histórico de conversa nunca vêm.");
    expect(text).toContain("Chega quando você criar o time.");
    // Only the groups whose items arrive changed say so: skills off, routines paused.
    expect([...document.querySelectorAll(".imp-group__help")].map((h) => h.textContent)).toEqual([
      "Chegam desligadas.",
      "Chegam pausadas.",
    ]);
    expect(document.querySelector(".imp-block__help")).toBeNull();
    // Nothing is saved while reading: the server only planned it.
    expect(calls(state, "agents.create")).toHaveLength(0);
    expect(calls(state, "imports.apply").map((c) => (c.args[1] as ImportInput).dryRun)).toEqual([true]);

    await click(bring("Quill"), 1);
    expect(bring("Quill").getAttribute("aria-checked")).toBe("false");
    await next();
    await skip();

    expect(screen().getByRole("heading", { name: "Seus agentes, e mais alguém?" })).toBeTruthy();
    expect(button(/Morgan · Sales lead/).getAttribute("aria-pressed")).toBe("true");
    expect(button(/Scout · Prospect researcher/).getAttribute("aria-pressed")).toBe("true");
    expect(button(/Quill · Outreach writer/).getAttribute("aria-pressed")).toBe("false");
    // Only Ada (always on the team) joins them.
    await keepOnly();
    await keyAndCreate(/Criar 2 agentes/);

    expect(calls(state, "agents.create").map((c) => (c.args[1] as { name: string }).name)).toEqual(["Ada"]);
    const applied = calls(state, "imports.apply")
      .map((c) => c.args[1] as ImportInput)
      .filter((i) => !i.dryRun);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.pick).toEqual([
      "skill:pricing-policy",
      "skill:research-brief",
      "skill:objection-handling",
      "agent:lead",
      "agent:scout",
      "channel:desk",
      "routine:daily-digest",
      "routine:weekly-review",
      "note:lead/MEMORY.md",
      "note:lead/memory/pricing.md",
    ]);
    const [morgan, scout] = applied[0]?.bundle.agents ?? [];
    expect(morgan).toMatchObject({
      name: "Morgan",
      handle: "lead",
      role: "Sales lead",
      // The source names no model of ours: Automático.
      model: "auto",
      appearance: { color: "violet" },
    });
    expect(String(morgan?.instructions)).toStartWith(
      "You coordinate the desk. Keep answers short and cite the price list.\n\n## Qualify a lead",
    );
    expect(scout).toMatchObject({ handle: "scout", role: "Prospect researcher", appearance: { color: "sky" } });
    expect(calls(state, "chat.addMember")).toHaveLength(3);
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();

    // They're in the crew at the end, with what the import brought.
    await next();
    expect(document.body.textContent).toContain("Ada, Morgan e Scout já estão no #general.");
    expect(screen().getByRole("heading", { name: "Chegou tudo" })).toBeTruthy();
  });

  test("import: an OpenBot GitHub link is read by the backend; a bad link says so; skipping the step drops it", async () => {
    const { state } = await start();
    const url = "https://github.com/acme/pacote/tree/main/tenant";
    state.githubFiles = {
      [url]: [
        { path: "agents.yaml", text: fixture("agents.yaml") },
        { path: "model.yaml", text: fixture("model.yaml") },
      ],
    };
    await throughContext(state);
    // OpenBot has no card of its own: it's one of the other apps.
    expect(screen().queryByRole("button", { name: /^OpenBot$/ })).toBeNull();
    await click(button(/^Outro app$/), 1);

    const field = "Ou cole um link do GitHub ou a resposta do outro app";
    await type(field, "https://github.com/acme/nada/blob/main/agents.yaml");
    await click(button("Ler"), 8);
    expect(screen().getByRole("alert").textContent).toContain("Não deu para ler esse link");

    await type(field, url);
    await click(button("Ler"), 8);
    expect(calls(state, "agents.importFromGithub").at(-1)?.args[1]).toBe(url);
    // Named after the linked folder; recognized by its files.
    expect(screen().getByRole("heading", { name: "tenant" })).toBeTruthy();
    expect(document.body.textContent).toContain("Veio do OpenBot");
    expect(screen().getByRole("checkbox", { name: "Trazer General Assistant" })).toBeTruthy();
    expect(screen().getByRole("checkbox", { name: "Trazer Knowledge" })).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Risk Analyst (remote-ag-ui), Your Bot (remote-ag-ui)");
    expect(text).toContain("openai/gpt-5.6-terra");
    expect(text).toContain("openai-api-key");
    expect(button("Continuar").hasAttribute("disabled")).toBe(false);

    // Skipped: nothing imported reaches the agents step, which offers the whole team.
    await skip();
    await skip();
    expect(screen().getByRole("heading", { name: "Fica com esse time?" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: /Knowledge · Company Knowledge/ })).toBeNull();
    await keyAndCreate(/Criar 3 agentes/);
    expect(calls(state, "agents.create").map((c) => (c.args[1] as { name: string }).name)).toEqual([
      "Theo",
      "Ada",
      "Lia",
      "Atlas",
    ]);
    expect(calls(state, "imports.apply").filter((c) => !(c.args[1] as ImportInput).dryRun)).toHaveLength(0);
  });

  test("import: files no app wrote are refused with what to do; skipping the step clears them", async () => {
    const { state } = await start();
    await throughContext(state);
    await pickFiles([new File(["Lista de compras: café, pão."], "notas.txt")]);
    expect(screen().getByRole("alert").textContent).toContain("Não reconhecemos esses arquivos");
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    await skip();
    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
  });
});
