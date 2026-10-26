import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, AiComputer, ComputerSetup, MachineAccount } from "@agenteschat/client";
import { ApiError, keys } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

const MAC: AiComputer = {
  machineId: "machine_1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};

const account = (over: Partial<MachineAccount> = {}): MachineAccount => ({
  id: "acct_new",
  kind: "claude_code",
  label: "GLM Coding",
  email: null,
  plan: null,
  status: "active",
  ownerId: "u-walter",
  ownerName: "Walter",
  mine: true,
  usedBy: [],
  usage: null,
  provider: "zai",
  keyHint: "MnOp",
  ...over,
});

/** The sign-in window: the page opens it on the click, then sends it to the provider's page. */
async function withPopup(run: () => Promise<void>) {
  const realOpen = window.open;
  const opened: string[] = [];
  const popup = { closed: false, opener: {}, location: { href: "" }, close: () => {} };
  window.open = ((url: string) => {
    opened.push(url);
    return popup;
  }) as unknown as typeof window.open;
  try {
    await run();
  } finally {
    window.open = realOpen;
  }
  return { opened, popup };
}

/**
 * Settings › AI accounts with Ada (Walter's) on the MacBook, a computer someone else connected for the workspace
 * (`brain`: Ada's view), and "Conectar uma IA" opened. `setup`: the workspace gets its own computer, this far.
 */
async function connect({
  computers = [MAC],
  setup,
  brain = {},
  mine = [ADA_ID],
  path = `/org/${ORG_ID}/settings/keys`,
}: {
  computers?: AiComputer[];
  setup?: Partial<ComputerSetup>;
  brain?: Partial<AgentBrain>;
  /** Walter's agents (a plan thinks only for its owner's). */
  mine?: string[];
  /** Where the dialog opens: Settings' button, or a link that asks for it. */
  path?: string;
} = {}) {
  const state = seedState();
  for (const a of state.agents) if (mine.includes(a.id)) a.ownerUserId = "u-walter";
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api);
  if (setup) machines?.setSetup(setup);
  else machines?.pair({ id: "machine_1", name: "MacBook", agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }] });
  machines?.setAiAccounts({ accounts: [], computers });
  const viewOf = api.agents.brain;
  api.agents.brain = async (orgId, agentId) => ({ ...(await viewOf(orgId, agentId)), ownSignIn: false, ...brain });
  const { router, services } = await renderApp(path, { api });
  await settle(6);
  if (!path.includes("connect=ai")) await click(screen().getByRole("button", { name: "Conectar uma IA" }));
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
  // The picker's options (the API key's makers are tiles too, in their own group).
  const picker = within(dialog).getByRole("group", { name: "Qual IA eles vão usar?" });
  const tile = (name: string) => within(picker).getByRole("button", { name: new RegExp(`^${name}`) });
  return { state, api, machines, dialog, tile, router, services };
}

const calls = (state: ReturnType<typeof seedState>, method: string) => state.calls.filter((c) => c.method === method);
/** A Claude plan's account, as the computer reports it once the sign-in ends. */
const claudeMax = account({ id: "acct_max", label: "Claude Max", provider: null, keyHint: null });

