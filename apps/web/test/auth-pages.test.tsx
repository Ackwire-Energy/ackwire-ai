import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
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

  /** Workspace → Contexto, up to "Trazer seus agentes". */
  const throughContext = async (state: ReturnType<typeof seedState>) => {
    expect(screen().getByText("Passo 1 de 7")).toBeTruthy();
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
    expect(screen().getByRole("heading", { name: "Trazer seus agentes de outro lugar" })).toBeTruthy();
    expect(screen().getByText("Passo 3 de 7 · opcional")).toBeTruthy();
  };

  /** Workspace → Contexto → (no import) → Agentes e chave, with Ada (the default) and Theo. */
  const throughAgents = async (state: ReturnType<typeof seedState>) => {
    await throughContext(state);
    // Optional: continuing without a source brings nothing.
    await next();

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
    expect(screen().getByText("Passo 5 de 7 · opcional")).toBeTruthy();
  });

  test("computer: this computer shows how to connect it (app or terminal) and connects live; team invites go out", async () => {
    const { state, api, services, router } = await start();
    await throughAgents(state);

    expect(button("Continuar").hasAttribute("disabled")).toBe(true);
    await click(button(/Este computador ou um servidor/), 8);
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
    await next();
    // Both agents now use the connected computer.
    expect(calls(state, "sandbox.setTarget")).toHaveLength(2);

    expect(screen().getByRole("heading", { name: "Chame quem trabalha com você" })).toBeTruthy();
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
    expect(steps.querySelectorAll("li[data-done]")).toHaveLength(6);
  });

  const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "agent-import", name), "utf8");
  const pickFiles = async (files: File[]) => {
    const input = document.querySelector('.onb__main input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    await act(async () => fireEvent.change(input));
    await settle(8);
  };
  const keyAndContinue = async () => {
    await type("Chave da API da Anthropic", "sk-ant-api03-abcdefghijklmnop");
    await next();
    await settle(4);
  };

  test("import: an OpenMausBot team file → what was found → the agents step prefilled → created with their instructions", async () => {
    const { state } = await start();
    await throughContext(state);
    expect(button(/Começar do zero/).getAttribute("aria-pressed")).toBe("false");
    await click(button(/OpenMausBot/), 1);
    expect(button(/OpenMausBot/).getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Compartilhar time… → Salvar arquivo");

    await pickFiles([new File([fixture("sales-desk.openmaus.json")], "sales-desk.openmaus.json")]);
    expect(screen().getByRole("heading", { name: "Sales desk" })).toBeTruthy();
    const bring = (name: string) => screen().getByRole("checkbox", { name: `Trazer ${name}` });
    for (const name of ["Morgan", "Scout", "Quill"]) expect(bring(name).getAttribute("aria-checked")).toBe("true");
    const text = document.body.textContent ?? "";
    expect(text).toContain("O que não vem junto");
    expect(text).toContain("pricing-policy, research-brief, objection-handling");
    expect(text).toContain("Daily digest (Scout), Weekly pipeline review (Morgan)");
    expect(text).toContain("CRM (mcp.example.com)");
    expect(text).toContain("Chaves, senhas e histórico de conversa nunca vêm.");
    expect(text).toContain("Os agentes chegam com o modelo e a chave do workspace");
    // Nothing is saved while reading.
    expect(calls(state, "agents.create")).toHaveLength(0);

    await click(bring("Quill"), 1);
    expect(bring("Quill").getAttribute("aria-checked")).toBe("false");
    await next();

    expect(screen().getByRole("heading", { name: "Seus agentes, e mais alguém?" })).toBeTruthy();
    expect(button(/Morgan · Sales lead/).getAttribute("aria-pressed")).toBe("true");
    expect(button(/Scout · Prospect researcher/).getAttribute("aria-pressed")).toBe("true");
    expect(button(/Quill · Outreach writer/).getAttribute("aria-pressed")).toBe("false");
    expect(button(/Ada · Dev/).getAttribute("aria-pressed")).toBe("true");
    expect(screen().getByText("3 agentes no #general.")).toBeTruthy();
    await keyAndContinue();

    const created = calls(state, "agents.create").map((c) => c.args[1] as Record<string, unknown>);
    expect(created.map((a) => a.name)).toEqual(["Ada", "Morgan", "Scout"]);
    expect(created[1]).toMatchObject({
      name: "Morgan",
      handle: "lead",
      role: "Sales lead",
      model: "claude-sonnet-5-5",
      credentialId: null,
      appearance: { color: "violet" },
    });
    expect(String(created[1]?.instructions)).toStartWith(
      "You coordinate the desk. Keep answers short and cite the price list.\n\n## Qualify a lead",
    );
    expect(created[2]).toMatchObject({ handle: "scout", role: "Prospect researcher", appearance: { color: "sky" } });
    expect(calls(state, "chat.addMember")).toHaveLength(3);
    expect(screen().getByRole("heading", { name: "Onde os agentes trabalham" })).toBeTruthy();

    // They're in the crew at the end.
    await click(button("Pular por agora"), 6);
    await next();
    expect(document.body.textContent).toContain("Ada, Morgan e Scout já estão no #general.");
  });

  test("import: an OpenBot GitHub link is read by the backend; a bad link says so; starting from scratch drops it", async () => {
    const { state } = await start();
    const url = "https://github.com/acme/pacote/tree/main/tenant";
    state.githubFiles = {
      [url]: [
        { path: "agents.yaml", text: fixture("agents.yaml") },
        { path: "model.yaml", text: fixture("model.yaml") },
      ],
    };
    await throughContext(state);
    await click(button(/OpenBot/), 1);

    await type("Ou um link público do GitHub", "https://github.com/acme/nada/blob/main/agents.yaml");
    await click(button("Ler link"), 8);
    expect(screen().getByRole("alert").textContent).toContain("Não deu para ler esse link");

    await type("Ou um link público do GitHub", url);
    await click(button("Ler link"), 8);
    expect(calls(state, "agents.importFromGithub").at(-1)?.args[1]).toBe(url);
    expect(screen().getByRole("heading", { name: "agents.yaml, model.yaml" })).toBeTruthy();
    expect(screen().getByRole("checkbox", { name: "Trazer General Assistant" })).toBeTruthy();
    expect(screen().getByRole("checkbox", { name: "Trazer Knowledge" })).toBeTruthy();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Risk Analyst (remote-ag-ui), Your Bot (remote-ag-ui)");
    expect(text).toContain("openai · gpt-5.6-terra");
    expect(text).toContain("openai-api-key");

    // Start from scratch: nothing imported reaches the agents step.
    await click(button(/Começar do zero/), 1);
    expect(screen().queryByRole("checkbox", { name: "Trazer Knowledge" })).toBeNull();
    await next();
    expect(screen().getByRole("heading", { name: "Escolha seus primeiros agentes" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: /Knowledge · Company Knowledge/ })).toBeNull();
    await keyAndContinue();
    expect(calls(state, "agents.create").map((c) => (c.args[1] as { name: string }).name)).toEqual(["Ada"]);
  });

  test("import: a file that isn't a team file is refused; skipping the step clears the source", async () => {
    const { state } = await start();
    await throughContext(state);
    await click(button(/OpenMausBot/), 1);
    await pickFiles([new File([fixture("agents.yaml")], "agents.yaml")]);
    expect(screen().getByRole("alert").textContent).toContain("Isso não parece um arquivo de time do OpenMausBot");
    await click(button("Pular por agora"), 6);
    expect(screen().getByRole("heading", { name: "Escolha seus primeiros agentes" })).toBeTruthy();
  });
});
