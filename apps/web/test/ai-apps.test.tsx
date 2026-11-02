import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AuditRow, Message } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import {
  claudeCodeCommand,
  codexCommands,
  cursorConfig,
  cursorInstallLink,
  vscodeConfig,
  vscodeInstallLink,
} from "@agenteschat/client/lib/app-clients";
import {
  appFacts,
  appMark,
  appName,
  appsSettingsUrl,
  consentErrorOf,
  consentErrorParam,
  tokenFacts,
} from "@agenteschat/client/lib/apps";
import { auditPhrase } from "@agenteschat/client/lib/audit";
import { signInFor } from "@agenteschat/client/lib/guards";
import { visibleText } from "@agenteschat/client/lib/text";
import { appVia } from "@agenteschat/client/lib/via";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createI18n } from "@/i18n";
import { ADA_ID, createFakeApi, ENG_ID, type FakeState, fakeAppsOf, meWithRole, ORG_ID, seedState } from "./fake-api";
import { type FakeApps, SERVER_URL } from "./fakes/apps";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const copied: string[] = [];
beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (s: string) => void copied.push(s) },
  });
});

const go = async (state: FakeState = seedState(), setup?: (apps: FakeApps) => void) => {
  const api = createFakeApi(state);
  const apps = fakeAppsOf.get(api) as FakeApps;
  setup?.(apps);
  const r = await renderApp(`/org/${ORG_ID}/settings/apps`, { api });
  await settle(6);
  return { ...r, state, apps };
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await settle(2);
};
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await key(trigger, "Enter");
  return within(screen().getByRole("menu"));
};
const pickTab = async (tab: HTMLElement) => {
  tab.focus();
  await key(tab, "Enter");
  await act(async () => fireEvent.mouseDown(tab));
  await settle(4);
};
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method).map((c) => c.args);
const section = () => within(document.querySelector(".settings__body") as HTMLElement);
const dialog = () => within(screen().getByRole("dialog"));
const t = createI18n("pt-BR").t;

describe("the client facts: one command, link or file per app, with this server's address", () => {
  const url = "https://agentes.example/mcp";
  test("commands and files", () => {
    expect(claudeCodeCommand(url)).toBe("claude mcp add --transport http agentes https://agentes.example/mcp");
    expect(codexCommands(url)).toBe("codex mcp add agentes --url https://agentes.example/mcp\ncodex mcp login agentes");
    expect(JSON.parse(cursorConfig(url))).toEqual({ mcpServers: { agentes: { url } } });
    expect(JSON.parse(vscodeConfig(url))).toEqual({ servers: { agentes: { type: "http", url } } });
  });

  test("Cursor's install link carries the config as base64 JSON; VS Code's as URL-encoded JSON", () => {
    const cursor = new URL(cursorInstallLink(url));
    expect(`${cursor.protocol}//${cursor.host}${cursor.pathname}`).toBe(
      "cursor://anysphere.cursor-deeplink/mcp/install",
    );
    expect(cursor.searchParams.get("name")).toBe("agentes");
    expect(JSON.parse(atob(cursor.searchParams.get("config") ?? ""))).toEqual({ url });
    const vscode = vscodeInstallLink(url);
    expect(vscode.startsWith("vscode:mcp/install?")).toBe(true);
    expect(JSON.parse(decodeURIComponent(vscode.slice("vscode:mcp/install?".length)))).toEqual({
      name: "agentes",
      type: "http",
      url,
    });
  });
});

