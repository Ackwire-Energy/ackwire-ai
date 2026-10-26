import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type {
  Agent,
  AgentBrowserSettings,
  BrowserHandoff,
  ComputerSetup,
  DesktopStatus,
  Machine,
  SocketFactory,
} from "@agenteschat/client";
import { ApiError, keys } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ComputerDialog } from "@/components/computer/ComputerDialog";
import { useChannelRealtime } from "@/realtime/context";
import { ADA_ID, createFakeApi, ENG_ID, fakeBrowserOf, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { fakeSockets } from "./fake-socket";
import { renderApp, renderPage, screen, settle } from "./render";

/** Screen sockets that never connect: the states here are the dialog's, not the stream's. */
class QuietSocket {
  binaryType = "blob";
  closed = false;
  constructor(readonly url: string) {}
  addEventListener() {}
  close() {
    this.closed = true;
  }
}
class FakeRfb {
  viewOnly = false;
  qualityLevel = 3;
  compressionLevel = 2;
  scaleViewport = false;
  resizeSession = false;
  focusOnClick = false;
  background = "";
  constructor(
    readonly el: HTMLElement,
    readonly ws: QuietSocket,
  ) {}
  addEventListener() {}
  clipboardPasteFrom() {}
  sendKey() {}
  focus() {}
  disconnect() {
    this.ws.close();
  }
}
mock.module("@novnc/novnc", () => ({ default: FakeRfb }));

function socketsFor() {
  const screens: QuietSocket[] = [];
  const realtime = fakeSockets();
  const factory: SocketFactory = (url) => {
    if (!url.includes("/api/desktop")) return realtime.factory(url);
    const s = new QuietSocket(url);
    screens.push(s);
    return s as unknown as ReturnType<SocketFactory>;
  };
  return { factory, screens, realtime };
}

const SPECS = { cpus: 4, memoryGb: 8, diskGb: 100 };
const RUNNING: Partial<DesktopStatus> = { available: true, reason: null, running: true, canControl: true };

interface Options {
  /** The workspace gets its own computer (the Cloud), this far. */
  setup?: Partial<ComputerSetup>;
  /** Ada's computer; null: none. */
  machine?: Partial<Machine> | null;
  desktop?: Partial<DesktopStatus>;
  /** Ada may use her browser. */
  browser?: boolean;
  /** What her computer says of her browser (with `browser`: ready). */
  settings?: AgentBrowserSettings;
  handoff?: BrowserHandoff;
  forbidden?: boolean;
}

/** Walter (an owner of Acme) opens Ada's computer. */
async function backend(o: Options = {}) {
  const state = seedState();
  if (o.browser) {
    state.scopes[ADA_ID] = [...(state.scopes[ADA_ID] ?? []), { connectionId: null, scope: "browser:use" }];
  }
  const api = createFakeApi(state);
  const fake = fakeBrowserOf.get(api);
  const machines = fakeMachinesOf.get(api);
  if (!fake || !machines) throw new Error("no fakes");
  if (o.setup) machines.setSetup(o.setup);
  let machine: Machine | null = null;
  if (o.machine !== null) {
    machine = machines.pair({ name: "Servidor de casa", os: "linux", mode: "system", ...o.machine });
    await api.sandbox.setTarget(ORG_ID, ADA_ID, machine.id);
  }
  fake.desktops.set(ADA_ID, o.desktop ?? RUNNING);
  if (o.handoff) fake.handoffs.set(o.handoff.id, o.handoff);
  if (o.forbidden) fake.forbidden.add(ADA_ID);
  if (o.browser)
    fake.settings.set(ADA_ID, { allowedDomains: null, available: true, reason: null, detail: null, machine: null });
  if (o.settings) fake.settings.set(ADA_ID, o.settings);
  return { state, api, fake, machines, machine, sockets: socketsFor() };
}

async function dialog(o: Options = {}) {
  const b = await backend(o);
  const ada = b.state.agents.find((a) => a.id === ADA_ID) as Agent;
  let closed = 0;
  const r = await renderPage(<ComputerDialog agent={ada} open onClose={() => closed++} />, {
    api: b.api,
    org: true,
    createSocket: b.sockets.factory,
  });
  await settle(8);
  return { ...r, ...b, closed: () => closed };
}

const sub = () => (document.querySelector(".ac-dialog__sub") as HTMLElement | null)?.textContent ?? null;
const box = () => screen().getByRole("dialog", { name: "Computador da Ada" });
const view = () => within(box());
const calls = (s: { state: ReturnType<typeof seedState> }, method: string) =>
  s.state.calls.filter((c) => c.method === method).map((c) => c.args);
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const screenAsk = (over: Partial<BrowserHandoff> = {}): BrowserHandoff => ({
  id: "h-screen",
  agentId: ADA_ID,
  runId: "r-1",
  machineId: "machine-1",
  screen: "desktop",
  kind: "ask",
  instructions: "Entrar no banco com o token da empresa",
  status: "pending",
  requestedForUserId: null,
  controllerUserId: null,
  note: null,
  expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
  createdAt: new Date().toISOString(),
  resolvedAt: null,
  ...over,
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  setSystemTime();
  cleanup();
});

describe("the computer dialog, Cloud: the workspace's own computer", () => {
  test("being prepared: the steps, the time left, the email to owners, the size; no screen yet", async () => {
    const t = await dialog({
      setup: {
        step: "installing",
        secondsLeft: 330,
        expectedReadyAt: new Date(Date.now() + 330_000).toISOString(),
        requestedAt: new Date(Date.now() - 120_000).toISOString(),
        secondsWaited: 120,
        notifyByEmail: true,
        specs: SPECS,
      },
      machine: null,
      desktop: { available: false, reason: "no_computer" },
    });
    expect(sub()).toBe("Sendo preparado");
    const text = box().textContent ?? "";
    expect(text).toContain("Preparando o computador da Acme");
    expect(text).toContain("Passo 3 de 4 · Instalando os programas");
    expect(text).toContain("Faltam uns 6 min");
    expect(text).toContain("Avisamos você em walter@acme.com.br quando ele ficar pronto.");
    expect(text).not.toContain("Pode fechar esta página");
    expect(text).toContain("4 CPUs · 8 GB de memória · 100 GB de disco");
    // The head already says whose computer this is: no line that Ada waits, no users line, no plans.
    expect(text).not.toMatch(/começa a usar|Um usuário para cada agente|plano de IA/);
    // Nothing to do but close: no screen opens, no take control.
    expect(t.sockets.screens).toHaveLength(0);
    expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();
    // The wait isn't the screen's frame: no line for steps under it.
    expect(box().querySelector(".cmp-steps-row")).toBeNull();
  });

  test("its header says where the wait is, as the chip does: being prepared, in line, a problem", async () => {
    const heads: (string | null)[] = [];
    for (const setup of [
      { step: "installing" },
      { state: "waiting", reason: "capacity", notifyByEmail: true },
      { state: "problem" },
    ] as const) {
      await dialog({ setup, machine: null, desktop: { available: false, reason: "no_computer" } });
      heads.push(sub());
      // Waiting for a computer: the line, and the owner's email in place of a time.
      if (setup.state === "waiting") {
        expect(box().textContent).toContain("Esperando um computador disponível");
        expect(box().textContent).toContain("Avisamos você em walter@acme.com.br quando ele ficar pronto.");
      }
      cleanup();
    }
    expect(heads).toEqual(["Sendo preparado", "Na fila", "Com problema"]);
  });

  test("ready: it flashes Pronto, then opens with nothing to click", async () => {
    const t = await dialog({
      setup: { step: "connecting" },
      machine: null,
      desktop: { available: false, reason: "no_computer" },
    });
    const socket = t.sockets.realtime.last();
    await act(async () => socket.open());
    // The computer is made, Ada is on it and its screen shows.
    const m = t.machines.pair({ name: "Computador da Acme", kind: "managed", os: "other" });
    await t.api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
    t.fake.desktops.set(ADA_ID, RUNNING);
    await act(async () =>
      socket.push({
        type: "event",
        scope: "org",
        event: { type: "machine.provisioning", state: "ready", machineId: m.id, since: new Date().toISOString() },
      }),
    );
    await settle(8);
    expect(sub()).toBe("Pronto");
    expect(box().textContent).toContain("Pronto");
    await act(async () => new Promise((r) => setTimeout(r, 1600)));
    await settle(8);
    // Opening, then the screen: no step of the person's.
    expect(t.sockets.screens.length).toBeGreaterThan(0);
    expect(box().textContent).toContain("Abrindo o computador da Ada…");
  });

  test("on hold before the computer is ready: the pause alone, never a countdown", async () => {
    await dialog({
      setup: { secondsLeft: 330, expectedReadyAt: new Date(Date.now() + 330_000).toISOString() },
      machine: null,
      desktop: { available: false, reason: "no_computer", held: true },
    });
    expect(sub()).toBe("Em pausa por enquanto · dá para assistir");
    expect(box().textContent).toContain("A Ada está em pausa por enquanto");
    expect(box().textContent).toContain("Ninguém assume o controle até a pausa acabar.");
    expect(box().textContent).not.toContain("Dá para assistir.");
    expect(box().textContent).not.toContain("min");
  });

  test("a hold that arrives during the wait: the pause at once, never a Pronto it isn't", async () => {
    const t = await dialog({
      setup: { step: "installing", secondsLeft: 330 },
      machine: null,
      desktop: { available: false, reason: "no_computer" },
    });
    expect(sub()).toBe("Sendo preparado");
    t.fake.desktops.set(ADA_ID, { available: false, reason: "no_computer", held: true });
    await act(async () => t.services.queryClient.invalidateQueries({ queryKey: keys.agentDesktop(ORG_ID, ADA_ID) }));
    await settle(8);
    expect(sub()).toBe("Em pausa por enquanto · dá para assistir");
    expect(box().textContent).not.toContain("Pronto");
    expect(box().textContent).toContain("A Ada está em pausa por enquanto");
  });

  test("its computer not answering: said by name, looked after, nothing to do and no other computer", async () => {
    // Its browser was there before it stopped answering: no page to show from a computer that doesn't answer.
    const t = await dialog({
      setup: { state: "ready" },
      machine: { name: "Computador da Acme", kind: "managed", os: "other", online: false },
      desktop: { available: false, reason: "offline" },
      browser: true,
    });
    expect(sub()).toBe("Sem resposta");
    expect(box().textContent).toContain("O Computador da Acme não está respondendo");
    expect(box().textContent).toContain("Costuma voltar em poucos minutos. Já estamos cuidando.");
    expect(box().textContent).not.toContain("nada a fazer");
    expect(view().queryByRole("button", { name: "Trocar computador" })).toBeNull();
    expect(t.sockets.screens).toHaveLength(0);
  });

  test("named in this reader's words, though its first owner's language named it in English", async () => {
    await dialog({
      setup: { state: "ready" },
      machine: { name: "Acme's computer", kind: "managed", os: "other", online: false },
      desktop: { available: false, reason: "offline" },
    });
    expect(box().textContent).toContain("O Computador da Acme não está respondendo");
    expect(box().textContent).not.toContain("Acme's computer");
  });

  test("back while this tab was away: the reconnect asks for the computers again, and its screen opens", async () => {
    const t = await dialog({
      setup: { state: "ready" },
      machine: { name: "Computador da Acme", kind: "managed", os: "other", online: false },
      desktop: { available: false, reason: "offline" },
    });
    await act(async () => t.sockets.realtime.last().open());
    await settle(4);
    expect(sub()).toBe("Sem resposta");
    // The socket drops; meanwhile the computer comes back, and its machine.status never reaches this tab.
    await act(async () => t.sockets.realtime.last().drop());
    t.machines.patch((t.machine as Machine).id, { online: true });
    t.fake.desktops.set(ADA_ID, RUNNING);
    await act(() => new Promise((r) => setTimeout(r, 650)));
    await act(async () => t.sockets.realtime.last().open());
    await settle(8);
    expect(sub()).not.toBe("Sem resposta");
    expect(t.sockets.screens.length).toBeGreaterThan(0);
  });

  test("its screen can't be shown: only to try again in a moment, never a command", async () => {
    await dialog({
      setup: { state: "ready" },
      machine: { name: "Computador da Acme", kind: "managed", os: "other" },
      desktop: { available: false, reason: "not_allowed" },
    });
    expect(box().textContent).toContain("A tela da Ada não pode ser mostrada agora");
    expect(box().textContent).toContain("Tente de novo daqui a pouco.");
    expect(document.querySelector(".machine-command__code")).toBeNull();
    expect(view().getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    // A cover takes the screen's frame, with nothing under it, as the screen that follows it opens.
    expect(box().querySelector(".cmp-stage")).toBeTruthy();
    expect(box().querySelector(".cmp-steps-row")).toBeNull();
  });
});

describe("the computer dialog, live", () => {
  test("watching while the agent doesn't work: nothing under the screen, no empty line for steps", async () => {
    await dialog();
    expect(box().querySelector(".dsk")).toBeTruthy();
    expect(box().querySelector(".cmp-steps-row")).toBeNull();
    expect(box().querySelector(".cmp-body")?.lastElementChild?.classList.contains("dsk")).toBe(true);
  });

  test("the steps' line comes under the screen while the agent works there, and goes with its run", async () => {
    const b = await backend();
    const ada = b.state.agents.find((a) => a.id === ADA_ID) as Agent;
    /** The conversation the agent works in, open in this tab: its runs come live. */
    function Listening() {
      useChannelRealtime(ORG_ID, ENG_ID, true);
      return null;
    }
    await renderPage(
      <>
        <Listening />
        <ComputerDialog agent={ada} open onClose={() => {}} />
      </>,
      { api: b.api, org: true, createSocket: b.sockets.factory },
    );
    await settle(8);
    const socket = b.sockets.realtime.last();
    await act(async () => socket.open());
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    const run = { threadId: null, runId: "r-desktop", agentId: ADA_ID };
    await ev({ type: "agent.thinking", ...run });
    await ev({ type: "agent.tool", ...run, tool: "desktop_click", toolUseId: "c1" });
    await settle(4);
    const row = () => box().querySelector(".cmp-body > .cmp-steps-row");
    expect(row()?.querySelectorAll("li")).toHaveLength(1);
    expect(box().querySelector(".cmp-body")?.lastElementChild).toBe(row());
    await ev({ type: "agent.run", ...run, status: "done" });
    await settle(4);
    expect(row()).toBeNull();
  });

  test("held with a ready computer: watching, under the pause's banner, with no take control", async () => {
    await dialog({ desktop: { ...RUNNING, held: true } });
    expect(box().querySelector(".cmp-banner")?.textContent).toContain("A Ada está em pausa por enquanto");
    expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();
  });

  test("a request on the screen for me: the banner's Ajudar takes control of the screen, with the request on top", async () => {
    const t = await dialog({ handoff: screenAsk() });
    const banner = box().querySelector(".cmp-banner") as HTMLElement;
    expect(banner.dataset.tone).toBe("warn");
    expect(banner.textContent).toContain("A Ada precisa de você: “Entrar no banco com o token da empresa” · 4 min");
    expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();
    await click(within(banner).getByRole("button", { name: "Ajudar" }));
    expect(calls(t, "browser.takeControl")).toEqual([[ORG_ID, "h-screen"]]);
    await settle(4);
    expect(t.sockets.screens.at(-1)?.url).toContain("mode=control");
    expect(sub()).toBe("Você no controle · a Ada pediu");
    expect(box().querySelector(".cmp-asked")?.textContent).toBe("“Entrar no banco com o token da empresa”");
    expect(view().getByRole("button", { name: "Pronto" })).toBeTruthy();
    expect(view().getByRole("button", { name: "Não consegui" })).toBeTruthy();
  });

  test("Ajudar refused (someone got there first): said in the head for a moment, not in a toast over the window", async () => {
    const t = await dialog({ handoff: screenAsk() });
    t.api.browser.takeControl = async () => {
      throw new ApiError(409, "conflict", "Someone else is in control");
    };
    await click(within(box().querySelector(".cmp-banner") as HTMLElement).getByRole("button", { name: "Ajudar" }));
    const said = box().querySelector(".ac-dialog__sub > .cmp-said");
    expect(said?.textContent).toBe("Outra pessoa já está ajudando.");
    expect(said?.getAttribute("role")).toBe("alert");
    expect(box().querySelector(".cmp-sub")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector(".ac-toast")).toBeNull();
  });

  test("full screen on the agent's page keeps the dialog's layout: only its screen goes alone", async () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    try {
      await dialog({ desktop: { available: false, reason: "no_desktop" }, browser: true });
      await click(view().getByRole("button", { name: "Tela cheia" }));
      expect(box().classList.contains("is-full")).toBe(true);
      expect(box().classList.contains("is-screen-only")).toBe(false);
    } finally {
      delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });

  test("whoever may take over the browser but not the screen takes the browser: the page shows", async () => {
    const t = await dialog({ desktop: { ...RUNNING, canControl: false }, browser: true });
    // Watching the screen; not connected yet: no take control until it's live.
    expect(t.sockets.screens).toHaveLength(1);
    expect(sub()).toBe("Abrindo…");
  });
});

describe("the computer dialog, self-host", () => {
  test("paused on the computer itself: until when and by whom, live, no take control", async () => {
    const until = new Date(Date.now() + 2 * 3_600_000);
    await dialog({ machine: { paused: { until: until.toISOString() } } });
    const banner = box().querySelector(".cmp-banner") as HTMLElement;
    expect(banner.textContent).toContain("O Servidor de casa está pausado até");
    expect(banner.textContent).toContain("Pausado no próprio computador por quem o conectou.");
    expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();
  });

  test("offline: since when, Ada waits, and Trocar computador for who may move her", async () => {
    // Mid-day: half an hour ago is still today, so the time shows without its date.
    setSystemTime(new Date(2026, 9, 21, 12));
    const seen = new Date(Date.now() - 30 * 60_000).toISOString();
    const t = await dialog({
      machine: { online: false, lastSeenAt: seen },
      desktop: { available: false, reason: "offline" },
      browser: true,
    });
    expect(box().textContent).toContain("O Servidor de casa está offline");
    // Since when is the head's: the cover says only that Ada waits.
    expect(box().textContent).toContain("A Ada espera o computador voltar.");
    expect(box().textContent).not.toMatch(/Desde \d\d:\d\d/);
    expect(sub()).toMatch(/^Offline desde \d\d:\d\d$/);
    // The switch shows where the server lists the outage.
    expect(view().queryByRole("button", { name: "Trocar computador" })).toBeNull();
    cleanup();

    const listed = await backend({
      machine: { online: false, lastSeenAt: seen },
      desktop: { available: false, reason: "offline" },
    });
    const m = listed.machine as Machine;
    listed.machines.setOutages({
      outages: [
        {
          machineId: m.id,
          name: m.name,
          platform: "linux",
          offlineSince: seen,
          agents: [{ agentId: ADA_ID, name: "Ada", brain: "claude_code", waiting: { routines: 0, conversations: 1 } }],
          waitingRuns: 1,
        },
      ],
      targets: [],
    });
    const ada = listed.state.agents.find((a) => a.id === ADA_ID) as Agent;
    await renderPage(<ComputerDialog agent={ada} open onClose={() => {}} />, {
      api: listed.api,
      org: true,
      createSocket: listed.sockets.factory,
    });
    await settle(8);
    await click(view().getByRole("button", { name: "Trocar computador" }));
    expect(screen().getByRole("dialog", { name: "Trocar o computador" })).toBeTruthy();
    expect(t.closed()).toBe(0);
  });

  test("a Mac with its browser off: that, and who turns it on, never a screen it doesn't have", async () => {
    await dialog({
      machine: { name: "Mac mini", os: "darwin", mode: "single" },
      desktop: { available: false, reason: "not_allowed" },
      settings: {
        allowedDomains: null,
        available: false,
        reason: "switched_off",
        detail: null,
        machine: { id: "machine-1", name: "Mac mini" },
      },
    });
    expect(box().textContent).toContain("O navegador da Ada está desligado no Mac mini");
    expect(box().textContent).toContain(
      "Só quem está no computador liga: no app agentes, em Preferências → Ferramentas.",
    );
    expect(box().textContent).not.toContain("A tela da Ada não pode ser mostrada agora");
  });

  test("no computer yet: choose one for her", async () => {
    await dialog({ machine: null, desktop: { available: false, reason: "no_computer" } });
    expect(sub()).toBe("Sem computador ainda");
    expect(box().textContent).toContain("Escolha um computador para a Ada.");
    expect(view().getByRole("button", { name: "Escolher um computador" })).toBeTruthy();
  });

  test("neither its screen nor its browser: where to allow them is the button", async () => {
    await dialog({ desktop: { available: false, reason: "no_desktop" } });
    expect(box().textContent).toContain("A Ada não tem tela para mostrar aqui");
    expect(box().textContent).not.toContain("Libere a tela ou o navegador");
    expect(view().getByRole("button", { name: "Abrir Ferramentas e acesso" })).toBeTruthy();
  });

  test("not allowed: someone who may not watch it reads so", async () => {
    await dialog({ forbidden: true });
    expect(box().textContent).toContain("Você não pode ver este computador.");
  });
});

describe("the links", () => {
  test("?computer=1, and the older ?browser=1, ?desktop=1 and ?terminal=1, open the dialog on the agent's page", async () => {
    for (const link of ["computer", "browser", "desktop", "terminal"]) {
      const b = await backend();
      const r = await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?${link}=1`, {
        api: b.api,
        createSocket: b.sockets.factory,
      });
      await settle(10);
      expect(screen().getByRole("dialog", { name: "Computador da Ada" })).toBeTruthy();
      // Used once: a reload doesn't open it again.
      const search = r.router.state.location.search as Record<string, unknown>;
      expect({ link, computer: search.computer, own: search[link] }).toEqual({
        link,
        computer: undefined,
        own: undefined,
      });
      cleanup();
    }
  });
});
