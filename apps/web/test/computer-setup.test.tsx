import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ComputerSetup, Machine } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import type { OnboardingStepId } from "@agenteschat/client/lib/onboarding";
import { en, ptBR } from "@agenteschat/i18n";
import { icons } from "@agenteschat/ui";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { COMPACT_QUERY } from "@/components/NavDrawer";
import { setNavigateAway } from "@/lib/navigate";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, fakeMachinesOf, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { hintOf, shownText } from "./hint";
import { renderApp, screen, settle } from "./render";

/** A phone: only the compact query matches (the rest goes to the real `matchMedia`). */
let restore: (() => void) | null = null;
function onPhone() {
  const real = window.matchMedia.bind(window);
  window.matchMedia = ((query: string) =>
    query === COMPACT_QUERY
      ? ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        } as unknown as MediaQueryList)
      : real(query)) as typeof window.matchMedia;
  restore = () => {
    window.matchMedia = real;
  };
}

afterEach(() => {
  setSystemTime();
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  restore?.();
  restore = null;
});

const SPECS = { cpus: 4, memoryGb: 8, diskGb: 100 };
/** No system, address, provider or tool list on these screens (ADR 0056 §10). */
const TECHNICAL = /Linux|\bIP\b|IPv4|Contabo|VPS|Debian|Chrome|\bgit\b|Outro sistema/;
const NOTICE = "O computador do workspace";
/** The clock faces a line can lead with: only the "as soon as it's ready" lines take one. */
const CLOCKS = [icons.clock, icons.waiting].map((shape) => shape.find(([tag]) => tag === "path")?.[1].d);
const leadsWithClock = (line: Element) =>
  CLOCKS.includes(line.firstElementChild?.querySelector("path")?.getAttribute("d") ?? undefined);
/** What a screen reader alone hears in a plan's panel: the status that shows no words. */
const heardOnly = (panel: Element) => panel.querySelector(".ac-visually-hidden[role='status']")?.textContent ?? null;

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

/**
 * How often the query of this kind (its key's last part) is asked again now: the shortest positive interval among
 * all its observers (false when none polls), since each observer polls on its own timer and others, such as a
 * closed dialog's `useMe`, set none.
 */
