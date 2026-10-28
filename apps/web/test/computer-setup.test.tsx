import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ComputerSetup, Machine } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { icons } from "@agenteschat/ui";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  setSystemTime();
  cleanup();
  localStorage.clear();
});

const SPECS = { cpus: 4, memoryGb: 8, diskGb: 100 };
/** No system, address, provider or tool list on these screens (ADR 0056 §10). */
const TECHNICAL = /Linux|\bIP\b|IPv4|Contabo|VPS|Debian|Chrome|\bgit\b|Outro sistema/;
const NOTICE = "O computador do workspace";
/** The clock faces a line can lead with: only the "as soon as it's ready" lines take one. */
const CLOCKS = [icons.clock, icons.waiting].map((shape) => shape.find(([tag]) => tag === "path")?.[1].d);
const leadsWithClock = (line: Element) =>
  CLOCKS.includes(line.firstElementChild?.querySelector("path")?.getAttribute("d") ?? undefined);

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
/** "Fica com esse time?": only these join Ada. */
const keepOnly = async (...keep: string[]) => {
  for (const name of ["Theo · PM", "Lia · Pesquisa", "Atlas · Ops"]) {
    const card = screen().getByRole("button", { name: new RegExp(name) });
    if ((card.getAttribute("aria-pressed") === "true") !== keep.includes(name)) await click(card);
  }
};

/** How often the query of this kind (its key's last part) is asked again, as its observer has it now. */
const pollEvery = (qc: QueryClient, key: string) => {
  const query = qc
    .getQueryCache()
    .findAll()
    .find((q) => q.queryKey.at(-1) === key && q.getObserversCount() > 0);
  const every = query?.observers[0]?.options.refetchInterval;
  return typeof every === "function" && query ? every(query) : every;
};

/** The workspace's own computer as the server lists it: named by the server, no system, nobody paired it. */
const WORKSPACE_COMPUTER: Partial<Machine> & { name: string } = {
  name: "Computador da Acme",
  kind: "managed",
  os: "other",
  arch: "",
  hostname: "",
  workspace: null,
  pairedBy: null,
  mode: "system",
};

/** Acme where the workspace's computer is ready (Ada on it) and the server has no cloud computer. */
async function readyWorkspace(path: string, patch: Partial<Machine> = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
  const m = machines.pair({ ...WORKSPACE_COMPUTER, ...patch });
  machines.setSetup({ state: "ready", machineId: m.id, specs: SPECS });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
  const settings = api.sandbox.settings;
  api.sandbox.settings = async (orgId) => ({ ...(await settings(orgId)), available: false });
  const r = await renderApp(path.replace("$machineId", m.id), { api });
  await settle(10);
  return { ...r, state, api, m };
}

/** The app at `path` where the workspace gets its own computer (`setup`), or where people pair theirs (null). */
async function open(
  path: string,
  setup: Partial<ComputerSetup> | null,
  state = seedState(),
  api = createFakeApi(state),
) {
  const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
  if (setup) machines.setSetup(setup);
  const r = await renderApp(path, { api });
  await settle(8);
  // The onboarding opens no socket.
  const socket = r.sockets.sockets.at(-1);
  if (socket) await act(async () => socket.open());
  const push = async (event: Partial<ComputerSetup> & { type?: string }) => {
    await act(async () =>
      socket?.push({
        type: "event",
        scope: "org",
        event: {
          type: "machine.provisioning",
          state: "preparing",
          step: null,
          reason: null,
          since: new Date().toISOString(),
          requestedAt: new Date(Date.now() - 30_000).toISOString(),
          expectedReadyAt: null,
          secondsLeft: null,
          secondsWaited: 30,
          specs: SPECS,
          machineId: null,
          ...event,
        },
      }),
    );
    await settle(6);
  };
  return { ...r, api, machines, socket, push };
}

