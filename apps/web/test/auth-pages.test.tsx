import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const type = (label: string, value: string) =>
  act(async () => fireEvent.change(screen().getByLabelText(label), { target: { value } }));

describe("Entrar", () => {
  test("wrong password shows the prototype's error and marks the field", async () => {
    const { auth, calls } = createFakeAuth({ signIn: { ok: false, status: 401, message: "Invalid" } });
    await renderApp("/login", { api: createFakeApi(seedState({ me: null })), auth });
    await type("E-mail", "walter@acme.com.br");
    await type("Senha", "senha-errada");
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Entrar" })));
    await settle();
    expect(calls[0]).toEqual({ method: "signIn", args: [{ email: "walter@acme.com.br", password: "senha-errada" }] });
    expect(screen().getByRole("alert").textContent).toBe(
      "E-mail ou senha incorretos. Confira e tente de novo, ou redefina a senha.",
    );
    expect(screen().getByLabelText("Senha").getAttribute("aria-invalid")).toBe("true");
  });

  test("signing in goes to the redirect target; social and sign-up links follow the server config", async () => {
    const state = seedState({ me: null });
    const signedIn = seedState().me;
    const { auth } = createFakeAuth({ onSignIn: () => (state.me = signedIn) });
    const { router } = await renderApp(`/login?redirect=/org/${ORG_ID}/members`, { api: createFakeApi(state), auth });
    // auth-config of the fake: GitHub only, sign-up open.
    expect(screen().queryByRole("button", { name: "Continuar com Google" })).toBeNull();
    expect(screen().getByRole("button", { name: "Continuar com GitHub" })).toBeTruthy();
    expect(screen().getByRole("link", { name: "Criar conta" })).toBeTruthy();
    await type("E-mail", "walter@acme.com.br");
    await type("Senha", "correct horse");
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Entrar" })));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/members`);
  });
});