describe("Conectar uma IA: one picker, plans first", () => {
  test("Settings › AI accounts opens the same picker: six plans, then the API key, Claude chosen with its sign-in", async () => {
    const { dialog, tile } = await connect();
    const group = within(dialog).getByRole("group", { name: "Qual IA eles vão usar?" });
    const tiles = within(group)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(tiles).toEqual([
      "Claude",
      "ChatGPT",
      "GLM Coding",
      "Kimi Code",
      "MiniMax",
      "OpenCode Go",
      "Chave de APIClaude, OpenAI, DeepSeek, Kimi, Z.ai ou MiniMax",
    ]);
    // Each by its maker's mark; the key row by four of them, overlapped.
    expect([...group.querySelectorAll(".ac-brand--sm")].map((m) => m.getAttribute("data-mark"))).toEqual([
      "claude",
      "openai",
      "zai",
      "kimi",
      "minimax",
      "opencode",
    ]);
    const stack = tile("Chave de API").querySelector(".ac-brand-stack");
    expect([...(stack?.querySelectorAll(".ac-brand") ?? [])].map((m) => m.getAttribute("data-mark"))).toEqual([
      "claude",
      "openai",
      "deepseek",
      "kimi",
    ]);
    expect(dialog.textContent).toContain("Ou pague pelo uso");
    expect(tile("Claude").getAttribute("aria-pressed")).toBe("true");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("Pro, Max, Team ou Enterprise");
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    // The sign-in step is its title, its ⓘ and its button: what to do on the wrong account and where the account
    // stays are the ⓘ's. How the agent treats everyone else stays in view, once, under the steps.
    expect(hintOf("Entre no Claude com a conta que vai usar", panel)).toMatchObject({
      text: "Conta errada? Saia de lá e tente de novo. A conta fica só no MacBook: o agentes.chat nunca vê a senha nem o acesso.",
      hidden: true,
    });
    expect(shownText(panel)).not.toMatch(/Abre a página|nunca vê a senha/);
    expect(shownText(panel).split("A Ada vai responder só a você.")).toHaveLength(2);
    // A first sign-in asks for no account, and nothing asks for a computer or a name.
    expect(within(panel).queryByLabelText("Qual conta? (opcional)")).toBeNull();
    expect(dialog.textContent).not.toContain("Em qual computador?");
    // Until something is connected the body is the dialog's last part: its own edge under the panel, no footer.
    expect(dialog.querySelector(".ac-dialog__body:last-child")).not.toBeNull();
    expect(dialog.querySelector(".ac-dialog__footer")).toBeNull();
  });

  test("a coding plan's key: its own key page, then the key sealed to the computer (in no request); the agent thinks with it", async () => {
    const { state, machines, dialog, tile } = await connect();
    machines?.endLogin("login_1", { state: "done", account: account() });
    await click(tile("GLM Coding"));
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    expect(panel.textContent).toContain("Lite, Pro ou Max");
    expect(within(panel).getByRole("link", { name: "Abrir z.ai" }).getAttribute("href")).toBe(
      "https://z.ai/manage-apikey/apikey-list",
    );
    // Each step is its title and its control: the team plan's key and where the key goes are their ⓘ, and the
    // field is described by its own.
    expect(hintOf("Crie a chave do seu plano", panel).text).toBe(
      "Num plano de equipe, use a chave da página Team Plan.",
    );
    const safe = hintOf("Cole a chave aqui", panel);
    expect(safe.text).toBe("A chave vai criptografada para o MacBook e fica só lá. O agentes.chat não consegue lê-la.");
    expect(shownText(panel)).not.toMatch(/Fica em|Num plano de equipe|criptografada/);
    expect(within(panel).getByLabelText("Chave do GLM Coding").getAttribute("aria-describedby")).toBe(
      safe.button.getAttribute("aria-describedby"),
    );
    // Nothing starts on the computer until the key is there; a paste that isn't a key says so.
    expect(machines?.lastLogin()).toBeUndefined();
    const keyBox = within(panel).getByLabelText("Chave do GLM Coding");
    await type(keyBox, "short");
    expect(panel.textContent).toContain("Isso não parece uma chave do GLM Coding.");
    const KEY = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp";
    await type(keyBox, KEY);
    await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(8);
    expect(calls(state, "machines.beginAccountLogin")[0]?.args).toEqual([
      ORG_ID,
      "machine_1",
      "claude_code",
      { provider: "zai" },
    ]);
    expect(machines?.lastLogin()?.box).not.toBeNull();
    expect(JSON.stringify(state.calls)).not.toContain("0123456789abcdef");
    // No naming step: the agent thinks with it at once.
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { brain: "claude_code", account: "acct_new" },
    ]);
    expect(calls(state, "machines.renameAccount")).toHaveLength(0);
    expect(dialog.textContent).toContain("Ada agora pensa com GLM Coding.");
    await click(within(dialog).getByRole("button", { name: "Pronto" }));
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("ChatGPT: first its settings, then a sign-in that starts only on its button; switching tiles starts nothing", async () => {
    const { state, dialog, tile } = await connect();
    await click(tile("ChatGPT"));
    await click(tile("Claude"));
    await click(tile("ChatGPT"));
    await settle(4);
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(0);
    const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
    expect(panel.textContent).toContain("Plus, Pro, Business ou Enterprise");
    expect(panel.textContent).toContain("Permita o login com código no ChatGPT");
    expect(within(panel).getByRole("link", { name: "Abrir as configurações do ChatGPT" }).getAttribute("href")).toBe(
      "https://chatgpt.com/#settings/Security",
    );
    // Who has to turn it on stays in view (a member of a Business plan can't do it alone): no ⓘ on this step.
    expect(shownText(panel)).toContain(
      "Em Configurações\u00a0›\u00a0Segurança, ligue o login com código de dispositivo para o Codex. No Business ou Enterprise, quem administra liga.",
    );
    expect(within(panel).queryByRole("button", { name: "Sobre Permita o login com código no ChatGPT" })).toBeNull();
    expect(hintOf("Entre no ChatGPT com a conta que vai usar", panel).text).toMatch(/^Conta errada\?/);
    const { opened, popup } = await withPopup(() =>
      click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })),
    );
    await settle(6);
    expect(opened).toEqual(["about:blank"]);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([[ORG_ID, "machine_1", "codex"]]);
    expect(popup.location.href).toBe("https://auth.openai.com/codex/device");
    expect(within(panel).getByLabelText("Código para o ChatGPT").textContent).toBe("ABCD-1234");
    expect(shownText(panel)).toContain("Digite este código na página que abrir.");
    expect(shownText(panel)).not.toContain("Foi você");
    expect(within(panel).getByRole("link", { name: "Abrir de novo" })).toBeTruthy();
  });

  test("a sign-in starting: the line under its title says the computer is asked, until it answers, and only then", async () => {
    const { api, dialog, tile } = await connect();
    // The computer answers only when let.
    const begin = api.machines.beginAccountLogin;
    let answer = () => {};
    api.machines.beginAccountLogin = async (...args) => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return begin(...args);
    };
    const signIn = async (plan: string) => {
      const panel = within(dialog).getByRole("region", { name: `Seu plano do ${plan}` });
      expect(shownText(panel)).not.toContain("Pedindo ao MacBook…");
      await withPopup(async () => {
        await click(within(panel).getByRole("button", { name: `Entrar com ${plan}` }));
        expect(shownText(panel)).toContain("Pedindo ao MacBook…");
        await act(async () => answer());
        await settle(6);
      });
      expect(within(panel).getByRole("link", { name: "Abrir de novo" })).toBeTruthy();
      expect(shownText(panel)).not.toContain("Pedindo ao MacBook…");
    };
    await signIn("Claude");
    await click(tile("ChatGPT"));
    await signIn("ChatGPT");
  });

  test("Claude: the same account twice is refused, and the page says how to add another", async () => {
    const { machines, dialog } = await connect();
    machines?.endLogin("login_1", { state: "failed", duplicate: { label: "Trabalho" } });
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
    await settle(8);
    expect(dialog.textContent).toContain(
      "Essa conta já está aqui (Trabalho). Para adicionar outra, saia do Claude na página que abriu",
    );
    expect(within(dialog).getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  test("a computer the person connected: its own sign-in, saved for the agent at once; or another account", async () => {
    const { state, dialog } = await connect({ brain: { ownSignIn: true } });
    const own = within(dialog).getByRole("button", { name: /^A conta do Claude com login no MacBook/ });
    expect(own.textContent).toBe("A conta do Claude com login no MacBookTodos os agentes pensam com ela.");
    expect(dialog.textContent).toContain("Eles só respondem a você enquanto pensam com o seu plano.");
    // Another account: its title alone; then the steps, asking which one with nothing under the field.
    const other = within(dialog).getByRole("button", { name: /^Outra conta do Claude, para um agente/ });
    expect(other.textContent).toBe("Outra conta do Claude, para um agente");
    await click(other);
    expect(within(dialog).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    // Who it replies to is said once, by its steps, for its one agent: the note about every agent goes.
    expect(dialog.textContent).not.toContain("Eles só respondem a você");
    expect(shownText(dialog).split("A Ada vai responder só a você.")).toHaveLength(2);
    const which = within(dialog).getByLabelText("Qual conta? (opcional)") as HTMLInputElement;
    expect(which.placeholder).toBe("Email da conta do Claude (opcional)");
    expect(shownText(dialog)).not.toContain("Vazio: você escolhe");
    await type(which, "ana@");
    expect(shownText(dialog)).toContain("Use um email simples, como ana@exemplo.com.");
    await click(own);
    await settle(4);
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([ORG_ID, ADA_ID, { brain: "claude_code", account: null }]);
    expect(dialog.textContent).toContain("Ada agora usa a conta do próprio MacBook.");
  });

  test("a plan its computer can't take: its tile dims, and its panel says why, with the key one click away", async () => {
    const { dialog, tile } = await connect({
      computers: [{ ...MAC, keys: false, brains: { claude_code: true, codex: false } }],
      brain: {
        options: [
          { kind: "model", available: true, experimental: false, models: [], defaultModel: null },
          { kind: "claude_code", available: true, experimental: false, models: [], defaultModel: "sonnet" },
          {
            kind: "codex",
            available: false,
            reason: "not_installed",
            experimental: true,
            models: [],
            defaultModel: null,
          },
        ],
      },
    });
    const dimmed = (name: string) => tile(name).querySelector(".ac-brand--off") !== null;
    expect(dimmed("Claude")).toBe(false);
    expect(dimmed("ChatGPT")).toBe(true);
    expect(dimmed("Kimi Code")).toBe(true);
    await click(tile("ChatGPT"));
    expect(dialog.textContent).toContain("Não está instalado no MacBook.");
    await click(tile("Kimi Code"));
    expect(dialog.textContent).toContain("Atualize o agentes no computador para usar a chave de um plano");
    await click(within(dialog).getByRole("button", { name: "Usar uma chave de API agora" }));
    expect(tile("Chave de API").getAttribute("aria-pressed")).toBe("true");
  });

  test("self-host with no computer for the agent: plans dim, the key comes first, and a plan's panel says to connect one", async () => {
    const { dialog, tile, router } = await connect({ computers: [], brain: { computer: null, machines: [] } });
    expect(tile("Chave de API").getAttribute("aria-pressed")).toBe("true");
    expect(tile("Claude").querySelector(".ac-brand--off")).not.toBeNull();
    await click(tile("Claude"));
    expect(dialog.textContent).toContain("As contas ficam num computador conectado. Conecte um seu primeiro.");
    await click(within(dialog).getByRole("button", { name: "Conectar um computador" }));
    await settle(4);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/computers`);
  });

  test("before the server says which edition this is: a wait, never a computer to connect", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setAiAccounts({ accounts: [], computers: [] });
    // The Cloud's answer still on its way: self-host's words would send its people to pair a computer.
    api.machines.computerSetup = () => new Promise(() => {});
    await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
    await settle(6);
    await click(screen().getByRole("button", { name: "Conectar uma IA" }));
    const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
    expect(within(dialog).queryByRole("button", { name: "Conectar um computador" })).toBeNull();
    expect(dialog.textContent).not.toMatch(/Conecte um seu|computador conectado/);
  });

  test("on the Cloud while its computer is prepared: the wait in the panel, sign-in off, no computer to connect", async () => {
    const { state, dialog } = await connect({
      computers: [],
      brain: { computer: null, machines: [] },
      setup: {
        step: "installing",
        secondsLeft: 330,
        expectedReadyAt: new Date(Date.now() + 330_000).toISOString(),
        notifyByEmail: true,
      },
    });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("Passo 3 de 4 · Instalando os programas");
    expect(panel.textContent).toContain("Faltam uns 6 min");
    // The panel's own line says what happens once it's ready: no email line too.
    expect(panel.textContent).toContain("Você entra aqui assim que ele ficar pronto.");
    expect(panel.textContent).not.toContain("Avisamos");
    expect((within(panel).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Conectar um computador" })).toBeNull();
    expect(dialog.textContent).not.toMatch(/Conecte um seu|computador conectado|seu computador/);
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(0);
  });

  test("on the Cloud, its computer not answering: said by name, looked after, a key meanwhile", async () => {
    const workspace: AiComputer = { ...MAC, machineId: "managed_1", name: "Computador da Acme", online: false };
    const { dialog } = await connect({
      computers: [workspace],
      setup: { state: "ready" },
      brain: { computer: { machineId: "managed_1", name: "Computador da Acme", online: false } },
    });
    expect(dialog.textContent).toContain("O Computador da Acme não está respondendo agora. Já estamos cuidando.");
    expect(within(dialog).getByRole("button", { name: "Usar uma chave de API agora" })).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/Seu computador está desligado|desligado/);
  });

  test("the email's link on a cold load: once the agents arrive, Claude's sign-in for the viewer's agent", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    const api = createFakeApi(state);
    const machines = fakeMachinesOf.get(api);
    machines?.pair({ id: "machine_1", name: "MacBook", agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }] });
    machines?.setAiAccounts({ accounts: [], computers: [MAC] });
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({ ...(await viewOf(orgId, agentId)), ownSignIn: false });
    // The agents' list answers only after the dialog opened.
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const list = api.agents.list;
    api.agents.list = async (orgId) => {
      await arrived;
      return list(orgId);
    };
    await renderApp(`/org/${ORG_ID}?connect=ai`, { api });
    const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
    await act(async () => arrive());
    await settle(8);
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    expect(dialog.querySelector(".ac-spinner, .ac-pixspin")).toBeNull();
  });

  test("a plan for Ada, then the API key for the rest: its field is there, and only a saved key says it's saved", async () => {
    const { state, machines, dialog, tile } = await connect();
    machines?.endLogin("login_1", { state: "done", account: claudeMax });
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
    await settle(8);
    expect(dialog.textContent).toContain("Ada agora pensa com Claude Max.");
    await click(tile("Chave de API"));
    const panel = within(dialog).getByRole("region", { name: "Chave de API" });
    // The row just chosen already names it: no head again, and who charges for it, once.
    expect(panel.querySelector(".ai-panel__head")).toBeNull();
    expect(shownText(panel).split("Você paga pelo uso, direto ao provedor.")).toHaveLength(2);
    expect(shownText(panel)).toContain("Todo agente sem plano pensa com ela.");
    // A maker with coding plans: where a plan's key goes is the first step's ⓘ, with no line under it.
    await click(within(panel).getByRole("button", { name: "Kimi" }));
    expect(hintOf("Crie a sua chave de API da Kimi", panel).text).toBe(
      "A chave de um plano de código vai na opção dele, acima.",
    );
    expect(shownText(panel)).not.toContain("plano de código");
    await click(within(panel).getByRole("button", { name: "Claude" }));
    expect(within(panel).queryByRole("button", { name: /^Sobre Crie a sua chave/ })).toBeNull();
    expect(panel.textContent).not.toContain("Salva.");
    await type(within(panel).getByLabelText("Cole aqui"), "sk-ant-api03-abcdefghijklmnop");
    await click(within(panel).getByRole("button", { name: "Salvar chave" }));
    await settle(4);
    expect(calls(state, "agents.addCredential")).toHaveLength(1);
    expect(panel.textContent).toContain("Salva. Todo agente sem plano pensa com ela.");
  });

  test("a sign-in started once the computer is ready is stopped on that computer when its panel goes", async () => {
    const workspace: AiComputer = { ...MAC, machineId: "managed_1", name: "Computador da Acme" };
    const { state, api, machines, dialog, tile, services } = await connect({
      computers: [],
      brain: { computer: null, machines: [] },
      setup: {
        step: "installing",
        secondsLeft: 330,
        expectedReadyAt: new Date(Date.now() + 330_000).toISOString(),
        notifyByEmail: true,
      },
    });
    const signIn = () =>
      within(dialog).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement | HTMLAnchorElement;
    expect((signIn() as HTMLButtonElement).disabled).toBe(true);
    // It turns ready while the person watches.
    const waiting = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({
      ...(await waiting(orgId, agentId)),
      computer: { machineId: "managed_1", name: "Computador da Acme", online: true },
    });
    machines?.setAiAccounts({ accounts: [], computers: [workspace] });
    machines?.setSetup({ state: "ready", machineId: "managed_1" });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(8);
    await withPopup(() => click(signIn()));
    await settle(4);
    expect(calls(state, "machines.beginAccountLogin")[0]?.args).toEqual([ORG_ID, "managed_1", "claude_code"]);
    // Another tile: the sign-in stops where it runs.
    await click(tile("ChatGPT"));
    expect(calls(state, "machines.cancelAccountLogin").map((c) => c.args)).toEqual([[ORG_ID, "managed_1", "login_1"]]);
  });

  test("the agent's view failing to load again mid-sign-in: the steps stay, and nothing is stopped", async () => {
    const { state, api, dialog, services } = await connect();
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
    await settle(6);
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(within(panel).getByRole("link", { name: "Abrir de novo" })).toBeTruthy();
    api.agents.brain = async () => {
      throw new ApiError(503, "unavailable", "Restarting");
    };
    await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.agentBrain(ORG_ID, ADA_ID) }));
    await settle(6);
    expect(panel.textContent).not.toContain("Não foi possível carregar");
    expect(within(panel).getByRole("link", { name: "Abrir de novo" })).toBeTruthy();
    expect(calls(state, "machines.cancelAccountLogin")).toHaveLength(0);
  });

  test("for which agent: another tile keeps the one chosen; once it thinks with a plan, the next tile moves on", async () => {
    const { state, machines, dialog, tile, services } = await connect({ mine: [ADA_ID, ATLAS_ID] });
    state.aiStatus = {
      any: false,
      agents: [
        { agentId: ADA_ID, state: "no_ai", reason: "no_key" },
        { agentId: ATLAS_ID, state: "no_ai", reason: "no_key" },
      ],
    };
    await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.aiStatus(ORG_ID) }));
    await settle(4);
    const agent = () => within(dialog).getByRole("combobox", { name: "Para qual agente" });
    expect(agent().textContent).toContain("Ada");
    agent().focus();
    await act(async () => fireEvent.keyDown(agent(), { key: "Enter" }));
    await click(screen().getByRole("option", { name: "Atlas" }));
    await click(tile("ChatGPT"));
    expect(agent().textContent).toContain("Atlas");
    // Atlas signs in with ChatGPT: the next plan is for Ada.
    machines?.endLogin("login_1", {
      state: "done",
      account: account({ id: "acct_plus", kind: "codex", label: "ChatGPT Plus", provider: null, keyHint: null }),
    });
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com ChatGPT" })));
    await settle(8);
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([
      ORG_ID,
      ATLAS_ID,
      { brain: "codex", account: "acct_plus" },
    ]);
    expect(dialog.textContent).toContain("Atlas agora pensa com ChatGPT Plus.");
    await click(tile("Claude"));
    expect(agent().textContent).toContain("Ada");
  });

  test("a hold on the workspace while its computer is prepared: the panel says the hold alone, sign-in off", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
    const me = state.me;
    if (me) me.organizations = me.organizations.map((o) => ({ ...o, standing: { state: "hold", reason: null } }));
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ step: "installing", secondsLeft: 330, notifyByEmail: true });
    fakeMachinesOf.get(api)?.setAiAccounts({ accounts: [], computers: [] });
    const viewOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({
      ...(await viewOf(orgId, agentId)),
      ownSignIn: false,
      computer: null,
      machines: [],
    });
    await renderApp(`/org/${ORG_ID}?connect=ai`, { api });
    await settle(8);
    const panel = within(screen().getByRole("dialog", { name: "Conectar uma IA" })).getByRole("region", {
      name: "Seu plano do Claude",
    });
    expect(panel.textContent).toContain("Os agentes deste workspace estão pausados para uma revisão.");
    expect(panel.textContent).not.toMatch(/Faltam|Avisamos|Você entra aqui/);
    expect((within(panel).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