describe("the workspace's computer on its way: the notice on top of the work area", () => {
  test("how far it is, the time left and who waits for it, live, closed until the state changes, gone once ready", async () => {
    const { push } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { state: "waiting", reason: "capacity" });
    const notice = () => screen().getByRole("region", { name: NOTICE });
    expect(notice().textContent).toContain("Preparando o computador da Acme");
    expect(notice().textContent).toContain("Esperando um computador disponível");
    expect(notice().textContent).not.toContain("Nada se perde");
    // Who waits for it: their faces, each named, and no sentence of names.
    expect(within(notice()).getByRole("img", { name: "Ada" })).toBeTruthy();
    expect(within(notice()).getByRole("img", { name: "Atlas" })).toBeTruthy();
    expect(notice().textContent).not.toContain("esperam por ele");
    // On a phone too, where other notices drop their faces: here nothing else says who waits.
    const css = await Bun.file(new URL("../src/responsive.css", import.meta.url).pathname).text();
    expect(css.split("\n  .setup-notice .outage__crew {")[1]?.split("}")[0]).toContain("display: inline-flex");
    expect(notice().textContent).not.toMatch(TECHNICAL);
    // This server sends no email: nothing is promised.
    expect(notice().textContent).not.toMatch(/avisamos/i);

    await push({ state: "preparing", step: "installing", secondsLeft: 330 });
    const line = () => notice().querySelector(".outage__text > span")?.textContent;
    expect(line()).toBe("Passo 3 de 4 · Instalando os programas · faltam uns 6 min");
    await push({ state: "preparing", step: "starting" });
    expect(line()).toBe("Passo 2 de 4 · Iniciando");

    // Closed: it stays closed for this step, and comes back for the next one.
    await click(within(notice()).getByRole("button", { name: "Ocultar" }));
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
    await push({ state: "preparing", step: "starting" });
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
    await push({ state: "preparing", step: "installing" });
    expect(notice().textContent).toContain("Instalando os programas");

    await push({ state: "problem" });
    expect(notice().textContent).toContain("Algo deu errado ao preparar o computador");
    await push({ state: "ready", machineId: "00000000-0000-4000-8000-000000000999" });
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
  });

  test("waiting for an available computer: owners read they'll be emailed in its line, and members don't", async () => {
    const wait = { state: "waiting", reason: "capacity", notifyByEmail: true } as const;
    const line = () =>
      screen().getByRole("region", { name: NOTICE }).querySelector(".outage__text > span")?.textContent ?? null;
    await open(`/org/${ORG_ID}/c/${ENG_ID}`, wait);
    expect(line()).toBe("Esperando um computador disponível. Avisamos por e-mail.");
    cleanup();
    const member = seedState();
    if (member.me?.organizations[0]) member.me.organizations[0].role = "member";
    await open(`/org/${ORG_ID}/c/${ENG_ID}`, wait, member);
    expect(line()).toBe("Esperando um computador disponível");
  });

  test("what it is doing within its step, in the same words on every screen; a stage it has no words for is its step", async () => {
    const { push } = await open(`/org/${ORG_ID}/settings/computers`, {
      step: "installing",
      stage: "updating",
      secondsLeft: 330,
    });
    const notice = () => screen().getByRole("region", { name: NOTICE }).textContent;
    const card = () => screen().getByRole("region", { name: "Computador da Acme" }).textContent;
    expect(notice()).toContain("Passo 3 de 4 · Atualizando o sistema · faltam uns 6 min");
    expect(card()).toContain("Passo 3 de 4 · Atualizando o sistema");
    await push({ step: "installing", stage: "restarting", secondsLeft: 300 });
    expect(notice()).toContain("Passo 3 de 4 · Reiniciando depois da atualização");
    expect(card()).toContain("Passo 3 de 4 · Reiniciando depois da atualização");
    await push({ step: "installing", stage: "defragmenting", secondsLeft: 240 });
    expect(notice()).toContain("Passo 3 de 4 · Instalando os programas");
    expect(card()).toContain("Passo 3 de 4 · Instalando os programas");
  });

  test("one time, read the same way everywhere: a screen opened later says what the notice says", async () => {
    // A minute and two seconds left: ten seconds on, before the notice repaints, it is under a minute.
    const { router } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { step: "installing", secondsLeft: 62 });
    const notice = () => screen().getByRole("region", { name: NOTICE }).textContent ?? "";
    expect(notice()).toContain("faltam uns 2 min");
    setSystemTime(new Date(Date.now() + 10_000));
    await act(async () =>
      router.navigate({ to: "/org/$orgId/settings/$section", params: { orgId: ORG_ID, section: "computers" } }),
    );
    await settle(6);
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    const time = card.querySelector(".setup-eta")?.textContent ?? "";
    expect(time).toMatch(/^Falta/);
    expect(notice()).toContain(time.charAt(0).toLowerCase() + time.slice(1));
  });

  test("the time line never steps back: almost ready only in the last step, a little longer once it runs out", async () => {
    const { push } = await open(`/org/${ORG_ID}/settings/computers`, {
      step: "installing",
      stage: "apps",
      secondsLeft: 50,
    });
    const notice = () => screen().getByRole("region", { name: NOTICE }).textContent ?? "";
    const time = () =>
      screen().getByRole("region", { name: "Computador da Acme" }).querySelector(".setup-eta")?.textContent;
    expect(notice()).toContain("Passo 3 de 4 · Instalando os programas · falta menos de um minuto");
    expect(time()).toBe("Falta menos de um minuto");
    // The apps end early: the last step, almost ready.
    await push({ step: "connecting", stage: "connecting", secondsLeft: 10 });
    expect(notice()).toContain("Passo 4 de 4 · Conectando ao seu workspace · quase pronto…");
    expect(time()).toBe("Quase pronto…");

    // Another wait whose time runs out during the apps: a little longer than expected, in the last step too.
    cleanup();
    const late = await open(`/org/${ORG_ID}/settings/computers`, { step: "installing", stage: "apps", secondsLeft: 0 });
    expect(notice()).toContain("Passo 3 de 4 · Instalando os programas · demorando um pouco mais que o previsto");
    expect(time()).toBe("Demorando um pouco mais que o previsto");
    await late.push({ step: "connecting", stage: "connecting", secondsLeft: -20 });
    expect(notice()).toContain("Passo 4 de 4 · Conectando ao seu workspace · demorando um pouco mais que o previsto");
    expect(time()).toBe("Demorando um pouco mais que o previsto");
  });

  test("where people connect their own computers, nothing changes: no notice", async () => {
    await open(`/org/${ORG_ID}/c/${ENG_ID}`, null);
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
  });
});

describe("no AI yet while the workspace's computer is on its way", () => {
  test("the banner is the one it always is: its line, its ⓘ and Connect, nothing about the computer", async () => {
    // The Cloud: Jev picks, so asking in the chat is understood (the line's ⓘ).
    const state = seedState({
      aiStatus: {
        any: false,
        agents: [{ agentId: ADA_ID, state: "no_ai", reason: "no_key" }],
        routing: { by: "jev", mine: "jev", model: null, noSmallModel: null },
      },
    });
    const { push } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { step: "installing", secondsLeft: 330 }, state);
    const banner = () => document.querySelector(".noai-banner") as HTMLElement;
    const ask = "Você também pode pedir no chat, como “usar meu plano do Claude”.";
    expect(shownText(banner())).toBe("Os agentes ainda não têm uma IA.Conectar uma IA");
    expect(hintOf("Conectar uma IA", banner()).text).toBe(ask);
    await push({ state: "ready", machineId: "00000000-0000-4000-8000-000000000999" });
    expect(shownText(banner())).toBe("Os agentes ainda não têm uma IA.Conectar uma IA");
    expect(hintOf("Conectar uma IA", banner()).text).toBe(ask);
  });
});