describe("apps in words", () => {
  test("a mark only from a verified brand; a program on this computer is the computer; else one letter", () => {
    expect(appMark({ brand: "claude", displayKind: "verified", name: "Claude" })).toEqual({
      kind: "brand",
      id: "claude",
    });
    expect(appMark({ brand: "cursor", displayKind: "app_scheme", name: "Cursor" })).toEqual({
      kind: "brand",
      id: "cursor",
    });
    expect(appMark({ brand: null, displayKind: "loopback", name: "Claude Code" })).toEqual({ kind: "computer" });
    // An unverified "Claude" never draws Claude's mark.
    expect(appMark({ brand: null, displayKind: "https", name: "claude" })).toEqual({ kind: "initial", letter: "C" });
    expect(appMark({ brand: "evil", displayKind: "https", name: "" })).toEqual({ kind: "initial", letter: "?" });
  });

  test("a long name is cut at 40 characters with the whole of it kept; a short one stays whole", () => {
    expect(appName("Claude")).toEqual({ short: "Claude", full: null });
    const long = "A".repeat(50);
    expect(appName(long)).toEqual({ short: `${"A".repeat(40)}…`, full: long });
  });

  test("invisible characters in an address are written out", () => {
    expect(visibleText("claude.ai\u202e")).toBe("claude.ai\\u{202e}");
    expect(visibleText("loc\u200balhost:3000")).toBe("loc\\u{200b}alhost:3000");
    expect(visibleText("cursor://anysphere.cursor-mcp")).toBe("cursor://anysphere.cursor-mcp");
  });

  test("the consent page's states from the server's errors and its ?erro=", () => {
    expect(consentErrorParam("endereco_de_retorno")).toBe("endereco_de_retorno");
    expect(consentErrorParam("<script>")).toBeNull();
    expect(consentErrorOf(new ApiError(404, "request_unknown", ""))).toBe("expirado");
    expect(consentErrorOf(new ApiError(409, "request_used", ""))).toBe("expirado");
    expect(consentErrorOf(new ApiError(410, "request_expired", ""))).toBe("expirado");
    expect(consentErrorOf(new ApiError(409, "workspace_paused", ""))).toBe("workspace_paused");
    expect(consentErrorOf(new ApiError(403, "not_member", ""))).toBe("not_member");
    expect(consentErrorOf(new ApiError(429, "rate_limited", ""))).toBe("muitas_tentativas");
    expect(consentErrorOf(new Error("boom"))).toBe("indisponivel");
  });

  test("a row's facts, the via tag's reading, the audit's sentences, the sign-in's purpose", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    const app = {
      id: "a",
      kind: "oauth" as const,
      displayKind: "loopback" as const,
      name: "Claude Code",
      host: null,
      brand: null,
      access: "write" as const,
      connectedAt: "2026-11-01T11:00:00Z",
      lastUsedAt: null,
    };
    expect(appFacts(t, "pt-BR", app, now)).toBe("neste computador · Conectado há 1 h · Nunca usado");
    expect(
      tokenFacts(
        t,
        "pt-BR",
        {
          id: "t",
          name: "Blender",
          access: "read",
          createdAt: "",
          expiresAt: null,
          lastUsedAt: "2026-11-01T11:59:30Z",
        },
        now,
      ),
    ).toBe("Sem validade · Usado agora");
    expect(appVia({ via: { kind: "app", grantId: "g", name: "Claude", brand: "claude", host: "claude.ai" } })).toEqual({
      name: "Claude",
      brand: "claude",
    });
    expect(appVia({ via: { kind: "routine", name: "x" } })).toBeNull();
    expect(appVia({})).toBeNull();
    const row = (action: string, details: Record<string, unknown>) =>
      ({ action, details, actor: { type: "person", id: "u", name: "Ana" }, target: {} }) as unknown as AuditRow;
    expect(auditPhrase(t, row("apps.connected", { app: "Claude" }))).toBe("Conectou o Claude");
    expect(auditPhrase(t, row("apps.scopes_changed", { app: "Claude" }))).toBe("Deixou o Claude mandar tarefas");
    expect(auditPhrase(t, row("apps.message_sent", { client: "Cursor" }))).toBe("Mandou uma mensagem pelo Cursor");
    expect(auditPhrase(t, row("apps.token_revoked", { app: "Blender" }))).toBe("Revogou o token pessoal Blender");
    expect(signInFor("/autorizar?req=abc")).toEqual({ authorize: "app" });
    expect(appsSettingsUrl("https://agentes.example/", ORG_ID)).toBe(
      `https://agentes.example/org/${ORG_ID}/settings/apps`,
    );
  });
});