const pollEvery = (qc: QueryClient, key: string) => {
  const query = qc
    .getQueryCache()
    .findAll()
    .find((q) => q.queryKey.at(-1) === key && q.getObserversCount() > 0);
  if (!query) return undefined;
  const every = query.observers
    .map(({ options: { refetchInterval: ms } }) => (typeof ms === "function" ? ms(query) : ms))
    .filter((ms): ms is number => typeof ms === "number" && ms > 0);
  return every.length > 0 ? Math.min(...every) : false;
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

/** Acme where the workspace's computer is ready (Ada on it). */
async function readyWorkspace(path: string, patch: Partial<Machine> = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
  const m = machines.pair({ ...WORKSPACE_COMPUTER, ...patch });
  machines.setSetup({ state: "ready", machineId: m.id, specs: SPECS });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
  const r = await renderApp(path.replace("$machineId", m.id), { api });
  await settle(10);
  return { ...r, state, api, m };
}

/** The app at `path` where the workspace gets its own computer (`setup`), or where people pair theirs (null). */
/** A workspace still in its onboarding, as `me` says it: saved at the computer step, the one its plan comes back from. */
function beingSetUp(state: ReturnType<typeof seedState>) {
  const org = state.me?.organizations[0];
  if (org) org.onboarding = { step: "computer", generalChannelId: GENERAL_ID };
  return state;
}

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
    const title = () => notice().querySelector(".outage__text > b")?.textContent;
    // In line nothing is prepared yet: its name alone, and its line says it waits.
    expect(title()).toBe("Computador da Acme");
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
    expect(title()).toBe("Preparando o computador da Acme");
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
    const { push, router } = await open(`/org/${ORG_ID}/c/${ENG_ID}`, {
      step: "installing",
      stage: "updating",
      secondsLeft: 330,
    });
    const notice = () => screen().getByRole("region", { name: NOTICE }).textContent;
    const card = () => screen().getByRole("region", { name: "Computador da Acme" }).textContent;
    // The notice over a conversation, then the card its See opens, which no notice covers.
    const both = async (words: string) => {
      expect(notice()).toContain(words);
      await act(async () =>
        router.navigate({ to: "/org/$orgId/settings/$section", params: { orgId: ORG_ID, section: "computers" } }),
      );
      await settle(6);
      expect(card()).toContain(words);
      await act(async () =>
        router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: ENG_ID } }),
      );
      await settle(6);
    };
    expect(notice()).toContain("Passo 3 de 4 · Atualizando o sistema · faltam uns 6 min");
    await both("Passo 3 de 4 · Atualizando o sistema");
    await push({ step: "installing", stage: "restarting", secondsLeft: 300 });
    await both("Passo 3 de 4 · Reiniciando depois da atualização");
    await push({ step: "installing", stage: "defragmenting", secondsLeft: 240 });
    await both("Passo 3 de 4 · Instalando os programas");
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
    // Back to the conversation, the notice says the same time.
    await act(async () =>
      router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: ENG_ID } }),
    );
    await settle(6);
    expect(notice()).toContain(time.charAt(0).toLowerCase() + time.slice(1));
  });

  test("the time line never steps back: almost ready only in the last step, a little longer once it runs out", async () => {
    const notice = () => screen().getByRole("region", { name: NOTICE }).textContent ?? "";
    const time = () =>
      screen().getByRole("region", { name: "Computador da Acme" }).querySelector(".setup-eta")?.textContent;
    /** The notice over a conversation says `line`; the card its See opens (no notice over it) says `left`. */
    const says = async (router: Awaited<ReturnType<typeof open>>["router"], line: string, left: string) => {
      expect(notice()).toContain(line);
      await act(async () =>
        router.navigate({ to: "/org/$orgId/settings/$section", params: { orgId: ORG_ID, section: "computers" } }),
      );
      await settle(6);
      expect(time()).toBe(left);
      await act(async () =>
        router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: ENG_ID } }),
      );
      await settle(6);
    };
    const first = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { step: "installing", stage: "apps", secondsLeft: 50 });
    await says(
      first.router,
      "Passo 3 de 4 · Instalando os programas · falta menos de um minuto",
      "Falta menos de um minuto",
    );
    // The apps end early: the last step, almost ready.
    await first.push({ step: "connecting", stage: "connecting", secondsLeft: 10 });
    await says(first.router, "Passo 4 de 4 · Conectando ao seu workspace · quase pronto…", "Quase pronto…");

    // Another wait whose time runs out during the apps: a little longer than expected, in the last step too.
    cleanup();
    const late = await open(`/org/${ORG_ID}/c/${ENG_ID}`, { step: "installing", stage: "apps", secondsLeft: 0 });
    await says(
      late.router,
      "Passo 3 de 4 · Instalando os programas · demorando um pouco mais que o previsto",
      "Demorando um pouco mais que o previsto",
    );
    await late.push({ step: "connecting", stage: "connecting", secondsLeft: -20 });
    await says(
      late.router,
      "Passo 4 de 4 · Conectando ao seu workspace · demorando um pouco mais que o previsto",
      "Demorando um pouco mais que o previsto",
    );
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
    expect(shownText(banner())).toBe("Os agentes ainda não têm uma\u00a0IA.Conectar uma IA");
    expect(hintOf("Conectar uma IA", banner()).text).toBe(ask);
    await push({ state: "ready", machineId: "00000000-0000-4000-8000-000000000999" });
    expect(shownText(banner())).toBe("Os agentes ainda não têm uma\u00a0IA.Conectar uma IA");
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
    expect(card()).toContain("O Atlas está separando um para a gente");
    expect(card()).toContain("Passo 1 de 4 · Reservando o computador");
    // The notice's See leads here, where the card says it all: no notice on this page.
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
  });

  test("its card: steps, size, one user per agent; ready, online with its agents", async () => {
    const { push, machines } = await open(`/org/${ORG_ID}/settings/computers`, {
      state: "preparing",
      step: "starting",
      specs: SPECS,
    });
    const card = () => screen().getByRole("region", { name: "Computador da Acme" });
    // The team's line over the steps; "Sendo preparado" is the head's chip alone, never again over the steps.
    expect(card().querySelector(".setup-say[data-on]")?.textContent).toBe("O Atlas está colocando ele de pé");
    expect(card().textContent?.split("Sendo preparado")).toHaveLength(2);
    expect(card().textContent).toContain("Passo 2 de 4 · Iniciando");
    expect(card().textContent).toContain(
      "4\u00a0CPUs\u00a0· 8\u00a0GB\u00a0de\u00a0memória\u00a0· 100\u00a0GB\u00a0de\u00a0disco",
    );
    // One user per agent is the name's ⓘ, not a line of the card.
    const users = "Um usuário para cada agente: cada um tem a própria pasta.";
    expect(hintOf("Computador da Acme", card()).text).toBe(users);
    expect(shownText(card())).not.toContain("Um usuário para cada agente");
    expect(card().textContent).not.toMatch(TECHNICAL);

    // The chip is the one place the card says where it is, so its live region: a screen reader hears each change.
    expect(card().querySelector(".computers-card__head [role='status'] .ac-chip")?.textContent).toBe("Sendo preparado");
    await push({ state: "waiting", reason: "capacity" });
    // In line said once, by its chip: no line under it saying it waits, and no notice over the page.
    expect(card().textContent).toContain("Na fila");
    expect(card().textContent).not.toContain("Esperando um computador disponível");
    expect(screen().queryByRole("region", { name: NOTICE })).toBeNull();
    expect(card().querySelector(".computers-card__head [role='status'] .ac-chip")?.textContent).toBe("Na fila");

    // Its first hello: ready, its row among the computers, the agents on it (each with its own folder only).
    const m = machines.pair({
      ...WORKSPACE_COMPUTER,
      agents: [{ id: ADA_ID, name: "Ada", handle: "ada" }],
      access: { folders: [], tools: { claude: true, codex: true, commands: true } },
    });
    await push({ state: "ready", machineId: m.id });
    expect(card().textContent).toContain("Online");
    expect(card().querySelector(".computers-card__head [role='status'] .ac-chip")?.textContent).toBe("Online");
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
    expect(page).toContain("4\u00a0CPUs\u00a0· 8\u00a0GB\u00a0de\u00a0memória\u00a0· 100\u00a0GB\u00a0de\u00a0disco");
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
    expect(url.origin + url.pathname).toBe("https://app.agentes.chat/help/workspace-computer");
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
    expect(card()).toContain("Avisamos\u00a0você\u00a0em walter@acme.com.br quando\u00a0ele\u00a0ficar\u00a0pronto.");
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

  test("the team's lines while it's prepared: one every 3.5 s, held with reduced motion until the step moves, none with nobody they name", async () => {
    const card = () => screen().getByRole("region", { name: "Computador da Acme" });
    const shown = () => card().querySelector(".setup-say[data-on]")?.textContent;
    // Reduced motion (the screen tests' own): the first line holds, and the next stage brings its own.
    const { push } = await open(`/org/${ORG_ID}/settings/computers`, { state: "preparing", step: "starting" });
    expect(shown()).toBe("O Atlas está colocando ele de pé");
    expect(card().querySelector(".setup-says")?.getAttribute("aria-hidden")).toBe("true");
    await push({ step: "installing", stage: "booting" });
    expect(shown()).toBe("A Ada está contando os 8 GB de memória");
    cleanup();

    // Its size said only now, within the same stage: the line shown stays, and the memory's waits for its turn.
    const sized = await open(`/org/${ORG_ID}/settings/computers`, {
      state: "preparing",
      step: "reserving",
      stage: "ordering",
      specs: null,
    });
    expect(shown()).toBe("O Atlas encomendou um novinho");
    await sized.push({ step: "reserving", stage: "ordering" });
    expect(card().textContent).toContain("A Ada pediu 8 GB de memória");
    expect(shown()).toBe("O Atlas encomendou um novinho");
    cleanup();

    // Motion allowed: the next line every 3.5 s, round again.
    const device = domWindow().happyDOM.settings.device;
    const ticks: (() => void)[] = [];
    const timers = spyOn(globalThis, "setInterval").mockImplementation(((tick: () => void, ms?: number) => {
      if (ms === 3500) ticks.push(tick);
      return 0;
    }) as unknown as typeof setInterval);
    device.prefersReducedMotion = "no-preference";
    try {
      await open(`/org/${ORG_ID}/settings/computers`, { state: "preparing", step: "starting" });
      expect(shown()).toBe("O Atlas está colocando ele de pé");
      await act(async () => ticks.at(-1)?.());
      expect(shown()).toBe("A Ada está esquentando os motores");
      await act(async () => ticks.at(-1)?.());
      expect(shown()).toBe("O Atlas está colocando ele de pé");
    } finally {
      device.prefersReducedMotion = "reduce";
      timers.mockRestore();
    }
    cleanup();

    // None of the agents the lines name on the team: nothing over the steps; the head's chip says where it is, once.
    const strangers = seedState();
    strangers.agents = strangers.agents.map((a) => ({ ...a, handle: `${a.handle}-2` }));
    await open(`/org/${ORG_ID}/settings/computers`, { state: "preparing", step: "starting" }, strangers);
    expect(card().querySelector(".setup-says")).toBeNull();
    expect(card().querySelector(".setup-progress .ac-chip")).toBeNull();
    expect(card().querySelector(".computers-card__head [role='status'] .ac-chip")?.textContent).toBe("Sendo preparado");
    cleanup();

    // Nor anywhere else (an agent's computer, its window, the AI step's wait): no chip over the steps.
    await open(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { state: "preparing", step: "starting" }, strangers);
    const pc = document.querySelector(".agp-pc") as HTMLElement;
    expect(pc.textContent).toContain("Passo 2 de 4 · Iniciando");
    expect(pc.querySelector(".setup-progress .ac-chip")?.textContent).toBeUndefined();
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

  test("Configurações › its computer: the progress", async () => {
    await open(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings`, { state: "preparing", step: "installing" });
    const pc = document.querySelector(".agp-pc") as HTMLElement;
    expect(pc.textContent).toContain("Computador da Acme");
    expect(pc.textContent).toContain("Passo 3 de 4 · Instalando os programas");
    expect(pc.textContent).not.toContain("começa a usar assim que ele ficar pronto");
    // Its name already shows there: no read-only row naming it again.
    expect(pc.textContent?.split("Computador da Acme")).toHaveLength(2);
    expect(pc.querySelector(".agp-ro")).toBeNull();
    expect(pc.textContent).not.toMatch(TECHNICAL);
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
    await click(button("Criar 3 agentes"));
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
    expect(step.textContent).toContain(
      "Avisamos\u00a0você\u00a0em walter@acme.com.br quando\u00a0ele\u00a0ficar\u00a0pronto.",
    );
    expect(step.textContent).not.toContain("Pode fechar esta página");
    expect(step.textContent).toContain(
      "4\u00a0CPUs\u00a0· 8\u00a0GB\u00a0de\u00a0memória\u00a0· 100\u00a0GB\u00a0de\u00a0disco",
    );
    // No plans: the AI step is where they are.
    expect(step.textContent).not.toContain("plano de IA");
    // The whole wait in one well, every line in it its own: each starts with its icon, set on its first line of text.
    const well = step.querySelector(":scope > .onb__wait") as HTMLElement;
    const lines = [...step.querySelectorAll(".setup-progress--line, .setup-line, .onb__status")];
    expect(lines.length).toBe(4);
    for (const line of lines) {
      expect(well.contains(line)).toBe(true);
      expect(line.classList.contains("setup-progress--line") || line.classList.contains("setup-line")).toBe(true);
      expect(line.classList.contains("ac-iconline")).toBe(true);
      expect(line.firstElementChild?.matches("svg.ac-icon, canvas.ac-pixspin")).toBe(true);
    }
    // The wait leads with the orbit, like any wait that is under way, never a clock.
    expect(step.querySelector(".setup-progress--line")?.firstElementChild?.matches("canvas.ac-pixspin")).toBe(true);
    expect(lines.filter(leadsWithClock)).toEqual([]);
    // One lead size, so every line's words start in one column.
    for (const line of lines) {
      const lead = line.firstElementChild as HTMLElement;
      expect(lead.style.width).toBe("14px");
    }
    // Sunk into its card in both themes, the AI step's well, its lines at the well's own gap (layout.css).
    const layout = await Bun.file(new URL("../src/layout.css", import.meta.url).pathname).text();
    const shared = layout.split("\n.ai-panel__wait,\n.onb__wait {")[1]?.split("}")[0] ?? "";
    expect(shared).toContain("background: var(--surface-sunken)");
    expect(shared).toContain("gap: 8px");
    expect(layout.split("\n.onb__wait > .setup-wait {")[1]?.split("}")[0]).toContain("display: contents");
    // The team's line and the steps under it are lines of either well too, at its gap: none of their own between them.
    const steps = layout.split("\n.onb__wait .setup-progress--steps,\n.ai-panel__wait > .setup-progress--steps {")[1];
    expect(steps?.split("}")[0]).toContain("display: contents");
    // The self-hosted step's callouts are that well too, in that type: never a plate lighter than its ground in dark.
    const onb = await Bun.file(new URL("../src/pages/onboarding.css", import.meta.url).pathname).text();
    const status = onb.split("\n.onb__status {")[1]?.split("}")[0] ?? "";
    expect(status).toContain("background: var(--surface-sunken)");
    expect(status).toContain("font-size: 13px");
    expect(status).not.toContain("--plate");
    expect(onb).not.toContain(".onb__workspace-computer > .onb__status");
    // The lead says where, and the rail says how far: never "opcional".
    expect(document.body.textContent).toContain("Num computador só deste workspace, sempre ligado.");
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Na fila");
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).not.toContain("opcional");
    expect(step.textContent).toContain("Pode seguir enquanto isso.");
    expect(step.textContent).not.toMatch(TECHNICAL);
    // Nothing to skip.
    expect(screen().queryByRole("button", { name: "Pular esta etapa" })).toBeNull();
    expect(button("Continuar").hasAttribute("disabled")).toBe(false);
    await click(button("Continuar"));
    await settle(4);
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
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
    await click(button("Criar 3 agentes"));
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
   * A new person's onboarding up to the computer step, the import skipped and the team made (every ready-made agent,
   * or Ada and `keep`). Its agents get the workspace's computer once it's ready (`computer.ready`), as the server
   * gives it to them; nobody connected it.
   */
  const toComputerStep = async (setup: Partial<ComputerSetup>, keep?: string[]) => {
    // A new workspace: no agents until the onboarding makes them.
    const state = seedState({ agents: [] });
    if (state.me) state.me.organizations = [];
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
    if (keep) await keepOnly(...keep);
    await click(screen().getByRole("button", { name: keep?.length === 0 ? "Continuar" : /^Criar \d agentes?$/ }));
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

    // The team was made before it: the AI step opens on Claude's sign-in for each of them, on the workspace's
    // computer.
    await click(screen().getByRole("button", { name: "Continuar" }));
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    expect(within(rail).getByRole("button", { name: /^IA/ }).getAttribute("aria-current")).toBe("step");
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect((within(panel).getByRole("button", { name: "Fazer login para o Theo" }) as HTMLButtonElement).disabled).toBe(
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

  test("a new workspace waiting for its first plan: the team made waits for its computer, one banner gets it, Agora não goes on", async () => {
    const left: string[] = [];
    setNavigateAway((url) => left.push(url));
    const r = await toComputerStep({ state: null });
    r.state.authConfig = { ...r.state.authConfig, billingUrl: "https://billing.example.com" };
    const me = r.state.me;
    if (!me) throw new Error("no me");
    r.state.me = {
      ...me,
      organizations: me.organizations.map((o) => ({ ...o, standing: { state: "hold", reason: "payment" } })),
    };
    await r.reported({ state: null });
    // Atlas, the host, names the team made beside himself.
    expect(document.querySelector(".onb__intro")?.textContent).toBe("E aí, Atlas aqui. Cuido dos computadores.");
    expect(
      screen().getByRole("heading", {
        name: "Theo, Ada, Lia e eu já chegamos. Só falta o nosso computador para a gente começar.",
      }),
    ).toBeTruthy();
    expect(document.querySelector(".onb__lead")?.textContent).toBe("É onde a gente trabalha, cada um com a sua pasta.");
    // The rail says what it waits for, not its state.
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Esperando você");
    expect(rail.textContent).not.toContain("Pausado");
    const offer = document.querySelector(".onb__offer") as HTMLElement;
    // Their computer waiting, the team standing around it: a picture only.
    const scene = offer.querySelector(".onb__scene") as HTMLElement;
    expect(scene.getAttribute("aria-hidden")).toBe("true");
    expect(scene.querySelector(".ac-computer")?.getAttribute("data-state")).toBe("paused");
    expect(scene.querySelectorAll('.ac-avatar[data-state="waiting"]')).toHaveLength(4);
    // Only what's done, each with its check.
    expect([...offer.querySelectorAll(".onb__done-row")].map((row) => row.textContent)).toEqual([
      "Workspace criadoAcme Saúde",
      "Contexto salvoTodos os agentes leem",
      "Theo, Ada, Lia e Atlas criados",
    ]);
    // The banner holds the step's one action: no status, no Continue, nothing to skip.
    const banner = offer.querySelector(".onb__offer-banner") as HTMLElement;
    expect(shownText(banner)).toBe(
      "Sempre ligado, pronto em minutosVem em todos os planos · cancele quando quiserGarantir o computador deles",
    );
    expect(screen().queryByRole("button", { name: "Continuar" })).toBeNull();
    expect(screen().queryByRole("button", { name: "Pular esta etapa" })).toBeNull();
    // With no bar, an empty last row keeps the bar's room under the step (onboarding.css): "Agora não" stays clear
    // of the screen's bottom and a phone's home bar.
    expect(document.querySelector(".onb__body > .onb__actions")).toBeNull();
    const onb = await Bun.file(new URL("../src/pages/onboarding.css", import.meta.url).pathname).text();
    const spacer = onb.split("\n.onb__body:not(:has(> .onb__actions))::after {")[1]?.split("}")[0] ?? "";
    expect(spacer).toContain("padding-bottom: env(safe-area-inset-bottom, 0px)");
    await click(within(banner).getByRole("button", { name: "Garantir o computador deles" }));
    expect(r.state.calls.find((c) => c.method === "orgs.billingLink")?.args.slice(1)).toEqual(["onboarding"]);
    expect(left).toEqual(["https://billing.example.com/link?t=onboarding"]);
    // Enter passes nothing by; Agora não goes on to the AI step.
    await act(async () => fireEvent.keyDown(document.querySelector(".onb__main") as HTMLElement, { key: "Enter" }));
    await settle(4);
    expect(document.querySelector(".onb__offer")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Agora não" }));
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
  });

  test("Ada alone waiting for the plan: her row agrees with her name", async () => {
    const r = await toComputerStep({ state: null }, []);
    const me = r.state.me;
    if (!me) throw new Error("no me");
    r.state.me = {
      ...me,
      organizations: me.organizations.map((o) => ({ ...o, standing: { state: "hold", reason: "payment" } })),
    };
    await r.reported({ state: null });
    expect([...document.querySelectorAll(".onb__done-row")].map((row) => row.textContent).at(-1)).toBe("Ada criada");
  });

  test("back from paying: the first step still waiting for the person, the plan said active over it, the team's computer on its way", async () => {
    // The workspace the onboarding made: Ada and Atlas (seeded) and Theo, its context written.
    const state = seedState({ context: "Clínicas." });
    state.authConfig = { workspaceComputer: true };
    const ada = state.agents[0];
    if (!ada) throw new Error("no agent");
    state.agents.push({ ...ada, id: "agent-theo", name: "Theo", handle: "theo", role: "PM" });
    const r = await open(
      `/org/${ORG_ID}/onboarding`,
      { state: "preparing", step: "starting", secondsLeft: 420, specs: SPECS, notifyByEmail: true },
      beingSetUp(state),
    );
    expect(r.router.state.location.pathname).toBe("/onboarding");
    // Paid, the computer step has nothing left to ask: the AI step, the plan said active over it.
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    expect(document.querySelector(".onb__paid")?.textContent).toBe(
      "Seu plano do agentes.chat está ativo. O computador deles está a caminho.",
    );
    // Every step before it done, with what each has: the team in the workspace's order, the computer on its way.
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(rail.querySelectorAll("li[data-done]")).toHaveLength(5);
    expect(within(rail).getByRole("button", { name: /^Workspace/ }).textContent).toContain("Acme");
    expect(within(rail).getByRole("button", { name: /^Agentes/ }).textContent).toContain("Ada, Atlas e Theo");
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Sendo preparado");
    // The computer being prepared in Claude's panel, the team's line over its steps.
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.querySelector(".setup-say[data-on]")?.textContent).toBe("O Atlas está colocando ele de pé");
    expect(panel.querySelector('.setup-progress [role="status"]')?.textContent).toBe("Passo 2 de 4 · Iniciando");
    // On to the team and Done, whose first message goes to #general.
    await click(screen().getByRole("button", { name: "Conectar depois" }));
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    cleanup();
    sessionStorage.clear();

    // Back without paying: the computer step again, its plan still offered, nothing said active.
    const unpaid = seedState();
    unpaid.authConfig = { workspaceComputer: true };
    const org = unpaid.me?.organizations[0];
    if (org) org.standing = { state: "hold", reason: "payment" };
    await open(`/org/${ORG_ID}/onboarding`, { state: null }, beingSetUp(unpaid));
    expect(screen().getByRole("button", { name: "Agora não" })).toBeTruthy();
    expect(screen().queryByRole("heading", { name: "Qual IA eles vão usar?" })).toBeNull();
    expect(document.querySelector(".onb__paid")).toBeNull();
    cleanup();

    // A workspace that can't be read back opens as it is, never set up again.
    const lostState = seedState();
    const gone = createFakeApi(lostState);
    gone.orgs.settings = async () => {
      throw new Error("offline");
    };
    const lost = await open(`/org/${ORG_ID}/onboarding`, { state: null }, lostState, gone);
    expect(lost.router.state.location.pathname).toMatch(new RegExp(`^/org/${ORG_ID}/c/`));
  });

  test("back from paying before the billing service lifts the hold: the payment being confirmed, asked again every 5 s until it does", async () => {
    const state = beingSetUp(seedState({ context: "Clínicas." }));
    state.authConfig = { workspaceComputer: true };
    const me = state.me;
    if (!me) throw new Error("no me");
    state.me = {
      ...me,
      organizations: me.organizations.map((o) => ({ ...o, standing: { state: "hold", reason: "payment" } })),
    };
    const r = await open(`/org/${ORG_ID}/onboarding?paid=1`, { state: null }, state);
    // The computer step it paid from, its offer gone while the payment is confirmed.
    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Agora não" })).toBeNull();
    const line = () => document.querySelector(".onb__paid");
    expect(line()?.textContent).toBe("Confirmando o pagamento do plano do agentes.chat deste workspace.");
    expect(line()?.getAttribute("data-state")).toBe("confirming");
    // Its computer waits on the hold: both are asked about again, here and on every step after it.
    const qc = r.services.queryClient;
    expect(pollEvery(qc, "me")).toBe(5000);
    expect(pollEvery(qc, "computer-setup")).toBe(5000);

    // The billing service's next pass lifts the hold and the computer is ordered; the next asks bring both.
    state.me = me;
    r.machines.setSetup({ state: "preparing", step: "starting", secondsLeft: 420, specs: SPECS });
    await act(async () => qc.refetchQueries({ type: "active" }));
    await settle(6);
    expect(line()?.textContent).toBe("Seu plano do agentes.chat está ativo. O computador deles está a caminho.");
    expect(line()?.getAttribute("data-state")).toBe("paid");
    await click(screen().getByRole("button", { name: "Continuar" }));
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.querySelector('.setup-progress [role="status"]')?.textContent).toBe("Passo 2 de 4 · Iniciando");
  });

  test("back from paying with an imported agent named like a ready-made one: still the import's, its model given back", async () => {
    // Ada, and the team's own Atlas the import brought (the ready-made Atlas wasn't picked), which ran on Sonnet.
    const state = seedState({ context: "Clínicas." });
    state.authConfig = { workspaceComputer: true };
    state.agents = state.agents.map((a) =>
      a.id === ATLAS_ID ? { ...a, role: "Suporte", appearance: { color: "rose" } } : a,
    );
    sessionStorage.setItem(`agentes.onboarding.imports.${ORG_ID}`, JSON.stringify([[ATLAS_ID, "claude-sonnet-5-5"]]));
    try {
      await open(`/org/${ORG_ID}/onboarding`, { state: null }, beingSetUp(state));
      const rail = screen().getByRole("navigation", { name: "Passos para começar" });
      expect(within(rail).getByRole("button", { name: /^Trazer seus agentes/ }).textContent).toContain("Atlas");
      expect(within(rail).getByRole("button", { name: /^Agentes/ }).textContent).toContain("Ada e Atlas");
      await click(screen().getByRole("button", { name: "Continuar" }));
      // A key that runs Sonnet gives it back to that Atlas, as it does without the way through billing.
      const picker = screen().getByRole("group", { name: "Qual IA eles vão usar?" });
      await click(within(picker).getByRole("button", { name: /^Chave de API/ }));
      await act(async () =>
        fireEvent.change(screen().getByLabelText("Cole aqui"), { target: { value: "sk-ant-api03-abcdefghijklmnop" } }),
      );
      await click(screen().getByRole("button", { name: "Salvar e continuar" }));
      await settle(6);
      expect(state.calls.filter((c) => c.method === "agents.update").map((c) => [c.args[1], c.args[2]])).toEqual([
        [ATLAS_ID, { model: "claude-sonnet-5-5" }],
      ]);
    } finally {
      sessionStorage.clear();
    }
  });

  /**
   * A workspace part way through its onboarding: Ada and Atlas (seeded), Theo and Lia, then the agents its import
   * brought (`imported`, from OpenBot.run, with `skills`), its step saved as `step` (an older version's save, maybe).
   */
  const partWay = (step: OnboardingStepId, imported: string[], { unpaid = false, skills = 0 } = {}) => {
    const state = seedState({ context: "Clínicas." });
    state.authConfig = { workspaceComputer: true };
    const ada = state.agents[0];
    if (!ada) throw new Error("no agent");
    state.agents.push(
      { ...ada, id: "agent-theo", name: "Theo", handle: "theo", role: "PM" },
      { ...ada, id: "agent-lia", name: "Lia", handle: "lia", role: "Pesquisa" },
      ...imported.map((name, i) => ({ ...ada, id: `agent-imported-${i}`, name, handle: `agente-${i}`, role: "" })),
    );
    const source = { app: "openbotrun", ref: "openbot-import" };
    state.imported = [
      ...imported.map(() => ({ ...source, kind: "agent" as const })),
      ...Array.from({ length: skills }, () => ({ ...source, kind: "skill" as const })),
    ];
    const org = state.me?.organizations[0];
    if (org) {
      org.onboarding = { step, generalChannelId: GENERAL_ID };
      if (unpaid) org.standing = { state: "hold", reason: "payment" };
    }
    return state;
  };
  const railStep = (name: RegExp) =>
    within(screen().getByRole("navigation", { name: "Passos para começar" })).getByRole("button", { name });
  const IMPORTED = ["Selma Sentinela", "Novo agente", "Bento"];

  test("back from paying where an older version saved the import's step: never behind the step the person reached", async () => {
    // The import ran and the team was made, the person reached the computer step and paid there, while the server's
    // step still said the import (as an older version saved it) and the tab kept no step of its own.
    const PREPARING = { state: "preparing", step: "starting", secondsLeft: 420, specs: SPECS } as const;
    await open(`/org/${ORG_ID}/onboarding?paid=1`, PREPARING, partWay("import", IMPORTED));
    // Never the import's step with an empty picker: the first step still waiting, the AI's, the plan said active.
    expect(screen().queryByRole("heading", { name: "Já usa agentes em outro app?" })).toBeNull();
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    expect(document.querySelector(".onb__paid")?.getAttribute("data-state")).toBe("paid");
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(rail.querySelectorAll("li[data-done]")).toHaveLength(5);
    expect(railStep(/^Trazer seus agentes/).textContent).toContain("Selma Sentinela, Novo agente e Bento");
    cleanup();

    // Opened again without the way back (a reload, another tab): the same.
    await open("/onboarding", PREPARING, partWay("import", IMPORTED));
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    cleanup();

    // Paid, its hold not lifted yet: the computer step it paid from, the payment being confirmed.
    await open(`/org/${ORG_ID}/onboarding?paid=1`, { state: null }, partWay("import", IMPORTED, { unpaid: true }));
    expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
    expect(document.querySelector(".onb__paid")?.getAttribute("data-state")).toBe("confirming");
  });

  test("the import's step once passed opens on what came: its source and counts, Continue, another file a click away", async () => {
    // Opened again at the computer step, then back to the import's on the rail.
    await open("/onboarding", { state: null }, partWay("computer", IMPORTED, { unpaid: true, skills: 2 }));
    await click(railStep(/^Trazer seus agentes/));
    expect(screen().getByRole("heading", { name: "Já usa agentes em outro app?" })).toBeTruthy();
    // Its summary: the app it came from, by its mark, and how much came. No empty picker.
    const head = document.querySelector(".onb__answer .imp-head") as HTMLElement;
    expect(head.querySelector(".imp-head__title")?.textContent).toBe("Veio do OpenBot.run");
    expect(head.querySelector(".imp-head__sub")?.textContent).toBe("3 agentes · 2 skills");
    expect(head.querySelector(".imp-mark img")?.getAttribute("src")).toBe("/brands/openbotrun.svg");
    expect(document.querySelector(".imp-drop")).toBeNull();
    // Done: Continue goes on to the agents.
    expect(screen().getByRole("button", { name: "Continuar" }).hasAttribute("disabled")).toBe(false);
    // Another file: the picker, as the first time, and Continue waits for it.
    await click(screen().getByRole("button", { name: "Importar outro arquivo" }));
    expect(document.querySelector(".imp-drop")).not.toBeNull();
    expect(document.querySelector(".onb__answer .imp-head")).toBeNull();
    expect(screen().getByRole("button", { name: "Continuar" }).hasAttribute("disabled")).toBe(true);
  });

  test("thirty agents: their faces in one line then +N, a few names then how many more, on every step and the rail", async () => {
    const thirty = Array.from({ length: 26 }, (_, i) => `Agente ${i + 1}`);
    const state = partWay("computer", thirty, { unpaid: true });
    const r = await open("/onboarding", { state: null }, state);
    // Atlas names three of the others, then how many more.
    expect(
      screen().getByRole("heading", {
        name: "Ada, Theo, Lia e mais 26 e eu já chegamos. Só falta o nosso computador para a gente começar.",
      }),
    ).toBeTruthy();
    // The checklist's row: four names, then how many; four faces, then +26, in one line beside the words.
    const row = [...document.querySelectorAll(".onb__done-row")].at(-1) as HTMLElement;
    expect(row.querySelector(".onb__done-what")?.textContent).toBe("Ada, Atlas, Theo, Lia e mais 26 criados");
    const faces = row.querySelector(".onb__done-faces") as HTMLElement;
    expect(faces.querySelectorAll(".ac-avatar")).toHaveLength(4);
    expect(faces.querySelector(".onb__faces-more")?.textContent).toBe("+26");
    const css = await Bun.file(new URL("../src/pages/onboarding.css", import.meta.url).pathname).text();
    expect(css.split("\n.onb__faces-more {")[1]?.split("}")[0]).toContain("white-space: nowrap");
    // The rail says them the same way.
    expect(railStep(/^Agentes/).textContent).toContain("Ada, Atlas, Theo, Lia e mais 26");
    expect(railStep(/^Trazer seus agentes/).textContent).toContain("Agente 1, Agente 2, Agente 3, Agente 4 e mais 22");

    // Paid: on through the AI step to the team's, whose row of faces is one line too, and Done names four.
    state.me = { ...(state.me as NonNullable<typeof state.me>) };
    for (const o of state.me.organizations) o.standing = undefined;
    r.machines.setSetup({ state: "preparing", step: "starting", secondsLeft: 420, specs: SPECS });
    await act(async () => r.services.queryClient.refetchQueries({ type: "active" }));
    await settle(6);
    await click(screen().getByRole("button", { name: "Continuar" }));
    // The workspace's key thinks for them already.
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    await click(screen().getByRole("button", { name: "Continuar" }));
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    const meet = [...document.querySelectorAll(".onb__answer .row")].find((x) => x.textContent?.includes("#general"));
    expect(meet?.querySelectorAll(".ac-avatar")).toHaveLength(4);
    expect(meet?.querySelector(".onb__faces-more")?.textContent).toBe("+26");
    await click(screen().getByRole("button", { name: "Pular esta etapa" }));
    expect(document.querySelector(".onb__welcome-lead")?.textContent).toStartWith(
      "Ada, Atlas, Theo, Lia e mais 26 já estão no #general.",
    );
  });

  test("a forged ?paid on a workspace still waiting for its plan: confirming for a minute at most, then its offer again", async () => {
    const real = globalThis.setTimeout;
    const minute: (() => void)[] = [];
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
      run: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      if (ms !== 60_000) return real(run, ms, ...args);
      minute.push(run);
      return 0;
    }) as unknown as typeof setTimeout);
    const line = () => document.querySelector(".onb__paid");
    try {
      // The address says paid; the server says the workspace still waits for its plan.
      await open(`/org/${ORG_ID}/onboarding?paid=true`, { state: null }, partWay("computer", [], { unpaid: true }));
      expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
      expect(line()?.textContent).toBe("Confirmando o pagamento do plano do agentes.chat deste workspace.");
      expect(screen().queryByRole("button", { name: "Agora não" })).toBeNull();
      // A minute on, still unpaid: the server's word, nothing claimed and its plan offered again.
      await act(async () => minute.at(-1)?.());
      await settle(4);
      expect(line()).toBeNull();
      expect(screen().getByRole("button", { name: "Agora não" })).toBeTruthy();
      expect(document.querySelector(".onb__offer")).not.toBeNull();
      cleanup();

      // Paid from the computer step opened again from a later one: back at the furthest, the computer step holds its
      // offer back for that minute too, then offers it again.
      await open(`/org/${ORG_ID}/onboarding?paid=1`, { state: null }, partWay("team", [], { unpaid: true }));
      expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
      expect(line()?.getAttribute("data-state")).toBe("confirming");
      await click(railStep(/^Computador/));
      expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
      expect(document.querySelector(".onb__offer")).toBeNull();
      expect(screen().queryByRole("button", { name: "Agora não" })).toBeNull();
      expect(line()?.getAttribute("data-state")).toBe("confirming");
      await act(async () => minute.at(-1)?.());
      await settle(4);
      expect(line()).toBeNull();
      expect(document.querySelector(".onb__offer")).not.toBeNull();
    } finally {
      timers.mockRestore();
    }
  });

  test("back from the billing service on any other hold: the plan never said active, the computer step that shows it", async () => {
    for (const standing of [
      { state: "hold", reason: "unpaid" },
      { state: "hold", reason: "ended" },
      { state: "hold", reason: null },
    ] as const) {
      const state = partWay("computer", []);
      const org = state.me?.organizations[0];
      if (org) org.standing = standing;
      await open(`/org/${ORG_ID}/onboarding?paid=1`, { state: null }, state);
      expect(screen().getByRole("heading", { name: "Onde a gente vai trabalhar?" })).toBeTruthy();
      expect(document.querySelector(".onb__paid")).toBeNull();
      cleanup();
    }
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
    expect(step()).toContain("Avisamos\u00a0você\u00a0em walter@acme.com.br quando\u00a0ele\u00a0ficar\u00a0pronto.");
    expect(pollEvery(r.services.queryClient, "computer-setup")).toBe(5000);
  });

  test("the AI step while it's prepared: Claude's panel waits in place, then turns on by itself; nothing starts before a click", async () => {
    const r = await toComputerStep(
      {
        state: "preparing",
        step: "installing",
        secondsLeft: 600,
        specs: SPECS,
        notifyByEmail: true,
        expectedReadyAt: new Date(Date.now() + 600_000).toISOString(),
      },
      ["Theo · PM"],
    );
    // Every step keeps asking about it while it's on its way.
    const interval = (key: string) => pollEvery(r.services.queryClient, key);
    expect(interval("computer-setup")).toBe(5000);
    await click(screen().getByRole("button", { name: "Continuar" }));
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    // Ada and Theo exist before any AI: leaving now leaves a whole team.
    expect(r.state.calls.filter((c) => c.method === "agents.create")).toHaveLength(2);
    const panel = () => screen().getByRole("region", { name: "Seu plano do Claude" });
    // The computer's wait in the panel's well: the team's line over the steps (Theo's; Lia isn't on this team), for
    // sighted readers only, then the owner's email line with no address. "Ready" is said there once: the sign-in's
    // step adds no timing of its own.
    const well = panel().querySelector(".ai-panel__wait") as HTMLElement;
    expect(well.querySelector(".setup-say[data-on]")?.textContent).toBe("O Theo foi atrás dos programas");
    expect(well.querySelector(".setup-says")?.getAttribute("aria-hidden")).toBe("true");
    expect(well.querySelector('[role="status"]')?.textContent).toBe("Passo 3 de 4 · Instalando os programas");
    expect(well.textContent).toEndWith(
      "Passo 3 de 4 · Instalando os programasFaltam uns 10 minAvisamos você por e-mail quando o computador ficar pronto. Pode fechar esta página.",
    );
    expect(panel().textContent?.split("pronto")).toHaveLength(2);
    expect(well.querySelector(".ac-iconline")).toBeNull();
    expect([...panel().querySelectorAll(".ac-iconline")].filter(leadsWithClock)).toEqual([]);
    const signIn = () => within(panel()).getByRole("button", { name: "Fazer login para o Theo" }) as HTMLButtonElement;
    expect(signIn().disabled).toBe(true);
    // Claude signs each agent in with the same account: the plan is for both, in the team's order. The foot is whom
    // they reply to.
    expect(within(panel()).getByRole("combobox", { name: "Agentes que usam este plano" }).textContent).toBe(
      "Todos os agentes",
    );
    expect(panel().querySelector(".ac-card__foot")?.textContent).toContain("Atendem outras pessoas");
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

    // It turns ready while the person watches, and the sign-in comes on. Still nothing started. The news comes with
    // the setup's own poll (the rail's): the panel follows it then, not at its view's next poll. The rail says it's
    // ready, so the panel shows no line saying it again: a screen reader still hears it.
    const orgId = String(r.state.calls.find((c) => c.method === "agents.create")?.args[0]);
    r.machines.setSetup({ state: "ready", machineId: "m-1", specs: SPECS, notifyByEmail: true });
    r.computer.ready = true;
    await act(async () => r.services.queryClient.invalidateQueries({ queryKey: keys.computerSetup(orgId) }));
    await settle(8);
    const rail = screen().getByRole("navigation", { name: "Passos para começar" });
    expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Pronto");
    expect(panel().querySelector(".ai-panel__ready")).toBeNull();
    expect(heardOnly(panel())).toBe("O computador está pronto.");
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
    // Back to the step: the panel still knows the computer it waited for is ready, and still leaves saying so to the
    // rail.
    await click(screen().getByRole("button", { name: "Voltar" }));
    expect(screen().getByRole("heading", { name: "Qual IA eles vão usar?" })).toBeTruthy();
    expect(panel().querySelector(".ai-panel__ready")).toBeNull();
    expect(heardOnly(panel())).toBe("O computador está pronto.");
  });

  test("at phone width the rail shows no words: the panel says the computer waits, then that it's ready, apart from the account", async () => {
    onPhone();
    const r = await toComputerStep({ state: "waiting", reason: "capacity", specs: SPECS, notifyByEmail: true });
    await click(screen().getByRole("button", { name: "Continuar" }));
    const panel = () => screen().getByRole("region", { name: "Seu plano do Claude" });
    expect((panel().querySelector(".ai-panel__wait") as HTMLElement).textContent).toBe(
      "Esperando um computador disponívelAvisamos você por e-mail quando o computador ficar pronto. Pode fechar esta página.",
    );
    await r.reported({ state: "ready", machineId: "m-1", specs: SPECS, notifyByEmail: true });
    // Without the computer's name, in a group of its own: whom it signs in, then the account's words, start after
    // its hairline.
    const ready = panel().querySelector(".ai-panel__ready") as HTMLElement;
    expect(ready.textContent).toBe("O computador está pronto.");
    expect(ready.getAttribute("aria-live")).toBe("polite");
    expect(ready.nextElementSibling?.matches(".ai-panel__who")).toBe(true);
    expect(
      within(panel().querySelector(".agp-addacct") as HTMLElement).getByRole("button", {
        name: "Fazer login para o Theo",
      }),
    ).toBeTruthy();
    expect(heardOnly(panel())).toBeNull();
    expect(panel().textContent?.split("pronto")).toHaveLength(2);
  });

  test("the account's sign-in on the workspace's computer says the computer, never its name", async () => {
    const r = await toComputerStep({ state: "ready", machineId: "m-1", specs: SPECS, notifyByEmail: true });
    await click(screen().getByRole("button", { name: "Continuar" }));
    const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
    const realOpen = window.open;
    window.open = (() => ({ closed: false, opener: {}, location: { href: "" }, close: () => {} })) as never;
    try {
      await click(within(panel).getByRole("button", { name: "Fazer login para o Theo" }));
      await settle(6);
    } finally {
      window.open = realOpen;
    }
    expect(within(panel).getByRole("button", { name: "Enviar ao computador" })).toBeTruthy();
    // The sign-in's own code goes by itself as it lands in the field.
    await act(async () =>
      fireEvent.change(within(panel).getByRole("textbox", { name: "Código do Claude" }), {
        target: { value: "c0de#st4te" },
      }),
    );
    await settle(4);
    expect(r.state.calls.filter((c) => c.method === "machines.sendAccountCode")).toHaveLength(1);
    expect(shownText(panel)).toContain("Código enviado. O computador está terminando de entrar.");
    // Its hints too.
    expect(panel.querySelector(".agp-addacct")?.textContent).not.toContain("Acme Saúde");
  });

  test("the AI step as it turns ready, the agent's view and the accounts still on their way: ready, its sign-in loading, never a wait", async () => {
    for (const plan of ["Claude", "GLM Coding"] as const) {
      const r = await toComputerStep({ state: "preparing", step: "installing", secondsLeft: 600, specs: SPECS }, [
        "Theo · PM",
      ]);
      await click(screen().getByRole("button", { name: "Continuar" }));
      if (plan !== "Claude") {
        const picker = screen().getByRole("group", { name: "Qual IA eles vão usar?" });
        await click(within(picker).getByRole("button", { name: /^GLM Coding/ }));
      }
      const panel = () =>
        screen().getByRole("region", { name: plan === "Claude" ? "Seu plano do Claude" : "GLM Coding Plan" });
      const action = () =>
        within(panel()).getByRole("button", { name: plan === "Claude" ? "Fazer login para o Theo" : /^Enviar ao/ });
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
      // Whatever has come back, the panel agrees with the rail (a screen reader hears it ready), and no plan dims.
      const saysReady = () => {
        const rail = screen().getByRole("navigation", { name: "Passos para começar" });
        expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Pronto");
        expect(heardOnly(panel())).toBe("O computador está pronto.");
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
      const panel = screen().getByRole("region", { name: "Seu plano do Claude" });
      // A problem says more than the rail's word for it. In line, the rail's "Na fila" says it all.
      const rail = screen().getByRole("navigation", { name: "Passos para começar" });
      if (setup.state === "problem") expect(panel.textContent).toContain("Algo deu errado ao preparar o computador");
      else {
        expect(within(rail).getByRole("button", { name: /^Computador/ }).textContent).toContain("Na fila");
        expect(panel.textContent).not.toContain("Esperando um computador disponível");
      }
      // No time to give: the owner reads when they'll hear, once.
      const well = panel.querySelector(".ai-panel__wait") as HTMLElement;
      expect(well.textContent).toContain(
        "Avisamos você por e-mail quando o computador ficar pronto. Pode fechar esta página.",
      );
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

  test("a plan thinks for all of them at once by default; then the Team step says nobody else gets an answer", async () => {
    const r = await toComputerStep({ state: "ready", machineId: "m-1", specs: SPECS });
    // Whoever creates an agent owns it, as the server makes them.
    for (const a of r.state.agents) a.ownerUserId = "u-walter";
    await click(screen().getByRole("button", { name: "Continuar" }));
    const picker = screen().getByRole("group", { name: "Qual IA eles vão usar?" });
    // Claude signs each agent in, one at a time; a coding plan's key goes to all of them at once.
    const claude = screen().getByRole("region", { name: "Seu plano do Claude" });
    expect(within(claude).getByRole("combobox").textContent).toBe("Todos os agentes");
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
    // Moved onto the plan, each answers only its owner.
    expect(r.state.agents.map((a) => a.audience?.mode)).toEqual(["owner", "owner", "owner", "owner"]);
    await click(screen().getByRole("button", { name: "Continuar" }));
    expect(screen().getByRole("heading", { name: "Quem mais trabalha com você?" })).toBeTruthy();
    const note = () => screen().queryByText("Seus agentes só atendem você.")?.closest(".setup-line");
    expect(note()).toBeTruthy();
    expect(hintOf("Seus agentes só atendem você.").text).toBe(
      "Num plano, você pode deixar cada um atender outras pessoas na página dele.",
    );
    // It comes before the invitations it's about.
    const emails = screen().getByLabelText("E-mails");
    expect((note() as Element).compareDocumentPosition(emails) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One agent on the API key answering everyone: someone invited gets an answer, so nothing to say.
    const orgId = String(r.state.calls.find((c) => c.method === "agents.create")?.args[0]);
    const first = r.state.agents[0];
    if (first) first.audience = { mode: "everyone", userIds: [] };
    await act(async () => r.services.queryClient.invalidateQueries({ queryKey: keys.agents(orgId) }));
    await settle(4);
    expect(note()).toBeFalsy();
  });
});

describe("the computer's wait in words: one edge for the words, whole phrases, even ink", () => {
  const sheet = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();
  const rule = (text: string, selector: string) => text.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
  const preparing = {
    state: "preparing",
    step: "starting",
    stage: "wiping",
    secondsLeft: 900,
    notifyByEmail: true,
    specs: SPECS,
  } as const;

  test("one edge for every word, the icons hanging before it: in the window, on setup's step and in Settings", async () => {
    const layout = await sheet("../src/layout.css");
    // What leads a line is 14 px and the kit's icon line puts 8 px after it: the lines that lead with nothing (the
    // steps' bar and step, the time left) start 22 px in, where the others' words do.
    expect(
      rule(layout, ":is(.setup-wait, .setup-card) > :is(.setup-progress:not(.ac-iconline), .setup-eta)"),
    ).toContain("margin-left: 22px");
    expect(rule(await sheet("../../../packages/ui/src/styles/components.css"), ".ac-iconline")).toContain("gap: 8px");
    // The window keeps that room after the words too, so the words' column is the one centred under the portrait.
    expect(rule(await sheet("../src/components/computer/computer.css"), ".cmp-prep .setup-wait")).toContain(
      "padding-inline-end: 22px",
    );
    // Settings › Computers: the lines the rule finds, where it finds them, each icon 14 px.
    await open(`/org/${ORG_ID}/settings/computers`, preparing);
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    expect(card.querySelector(":scope > .setup-progress:not(.ac-iconline) .ac-steps")).toBeTruthy();
    expect(card.querySelector(":scope > .setup-eta")?.textContent).toBe("Faltam uns 15 min");
    const led = [...card.querySelectorAll(":scope > .setup-line.ac-iconline")];
    expect(led).toHaveLength(2);
    for (const line of led) expect((line.firstElementChild as HTMLElement).style.width).toBe("14px");
  });

  test("the steps' bar ends as far from the right as it starts from the left: setup's well and Settings' card", async () => {
    const layout = await sheet("../src/layout.css");
    // Setup's well: its icons hang in its 14 px, the bar and the words start 22 px further in, and end as far from its
    // right edge, as the AI panel's well keeps its text's column on both sides.
    const well = layout
      .split("\n.onb__wait {")
      .slice(1)
      .map((block) => block.split("}")[0] ?? "")
      .find((block) => block.includes("padding"));
    expect(well).toContain("padding: 12px 36px 12px 14px");
    expect(rule(layout, ".ai-panel__wait")).toContain("padding: 12px var(--text-edge)");
    // Settings' card: its padding on both sides, and the 22 px after the wait's lines too.
    expect(rule(layout, ".setup-card > :is(.setup-progress, .setup-eta, .setup-line)")).toContain("margin-right: 22px");
    await open(`/org/${ORG_ID}/settings/computers`, preparing);
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    const lines = [...card.querySelectorAll(":scope > :is(.setup-progress, .setup-eta, .setup-line)")];
    expect(lines.length).toBe(4);
    expect(card.querySelector(":scope > .setup-progress .ac-steps")).toBeTruthy();
  });

  test("its phrases stay whole: the step's own words where they fit, the email's and the size's by no-break spaces", async () => {
    expect(rule(await sheet("../src/layout.css"), ".setup-progress .ac-eyebrow > span")).toContain(
      "display: inline-block",
    );
    await open(`/org/${ORG_ID}/settings/computers`, preparing);
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    const step = card.querySelector(".setup-progress .ac-eyebrow");
    expect(step?.textContent).toBe("Passo 2 de 4 · Limpando para começar do zero");
    expect(step?.querySelector(":scope > span")?.textContent).toBe("Limpando para começar do zero");
    // Lines break only between phrases: around the address, and after each of the size's dots.
    const breaks = (s: string) => s.split(" ");
    for (const [strings, you, specs] of [
      [ptBR, ["Avisamos você em", "{{email}}", "quando ele ficar pronto."], ["de memória"]],
      [en, ["We'll email you at", "{{email}}", "when it's ready."], ["of memory"]],
    ] as const) {
      expect(breaks(strings.computerSetup.email.you)).toEqual([...you]);
      expect(breaks(strings.computerSetup.specs)).toHaveLength(3);
      expect(strings.computerSetup.specs).toContain(specs[0]);
    }
    // A problem's last sentence wraps whole.
    expect(breaks(ptBR.computerSetup.status.problem).at(-1)).toBe("Já estamos cuidando.");
    expect(breaks(en.computerSetup.status.problem).at(-1)).toBe("We're on it.");
  });

  test("a problem's line wraps plainly, so its last sentence goes whole to the next line", async () => {
    // `pretty` takes that sentence, one phrase, for a short last line and pulls the word before it under it.
    expect(
      rule(
        await sheet("../src/layout.css"),
        ':is(.setup-wait, .setup-card) > .setup-progress--line[data-phase="problem"]',
      ),
    ).toContain("text-wrap: wrap");
    await open(`/org/${ORG_ID}/settings/computers`, { state: "problem", notifyByEmail: true, specs: SPECS });
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    expect(card.querySelector(':scope > .setup-progress--line[data-phase="problem"]')?.textContent).toBe(
      "Algo deu errado ao preparar o computador. Já estamos cuidando.",
    );
  });

  test("Settings › Computers' card ends as far under its last line's baseline as its drawing starts under its top", async () => {
    const layout = await sheet("../src/layout.css");
    // The card's padding under the baseline, as above the drawing (`--cap-top` and `--cap-mid` place the line's
    // capitals in its box), with the page's 22 px line where the lh unit is missing.
    expect(rule(layout, ".setup-card > p:last-child")).toContain(
      "margin-bottom: calc(var(--cap-top) - 2 * var(--cap-mid) - 11px)",
    );
    expect(layout.split("\n  .setup-card > p:last-child {")[1]?.split("}")[0]).toContain(
      "margin-bottom: calc(var(--cap-top) - 2 * var(--cap-mid) - 0.5lh)",
    );
    // The size is its last line on the way, a paragraph the rule finds.
    await open(`/org/${ORG_ID}/settings/computers`, preparing);
    const card = screen().getByRole("region", { name: "Computador da Acme" });
    expect(card.lastElementChild?.matches("p.setup-line")).toBe(true);
    expect(card.lastElementChild?.textContent).toContain("100 GB de disco");
  });
});