describe("Configurações → Computadores: the workspace's own computer", () => {
  test("on hold with none ready: paused, nothing on its way and no notice; active again, its wait shows", async () => {
    const state = seedState();
    const me = state.me;
    if (!me) throw new Error("no me");
    me.organizations = me.organizations.map((o) => ({ ...o, standing: { state: "hold", reason: null } }));
    // The server says no state for a workspace on hold whose computer isn't ready.
    const { machines, socket } = await open(`/org/${ORG_ID}/settings/computers`, { state: null }, state);
    const card = () => screen().getByRole("region", { name: "Computador da Acme" }).textContent ?? "";
    expect(card()).toContain("Pausado");
    expect(card()).toContain("Não está sendo preparado enquanto o workspace estiver em espera.");
    expect(card()).not.toContain("Sendo preparado");
    expect(card()).not.toContain("Avisamos");
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();

    // Active again: the app asks again, and the wait is back.
    machines.setSetup({ state: "preparing", step: "reserving" });
    await act(async () =>
      socket?.push({
        type: "event",
        scope: "org",
        event: { type: "org.standing", orgId: ORG_ID, state: "active", reason: null },
      }),
    );
    await settle(8);
    expect(card()).toContain("Sendo preparado");
    expect(card()).toContain("Passo 1 de 4 · Reservando o computador");
    expect(screen().getByRole("region", { name: NOTICE }).textContent).toContain("Preparando o computador da Acme");
  });

  test("its card instead of the cloud's: steps, size, one user per agent; ready, online with its agents", async () => {
    const { push, machines } = await open(`/org/${ORG_ID}/settings/computers`, {
      state: "preparing",
      step: "starting",
      specs: SPECS,
    });
    const card = () => screen().getByRole("region", { name: "Computador da Acme" });
    expect(card().textContent).toContain("Sendo preparado");
    expect(card().textContent).toContain("Passo 2 de 4 · Iniciando");
    expect(card().textContent).toContain("4 CPUs · 8 GB de memória · 100 GB de disco");
    // One user per agent is the name's ⓘ, not a line of the card.
    const users = "Um usuário para cada agente: cada um tem a própria pasta.";
    expect(hintOf("Computador da Acme", card()).text).toBe(users);
    expect(shownText(card())).not.toContain("Um usuário para cada agente");
    expect(card().textContent).not.toMatch(TECHNICAL);
    // Not the cloud computer's cards: there is none here.
    expect(screen().queryByText("Na nuvem")).toBeNull();
    expect(screen().queryByRole("region", { name: "Computador na nuvem" })).toBeNull();

    await push({ state: "waiting", reason: "capacity" });
    expect(card().textContent).toContain("Na fila");
    expect(card().textContent).toContain("Esperando um computador disponível");

    // Its first hello: ready, its row among the computers, the agents on it (each with its own folder only).
    const m = machines.pair({
      ...WORKSPACE_COMPUTER,
      agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }],
      access: { folders: [], tools: { claude: true, codex: true, commands: true } },
    });
    await push({ state: "ready", machineId: m.id });
    expect(card().textContent).toContain("Online");
    expect(card().textContent).toContain("Usado por Ada");
    // The page says what the agents' computer is here in one line, and its card doesn't say it again; nothing
    // else to connect or pick.
    const words = document.body.textContent ?? "";
    expect(words).toContain("Onde os agentes trabalham: um computador só deste workspace, sempre ligado.");
    for (const said of ["sempre ligado", "onde os agentes trabalham"])
      expect(words.toLowerCase().split(said)).toHaveLength(2);
    expect(card().textContent).not.toContain("Passo");
    expect(hintOf("Computador da Acme", card()).text).toBe(users);
    expect(screen().queryByRole("region", { name: "Outros computadores" })).toBeNull();
    expect(screen().queryByRole("region", { name: "Conectar outro computador" })).toBeNull();
    expect(screen().queryByRole("region", { name: "Qual computador cada agente usa" })).toBeNull();

    // Its page: its name, size and agents, Open beside each; no system, folder, Remove or "Para liberar mais".
    await click(within(card()).getByRole("link", { name: "Computador da Acme" }));
    await settle(6);
    expect(screen().getByRole("heading", { name: "Computador da Acme" })).toBeTruthy();
    expect(hintOf("Computador da Acme").text).toBe(users);
    // Each agent's own folder is that ⓘ: no line under the agent saying it again.
    expect(shownText(document.body)).not.toContain("Só a própria pasta");
    expect(screen().getByRole("button", { name: "Abrir: Computador da Ada" })).toBeTruthy();
    const page = document.body.textContent ?? "";
    expect(page).toContain("4 CPUs · 8 GB de memória · 100 GB de disco");
    expect(page.toLowerCase().split("sempre ligado")).toHaveLength(2);
    expect(page).not.toMatch(TECHNICAL);
    expect(page).not.toContain("Pasta:");
    expect(page).not.toContain("Para liberar mais");
    const actions = screen().getByRole("button", { name: "Ações de Computador da Acme" });
    actions.focus();
    await act(async () => {
      fireEvent.keyDown(actions, { key: "Enter" });
      fireEvent.keyUp(actions, { key: "Enter" });
    });
    await settle(2);
    const menu = screen().getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Renomear" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Remover" })).toBeNull();
  });

  test("its page: what it is behind its name's ⓘ, its help page at the end, nothing to turn off that nobody here could turn back on", async () => {
    await readyWorkspace(`/org/${ORG_ID}/settings/computers/$machineId`, {
      agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }],
      access: {
        folders: [{ path: "/srv/shared", agents: [ADA_ID] }],
        tools: { claude: true, codex: true, commands: true, browser: true, desktop: true },
      },
      browser: {
        available: false,
        version: null,
        chrome: null,
        reason: "ETXTBSY: text file is busy; run `agentes-runner browser install`",
      },
      desktopUse: { available: false, reason: "Missing packages: run `sudo apt-get install xdotool`" },
    });
    expect(screen().getByRole("heading", { name: "Computador da Acme" })).toBeTruthy();
    expect(hintOf("Computador da Acme").text).toBe("Um usuário para cada agente: cada um tem a própria pasta.");
    // No card of what is on it, and no plans: what it is and how it works is its help page, linked once at the end.
    expect(screen().queryByRole("region", { name: "Neste computador" })).toBeNull();
    expect(document.body.textContent).not.toContain("plano de IA");
    const about = screen().getByRole("link", { name: "Sobre este computador" });
    const url = new URL(about.getAttribute("href") ?? "");
    expect(url.origin + url.pathname).toBe("https://agentes.chat/help/workspace-computer");
    expect(url.searchParams.get("lang")).toBe("pt-BR");
    expect(about.className).toBe("ac-link ac-link--muted");
    expect(about.getAttribute("rel")).toBe("noopener noreferrer");
    const links = [...document.querySelectorAll("main a, .settings__body a")];
    expect(links.at(-1)).toBe(about);
    // Not the cards of a computer someone connected: folders, tools, browser, apps.
    for (const name of ["Pastas liberadas", "Ferramentas", "Navegador", "Apps nas telas dos agentes"])
      expect(screen().queryByRole("region", { name })).toBeNull();
    expect(screen().queryAllByRole("button", { name: /^Desligar/ })).toEqual([]);
    expect(screen().queryByRole("button", { name: "Ações de shared" })).toBeNull();
    const page = document.body.textContent ?? "";
    for (const word of ["ETXTBSY", "agentes-runner", "apt-get", "Preferências", "Linux"])
      expect(page).not.toContain(word);
  });

  test("an agent on it: no word about allowing more on the computer itself", async () => {
    await readyWorkspace(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, {
      access: { folders: [], tools: { claude: true, codex: true, commands: true } },
    });
    const pc = document.querySelector(".agp-pc") as HTMLElement;
    expect(pc.textContent).toContain("Computador da Acme");
    // What it is, its name's ⓘ; its name once, with no read-only row naming it again.
    expect(hintOf("Computador da Acme", pc).text).toBe(
      "O computador do próprio workspace: sempre ligado, com um usuário só dele para cada agente.",
    );
    expect(pc.querySelector(".agp-ro")).toBeNull();
    expect(pc.textContent).toContain("Usa só a própria pasta no Computador da Acme.");
    expect(pc.textContent).not.toContain("por quem o conectou");
    expect(within(pc).queryByRole("button", { name: "Sobre Pastas no computador" })).toBeNull();
  });

  test("ready: every agent works on the workspace's computer, with nothing to pick", async () => {
    await readyWorkspace(`/org/${ORG_ID}/settings/computers`);
    expect(screen().queryByRole("region", { name: "Qual computador cada agente usa" })).toBeNull();
    expect(screen().queryByRole("combobox", { name: "Computador de Ada" })).toBeNull();
    cleanup();

    await readyWorkspace(`/org/${ORG_ID}/agents/${ADA_ID}`);
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).toContain("Trabalha no");
    expect(work.textContent).toContain("Computador da Acme");
    // A static line: no chevron, no picker.
    expect(screen().queryByRole("button", { name: "Mudar onde trabalha" })).toBeNull();
    expect(work.textContent).not.toMatch(/nuvem/i);
  });

  test("who hears when it's ready: owners of a server that sends email; anyone else reads it shows here", async () => {
    const wait = { state: "waiting", reason: "capacity", notifyByEmail: true } as const;
    const card = () => screen().getByRole("region", { name: "Computador da Acme" }).textContent ?? "";
    await open(`/org/${ORG_ID}/settings/computers`, wait);
    expect(card()).toContain("Avisamos você em walter@acme.com.br quando ele ficar pronto.");
    expect(card()).not.toContain("Pode fechar esta página");
    expect(card()).not.toContain("Aparece aqui");
    cleanup();

    // Only owners get the email: nobody else is promised it.
    const member = seedState();
    if (member.me?.organizations[0]) member.me.organizations[0].role = "member";
    await open(`/org/${ORG_ID}/settings/computers`, wait, member);
    expect(card()).toContain("Aparece aqui assim que ficar pronto.");
    expect(card()).not.toContain("Avisamos");
    cleanup();

    // A server that sends no email promises none, to owners either.
    await open(`/org/${ORG_ID}/settings/computers`, { ...wait, notifyByEmail: false });
    expect(card()).toContain("Aparece aqui assim que ficar pronto.");
    expect(card()).not.toContain("Avisamos");
  });

  test("while it is on its way: no picker either, the wait in its place", async () => {
    await open(`/org/${ORG_ID}/settings/computers`, { state: "waiting", reason: "capacity" });
    expect(screen().queryByRole("region", { name: "Qual computador cada agente usa" })).toBeNull();
    expect(screen().getByRole("region", { name: "Computador da Acme" }).textContent).toContain("Na fila");
  });
});

