import { afterEach, describe, expect, test } from "bun:test";
import type { AgentBrain, AiComputer, ComputerSetup, MachineAccount } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
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
}: {
  computers?: AiComputer[];
  setup?: Partial<ComputerSetup>;
  brain?: Partial<AgentBrain>;
} = {}) {
  const state = seedState();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.ownerUserId = "u-walter";
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api);
  if (setup) machines?.setSetup(setup);
  else machines?.pair({ id: "machine_1", name: "MacBook", agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }] });
  machines?.setAiAccounts({ accounts: [], computers });
  const viewOf = api.agents.brain;
  api.agents.brain = async (orgId, agentId) => ({ ...(await viewOf(orgId, agentId)), ownSignIn: false, ...brain });
  const { router } = await renderApp(`/org/${ORG_ID}/settings/keys`, { api });
  await settle(6);
  await click(screen().getByRole("button", { name: "Conectar uma IA" }));
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
  // The picker's options (the API key's makers are tiles too, in their own group).
  const picker = within(dialog).getByRole("group", { name: "Qual IA eles vão usar?" });
  const tile = (name: string) => within(picker).getByRole("button", { name: new RegExp(`^${name}`) });
  return { state, api, machines, dialog, tile, router };
}

const calls = (state: ReturnType<typeof seedState>, method: string) => state.calls.filter((c) => c.method === method);

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
    expect(panel.textContent).toContain("Num plano de equipe, use a chave da página Team Plan.");
    expect(within(panel).getByRole("link", { name: "Abrir z.ai" }).getAttribute("href")).toBe(
      "https://z.ai/manage-apikey/apikey-list",
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
    const { opened, popup } = await withPopup(() =>
      click(within(panel).getByRole("button", { name: "Entrar com ChatGPT" })),
    );
    await settle(6);
    expect(opened).toEqual(["about:blank"]);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual([[ORG_ID, "machine_1", "codex"]]);
    expect(popup.location.href).toBe("https://auth.openai.com/codex/device");
    expect(within(panel).getByLabelText("Código para o ChatGPT").textContent).toBe("ABCD-1234");
    expect(within(panel).getByRole("link", { name: "Abrir de novo" })).toBeTruthy();
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
    expect(own.textContent).toContain("Todos os agentes pensam com ela. Nada para entrar.");
    expect(dialog.textContent).toContain("Eles só respondem a você enquanto pensam com o seu plano.");
    // Another account: the steps, asking which one.
    await click(within(dialog).getByRole("button", { name: /^Outra conta do Claude, para um agente/ }));
    expect(within(dialog).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    expect(within(dialog).getByLabelText("Qual conta? (opcional)")).toBeTruthy();
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
    expect(panel.textContent).toContain(
      "Avisamos você em walter@acme.com.br quando ele ficar pronto. Pode fechar esta página.",
    );
    expect(panel.textContent).toContain("Você entra aqui assim que ele ficar pronto.");
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
});