describe("Configurações › Apps de IA (ADR 0113)", () => {
  test("its own section under Você, the server's address with Copiar, the empty state and the tokens shown at once", async () => {
    copied.length = 0;
    await go();
    const nav = screen().getByRole("navigation", { name: "Seções das configurações" });
    expect(within(nav).getByRole("link", { name: "Apps de IA" }).getAttribute("aria-current")).toBe("page");
    expect(section().getByRole("heading", { level: 2, name: "Apps de IA" })).toBeTruthy();
    const server = section().getByRole("region", { name: "Endereço do servidor" });
    expect(server.textContent).toContain(SERVER_URL);
    await click(within(server).getByRole("button", { name: "Copiar" }));
    expect(copied).toEqual([SERVER_URL]);
    expect(document.body.textContent).toContain("Endereço copiado");
    expect(section().getByText(/Nenhum app conectado/)).toBeTruthy();
    expect(section().queryByRole("region", { name: "Conectados" })).toBeNull();
    const tokens = section().getByRole("region", { name: "Tokens pessoais" });
    expect(tokens.textContent).toContain("Para scripts e apps sem login OAuth. Valem só neste workspace.");
    expect(tokens.textContent).toContain("Nenhum token criado.");
  });

  test("Conectar um app: a card per app with its official mark, each app's exact steps with this server's address", async () => {
    await go();
    await click(section().getAllByRole("button", { name: "Conectar um app" })[0] as HTMLElement);
    const cards = dialog()
      .getAllByRole("button")
      .filter((b) => b.classList.contains("apps-client"));
    expect(cards.map((c) => c.querySelector(".apps-client__name")?.textContent)).toEqual([
      "Claude",
      "Claude Code",
      "ChatGPT",
      "Cursor",
      "Outro app",
    ]);
    expect(cards.map((c) => c.querySelector(".ac-brand")?.getAttribute("data-mark") ?? null)).toEqual([
      "claude",
      "claude",
      "openai",
      "cursor",
      null,
    ]);

    await click(cards[1] as HTMLElement);
    expect(dialog().getByRole("heading", { name: "Claude Code" })).toBeTruthy();
    expect(screen().getByRole("dialog").textContent).toContain(claudeCodeCommand(SERVER_URL));
    expect(screen().getByRole("dialog").querySelector("code")?.textContent).toBeTruthy();
    expect([...screen().getByRole("dialog").querySelectorAll("li code")].map((c) => c.textContent)).toContain("/mcp");
    expect(screen().getByRole("dialog").textContent).toContain("Esperando o app se conectar");
    await click(dialog().getByRole("button", { name: "Voltar para os apps" }));

    await click(dialog().getByRole("button", { name: /^Claude claude\.ai/ }));
    const open = dialog().getByRole("link", { name: "Abrir o Claude" });
    expect(open.getAttribute("href")).toBe("https://claude.ai/settings/connectors");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(screen().getByRole("dialog").textContent).toContain("Adicionar conector personalizado");
    expect(screen().getByRole("dialog").textContent).toContain(SERVER_URL);
    await click(dialog().getByRole("button", { name: "Voltar para os apps" }));

    await click(dialog().getByRole("button", { name: /^Cursor/ }));
    expect(dialog().getByRole("link", { name: "Adicionar ao Cursor" }).getAttribute("href")).toBe(
      cursorInstallLink(SERVER_URL),
    );
    expect(screen().getByRole("dialog").textContent).toContain("~/.cursor/mcp.json");
    await click(dialog().getByRole("button", { name: "Voltar para os apps" }));

    await click(dialog().getByRole("button", { name: /^Outro app/ }));
    expect(dialog().getByRole("link", { name: "Adicionar ao VS Code" }).getAttribute("href")).toBe(
      vscodeInstallLink(SERVER_URL),
    );
    await pickTab(dialog().getByRole("tab", { name: "Codex" }));
    expect(screen().getByRole("dialog").textContent).toContain("codex mcp login agentes");
  });

  test("the new app shows in the dialog once its sign-in is done; Concluir lists it, with its access and its times", async () => {
    const { apps, services } = await go();
    await click(section().getAllByRole("button", { name: "Conectar um app" })[0] as HTMLElement);
    await click(dialog().getByRole("button", { name: /^Claude claude\.ai/ }));
    apps.connect({ name: "Claude", brand: "claude", host: "claude.ai", displayKind: "verified" });
    // The dialog asks every 5 s; a refetch stands for the next one here.
    await act(() => services.queryClient.refetchQueries({ queryKey: ["org", ORG_ID, "apps"] }));
    await settle(4);
    expect(screen().getByRole("dialog").textContent).toContain("Conectado: Claude");
    await click(dialog().getByRole("button", { name: "Concluir" }));
    const list = section().getByRole("region", { name: "Conectados" });
    expect(list.textContent).toContain("Claude");
    expect(list.textContent).toContain("Lê e manda tarefas");
    expect(list.textContent).toContain("claude.ai · Conectado agora · Nunca usado");
    expect(list.querySelector(".ac-brand")?.getAttribute("data-mark")).toBe("claude");
  });

  test("Desconectar asks first, then the app loses access", async () => {
    const { state } = await go(seedState(), (apps) => {
      apps.connect({ name: "Claude Code", displayKind: "loopback", access: "read" });
    });
    const list = section().getByRole("region", { name: "Conectados" });
    expect(list.textContent).toContain("Só leitura");
    expect(list.textContent).toContain("neste computador");
    await click(
      (await openMenu(within(list).getByRole("button", { name: "Opções de Claude Code" }))).getByRole("menuitem", {
        name: "Desconectar",
      }),
    );
    expect(dialog().getByRole("heading", { name: "Desconectar Claude Code?" })).toBeTruthy();
    expect(screen().getByRole("dialog").textContent).toContain(
      "Ele perde o acesso agora, em todos os computadores onde está conectado.",
    );
    await click(dialog().getByRole("button", { name: "Desconectar" }));
    expect(calls(state, "apps.disconnect")).toHaveLength(1);
    expect(section().queryByRole("region", { name: "Conectados" })).toBeNull();
    expect(document.body.textContent).toContain("Claude Code desconectado");
  });

  test("Criar token: shown once, Já copiei only after copying, then listed; Revogar asks first", async () => {
    copied.length = 0;
    const { state } = await go();
    await click(section().getByRole("button", { name: "Criar token" }));
    const create = dialog();
    const submit = create.getByRole("button", { name: "Criar token" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    await act(async () => fireEvent.change(create.getByLabelText("Nome"), { target: { value: "Script do Blender" } }));
    await click(create.getByRole("radio", { name: /Só ler/ }));
    await click(submit);
    expect(calls(state, "apps.createToken")).toEqual([
      [ORG_ID, { name: "Script do Blender", access: "read", expiresInDays: 90 }],
    ]);
    expect(dialog().getByRole("heading", { name: "Token criado" })).toBeTruthy();
    expect(screen().getByRole("dialog").textContent).toContain("Copie agora. Ele não aparece de novo.");
    const done = dialog().getByRole("button", { name: "Já copiei" });
    expect(done.hasAttribute("disabled")).toBe(true);
    // Before copying, Esc and a press outside keep the token on screen and ask first.
    await key(screen().getByRole("dialog"), "Escape");
    await act(async () => {
      fireEvent.pointerDown(document.body);
      fireEvent.pointerUp(document.body);
    });
    await settle(4);
    expect(screen().getByRole("dialog").textContent).toContain("agp_FAKEFAKE");
    expect(screen().getByRole("dialog").textContent).toContain("Fechar sem copiar? O token não aparece de novo");
    expect(dialog().getByRole("button", { name: "Fechar sem copiar" })).toBeTruthy();
    await click(dialog().getByRole("button", { name: "Copiar token" }));
    expect(copied).toEqual(["agp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK"]);
    expect(dialog().getByRole("button", { name: "Já copiei" }).hasAttribute("disabled")).toBe(false);
    await click(dialog().getByRole("button", { name: "Já copiei" }));
    expect(screen().queryByRole("dialog")).toBeNull();
    const tokens = section().getByRole("region", { name: "Tokens pessoais" });
    expect(tokens.textContent).toContain("Script do Blender");
    expect(tokens.textContent).toContain("Só leitura");
    expect(tokens.textContent).toContain("Expira em");
    expect(tokens.textContent).not.toContain("agp_");

    await click(
      (await openMenu(within(tokens).getByRole("button", { name: "Opções de Script do Blender" }))).getByRole(
        "menuitem",
        { name: "Revogar" },
      ),
    );
    expect(dialog().getByRole("heading", { name: "Revogar Script do Blender?" })).toBeTruthy();
    await click(dialog().getByRole("button", { name: "Revogar" }));
    expect(calls(state, "apps.revokeToken")).toHaveLength(1);
    expect(section().getByRole("region", { name: "Tokens pessoais" }).textContent).toContain("Nenhum token criado.");
  });

  test("past 10 tokens the dialog says so, and nothing is created", async () => {
    const { apps } = await go(seedState(), (fake) => {
      for (let i = 0; i < 10; i++)
        fake.tokens.push({
          id: `t${i}`,
          name: `Token ${i}`,
          access: "write",
          createdAt: "",
          expiresAt: null,
          lastUsedAt: null,
        });
    });
    await click(section().getByRole("button", { name: "Criar token" }));
    await act(async () => fireEvent.change(dialog().getByLabelText("Nome"), { target: { value: "Mais um" } }));
    await click(dialog().getByRole("button", { name: "Criar token" }));
    expect(screen().getByRole("dialog").textContent).toContain(
      "Você chegou a 10 tokens neste workspace. Revogue um para criar outro.",
    );
    expect(apps.tokens).toHaveLength(10);
  });

  test("a token the server wants a fresh sign-in for: says so, with Entrar de novo in place of Criar token", async () => {
    const { apps } = await go();
    await click(section().getByRole("button", { name: "Criar token" }));
    await act(async () => fireEvent.change(dialog().getByLabelText("Nome"), { target: { value: "Backup" } }));
    apps.nextError = new ApiError(403, "reauth.sign_in", "Sign in again");
    await click(dialog().getByRole("button", { name: "Criar token" }));
    expect(screen().getByRole("dialog").textContent).toContain("Um token sem validade pede uma entrada recente.");
    expect(dialog().getByRole("button", { name: "Entrar de novo" })).toBeTruthy();
    expect(dialog().queryByRole("button", { name: "Criar token" })).toBeNull();
    expect(apps.tokens).toHaveLength(0);
  });

  test("who manages members: Meus and Todo o workspace, with whose each app is and no creating there", async () => {
    const state = seedState();
    await go(state, (apps) => {
      apps.connect({ name: "Cursor", brand: "cursor", displayKind: "app_scheme" });
    });
    await pickTab(section().getByRole("tab", { name: "Todo o workspace" }));
    expect(calls(state, "apps.list").at(-1)).toEqual([ORG_ID, true]);
    const list = section().getByRole("region", { name: "Conectados" });
    expect(list.textContent).toContain("De João");
    expect(section().queryByRole("button", { name: "Criar token" })).toBeNull();
    await click(
      (await openMenu(within(list).getByRole("button", { name: "Opções de Cursor" }))).getByRole("menuitem", {
        name: "Desconectar",
      }),
    );
    expect(screen().getByRole("dialog").textContent).toContain("A pessoa não é avisada.");
  });

  test("a member without manage_members sees only their own", async () => {
    const state = seedState();
    meWithRole(state, ["read", "post"]);
    await go(state);
    expect(section().queryByRole("tab", { name: "Todo o workspace" })).toBeNull();
    expect(calls(state, "apps.list").every((args) => args[1] === false)).toBe(true);
  });
});

describe("a message sent through an AI app", () => {
  test("says via {app} beside the person's name, with the app's mark and who sent it on hover", async () => {
    const state = seedState();
    const me = state.me?.user.id ?? "";
    const message = (id: string, via: Record<string, unknown> | null, author: Message["author"]) =>
      ({
        id,
        channelId: ENG_ID,
        threadId: null,
        author,
        body: `mensagem ${id}`,
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        meta: via ? { via } : {},
      }) as Message;
    state.messages = [
      message(
        "m1",
        { kind: "app", grantId: "g", name: "Claude", brand: "claude", host: "claude.ai" },
        { type: "person", id: me },
      ),
      message(
        "m2",
        { kind: "app", grantId: "g2", name: "Script do Blender", brand: null, host: null },
        { type: "person", id: me },
      ),
      // Only people's messages: an agent's meta never draws it.
      message(
        "m3",
        { kind: "app", grantId: "g3", name: "Forjado", brand: null, host: null },
        { type: "agent", id: ADA_ID },
      ),
    ];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const tags = [...document.querySelectorAll(".msg-via")] as HTMLElement[];
    expect(tags.map((tag) => tag.textContent)).toEqual(["via Claude", "via Script do Blender"]);
    expect(tags[0]?.querySelector(".ac-brand")?.getAttribute("data-mark")).toBe("claude");
    expect(tags[0]?.getAttribute("title")).toBe("Enviada por Walter pelo Claude, um app conectado");
    expect(tags[1]?.querySelector(".ac-brand")).toBeNull();
    expect(document.body.textContent).not.toContain("via Forjado");
  });
});