describe("an agent's computer while the workspace's is on its way", () => {
  test("Como trabalha says where it will work and why it waits", async () => {
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, { state: "waiting", reason: "capacity" });
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).toContain("Trabalha no");
    expect(work.textContent).toContain("Computador da Acme");
    expect(work.textContent).toContain("Na fila");
    expect(work.textContent).not.toContain("nuvem");
    // The cell says where it will work and how far along it is: no line under it saying the agent waits.
    expect(document.body.textContent).not.toContain("começa a usar assim que ele ficar pronto");
  });

  test("once ready, the agent works on the workspace's computer, by its name", async () => {
    await readyWorkspace(`/org/${ORG_ID}/agents/${ADA_ID}`);
    const work = document.querySelector(".agp-workcard") as HTMLElement;
    expect(work.textContent).toContain("Trabalha no");
    expect(work.textContent).toContain("Computador da Acme");
    expect(document.body.textContent).not.toContain("A Ada começa a usar");
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
  });

  test("Configurações › its computer: the progress, and no cloud PC to create", async () => {
    await open(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { state: "preparing", step: "installing" });
    const pc = document.querySelector(".agp-pc") as HTMLElement;
    expect(pc.textContent).toContain("Computador da Acme");
    expect(pc.textContent).toContain("Passo 3 de 4 · Instalando os programas");
    expect(pc.textContent).not.toContain("começa a usar assim que ele ficar pronto");
    // Its name already shows there: no read-only row naming it again.
    expect(pc.textContent?.split("Computador da Acme")).toHaveLength(2);
    expect(pc.querySelector(".agp-ro")).toBeNull();
    expect(pc.textContent).not.toMatch(TECHNICAL);
    expect(within(pc).queryByRole("button", { name: /Criar PC/ })).toBeNull();
  });
});

describe("a computer connected in system mode (each agent its own user)", () => {
  test("its page says so instead of the folder it was connected from, and allowing takes its administrator", async () => {
    const { machines, router, socket } = await open(`/org/${ORG_ID}/settings/computers`, null);
    const box = machines.pair({ name: "Servidor", os: "linux", mode: "system", workspace: "/root/agentes" });
    const laptop = machines.pair({ name: "Notebook", os: "linux", workspace: "/home/ana/agentes" });
    const mac = machines.pair({ name: "MacBook", os: "darwin", workspace: "/Users/ana/agentes" });
    await act(async () =>
      socket?.push({
        type: "event",
        scope: "org",
        event: { type: "machine.paired", machineId: box.id, name: box.name },
      }),
    );
    await settle(6);
    const page = async (id: string) => {
      await act(async () =>
        router.navigate({ to: "/org/$orgId/settings/computers/$machineId", params: { orgId: ORG_ID, machineId: id } }),
      );
      await settle(8);
      return document.body.textContent ?? "";
    };

    const system = await page(box.id);
    expect(system).toContain("Cada agente trabalha com o próprio usuário, na própria pasta.");
    expect(system).not.toContain("/root/agentes");
    expect(system).toContain("Liberar é no próprio computador, no Terminal dele, como administrador:");
    expect(system).toContain("sudo agentes-runner folders allow <pasta> --agent <agente>");
    expect(system).not.toContain("app do agentes.chat");

    // One user for every agent: the folder it was connected from is theirs, and the Terminal needs no sudo.
    const single = await page(laptop.id);
    expect(single).toContain("Pasta: /home/ana/agentes");
    expect(single).toContain("Liberar é no próprio computador, no Terminal dele:");
    expect(single).not.toContain("sudo");
    expect(single).not.toContain("app do agentes.chat");

    // A Mac keeps the app first, the terminal as the way without it.
    const onMac = await page(mac.id);
    expect(onMac).toContain("abra o app do agentes.chat nele (Preferências → Pastas).");
    expect(onMac).toContain("Sem o app? No terminal do computador:");
  });
});

