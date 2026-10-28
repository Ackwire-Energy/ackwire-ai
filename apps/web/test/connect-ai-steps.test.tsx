import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentBrain,
  AgentBrainLine,
  AiComputer,
  ComputerSetup,
  Machine,
  MachineAccount,
} from "@agenteschat/client";
import { ApiError, keys } from "@agenteschat/client";
import { LOGIN_PER_AGENT } from "@agenteschat/client/lib/plans";
import { icons } from "@agenteschat/ui";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, fakeAgentBrain, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
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
 * (`brain`: Ada's view; `machine`: over its row), and "Conectar uma IA" opened. `setup`: the workspace gets its own
 * computer, this far.
 */
async function connect({
  computers = [MAC],
  setup,
  brain = {},
  machine = {},
  mine = [ADA_ID],
  crew = false,
  path = `/org/${ORG_ID}/settings/keys`,
}: {
  computers?: AiComputer[];
  setup?: Partial<ComputerSetup>;
  brain?: Partial<AgentBrain>;
  machine?: Partial<Machine>;
  /** Walter's agents (a plan thinks only for its owner's). */
  mine?: string[];
  /** Ada, Atlas and Lia, all Walter's, all on the MacBook, none with an AI yet. */
  crew?: boolean;
  /** Where the dialog opens: Settings' button, or a link that asks for it. */
  path?: string;
} = {}) {
  const state = seedState();
  const ada = state.agents[0];
  if (crew && ada) {
    state.agents.push({ ...ada, id: LIA_ID, name: "Lia", handle: "lia" });
    mine = [ADA_ID, ATLAS_ID, LIA_ID];
    state.aiStatus = { any: false, agents: mine.map((agentId) => ({ agentId, state: "no_ai", reason: "no_key" })) };
  }
  for (const a of state.agents) if (mine.includes(a.id)) a.ownerUserId = "u-walter";
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api);
  if (setup) machines?.setSetup(setup);
  else
    machines?.pair({
      id: "machine_1",
      name: "MacBook",
      agents: state.agents
        .filter((a) => a.id === ADA_ID || (crew && mine.includes(a.id)))
        .map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
      ...machine,
    });
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

/**
 * As the server answers a move: the agent's row says what it thinks with and the AI status says it's ready, so the
 * agents a panel would open on by default change while it signs them in.
 */
function serverMoves(
  state: ReturnType<typeof seedState>,
  api: ReturnType<typeof createFakeApi>,
  brain: AgentBrainLine,
) {
  const setBrain = api.agents.setBrain;
  api.agents.setBrain = async (orgId, agentId, input) => {
    const view = await setBrain(orgId, agentId, input);
    const row = state.agents.find((a) => a.id === agentId);
    if (row) row.brain = brain;
    state.aiStatus = {
      any: true,
      agents: (state.aiStatus?.agents ?? []).map((a) => (a.agentId === agentId ? { agentId, state: "ready" } : a)),
    };
    return view;
  };
}
const GLM: AgentBrainLine = { kind: "claude_code", model: null, provider: "zai" };
const GLM_KEY = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp";

const LIA_ID = "00000000-0000-4000-8000-0000000000a3";
/** Whether an icon is drawn as `name` (its shape's first path). */
const drawnAs = (svg: Element | null | undefined, name: keyof typeof icons) =>
  svg?.querySelector("path")?.getAttribute("d") === icons[name].find(([tag]) => tag === "path")?.[1].d;
/** "For": the select of whom a plan thinks for, opened. */
async function openFor(inside: HTMLElement) {
  const select = within(inside).getByRole("combobox", { name: "Agentes que usam este plano" });
  select.focus();
  await act(async () => fireEvent.keyDown(select, { key: "Enter" }));
  await settle(2);
  return screen().getAllByRole("option");
}

/** A stylesheet's text, its comments left out. */
const stylesheet = async (path: string) =>
  (await Bun.file(new URL(path, import.meta.url).pathname).text()).replace(/\/\*[\s\S]*?\*\//g, "");
/** The body of the first rule whose selector is `selector`, at any indent (inside a media query too). */
const ruleOf = (css: string, selector: string) =>
  css.split(new RegExp(`\\n *${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`))[1]?.split("}")[0] ?? "";
/** What the media query `query` holds, its first time in the stylesheet. */
const atMedia = (css: string, query: string) => css.split(`\n@media ${query} {`)[1]?.split("\n}")[0] ?? "";
/** A Claude plan's account, as the computer reports it once the sign-in ends. */
const claudeMax = account({ id: "acct_max", label: "Claude Max", provider: null, keyHint: null });

describe("Conectar uma IA: one picker, plans first", () => {
  test("Settings › AI accounts opens the same picker: six plans, then the API key, Claude chosen with its sign-in", async () => {
    const { dialog, tile } = await connect();
    const group = within(dialog).getByRole("group", { name: "Qual IA eles vão usar?" });
    const options = [...group.querySelectorAll(":scope > .ac-option")];
    expect(options.map((b) => b.textContent)).toEqual([
      "Claude",
      "ChatGPT",
      "GLM Coding",
      "Kimi Code",
      "MiniMax",
      "OpenCode Go",
      "Chave de APIClaude, OpenAI, Gemini e outros",
    ]);
    // Each by its maker's mark; the key row by four of them, overlapped.
    expect(
      options.flatMap((o) => [...o.querySelectorAll(".ac-brand--sm")]).map((m) => m.getAttribute("data-mark")),
    ).toEqual(["claude", "openai", "zai", "kimi", "minimax", "opencode"]);
    const stack = tile("Chave de API").querySelector(".ac-brand-stack");
    expect([...(stack?.querySelectorAll(".ac-brand") ?? [])].map((m) => m.getAttribute("data-mark"))).toEqual([
      "claude",
      "openai",
      "gemini",
      "deepseek",
    ]);
    expect(dialog.textContent).toContain("Ou pague pelo uso");
    expect(tile("Claude").getAttribute("aria-pressed")).toBe("true");
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    // Right under the plans: the API key row comes after Claude's steps, never between Claude and them.
    expect(options[5]?.nextElementSibling).toBe(panel);
    expect(panel.compareDocumentPosition(tile("Chave de API")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.textContent).toContain("Pro, Max, Team ou Enterprise");
    expect(within(panel).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    // The sign-in step is its title, its ⓘ and its button: the ⓘ says what to do on the wrong account.
    expect(hintOf("Entre no Claude", panel)).toMatchObject({
      text: "Conta errada? Saia na página do Claude e tente de novo.",
      hidden: true,
    });
    expect(shownText(panel)).not.toMatch(/Abre a página|nunca vê a senha|senha vai só/);
    // Who the agent answers, once, in the panel's foot (no lock note above it), and where the account stays in its ⓘ.
    const foot = panel.querySelector(".ac-card__foot") as HTMLElement;
    expect(panel.lastElementChild).toBe(foot);
    expect(foot.firstElementChild?.getAttribute("data-icon") ?? foot.querySelector("svg")).toBeTruthy();
    expect(shownText(foot)).toBe("Com o seu plano, a Ada só responde a você. ");
    expect(hintOf("Com o seu plano, a Ada só responde a você.", foot).text).toBe(
      "A conta fica só no MacBook. A sua senha vai só para o Claude.",
    );
    expect(panel.querySelectorAll(".ac-setnote")).toHaveLength(0);
    // One agent of the viewer's: nobody to choose.
    expect(within(panel).queryByRole("combobox")).toBeNull();
    // A first sign-in asks for no account, and nothing asks for a computer or a name.
    expect(within(panel).queryByLabelText("Qual conta? (opcional)")).toBeNull();
    expect(dialog.textContent).not.toContain("Em qual computador?");
    // Until something is connected the body is the dialog's last part: its own edge under the panel, no footer.
    expect(dialog.querySelector(".ac-dialog__body:last-child")).not.toBeNull();
    expect(dialog.querySelector(".ac-dialog__footer")).toBeNull();
  });

  test("a tile's check sits on its name's line; the chosen plan's panel takes a row of its own, 12px under the plans", async () => {
    const ui = await stylesheet("../../../packages/ui/src/styles/components.css");
    const check = ruleOf(ui, '.ac-option[aria-pressed="true"]::after,\n.ac-option[data-state="checked"]::after');
    expect(check).toContain("height: 18px");
    const layout = await stylesheet("../src/layout.css");
    // A one-line tile's in its middle.
    expect(ruleOf(layout, ".grid-options--plans > .ac-option:not(.ai-picker__key)::after")).toContain(
      "top: calc(50% - 9px)",
    );
    // The API key row has two lines: its check goes on the first, its name's, past the tile's padding (the page's
    // 22px line where the lh unit is unknown).
    expect(ruleOf(ui, ".ac-option")).toContain("padding: var(--space-3)");
    const key = ".grid-options--plans > .ac-option.ai-picker__key::after";
    expect(ruleOf(layout, key)).toContain("top: calc(var(--space-3) + 11px - 9px)");
    expect(ruleOf(layout.split("\n@supports (top: 1lh) {")[1] ?? "", key)).toContain(
      "top: calc(var(--space-3) + 0.5lh - 9px)",
    );
    const panel = ruleOf(layout, ".grid-options--plans > .ai-panel");
    expect(panel).toContain("grid-column: 1 / -1");
    // The grid's 8px gap and 4px more: as far under the plans as the key's panel is under its row.
    expect(ruleOf(layout, ".grid-options")).toContain("gap: var(--space-2)");
    expect(panel).toContain("margin-top: 4px");
  });

  test("a coding plan's key: its own key page, then the key sealed to the computer (in no request); the agent thinks with it", async () => {
    const { state, machines, dialog, tile } = await connect();
    machines?.endLogin("login_1", { state: "done", account: account() });
    // A plan whose keys have a known start shows it as the field's example.
    await click(tile("OpenCode Go"));
    const opencode = within(dialog).getByRole("region", { name: "OpenCode Go" });
    expect(within(opencode).getByLabelText("Chave do OpenCode Go").getAttribute("placeholder")).toBe("oc_sk_…");
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
    // Where the key goes is the foot's ⓘ, said once for the panel: the paste step has none.
    expect(within(panel).queryByRole("button", { name: "Sobre Cole a chave aqui" })).toBeNull();
    const foot = panel.querySelector(".ac-card__foot") as HTMLElement;
    expect(hintOf("Com o seu plano, a Ada só responde a você.", foot).text).toBe(
      "A chave vai criptografada para o MacBook e fica só lá.",
    );
    expect(shownText(panel)).not.toMatch(/Fica em|Num plano de equipe|criptografada/);
    expect(within(panel).getByLabelText("Chave do GLM Coding").hasAttribute("aria-describedby")).toBe(false);
    // Z.ai publishes no prefix for its keys: no example in the field, never a bare "…". Its buttons are the field's
    // height (the ruler's default step).
    expect(within(panel).getByLabelText("Chave do GLM Coding").hasAttribute("placeholder")).toBe(false);
    for (const name of ["Colar", "Enviar ao MacBook"])
      expect(within(panel).getByRole("button", { name }).classList.contains("ac-btn--sm")).toBe(false);
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
    expect(hintOf("Entre no ChatGPT", panel).text).toBe("Conta errada? Saia na página do ChatGPT e tente de novo.");
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
      "Essa conta já está aqui, como Trabalho. Para adicionar outra, saia na página do Claude e entre com a outra.",
    );
    // What went wrong and its button on one row, the note in the button's middle.
    const retry = within(dialog).getByRole("button", { name: "Tentar de novo" });
    expect(retry.parentElement?.className).toBe("ai-panel__row");
    expect(retry.parentElement?.querySelector(":scope > .ac-setnote")).not.toBeNull();
  });

  test("a step's number and title come down to the middle of the button beside it; a failure's note sits in its button's middle", async () => {
    const layout = await stylesheet("../src/layout.css");
    expect(ruleOf(layout, ".agp-addacct__step")).toContain("line-height: 20px");
    const step = ".agp-addacct__step:has(> .ac-btn--sm) > :is(i, .agp-addacct__text)";
    // Beside it only from 641px wide: narrower, the button goes under the words.
    expect(ruleOf(atMedia(layout, "(min-width: 641px)"), step)).toContain(
      "margin-top: calc((var(--control-h-sm) - 20px) / 2)",
    );
    // A touch screen's small button is the ruler's default step.
    expect(ruleOf(atMedia(layout, "(min-width: 641px) and (pointer: coarse)"), step)).toContain(
      "margin-top: calc((var(--control-h-md) - 20px) / 2)",
    );
    expect(ruleOf(layout, ".ai-panel__row")).toContain("align-items: center");
    expect(ruleOf(layout, ".ai-panel__row > .ac-setnote")).toContain("margin: 0");
    // A key's field can narrow to 112px, so "Enviar ao Computador da Costa Atelier" keeps its line in a panel too.
    expect(ruleOf(layout, ".agp-addacct__paste .ac-input")).toContain("min-width: 112px");
  });

  test("a computer the person connected: its own sign-in, saved for the agent at once; or another account", async () => {
    const { state, dialog } = await connect({ brain: { ownSignIn: true } });
    const own = within(dialog).getByRole("button", { name: /^A conta do Claude com login no MacBook/ });
    expect(own.textContent).toBe("A conta do Claude com login no MacBookTodos os agentes pensam com ela.");
    // Who it replies to is the foot's, once, either way.
    expect(shownText(dialog).split("Com o seu plano, a Ada só responde a você.")).toHaveLength(2);
    // Another account: its title alone; then the steps, asking which one with nothing under the field.
    const other = within(dialog).getByRole("button", { name: /^Outra conta do Claude/ });
    expect(other.textContent).toBe("Outra conta do Claude");
    await click(other);
    expect(within(dialog).getByRole("button", { name: "Entrar com Claude" })).toBeTruthy();
    expect(shownText(dialog).split("Com o seu plano, a Ada só responde a você.")).toHaveLength(2);
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

  test("a plan whose tool is off on its computer: the app's Preferences on a Mac, the command too on Linux", async () => {
    const reason = async (os: string, name: string) => {
      cleanup();
      const options = fakeAgentBrain(ADA_ID).options.map((o) =>
        o.kind === "codex" ? { ...o, available: false, reason: "tool_off" as const } : o,
      );
      const { dialog, tile } = await connect({
        machine: { os, name, mode: "system" },
        brain: { computer: { machineId: "machine_1", name, online: true }, options },
      });
      await click(tile("ChatGPT"));
      return dialog.textContent;
    };
    expect(await reason("linux", "Servidor")).toContain(
      "Desligado no Servidor. Ligue lá, no app do agentes.chat ou com sudo agentes-runner tools enable codex.",
    );
    expect(await reason("darwin", "MacBook")).toContain(
      "Desligado no MacBook. Ligue lá, no app do agentes.chat: Preferências → Ferramentas.",
    );
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
    // The computer's wait in one well: how far, the time left, and the owner's email line (no address, no clock).
    const well = panel.querySelector(".ai-panel__wait") as HTMLElement;
    expect(shownText(well)).toBe(
      "Passo 3 de 4 · Instalando os programasFaltam uns 6 minAvisamos você por e-mail quando ele ficar pronto. Pode fechar esta página.",
    );
    expect(panel.textContent).not.toContain("walter@");
    // Each step says its own timing: the sign-in's, under it.
    const step = within(panel).getByText("Entre no Claude").closest(".agp-addacct__step") as HTMLElement;
    expect(shownText(step)).toContain("Você entra aqui assim que o computador ficar pronto.");
    expect(panel.textContent?.split("assim que")).toHaveLength(2);
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
    // Right under its row, the picker's last; Claude's panel is gone from above it.
    expect(tile("Chave de API").parentElement?.lastElementChild).toBe(tile("Chave de API"));
    expect(tile("Chave de API").parentElement?.nextElementSibling).toBe(panel);
    expect(within(dialog).queryByRole("region", { name: "Seu plano do Claude" })).toBeNull();
    // The row just chosen already names it: no head again, and who charges for it, once.
    expect(panel.querySelector(".ai-panel__head")).toBeNull();
    expect(shownText(panel).split("Você paga pelo uso, direto ao provedor.")).toHaveLength(2);
    expect(shownText(panel)).toContain("Todo agente sem plano pensa com ela.");
    // Every maker as a tile, Gemini third.
    const makers = within(panel).getByRole("group", { name: "Provedor" });
    expect([...makers.querySelectorAll(".ac-option__title")].map((el) => el.textContent)).toEqual([
      "Claude",
      "OpenAI",
      "Gemini",
      "DeepSeek",
      "Kimi",
      "Z.ai",
      "MiniMax",
    ]);
    // A maker with coding plans: where a plan's key goes is the first step's ⓘ, with no line under it.
    await click(within(panel).getByRole("button", { name: "Kimi" }));
    expect(hintOf("Crie a sua chave de API da Kimi", panel).text).toBe(
      "A chave de um plano de código vai na opção dele, acima.",
    );
    expect(shownText(panel)).not.toContain("plano de código");
    // Gemini: its free tier may use what the agents send, so the first step's ⓘ says to turn on billing.
    await click(within(panel).getByRole("button", { name: "Gemini" }));
    expect(hintOf("Crie a sua chave de API do Gemini", panel)).toMatchObject({
      text: "Ative o faturamento no projeto da chave. Sem faturamento, o Google pode usar o que os agentes enviam.",
      hidden: true,
    });
    expect(shownText(panel)).not.toContain("faturamento");
    expect(within(panel).getByRole("link", { name: "Abrir aistudio.google.com" }).getAttribute("href")).toBe(
      "https://aistudio.google.com/api-keys",
    );
    expect(within(panel).getByLabelText("Cole aqui").getAttribute("placeholder")).toBe("AQ.…");
    // A maker that publishes no prefix for its keys: no example in the field, never a bare "…".
    await click(within(panel).getByRole("button", { name: "Z.ai" }));
    expect(within(panel).getByLabelText("Cole aqui").hasAttribute("placeholder")).toBe(false);
    await click(within(panel).getByRole("button", { name: "Claude" }));
    expect(within(panel).getByLabelText("Cole aqui").getAttribute("placeholder")).toBe("sk-ant-…");
    expect(within(panel).queryByRole("button", { name: /^Sobre Crie a sua chave/ })).toBeNull();
    expect(panel.textContent).not.toContain("Salva.");
    // Save key is the field's height (the ruler's default step), not a small button beside a tall field.
    expect(within(panel).getByRole("button", { name: "Salvar chave" }).classList.contains("ac-btn--sm")).toBe(false);
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
    const agent = () => within(dialog).getByRole("combobox", { name: "Agentes que usam este plano" });
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

describe("All agents: one plan for the team, a login per agent", () => {
  test("the head: the name's capitals at the mark's top, For with All agents first where the plan allows it", async () => {
    const { dialog, tile } = await connect({ crew: true });
    const head = () => dialog.querySelector(".ai-panel__head") as HTMLElement;
    expect(head().classList.contains("ac-faceline")).toBe(true);
    expect(head().querySelector(".ai-panel__title > b")?.classList.contains("ac-captop")).toBe(true);
    expect(within(head()).getByText("Para")).toBeTruthy();
    // Claude and ChatGPT sign in once per account for now: each agent, the first with no AI chosen.
    for (const plan of ["Claude", "ChatGPT"]) {
      await click(tile(plan));
      const panel = within(dialog).getByRole("region", { name: `Seu plano do ${plan}` });
      expect(within(panel).getByRole("combobox").textContent).toBe("Ada");
      expect((await openFor(panel)).map((o) => o.textContent)).toEqual(["Ada", "Atlas", "Lia"]);
      await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
      await settle(2);
    }
    // A coding plan: all of them, by default, with their faces and names.
    await click(tile("GLM Coding"));
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    expect(within(panel).getByRole("combobox").textContent).toBe("Todos os agentes");
    const options = await openFor(panel);
    expect(options.map((o) => o.textContent)).toEqual(["Todos os agentesAda, Atlas e Lia", "Ada", "Atlas", "Lia"]);
    expect(options[0]?.querySelectorAll(".ac-avatar-stack > .ac-avatar")).toHaveLength(3);
    expect(options[1]?.querySelectorAll(".ac-avatar")).toHaveLength(1);
    // Who it's for, and who it answers, once.
    expect(shownText(panel)).toContain("Com o seu plano, os seus agentes só respondem a você.");
  });

  test("an agent on the API key stays out of All agents: a plan would make it answer only its owner", async () => {
    const { state, dialog, tile, services } = await connect({ crew: true });
    state.aiStatus = {
      any: true,
      agents: [
        { agentId: ADA_ID, state: "no_ai", reason: "no_key" },
        { agentId: ATLAS_ID, state: "ready" },
        { agentId: LIA_ID, state: "no_ai", reason: "no_key" },
      ],
    };
    await act(async () => services.queryClient.invalidateQueries({ queryKey: keys.aiStatus(ORG_ID) }));
    await settle(4);
    await click(tile("Kimi Code"));
    const panel = within(dialog).getByRole("region", { name: "Kimi Code" });
    expect((await openFor(panel))[0]?.textContent).toBe("Todos os agentesAda e Lia");
    const who = panel.querySelector(".ai-panel__who") as HTMLElement;
    expect([...who.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["AdaEsperando", "LiaEsperando"]);
  });

  test("GLM for all: one paste, the key sealed to one login per agent (in no request), each agent on its own", async () => {
    const { state, machines, dialog, tile } = await connect({ crew: true });
    const acct = (n: number) =>
      account({ id: `acct_${n}`, label: "GLM Coding", usedBy: [], provider: "zai", keyHint: "MnOp" });
    for (const n of [1, 2, 3]) machines?.endLogin(`login_${n}`, { state: "done", account: acct(n) });
    await click(tile("GLM Coding"));
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    const who = () => [...panel.querySelectorAll(".ai-panel__who > li")].map((li) => li.getAttribute("data-state"));
    expect(who()).toEqual(["next", "next", "next"]);
    // The steps look like one agent's: no sign-in per agent to say.
    expect(shownText(panel)).not.toContain("Um login por agente");
    expect(machines?.logins()).toEqual([]);
    const KEY = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp";
    await type(within(panel).getByLabelText("Chave do GLM Coding"), KEY);
    await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(12);
    expect(calls(state, "machines.beginAccountLogin").map((c) => c.args)).toEqual(
      [1, 2, 3].map(() => [ORG_ID, "machine_1", "claude_code", { provider: "zai" }]),
    );
    const boxes = machines?.logins().map((l) => JSON.stringify(l.box)) ?? [];
    expect(new Set(boxes).size).toBe(3);
    expect(JSON.stringify(state.calls)).not.toContain("0123456789abcdef");
    expect(calls(state, "agents.setBrain").map((c) => c.args)).toEqual([
      [ORG_ID, ADA_ID, { brain: "claude_code", account: "acct_1" }],
      [ORG_ID, ATLAS_ID, { brain: "claude_code", account: "acct_2" }],
      [ORG_ID, LIA_ID, { brain: "claude_code", account: "acct_3" }],
    ]);
    expect(shownText(panel)).toContain("Ada, Atlas e Lia agora pensam com GLM Coding.");
    expect(within(panel).queryByRole("button", { name: "Enviar ao MacBook" })).toBeNull();
    expect(calls(state, "machines.cancelAccountLogin")).toHaveLength(0);
  });

  test("GLM for all, closed midway: only the logins still running stop", async () => {
    const { state, machines, dialog, tile } = await connect({ crew: true });
    machines?.endLogin("login_1", { state: "done", account: account({ id: "acct_1" }) });
    await click(tile("GLM Coding"));
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    await type(
      within(panel).getByLabelText("Chave do GLM Coding"),
      "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp",
    );
    await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(12);
    expect([...panel.querySelectorAll(".ai-panel__who > li")].map((li) => li.getAttribute("data-state"))).toEqual([
      "done",
      "now",
      "now",
    ]);
    await click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(calls(state, "machines.cancelAccountLogin").map((c) => c.args[2])).toEqual(["login_2", "login_3"]);
  });

  test("GLM for all as the server moves each agent: whom it's for and its steps hold while the logins land a poll apart", async () => {
    const { state, api, machines, dialog, tile, services } = await connect({ crew: true });
    serverMoves(state, api, GLM);
    const land = (n: number) =>
      machines?.endLogin(`login_${n}`, { state: "done", account: account({ id: `acct_${n}` }) });
    land(1);
    await click(tile("GLM Coding"));
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    const forWhom = () => within(panel).getByRole("combobox").textContent;
    const who = () => [...panel.querySelectorAll(".ai-panel__who > li")].map((li) => li.getAttribute("data-state"));
    await type(within(panel).getByLabelText("Chave do GLM Coding"), GLM_KEY);
    await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
    await settle(12);
    // Ada has an AI now, the first that had none: the panel stays on everyone, the key sent once.
    expect(forWhom()).toBe("Todos os agentes");
    expect(who()).toEqual(["done", "now", "now"]);
    expect((within(panel).getByLabelText("Chave do GLM Coding") as HTMLInputElement).disabled).toBe(true);
    for (const n of [2, 3]) {
      land(n);
      const poll = keys.accountLogin(ORG_ID, "machine_1", `login_${n}`);
      await act(() => services.queryClient.invalidateQueries({ queryKey: poll }));
      await settle(12);
      expect(forWhom()).toBe("Todos os agentes");
    }
    expect(shownText(panel)).toContain("Ada, Atlas e Lia agora pensam com GLM Coding.");
    expect(calls(state, "agents.setBrain").map((c) => c.args[1])).toEqual([ADA_ID, ATLAS_ID, LIA_ID]);
    expect(calls(state, "machines.cancelAccountLogin")).toHaveLength(0);
  });

  test("GLM for all, one login failing: that agent waits, and Try again signs in only that one", async () => {
    const { state, api, machines, dialog, tile } = await connect({ crew: true });
    serverMoves(state, api, GLM);
    machines?.endLogin("login_1", { state: "done", account: account({ id: "acct_1" }) });
    machines?.endLogin("login_2", { state: "done", account: account({ id: "acct_2" }) });
    machines?.endLogin("login_3", { state: "failed" });
    await click(tile("GLM Coding"));
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    const who = () => [...panel.querySelectorAll(".ai-panel__who > li")].map((li) => li.getAttribute("data-state"));
    const send = async () => {
      await type(within(panel).getByLabelText("Chave do GLM Coding"), GLM_KEY);
      await click(within(panel).getByRole("button", { name: "Enviar ao MacBook" }));
      await settle(12);
    };
    await send();
    expect(shownText(panel)).toContain("Não deu para entrar nessa conta. Tente de novo.");
    // Lia's login ended without her: nothing signs her in until the key goes again.
    expect(who()).toEqual(["done", "done", "next"]);
    machines?.endLogin("login_4", { state: "done", account: account({ id: "acct_4" }) });
    await click(within(panel).getByRole("button", { name: "Tentar de novo" }));
    await send();
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(4);
    expect(calls(state, "agents.setBrain").map((c) => [c.args[1], (c.args[2] as { account: string }).account])).toEqual(
      [
        [ADA_ID, "acct_1"],
        [ATLAS_ID, "acct_2"],
        [LIA_ID, "acct_4"],
      ],
    );
    expect(shownText(panel)).toContain("Ada, Atlas e Lia agora pensam com GLM Coding.");
  });

  test("every agent already on the plan: All agents says so, with no key to send", async () => {
    const { state, dialog, tile, services } = await connect({ crew: true });
    const crew = [ADA_ID, ATLAS_ID, LIA_ID];
    for (const a of state.agents) if (crew.includes(a.id)) a.brain = GLM;
    state.aiStatus = { any: true, agents: crew.map((agentId) => ({ agentId, state: "ready" })) };
    await act(async () => {
      await services.queryClient.invalidateQueries({ queryKey: keys.agents(ORG_ID) });
      await services.queryClient.invalidateQueries({ queryKey: keys.aiStatus(ORG_ID) });
    });
    await settle(4);
    await click(tile("GLM Coding"));
    const panel = within(dialog).getByRole("region", { name: "GLM Coding Plan" });
    await click((await openFor(panel))[0] as HTMLElement);
    expect(within(panel).getByRole("combobox").textContent).toBe("Todos os agentes");
    expect(shownText(panel)).toContain("Ada, Atlas e Lia agora pensam com GLM Coding.");
    expect(within(panel).queryByLabelText("Chave do GLM Coding")).toBeNull();
    expect(calls(state, "machines.beginAccountLogin")).toHaveLength(0);
  });

  test("ChatGPT for all, once one login per agent holds: one sign-in at a time, the who row ticking", async () => {
    const was = LOGIN_PER_AGENT.codex;
    (LOGIN_PER_AGENT as { codex: boolean }).codex = true;
    try {
      const { state, machines, dialog, tile } = await connect({ crew: true });
      const plus = (n: number, email: string) =>
        account({ id: `acct_${n}`, kind: "codex", label: "ChatGPT Plus", provider: null, keyHint: null, email });
      machines?.endLogin("login_1", { state: "done", account: plus(1, "walt@acme.com") });
      machines?.endLogin("login_2", { state: "done", account: plus(2, "other@acme.com") });
      await click(tile("ChatGPT"));
      const panel = within(dialog).getByRole("region", { name: "Seu plano do ChatGPT" });
      expect(within(panel).getByRole("combobox").textContent).toBe("Todos os agentes");
      const who = () => [...panel.querySelectorAll(".ai-panel__who > li")].map((li) => li.getAttribute("data-state"));
      expect(who()).toEqual(["now", "next", "next"]);
      expect(hintOf("Um login por agente, com a mesma conta.", panel).text).toBe(
        "Cada agente tem o próprio login. Todos dividem os limites do seu plano.",
      );
      await withPopup(() => click(within(panel).getByRole("button", { name: "Fazer login para a Ada" })));
      await settle(8);
      expect(calls(state, "agents.setBrain")[0]?.args).toEqual([ORG_ID, ADA_ID, { brain: "codex", account: "acct_1" }]);
      expect(who()).toEqual(["done", "now", "next"]);
      const done = panel.querySelector('.ai-panel__who > [data-state="done"] svg');
      expect(drawnAs(done, "check")).toBe(true);
      // Atlas lands on another account than Ada's: said, with a way back and a way through.
      await withPopup(() => click(within(panel).getByRole("button", { name: "Fazer login para o Atlas" })));
      await settle(8);
      expect(shownText(panel)).toContain(
        "O ChatGPT entrou como other@acme.com. Para usar walt@acme.com, saia na página do ChatGPT e tente de novo.",
      );
      expect(calls(state, "agents.setBrain")).toHaveLength(1);
      expect(within(panel).getByRole("button", { name: "Usar other@acme.com" })).toBeTruthy();
      await click(within(panel).getByRole("button", { name: "Tentar de novo" }));
      expect(calls(state, "machines.removeAccount").map((c) => c.args)).toEqual([[ORG_ID, "machine_1", "acct_2"]]);
      expect(within(panel).getByRole("button", { name: "Fazer login para o Atlas" })).toBeTruthy();
    } finally {
      (LOGIN_PER_AGENT as { codex: boolean }).codex = was;
    }
  });

  test("Claude signed in as another account than the one typed: said, and used only when asked", async () => {
    const { state, machines, dialog } = await connect({ brain: { ownSignIn: true } });
    machines?.endLogin("login_1", { state: "done", account: { ...claudeMax, email: "rafael@gmail.com" } });
    await click(within(dialog).getByRole("button", { name: /^Outra conta do Claude/ }));
    await type(within(dialog).getByLabelText("Qual conta? (opcional)"), "Rafael@Souza.com");
    await withPopup(() => click(within(dialog).getByRole("button", { name: "Entrar com Claude" })));
    await settle(8);
    expect(shownText(dialog)).toContain(
      "O Claude entrou como rafael@gmail.com. Para usar Rafael@Souza.com, saia na página do Claude e tente de novo.",
    );
    expect(calls(state, "agents.setBrain")).toHaveLength(0);
    await click(within(dialog).getByRole("button", { name: "Usar rafael@gmail.com" }));
    await settle(4);
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { brain: "claude_code", account: "acct_max" },
    ]);
    expect(dialog.textContent).toContain("Ada agora pensa com Claude Max.");
  });

  test("the API key's note leads with an agent, not an ⓘ that looks pressable", async () => {
    const { dialog, tile } = await connect();
    await click(tile("Chave de API"));
    const note = within(dialog).getByText("Todo agente sem plano pensa com ela.").closest(".ac-setnote");
    expect(drawnAs(note?.querySelector("svg"), "agent")).toBe(true);
  });
});
