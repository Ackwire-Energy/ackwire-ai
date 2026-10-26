import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ImportInput, SignInOptions } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
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
    await type("E-mail", "walter@acme.com.br");
    await press(/^Continuar(?! com)/);
    expect(heading()).toBe("Prazer. Esse e-mail é novo por aqui.");
    await type("Seu nome", "Walter Souza");
    await press(/^Continuar(?! com)/, 2);
    expect(heading()).toBe("Boa, Walter. Agora uma senha.");
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
    await type("Crie uma senha nova.", "senha-nova-1");
    await press(/Salvar senha/);
    expect(calls[0]).toEqual({ method: "resetPassword", args: [{ token: "tok-1", newPassword: "senha-nova-1" }] });
    expect(heading()).toBe("Senha nova salva.");
  });

  test("an expired link (no token) asks for another", async () => {
    await renderApp("/reset-password?error=INVALID_TOKEN", {
      api: createFakeApi(seedState({ me: null })),
      auth: createFakeAuth().auth,
    });
    expect(heading()).toBe("Esse link expirou.");
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
    expect(document.body.textContent).toContain("Theo e Ada já estão no #general.");
    expect(document.body.textContent).toContain("MacBook do Walter");
    await click(button("Abrir o #general"), 8);
    expect(router.state.location.pathname).toMatch(/^\/org\/org-\d+\/c\/chan-\d+$/);
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
    const summary = document.querySelector(".onb__summary")?.textContent ?? "";
    expect(summary).toContain("Depois");
    expect(summary).toContain("Convites0");
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
    await click(button("Abrir o #general"), 8);
    expect(sessionStorage.getItem("agentes.confirmation.sent")).toBeNull();
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