describe("the onboarding where the workspace gets its own computer", () => {
  test("the computer step shows it being prepared: nothing to choose, nothing to skip, go on", async () => {
    const state = seedState();
    if (state.me) state.me.organizations = [];
    await open("/onboarding", { state: "waiting", reason: "capacity", specs: SPECS, notifyByEmail: true }, state);
    const type = async (label: string, value: string) => {
      await act(async () => fireEvent.change(screen().getByLabelText(label), { target: { value } }));
      await settle(2);
    };
    const button = (name: string) => screen().getByRole("button", { name });
    await type("Nome", "Acme Saúde");
    await click(button("Continuar"));
    await settle(4);
    await type("Contexto", "Clínicas.");
    await click(button("Continuar"));
    await settle(4);
    await click(button("Pular esta etapa"));
    await settle(6);

    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
    const step = document.querySelector(".onb__workspace-computer") as HTMLElement;
    expect(step.textContent).toContain("Computador da Acme Saúde");
    // Its name and its ⓘ, no line under the name; then the wait, the email, the size and that the person goes on.
    expect(hintOf("Computador da Acme Saúde", step).text).toBe(
      "Um usuário para cada agente: cada um tem a própria pasta.",
    );
    expect(step.textContent).not.toContain("Um computador só de vocês");
    expect(step.textContent).toContain("Esperando um computador disponível");
    expect(step.textContent).not.toContain("Nada se perde");
    // Whoever creates the workspace owns it: the email is theirs, and nothing says the page can be closed.
    expect(step.textContent).toContain("Avisamos você em walter@acme.com.br quando ele ficar pronto.");
    expect(step.textContent).not.toContain("Pode fechar esta página");
    expect(step.textContent).toContain("4 CPUs · 8 GB de memória · 100 GB de disco");
    // No plans: the AI step is where they are.
    expect(step.textContent).not.toContain("plano de IA");
    // Every line starts with its icon, set on the line's first line of text.
    const lines = [...step.querySelectorAll(".setup-progress--line, .setup-line, .onb__status")];
    expect(lines.length).toBe(4);
    for (const line of lines) {
      expect(line.classList.contains("ac-iconline")).toBe(true);
      expect(line.firstElementChild?.matches("svg.ac-icon, canvas.ac-pixspin")).toBe(true);
    }
    // The wait leads with the orbit, like any wait that is under way, never a clock.
    expect(step.querySelector(".setup-progress--line")?.firstElementChild?.matches("canvas.ac-pixspin")).toBe(true);
    expect(lines.filter(leadsWithClock)).toEqual([]);
    // One lead size, so those lines' words start in one column (the status under them is a box of its own).
    for (const line of lines.filter((l) => !l.matches(".onb__status"))) {
      const lead = line.firstElementChild as HTMLElement;
      expect(lead.style.width).toBe("14px");
    }
    // The lead says where, and the rail says how far: never "opcional".
    expect(document.body.textContent).toContain("Num computador só deste workspace, sempre ligado.");
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Na fila");
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).not.toContain("opcional");
    expect(step.textContent).toContain("Pode seguir enquanto isso.");
    expect(step.textContent).not.toMatch(TECHNICAL);
    // No cloud PC or computer of mine to pick, and nothing to skip.
    expect(screen().queryByRole("button", { name: /Computador na nuvem/ })).toBeNull();
    expect(screen().queryByRole("button", { name: "Pular esta etapa" })).toBeNull();
    expect(button("Continuar").hasAttribute("disabled")).toBe(false);
    await click(button("Continuar"));
    await settle(4);
    expect(screen().getByRole("heading", { name: "Fica com esse time?" })).toBeTruthy();
  });

  test("a hold put on the new workspace meanwhile: the hold speaks, with no time and no email", async () => {
    const state = seedState();
    if (state.me) state.me.organizations = [];
    const r = await open(
      "/onboarding",
      { state: "preparing", step: "installing", secondsLeft: 330, notifyByEmail: true },
      state,
    );
    const type = async (label: string, value: string) => {
      await act(async () => fireEvent.change(screen().getByLabelText(label), { target: { value } }));
      await settle(2);
    };
    const button = (name: string) => screen().getByRole("button", { name });
    await type("Nome", "Acme Saúde");
    await click(button("Continuar"));
    await settle(4);
    await type("Contexto", "Clínicas.");
    await click(button("Continuar"));
    await settle(4);
    await click(button("Pular esta etapa"));
    await settle(6);
    const step = () => (document.querySelector(".onb__workspace-computer") as HTMLElement).textContent ?? "";
    expect(step()).toContain("Faltam uns 6 min");

    // Held (a review of the new sign-up, say): its provisioner waits too, so no countdown and no promise.
    const me = state.me;
    if (!me) throw new Error("no me");
    state.me = {
      ...me,
      organizations: me.organizations.map((o) =>
        o.name === "Acme Saúde" ? { ...o, standing: { state: "hold", reason: null } } : o,
      ),
    };
    await act(async () => r.services.queryClient.invalidateQueries({ queryKey: keys.me }));
    await settle(6);
    expect(step()).toContain("Os agentes deste workspace estão pausados para uma revisão.");
    expect(step()).not.toContain("Faltam");
    expect(step()).not.toContain("Avisamos");
  });

  /**
   * A new person's onboarding up to the computer step, the import skipped. Its agents get the workspace's computer
   * once it's ready (`computer.ready`), as the server gives it to them; nobody connected it.
   */
  const toComputerStep = async (
    setup: Partial<ComputerSetup>,
    prepare?: (state: ReturnType<typeof seedState>) => void,
  ) => {
    const state = seedState();
    if (state.me) state.me.organizations = [];
    prepare?.(state);
    // The server says every workspace gets its own: never "opcional", from the first step on.
    state.authConfig = { workspaceComputer: true };
    const api = createFakeApi(state);
    const computer = { ready: setup.state === "ready" };
    const brainOf = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({
      ...(await brainOf(orgId, agentId)),
      computer: computer.ready ? { machineId: "m-1", name: "Computador da Acme Saúde", online: true } : null,
      machines: [],
      ownSignIn: false,
    });
    api.machines.aiAccounts = async () => ({
      accounts: [],
      computers: computer.ready
        ? [
            {
              machineId: "m-1",
              name: "Computador da Acme Saúde",
              online: true,
              mine: false,
              canAdd: true,
              keys: true,
              brains: { claude_code: true, codex: true },
            },
          ]
        : [],
    });
    const r = await open("/onboarding", setup, state, api);
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).not.toContain("opcional");
    for (const [label, value] of [
      ["Nome", "Acme Saúde"],
      ["Contexto", "Clínicas."],
    ] as const) {
      await act(async () => fireEvent.change(screen().getByLabelText(label), { target: { value } }));
      await click(screen().getByRole("button", { name: "Continuar" }));
    }
    await click(screen().getByRole("button", { name: "Pular esta etapa" }));
    const reported = async (next: Partial<ComputerSetup>) => {
      r.machines.setSetup(next);
      computer.ready = next.state === "ready";
      await act(async () => r.services.queryClient.invalidateQueries());
      await settle(6);
    };
    return { ...r, state, computer, reported };
  };

  test("a computer kept ready: every line follows it in seconds, and nothing waits once it's ready", async () => {
    const r = await toComputerStep({ state: "preparing", specs: SPECS, notifyByEmail: true });
    const step = () => (document.querySelector(".onb__workspace-computer") as HTMLElement).textContent ?? "";
    // Nothing reported yet: no time is promised.
    expect(step()).toContain("Preparando o computador.");
    expect(step()).not.toContain("minutos");

    // One kept ready is handed over: the last step, seconds away. The steps before it are done, it is under way.
    await r.reported({ state: "preparing", step: "connecting", secondsLeft: 6, specs: SPECS, notifyByEmail: true });
    const bars = [...document.querySelectorAll(".onb__workspace-computer .ac-steps__bar")];
    expect(bars.map((b) => [b.getAttribute("data-done"), b.hasAttribute("data-current")])).toEqual([
      ["true", false],
      ["true", false],
      ["true", false],
      ["false", true],
    ]);
    expect(step()).toContain("Passo 4 de 4 · Conectando ao seu workspace");
    expect(step()).toContain("Quase pronto…");

    await r.reported({ state: "ready", machineId: "m-1", specs: SPECS, notifyByEmail: true });
    expect(document.body.textContent).toContain("Num computador só deste workspace, sempre ligado.");
    expect(step()).toContain("Pronto.");
    expect(step()).not.toMatch(/Os agentes trabalham nele|plano de IA/);
    expect(step()).not.toMatch(/Quando ficar pronto|Pode seguir/);
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Pronto");

    // The team is made before the AI: the AI step opens on Claude's sign-in, on the workspace's computer.
    await click(screen().getByRole("button", { name: "Continuar" }));
    await click(screen().getByRole("button", { name: "Criar 3 agentes" }));
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    expect(within(rail).getByRole("button", { name: /^Agentes e IA/ })).toBeTruthy();
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect((within(panel).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await click(screen().getByRole("button", { name: "Conectar depois" }));
    await settle(6);
    await click(screen().getByRole("button", { name: "Pular esta etapa" }));
    // Done: the computer lit at the end of the faces, saying whose it is and how far; Lia browses on it, so she asks.
    const plate = screen().getByRole("img", { name: "Computador da Acme Saúde · Pronto" });
    expect(plate.getAttribute("data-state")).toBe("online");
    expect(plate.closest(".onb__crew-computer")?.getAttribute("title")).toBe("Computador da Acme Saúde · Pronto");
    // Spaced by the row's gap alone: wrapped onto a line of its own (more faces, a phone), it starts under the first.
    const css = await Bun.file(new URL("../src/pages/onboarding.css", import.meta.url).pathname).text();
    expect(css.match(/\.onb__crew-computer \{[^}]*\}/)?.[0]).not.toContain("margin");
    expect(
      (screen().getByRole("textbox", { name: "Sua primeira mensagem no #general" }) as HTMLTextAreaElement).value,
    ).toBe("@lia Quem são os nossos 5 concorrentes mais próximos, e o que eles fazem melhor que a gente?");
    expect(screen().getByRole("button", { name: "Enviar para Lia" })).toBeTruthy();
  });

  test("Done while it's prepared: the computer's portrait dimmed with the time left, and Theo asks, since Lia can't browse yet", async () => {
    await toComputerStep({ state: "preparing", step: "installing", secondsLeft: 600, specs: SPECS });
    await click(screen().getByRole("button", { name: "Continuar" }));
    await click(screen().getByRole("button", { name: "Criar 3 agentes" }));
    await click(screen().getByRole("button", { name: "Conectar depois" }));
    await settle(6);
    await click(screen().getByRole("button", { name: "Pular esta etapa" }));
    const plate = screen().getByRole("img", { name: "Computador da Acme Saúde · Sendo preparado · Faltam uns 10 min" });
    expect(plate.getAttribute("data-state")).toBe("paused");
    expect(
      (screen().getByRole("textbox", { name: "Sua primeira mensagem no #general" }) as HTMLTextAreaElement).value,
    ).toBe("@theo Monte o plano da nossa primeira semana: o que cada um de nós faz primeiro?");
    expect(screen().getByRole("button", { name: "Enviar para Theo" })).toBeTruthy();
  });

  test("on hold before its computer is made: the lead says when it gets prepared, not that it's always on", async () => {
    // The server gives no state for a workspace on hold whose computer isn't ready.
    await toComputerStep({ state: null });
    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
    expect(document.querySelector(".onb__lead")?.textContent).toBe(
      "Num computador só deste workspace, preparado quando o workspace voltar a funcionar.",
    );
  });

  test("its first time shows at once: asked every 2 s until the provisioner says one, with the email line", async () => {
    const r = await toComputerStep({ state: "preparing", specs: SPECS, notifyByEmail: true });
    const step = () => (document.querySelector(".onb__workspace-computer") as HTMLElement).textContent ?? "";
    expect(step()).toContain("Preparando o computador.");
    expect(step()).not.toContain("Avisamos");
    expect(pollEvery(r.services.queryClient, "computer-setup")).toBe(2000);
    await r.reported({
      state: "preparing",
      step: "installing",
      stage: "updating",
      secondsLeft: 600,
      specs: SPECS,
      notifyByEmail: true,
    });
    expect(step()).toContain("Passo 3 de 4 · Atualizando o sistema");
    expect(step()).toContain("Faltam uns 10 min");
    expect(step()).toContain("Avisamos você em walter@acme.com.br quando ele ficar pronto.");
    expect(pollEvery(r.services.queryClient, "computer-setup")).toBe(5000);
  });

  test("the AI step while it's prepared: Claude's panel waits in place, then turns on by itself; nothing starts before a click", async () => {
    const r = await toComputerStep({
      state: "preparing",
      step: "installing",
      secondsLeft: 600,
      specs: SPECS,
      notifyByEmail: true,
      expectedReadyAt: new Date(Date.now() + 600_000).toISOString(),
    });
    await click(screen().getByRole("button", { name: "Continuar" }));
    expect(screen().getByRole("heading", { name: "Fica com esse time?" })).toBeTruthy();
    // Every step keeps asking about it while it's on its way.
    const interval = (key: string) => pollEvery(r.services.queryClient, key);
    expect(interval("computer-setup")).toBe(5000);
    await keepOnly("Theo · PM");
    await click(screen().getByRole("button", { name: "Criar 1 agente" }));
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    // Ada and Theo exist before any AI: leaving now leaves a whole team.
    expect(r.state.calls.filter((c) => c.method === "agents.create")).toHaveLength(2);
    const panel = () => screen().getByRole("region", { name: "Seu plano do Claude" });
    // The computer's wait in the panel's well, the owner's email line with no address. "Ready" is said there once:
    // the sign-in's step adds no timing of its own.
    const well = panel().querySelector(".ai-panel__wait") as HTMLElement;
    expect(well.textContent).toBe(
      "Passo 3 de 4 · Instalando os programasFaltam uns 10 minAvisamos você por e-mail quando ele ficar pronto. Pode fechar esta página.",
    );
    expect(panel().textContent?.split("pronto")).toHaveLength(2);
    expect(well.querySelector(".ac-iconline")).toBeNull();
    expect([...panel().querySelectorAll(".ac-iconline")].filter(leadsWithClock)).toEqual([]);
    const signIn = () => within(panel()).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement;
    expect(signIn().disabled).toBe(true);
    // Ada asks which AI they use, so the plan is for her, as the foot says; Theo is the other choice.
    expect(within(panel()).getByRole("combobox", { name: "Agentes que usam este plano" }).textContent).toBe("Ada");
    expect(panel().querySelector(".ac-card__foot")?.textContent).toContain("a Ada só responde a você");
    // No socket here: the agent's view and the accounts are asked again every 5 s until something is connected,
    // and so is a hold, which the panel would say instead.
    expect(interval("brain")).toBe(5000);
    expect(interval("ai-accounts")).toBe(5000);
    const meEvery = () =>
      r.services.queryClient
        .getQueryCache()
        .find({ queryKey: keys.me })
        ?.observers.map((o) => o.options.refetchInterval);
    expect(meEvery()).toContain(5000);
    expect(screen().getByRole("button", { name: "Continuar" }).hasAttribute("disabled")).toBe(true);
    expect(screen().getByRole("button", { name: "Conectar depois" })).toBeTruthy();

    // It turns ready while the person watches: said in place, and the sign-in comes on. Still nothing started. The
    // news comes with the setup's own poll (the rail's): the panel follows it then, not at its view's next poll.
    const orgId = String(r.state.calls.find((c) => c.method === "agents.create")?.args[0]);
    r.machines.setSetup({ state: "ready", machineId: "m-1", specs: SPECS, notifyByEmail: true });
    r.computer.ready = true;
    await act(async () => r.services.queryClient.invalidateQueries({ queryKey: keys.computerSetup(orgId) }));
    await settle(8);
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Pronto");
    expect(panel().textContent).toContain("O Computador da Acme Saúde está pronto.");
    expect(panel().textContent).not.toContain("assim que o computador ficar pronto");
    expect(panel().querySelector(".ai-panel__wait")).toBeNull();
    expect(signIn().disabled).toBe(false);
    expect(interval("computer-setup")).toBe(false);
    expect(r.state.calls.filter((c) => c.method === "machines.beginAccountLogin")).toHaveLength(0);
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(signIn());
      await settle(6);
    } finally {
      window.open = realOpen;
    }
    expect(r.state.calls.filter((c) => c.method === "machines.beginAccountLogin").map((c) => c.args)).toEqual([
      [orgId, "m-1", "claude_code"],
    ]);
    expect(meEvery()).not.toContain(5000);
    // Left for later: the sign-in stops on the computer it started on.
    await click(screen().getByRole("button", { name: "Conectar depois" }));
    expect(r.state.calls.filter((c) => c.method === "machines.cancelAccountLogin").map((c) => c.args)).toEqual([
      [orgId, "m-1", "login_1"],
    ]);
    // Back to the step (the team, kept as it is, then the AI): the panel still says the computer it waited for is ready.
    await click(screen().getByRole("button", { name: "Voltar" }));
    expect(screen().getByRole("heading", { name: "Fica com esse time?" })).toBeTruthy();
    await click(screen().getByRole("button", { name: /^Continuar/ }));
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    expect(panel().textContent).toContain("O Computador da Acme Saúde está pronto.");
  });

  test("the AI step as it turns ready, the agent's view and the accounts still on their way: ready, its sign-in loading, never a wait", async () => {
    for (const plan of ["Claude", "GLM Coding"] as const) {
      const r = await toComputerStep({ state: "preparing", step: "installing", secondsLeft: 600, specs: SPECS });
      await click(screen().getByRole("button", { name: "Continuar" }));
      await keepOnly("Theo · PM");
      await click(screen().getByRole("button", { name: "Criar 1 agente" }));
      if (plan !== "Claude") {
        const picker = screen().getByRole("group", { name: "Qual IA eles vão usar?" });
        await click(within(picker).getByRole("button", { name: /^GLM Coding/ }));
      }
      const panel = () =>
        screen().getByRole("region", { name: plan === "Claude" ? "Seu plano do Claude" : "GLM Coding Plan" });
      const action = () =>
        within(panel()).getByRole("button", { name: plan === "Claude" ? "Entrar com Claude" : /^Enviar ao/ });
      // Asked again at ready, the agent's view and the accounts answer late, the view first: each says what was
      // true when it was asked.
      let viewIn = () => {};
      let accountsIn = () => {};
      const viewBack = new Promise<void>((done) => {
        viewIn = done;
      });
      const accountsBack = new Promise<void>((done) => {
        accountsIn = done;
      });
      const brain = r.api.agents.brain;
      r.api.agents.brain = async (...args) => {
        const answer = brain(...args);
        await viewBack;
        return answer;
      };
      const accounts = r.api.machines.aiAccounts;
      r.api.machines.aiAccounts = async (...args) => {
        const answer = accounts(...args);
        await accountsBack;
        return answer;
      };
      const orgId = String(r.state.calls.find((c) => c.method === "agents.create")?.args[0]);
      r.machines.setSetup({ state: "ready", machineId: "m-1", specs: SPECS });
      r.computer.ready = true;
      await act(async () => r.services.queryClient.invalidateQueries({ queryKey: keys.computerSetup(orgId) }));
      await settle(8);
      // Whatever has come back, the panel says what the rail says, and no plan dims.
      const saysReady = () => {
        const rail = screen().getByRole("navigation", { name: "Passos para começar" });
        expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Pronto");
        expect(panel().textContent).toContain("O Computador da Acme Saúde está pronto.");
        expect(panel().textContent).not.toContain("assim que ele ficar pronto");
        expect(panel().textContent).not.toContain("Ainda não está pronto");
        expect(document.querySelectorAll(".grid-options--plans .ac-brand--off")).toHaveLength(0);
      };
      saysReady();
      expect(action().getAttribute("aria-busy")).toBe("true");
      viewIn();
      await settle(8);
      saysReady();
      expect(action().getAttribute("aria-busy")).toBe("true");
      accountsIn();
      await settle(8);
      saysReady();
      expect(action().hasAttribute("aria-busy")).toBe(false);
      if (plan === "Claude") expect((action() as HTMLButtonElement).disabled).toBe(false);
      expect(r.state.calls.filter((c) => c.method === "machines.beginAccountLogin")).toHaveLength(0);
      cleanup();
    }
  });

  test("the AI step while it waits for a computer or has a problem: the email in place of a time, no key button", async () => {
    for (const setup of [{ state: "waiting", reason: "capacity" }, { state: "problem" }] as const) {
      const r = await toComputerStep({ ...setup, specs: SPECS, notifyByEmail: true });
      await click(screen().getByRole("button", { name: "Continuar" }));
      await click(screen().getByRole("button", { name: "Criar 3 agentes" }));
      const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
      expect(panel.textContent).toContain(
        setup.state === "problem" ? "Algo deu errado ao preparar o computador" : "Esperando um computador disponível",
      );
      // No time to give: the owner reads when they'll hear, once.
      const well = panel.querySelector(".ai-panel__wait") as HTMLElement;
      expect(well.textContent).toContain("Avisamos você por e-mail quando ele ficar pronto. Pode fechar esta página.");
      expect(panel.textContent?.split("pronto")).toHaveLength(2);
      expect([...panel.querySelectorAll(".ac-iconline")].filter(leadsWithClock)).toEqual([]);
      // A key is the picker's own row, under the panel: no button for it in any wait.
      expect(within(panel).queryByRole("button", { name: "Usar uma chave de API agora" })).toBeNull();
      const picker = screen().getByRole("group", { name: "Qual IA eles vão usar?" });
      await click(within(picker).getByRole("button", { name: /^Chave de API/ }));
      expect(screen().getByRole("region", { name: "Chave de API" })).toBeTruthy();
      expect(r.state.calls.filter((c) => c.method === "machines.beginAccountLogin")).toHaveLength(0);
      cleanup();
    }
  });

  test("a coding plan thinks for all of them at once by default; then the Team step says nobody else gets an answer", async () => {
    // Only this workspace's agents.
    const r = await toComputerStep({ state: "ready", machineId: "m-1", specs: SPECS }, (state) => {
      state.agents = [];
    });
    await click(screen().getByRole("button", { name: "Continuar" }));
    await click(screen().getByRole("button", { name: "Criar 3 agentes" }));
    const picker = screen().getByRole("group", { name: "Qual IA eles vão usar?" });
    // Claude signs in once per account: one agent, the first in the team's order.
    const claude = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(within(claude).getByRole("combobox").textContent).not.toBe("Todos os agentes");
    await click(within(picker).getByRole("button", { name: /^GLM Coding/ }));
    const panel = screen().getByRole("region", { name: "GLM Coding Plan" });
    expect(within(panel).getByRole("combobox").textContent).toBe("Todos os agentes");
    const who = [...panel.querySelectorAll(".ai-panel__who > li")].map((li) => li.textContent);
    expect(who).toEqual(["TheoEsperando", "AdaEsperando", "LiaEsperando", "AtlasEsperando"]);
    for (const n of [1, 2, 3, 4]) {
      r.machines.endLogin(`login_${n}`, {
        state: "done",
        account: {
          id: `acct_${n}`,
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
        },
      });
    }
    await act(async () =>
      fireEvent.change(within(panel).getByLabelText("Chave do GLM Coding"), {
        target: { value: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOp" },
      }),
    );
    await click(within(panel).getByRole("button", { name: /^Enviar ao/ }));
    await settle(12);
    expect(r.state.calls.filter((c) => c.method === "agents.setBrain")).toHaveLength(4);
    expect(panel.textContent).toContain("Theo, Ada, Lia e Atlas agora pensam com GLM Coding.");
    // Every agent has an AI: Who thinks has nobody left to offer the key for.
    expect(screen().queryByRole("region", { name: "Quem pensa" })).toBeNull();
    // On a plan each answers only its owner, as the server sets them.
    const orgId = String(r.state.calls.find((c) => c.method === "agents.create")?.args[0]);
    for (const a of r.state.agents) {
      a.ownerUserId = "u-walter";
      a.audience = { mode: "owner", userIds: [] };
    }
    await click(screen().getByRole("button", { name: "Continuar" }));
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    const note = () => screen().queryByText("Seus agentes só respondem a você.")?.closest(".setup-line");
    expect(note()).toBeTruthy();
    expect(hintOf("Seus agentes só respondem a você.").text).toBe(
      "Um plano é pessoal. Agentes que usam a chave de API respondem a todos.",
    );
    // It comes before the invitations it's about.
    const emails = screen().getByLabelText("E-mails");
    expect((note() as Element).compareDocumentPosition(emails) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One agent on the API key answering everyone: someone invited gets an answer, so nothing to say.
    const first = r.state.agents[0];
    if (first) first.audience = { mode: "everyone", userIds: [] };
    await act(async () => r.services.queryClient.invalidateQueries({ queryKey: keys.agents(orgId) }));
    await settle(4);
    expect(note()).toBeFalsy();
  });

  test("a step stays where it opened as its content changes; a resize or the next step places it", async () => {
    // The room above the step as the browser lays it out: the auto margin of the column's empty first row, or the
    // room pinned on the column.
    let room = 120;
    const g = globalThis as { getComputedStyle: typeof getComputedStyle };
    const real = g.getComputedStyle;
    g.getComputedStyle = (el: Element, pseudo?: string | null) =>
      pseudo === "::before" && el instanceof HTMLElement && el.classList.contains("onb__body")
        ? ({ marginTop: el.style.getPropertyValue("--onb-lead") || `${room}px` } as CSSStyleDeclaration)
        : real(el, pseudo);
    try {
      const r = await toComputerStep({ state: "preparing", step: "installing", secondsLeft: 330, specs: SPECS });
      const lead = () => (document.querySelector(".onb__body") as HTMLElement).style.getPropertyValue("--onb-lead");
      expect(lead()).toBe("120px");
      // The computer's progress grows and shrinks the step (left to the browser, the room would change and the step
      // would move): the question and Back stay put.
      room = 60;
      await r.reported({ state: "preparing", step: "connecting", secondsLeft: 6, specs: SPECS });
      await r.reported({ state: "ready", machineId: "m-1", specs: SPECS });
      expect(lead()).toBe("120px");
      await act(async () => window.dispatchEvent(new Event("resize")));
      expect(lead()).toBe("60px");
      room = 80;
      await click(screen().getByRole("button", { name: "Continuar" }));
      expect(screen().getByRole("heading", { name: "Fica com esse time?" })).toBeTruthy();
      expect(lead()).toBe("80px");
    } finally {
      g.getComputedStyle = real;
    }
  });
});
