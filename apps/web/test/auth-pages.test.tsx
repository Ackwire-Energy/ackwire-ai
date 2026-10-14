import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
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
  test("4 steps create the org, the first agent in #general, and the invitations", async () => {
    const state = seedState();
    if (state.me) state.me.organizations = [];
    const api = createFakeApi(state);
    const { router } = await renderApp("/onboarding", { api });
    const next = () => act(async () => fireEvent.click(screen().getByRole("button", { name: "Continuar" })));

    expect(screen().getByText("Passo 1 de 4 · Organização")).toBeTruthy();
    expect(screen().getByRole("button", { name: "Continuar" }).hasAttribute("disabled")).toBe(true);
    await type("Nome da organização", "Acme Saúde");
    expect((screen().getByLabelText("Endereço") as HTMLInputElement).value).toBe("acme-saude");
    await next();
    await settle();

    expect(screen().getByRole("heading", { name: "Conte aos agentes sobre a Acme Saúde" })).toBeTruthy();
    await type("Contexto da organização", "A Acme Saúde faz um app para clínicas.");
    await next();
    await settle(4);
    expect(state.calls.find((c) => c.method === "orgs.create")?.args[0]).toEqual({
      name: "Acme Saúde",
      context: "A Acme Saúde faz um app para clínicas.",
    });

    expect(screen().getByRole("heading", { name: "Chame o primeiro agente" })).toBeTruthy();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /Ada · Dev/ })));
    expect(
      screen()
        .getByRole("button", { name: /Ada · Dev/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await act(async () => fireEvent.click(screen().getByRole("radio", { name: /Chave da Acme Saúde/ })));
    expect(screen().getByRole("button", { name: "Continuar" }).hasAttribute("disabled")).toBe(true);
    await type("Chave da API da Anthropic", "sk-ant-api-123456");
    await next();
    await settle(4);
    const created = state.calls.find((c) => c.method === "agents.create")?.args[1] as Record<string, unknown>;
    expect(created).toMatchObject({ name: "Ada", handle: "ada", role: "Dev" });
    expect(created.credentialId).toBeTruthy();
    expect(state.calls.some((c) => c.method === "chat.addMember")).toBe(true);

    expect(screen().getByText("Ada já está esperando no #general. Chame quem vai trabalhar com ela.")).toBeTruthy();
    await type("E-mail", "marina@acme.com.br");
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Adicionar" })));
    await type("E-mail", "não-é-email");
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Adicionar" })));
    expect(screen().getByText("Confira o e-mail: falta algo como nome@empresa.com.br.")).toBeTruthy();
    expect(screen().getByRole("button", { name: "Remover marina@acme.com.br" })).toBeTruthy();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Enviar 1 convite e entrar" })));
    await settle(6);
    expect(state.calls.find((c) => c.method === "orgs.invite")?.args[1]).toEqual({
      email: "marina@acme.com.br",
      role: "member",
    });
    expect(router.state.location.pathname).toMatch(/^\/org\/org-\d+\/c\/chan-\d+$/);
  });
});
