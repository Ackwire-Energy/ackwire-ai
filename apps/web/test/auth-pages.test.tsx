import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ApiError, type ImportInput, type SignInOptions } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeMachinesOf, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
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
    expect(panel.textContent).toContain("O Computador da Acme está pronto.");
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
    const ask = screen().getByRole("button", { name: "Pedir um novo convite" });
    await act(async () => fireEvent.click(ask));
    await settle();
    expect(screen().getByRole("button", { name: "Pedido enviado" }).hasAttribute("disabled")).toBe(true);
  });

  test("signed in with another email: explains and offers to sign out", async () => {
    await renderApp("/invite/valid", { api: createFakeApi() });
    expect(screen().getByRole("status").textContent).toContain("Este convite foi enviado para marina@acme.com.br");
    expect(screen().getByRole("button", { name: "Sair" })).toBeTruthy();
  });
});

describe("Onboarding", () => {
  const start = async (patch: Partial<ReturnType<typeof seedState>> = {}) => {
    const state = seedState(patch);
    if (state.me) state.me.organizations = [];
    // A server where people connect their own computers says so before any workspace exists.
    state.authConfig = { workspaceComputer: false };
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
    // Ada is already on the team: no card to leave her out. The others start picked.
    expect(screen().queryByRole("button", { name: /Ada · Dev/ })).toBeNull();
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
      "Os agentes pensam com uma chave de API, ou com o seu plano de IA num computador que você conectar.",
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
    expect(within(makers).queryByRole("button", { name: "agentes.chat" })).toBeNull();
    // Nothing connected yet: Continue waits; "Conectar depois" is the way on without one.
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    // New agents start on "Automático".
    expect(document.body.textContent).toContain("Começa no Automático: escolhe o modelo e o esforço para cada tarefa.");
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
    expect(screen().getByRole("heading", { name: "Bem-vindo à Acme Saúde" })).toBeTruthy();
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

  test("Conectar depois: the agents are there without an AI, and answer once one is connected", async () => {
    const { state } = await start();
    await throughImport(state);
    await skip();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    expect(document.body.textContent).toContain("Os agentes começam a responder quando uma IA estiver conectada.");
    // A key typed and then left for later isn't saved.
    await type("Cole aqui", "sk-ant-api03-abcdefghijklmnop");
    await click(button("Conectar depois"), 8);
    expect(calls(state, "agents.addCredential")).toHaveLength(0);
    expect(calls(state, "agents.create")).toHaveLength(2);
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
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
    expect(card.textContent).toContain("com um usuário para cada agente");
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
    expect(document.body.textContent).toContain(
      "Entre com o seu plano de IA e eles pensam com ele: sem chave de API. Ou use uma chave de API, paga pelo uso.",
    );
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    expect(within(panel).getByRole("combobox", { name: "Para qual agente" }).textContent).toContain("Ada");
    expect(screen().queryByRole("button", { name: "Avançado" })).toBeNull();
    // Theo picked: another plan's tile keeps him while he has none.
    const agent = () => screen().getByRole("combobox", { name: "Para qual agente" });
    agent().focus();
    await act(async () => fireEvent.keyDown(agent(), { key: "Enter" }));
    await click(screen().getByRole("option", { name: "Theo" }));
    await click(option(/^ChatGPT$/), 6);
    expect(agent().textContent).toContain("Theo");
    await click(button("Conectar depois"), 8);
    expect(calls(state, "agents.setBrain")).toHaveLength(0);
  });

  test("a plan for Ada: she thinks with it once signed in; Who thinks shows the others, and one key covers them", async () => {
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
    const ada = calls(state, "agents.create").findIndex((c) => (c.args[1] as { name: string }).name === "Ada");
    expect(calls(state, "agents.setBrain").map((c) => c.args[2])).toEqual([
      { brain: "claude_code", account: "acct_max" },
    ]);
    expect(ada).toBeGreaterThan(-1);
    expect(document.body.textContent).toContain("Ada agora pensa com Claude Max.");
    const who = screen().getByRole("region", { name: "Quem pensa" });
    expect([...who.querySelectorAll(".ai-who__row")].map((r) => r.textContent)).toEqual([
      "AdaClaude Max",
      "TheoSem IA",
    ]);
    expect(who.textContent).toContain("Cada plano pensa por um agente.");
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
    const makers = within(screen().getByRole("region", { name: "Chave de API" })).getByRole("group", {
      name: "Provedor",
    });
    const ours = within(makers).getByRole("button", { name: "agentes.chat" });
    // The makers' 30 px tile, so every tile is as tall.
    expect(ours.querySelector(".ac-brand--sm .ac-logo__mark")).not.toBeNull();
    await click(ours, 2);
    expect(screen().queryByLabelText("Cole aqui")).toBeNull();
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
    expect(document.body.textContent).toContain("O app para Mac ainda não está disponível.");
    await click(button("Outras formas: servidor ou Linux"), 2);
    expect(document.querySelector(".machine-command__code")?.textContent).toBe(
      "curl -fsSL http://localhost:3000/api/machines/install.sh | sh",
    );
    expect(document.body.textContent).toContain("Esperando o computador conectar…");

    // The computer connects; the list refreshes (polling, or an invalidation like here).
    fakeMachinesOf.get(api)?.pair({ name: "MacBook do Walter", os: "darwin" });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(6);
    expect(document.body.textContent).toContain("MacBook do Walter conectado · macOS.");
    // Choosing a plan asks nothing: only letting others talk to an agent on it does (ADR 0059 §5).
    expect(screen().queryByRole("dialog")).toBeNull();
    await next();

    expect(screen().getByRole("heading", { name: "Fica com esse time?" })).toBeTruthy();
    expect(screen().queryByRole("heading", { name: "Quem pensa" })).toBeNull();
    await keepOnly("Theo · PM");
    await click(button(/Criar 1 agente/), 8);
    // Both agents use the connected computer.
    expect(calls(state, "sandbox.setTarget")).toHaveLength(2);
    // The AI step: the account signed in on that computer, chosen, thinks for every agent; nothing to sign in.
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    const own = within(panel).getByRole("button", { name: /^A conta do Claude com login no MacBook do Walter/ });
    expect(own.getAttribute("aria-pressed")).toBe("true");
    expect(within(panel).queryByRole("combobox", { name: "Para qual agente" })).toBeNull();
    expect(button("Continuar").hasAttribute("disabled")).toBe(false);
    await next();
    await settle(4);
    expect(calls(state, "agents.addCredential")).toHaveLength(0);
    expect(calls(state, "agents.setBrain").map((c) => c.args[2])).toEqual([
      { brain: "claude_code", fallback: true },
      { brain: "claude_code", fallback: true },
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

    expect(screen().getByRole("heading", { name: "Bem-vindo à Acme Saúde" })).toBeTruthy();
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
    expect(screen().getByRole("heading", { name: "Bem-vindo à Acme Saúde" })).toBeTruthy();
    // No cards repeating the rail and the faces, and nothing said of what was skipped: no invitations, no computer.
    expect(document.querySelector(".onb__summary, .onb__stat, .onb__body > .ac-card")).toBeNull();
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
    expect(screen().getByRole("heading", { name: "Bem-vindo à Acme Saúde" })).toBeTruthy();
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
    expect(screen().getByRole("heading", { name: "Bem-vindo à Acme Saúde" })).toBeTruthy();
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
    expect(screen().getByRole("heading", { name: "Bem-vindo à Acme Saúde" })).toBeTruthy();
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
    expect(askLine()).toBe("Ainda sem IA conectada. Envie mesmo assim: Theo responde quando você conectar uma.");
    expect(document.querySelector(".onb__first-line")?.getAttribute("data-state")).toBe("no_ai");
    expect(button("Enviar para Theo")).toBeTruthy();
    await type(ASK, "Bom dia, time");
    expect(askLine()).toBe("Ainda sem IA conectada. Envie mesmo assim: os agentes respondem quando você conectar uma.");
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

  test('import: Theo\'s "pular" is the way out, and each app is shown by its official logo', async () => {
    const { state } = await start();
    await throughContext(state);
    expect(document.body.textContent).toContain("Se não usa, é só pular.");
    // Each app's own logo, never letters or a generic icon; only "Outro app", which names many, keeps one.
    const tiles = [...document.querySelectorAll(".imp-source")].map((card) => [
      card.querySelector(".ac-option__title")?.textContent,
      card.querySelector(".imp-mark img")?.getAttribute("src") ?? card.querySelector(".imp-mark svg")?.tagName,
    ]);
    expect(tiles).toEqual([
      ["OpenClaw", "/brands/openclaw.svg"],
      ["Hermes Agent", "/brands/hermes.svg"],
      ["OpenBot.Run", "/brands/openbotrun.svg"],
      ["Paperclip", "/brands/paperclip.svg"],
      ["OpenMausBot", "/brands/openmausbot.svg"],
      ["OpenBot", "/brands/openbot.png"],
      ["Exportação do agentes.chat", "/favicon.svg"],
      ["Outro app", "svg"],
    ]);
    await click(button("pular"), 6);
    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
    expect(railStep(/^Trazer seus agentes/).textContent).toContain("Pulado");
  });

  test("the confirmation email: where it went and for how long, a new link, then that it's confirmed", async () => {
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
      expect(note()).toBe(
        "Mandamos um link de confirmação para walter@acme.com.br. Ele vale por uma hora.Mandar outro link",
      );
      // Nothing waits for it.
      expect(button("Continuar").hasAttribute("disabled")).toBe(true);
      await type("Nome", "Acme");
      expect(button("Continuar").hasAttribute("disabled")).toBe(false);

      // Didn't get it, or it ran out: a new one, once.
      await click(button("Mandar outro link"), 4);
      expect(calls).toEqual([{ method: "sendVerificationEmail", args: ["walter@acme.com.br"] }]);
      expect(document.body.textContent).toContain("Mandamos outro link para walter@acme.com.br.");
      expect(note()).toBe("Mandamos um link de confirmação para walter@acme.com.br. Ele vale por uma hora.");

      // The link opened in another tab: back here, the line says so, and this tab forgets it was sent.
      state.me = { ...state.me, user: { ...state.me.user, emailVerified: true } };
      await act(async () => window.dispatchEvent(new Event("visibilitychange")));
      await settle(6);
      expect(note()).toBe("E-mail confirmado: walter@acme.com.br.");
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
    expect(text).toContain("Os agentes usam o modelo e a chave do workspace.");
    expect(text).toContain("Isso chega junto com o time, quando você criar os agentes.");
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
    await click(button(/^OpenBot O pacote/), 1);

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