describe("Criar conta", () => {
  test("live password help and the button enables only when everything is valid", async () => {
    const { auth, calls } = createFakeAuth();
    const { router } = await renderApp("/signup", { api: createFakeApi(seedState({ me: null })), auth });
    const submit = screen().getByRole("button", { name: "Criar conta" });
    expect(screen().getByText("Pelo menos 8 caracteres.")).toBeTruthy();
    await type("Seu nome", "Walter");
    await type("E-mail de trabalho", "walter@acme.com.br");
    await type("Senha", "curta");
    expect(screen().getByText("Faltam 3 caracteres (mínimo de 8).").className).toBe("ac-field__error");
    expect(submit.hasAttribute("disabled")).toBe(true);
    await type("Senha", "senha-longa");
    expect(screen().getByText("Senha ok.")).toBeTruthy();
    expect(submit.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(submit));
    await settle(6);
    expect(calls[0]?.args[0]).toEqual({ name: "Walter", email: "walter@acme.com.br", password: "senha-longa" });
    expect(router.state.location.pathname).toBe("/login");
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
  const start = async () => {
    const state = seedState();
    if (state.me) state.me.organizations = [];
    const api = createFakeApi(state);
    const r = await renderApp("/onboarding", { api });
    return { ...r, api, state };
  };
  const button = (name: string | RegExp) => screen().getByRole("button", { name });
  const click = async (el: HTMLElement, rounds = 4) => {
    await act(async () => fireEvent.click(el));
    await settle(rounds);
  };
  const next = () => click(button("Continuar"), 6);
  const calls = (state: ReturnType<typeof seedState>, method: string) => state.calls.filter((c) => c.method === method);

  /** Workspace → Contexto → Agentes e chave, with Ada (the default) and Theo. */
  const throughAgents = async (state: ReturnType<typeof seedState>) => {
    expect(screen().getByText("Passo 1 de 6")).toBeTruthy();
    expect(screen().getByRole("heading", { name: "Comece pelo seu workspace" })).toBeTruthy();
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    await type("Nome", "Acme Saúde");
    await next();
    // The workspace exists after step 1 (so the logo can be sent); the time zone goes to its settings.
    expect(calls(state, "orgs.create")[0]?.args[0]).toEqual({ name: "Acme Saúde" });
    const zone = calls(state, "orgs.updateSettings")[0]?.args[1] as { timezone?: unknown };
    expect(typeof zone.timezone).toBe("string");

    expect(screen().getByRole("heading", { name: "O que todo agente deve saber" })).toBeTruthy();
    await type("Contexto", "A Acme Saúde faz um app para clínicas.");
    await next();
    expect(calls(state, "orgs.updateSettings")[1]?.args[1]).toEqual({
      context: "A Acme Saúde faz um app para clínicas.",
    });

    expect(screen().getByRole("heading", { name: "Escolha seus primeiros agentes" })).toBeTruthy();
    expect(button(/Ada · Dev/).getAttribute("aria-pressed")).toBe("true");
    await click(button(/Ada · Dev/), 1);
    expect(screen().getByText("Escolha pelo menos um agente.")).toBeTruthy();
    await click(button(/Ada · Dev/), 1);
    await click(button(/Theo · PM/), 1);
    expect(button(/Theo · PM/).getAttribute("aria-pressed")).toBe("true");
    expect(screen().getByText("2 agentes no #general.")).toBeTruthy();
    // The workspace key is required; the platform key isn't offered by this server.
    expect(screen().queryByRole("button", { name: /Usar créditos da plataforma/ })).toBeNull();
    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    expect(document.body.textContent).toContain("Começa com Claude Sonnet 5.5.");
    await type("Chave da API da Anthropic", "sk-errado");
    await act(async () => fireEvent.blur(screen().getByLabelText("Chave da API da Anthropic")));
    expect(document.body.textContent).toContain("As chaves da Anthropic começam com sk-ant-.");
    await click(button("Avançado"), 1);
    await type("ID do workspace da Anthropic", "wrkspc_01ABC");
    await type("Chave da API da Anthropic", "sk-ant-api03-abcdefghijklmnop");
    await next();
    await settle(4);
    expect(calls(state, "agents.addCredential")[0]?.args[1]).toEqual({
      provider: "anthropic",
      label: "Anthropic",
      apiKey: "[redacted]",
      workspaceId: "wrkspc_01ABC",
    });
    const cred = state.credentials[state.credentials.length - 1];
    expect(
      calls(state, "orgs.updateSettings").some(
        (c) => (c.args[1] as { defaultCredentialId?: string }).defaultCredentialId === cred?.id,
      ),
    ).toBe(true);
  };

  test("every chosen preset is created with its own look and joins #general", async () => {
    const { state } = await start();
    await throughAgents(state);
    const created = calls(state, "agents.create").map((c) => c.args[1] as Record<string, unknown>);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      name: "Theo",
      handle: "theo",
      role: "PM",
      model: "claude-sonnet-5-5",
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
    expect(screen().getByRole("heading", { name: "Onde os agentes trabalham" })).toBeTruthy();
    expect(screen().getByText("Passo 4 de 6 · opcional")).toBeTruthy();
  });

  test("computer: this computer creates a pairing, shows the command and connects live; team invites go out", async () => {
    const { state, api, services, router } = await start();
    await throughAgents(state);

    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    await click(button(/Este computador ou um servidor/), 8);
    expect(calls(state, "machines.createPairing")[0]?.args[1]).toEqual({ name: "Meu computador" });
    expect(document.querySelector(".machine-command__code")?.textContent).toContain(
      "install.sh | sh -s -- --code K7QM-4XTB",
    );
    expect(document.body.textContent).toContain("acrescente --no-exec ao final");
    expect(document.body.textContent).toContain("Esperando o computador conectar…");
    expect(screen().getByRole("radiogroup", { name: "Sistema" })).toBeTruthy();

    // The runner pairs; the list refreshes (polling, or an invalidation like here).
    fakeMachinesOf.get(api)?.pair({ name: "MacBook do Walter", os: "darwin" });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(6);
    expect(document.body.textContent).toContain("MacBook do Walter conectado · macOS.");
    await next();
    // Both agents now use the connected computer.
    expect(calls(state, "sandbox.setTarget")).toHaveLength(2);

    expect(screen().getByRole("heading", { name: "Chame quem trabalha com você" })).toBeTruthy();
    const link = screen().getByLabelText("Link de convite") as HTMLInputElement;
    expect(link.value).toMatch(/^http:\/\/localhost:3000\/invite\/link-/);
    const emails = screen().getByLabelText("E-mails");
    await act(async () =>
      fireEvent.change(emails, { target: { value: "Marina@acme.com.br, joao@acme.com.br\nnao-e-email" } }),
    );
    await act(async () => fireEvent.keyDown(emails, { key: "Enter" }));
    expect(button("Remover marina@acme.com.br")).toBeTruthy();
    expect(button("Remover joao@acme.com.br")).toBeTruthy();
    expect(button("Remover nao-e-email")).toBeTruthy();
    expect(screen().getByText("confira")).toBeTruthy();
    expect(screen().getByText("2 convites prontos")).toBeTruthy();
    await click(button("Remover joao@acme.com.br"), 1);
    await click(button("Convidar e continuar"), 8);
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
    const { state } = await start();
    await throughAgents(state);
    await click(button("Pular por agora"), 6);
    expect(calls(state, "machines.createPairing")).toHaveLength(0);
    expect(calls(state, "sandbox.setTarget")).toHaveLength(0);

    expect(screen().getByRole("heading", { name: "Chame quem trabalha com você" })).toBeTruthy();
    await next();
    expect(calls(state, "orgs.invite")).toHaveLength(0);
    expect(screen().getByRole("heading", { name: "Bem-vindo à Acme Saúde" })).toBeTruthy();
    const summary = document.querySelector(".onb__summary")?.textContent ?? "";
    expect(summary).toContain("Depois");
    expect(summary).toContain("Convites0");
    // The rail marks the steps done and lets you go back.
    const steps = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(steps.querySelectorAll("li[data-done]")).toHaveLength(5);
  });
});
