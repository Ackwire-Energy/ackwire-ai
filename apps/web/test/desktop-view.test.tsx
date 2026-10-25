import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, BrowserHandoff, DesktopStatus, SocketFactory } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ComputerDialog } from "@/components/computer/ComputerDialog";
import { ADA_ID, createFakeApi, fakeBrowserOf, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { fakeSockets } from "./fake-socket";
import { renderPage, screen, settle } from "./render";

/** A person's socket to the screen: the server side closes it with a code. */
class DesktopSocket {
  binaryType = "blob";
  closed = false;
  /** A microtask after it was made: what the computer sends first may arrive from then on. */
  late = false;
  private onClose: ((e: { code: number; reason: string }) => void)[] = [];
  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.late = true;
    });
  }
  addEventListener(type: string, fn: (e: { code: number; reason: string }) => void) {
    if (type === "close") this.onClose.push(fn);
  }
  close() {
    this.closed = true;
  }
  serverClose(code: number, reason = "") {
    this.closed = true;
    for (const fn of this.onClose) fn({ code, reason });
  }
}

/** noVNC's RFB as the screen drives it: how it was set, what it pasted and pressed; `emit` plays its events. */
class FakeRfb {
  static all: FakeRfb[] = [];
  viewOnly = false;
  qualityLevel = 6;
  compressionLevel = 2;
  scaleViewport = false;
  resizeSession = false;
  focusOnClick = true;
  background = "";
  focused = 0;
  pasted: string[] = [];
  keys: [number, string | null, boolean | undefined][] = [];
  /** It took its socket in the tick the socket was made, before anything could arrive on it. */
  readonly onTime: boolean;
  private listeners = new Map<string, ((e: Event) => void)[]>();
  constructor(
    readonly el: HTMLElement,
    readonly ws: DesktopSocket,
    readonly options?: { shared?: boolean },
  ) {
    this.onTime = !ws.late;
    FakeRfb.all.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, detail?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new CustomEvent(type, { detail }));
  }
  clipboardPasteFrom(text: string) {
    this.pasted.push(text);
  }
  sendKey(keysym: number, code: string | null, down?: boolean) {
    this.keys.push([keysym, code, down]);
  }
  focus() {
    this.focused++;
  }
  disconnect() {
    this.ws.close();
  }
}
mock.module("@novnc/novnc", () => ({ default: FakeRfb }));

const RUNNING: Partial<DesktopStatus> = { available: true, reason: null, running: true, canControl: true };

/** The screen sockets apart from the realtime one. */
function socketsFor() {
  const desktops: DesktopSocket[] = [];
  const realtime = fakeSockets();
  const factory: SocketFactory = (url) => {
    if (!url.includes("/api/desktop")) return realtime.factory(url);
    const s = new DesktopSocket(url);
    desktops.push(s);
    return s as unknown as ReturnType<SocketFactory>;
  };
  return { factory, desktops };
}

/** Ada on a Linux computer of the workspace's, which serves screens; self-host. */
async function backend(desktop: Partial<DesktopStatus>) {
  const state = seedState();
  const api = createFakeApi(state);
  const fake = fakeBrowserOf.get(api);
  const machines = fakeMachinesOf.get(api);
  if (!fake || !machines) throw new Error("no fakes");
  const m = machines.pair({ name: "Servidor de casa", os: "linux", mode: "system" });
  await api.sandbox.setTarget(ORG_ID, ADA_ID, m.id);
  fake.desktops.set(ADA_ID, desktop);
  return { state, api, fake, machines, machine: m, sockets: socketsFor() };
}

async function dialog(desktop: Partial<DesktopStatus> = RUNNING) {
  const b = await backend(desktop);
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

const calls = (s: { state: ReturnType<typeof seedState> }, method: string) =>
  s.state.calls.filter((c) => c.method === method).map((c) => c.args);
const rfb = () => FakeRfb.all.at(-1) as FakeRfb;
const sub = () => (document.querySelector(".ac-dialog__sub") as HTMLElement).textContent;
const view = () => within(screen().getByRole("dialog", { name: "Computador da Ada" }));
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const connected = async () => {
  await act(async () => rfb().emit("connect"));
  await settle(2);
};
const controlOf = (agentId: string, controllerUserId: string): BrowserHandoff => ({
  id: "h-joao",
  agentId,
  runId: null,
  machineId: "machine-1",
  screen: "desktop",
  kind: "takeover",
  instructions: "",
  status: "active",
  requestedForUserId: null,
  controllerUserId,
  note: null,
  expiresAt: null,
  createdAt: new Date().toISOString(),
  resolvedAt: null,
});

beforeEach(() => {
  FakeRfb.all = [];
  localStorage.clear();
});
afterEach(() => cleanup());

describe("the agent's screen in the computer dialog", () => {
  test("watching: a socket of its own in binary, view-only at quality 3, scaled; live once noVNC connects", async () => {
    const t = await dialog();
    expect(t.sockets.desktops).toHaveLength(1);
    const ws = t.sockets.desktops[0];
    expect(ws?.url).toBe(`ws://localhost:3000/api/desktop?orgId=${ORG_ID}&agentId=${ADA_ID}&mode=watch`);
    expect(ws?.binaryType).toBe("arraybuffer");
    expect(rfb().ws).toBe(ws as DesktopSocket);
    // The computer speaks first: bytes that reach the socket before noVNC listens are lost.
    expect(rfb().onTime).toBe(true);
    expect(rfb().options).toEqual({ shared: true });
    expect(rfb()).toMatchObject({
      viewOnly: true,
      qualityLevel: 3,
      compressionLevel: 2,
      scaleViewport: true,
      resizeSession: false,
      focusOnClick: false,
    });
    expect(screen().getByText("Abrindo o computador da Ada…")).toBeTruthy();
    expect(sub()).toBe("Abrindo…");
    await connected();
    expect(screen().queryByText("Abrindo o computador da Ada…")).toBeNull();
    expect(sub()).toBe("Ao vivo · você está assistindo");
    expect(view().getByRole("img", { name: "Tela da Ada, ao vivo" })).toBeTruthy();
    expect(view().getByRole("button", { name: "Assumir o controle" })).toBeTruthy();
    // No power and no fold: the screen starts by itself and stays on.
    expect(view().queryByRole("button", { name: "Desligar" })).toBeNull();
    expect(view().queryByRole("button", { name: "Recolher" })).toBeNull();
    // Watching gives no way to type into it.
    expect(view().queryByRole("textbox", { name: "Texto para colar no computador da Ada" })).toBeNull();
  });

  test("a screen that isn't running opens like any other: no Off and no Turn on; an older computer's refusal reads as opening", async () => {
    const t = await dialog({ ...RUNNING, running: false });
    // Opening the stream starts it.
    expect(t.sockets.desktops).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/Desligad|Ligar|está desligada/);
    // An older computer still refuses a screen that isn't running; the server starts it and the next try opens.
    await act(async () => t.sockets.desktops[0]?.serverClose(4502, "desktop_off"));
    await settle(4);
    expect(screen().getByText("Abrindo o computador da Ada…")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Desligad|Ligar/);
    await act(async () => new Promise((r) => setTimeout(r, 1100)));
    await settle(4);
    expect(t.sockets.desktops).toHaveLength(2);
    await connected();
    expect(sub()).toBe("Ao vivo · você está assistindo");
  });

  test("4409: someone else took control, the screen hides; once handed back it opens again", async () => {
    const t = await dialog();
    await connected();
    const joao = controlOf(ADA_ID, "u-joao");
    t.fake.handoffs.set(joao.id, joao);
    await act(async () => t.sockets.desktops[0]?.serverClose(4409, "someone_in_control"));
    await settle(6);
    expect(screen().getByText("João está no controle")).toBeTruthy();
    expect(sub()).toBe("João no controle · tela oculta");
    expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();
    expect(t.sockets.desktops).toHaveLength(1);

    t.fake.handoffs.set(joao.id, { ...joao, status: "done" });
    await act(async () => t.services.queryClient.invalidateQueries({ queryKey: keys.agentDesktop(ORG_ID, ADA_ID) }));
    await settle(6);
    expect(t.sockets.desktops).toHaveLength(2);
    expect(t.sockets.desktops[1]?.url).toContain("mode=watch");
    await connected();
    expect(sub()).toBe("Ao vivo · você está assistindo");
  });

  test("too many watching: it says so and tries again; no room for another screen: Tentar de novo", async () => {
    const t = await dialog();
    await act(async () => t.sockets.desktops[0]?.serverClose(4429, "too_many"));
    await settle(4);
    expect(screen().getByText("Muita gente assistindo agora.")).toBeTruthy();
    expect(screen().getByText("Tentando de novo…")).toBeTruthy();
    expect(sub()).toBe("Abrindo…");
    await act(async () => new Promise((r) => setTimeout(r, 1100)));
    await settle(4);
    expect(t.sockets.desktops).toHaveLength(2);

    await act(async () => t.sockets.desktops[1]?.serverClose(4502, "desktop_busy"));
    await settle(4);
    expect(
      screen().getByText("O Servidor de casa já mostra o máximo de telas que consegue. Tente de novo daqui a pouco."),
    ).toBeTruthy();
    // Nothing by itself: a person tries again.
    await act(async () => new Promise((r) => setTimeout(r, 1100)));
    await settle(2);
    expect(t.sockets.desktops).toHaveLength(2);
    await click(view().getByRole("button", { name: "Tentar de novo" }));
    expect(t.sockets.desktops).toHaveLength(3);
  });

  test("Assumir takes the screen's own handoff, control opens at quality 6 with the person's keyboard; Devolver hands it back", async () => {
    localStorage.setItem("agentes.screen.keyboard", "br");
    const t = await dialog();
    await connected();
    await click(view().getByRole("button", { name: "Assumir o controle" }));
    expect(calls(t, "browser.takeover")).toEqual([[ORG_ID, ADA_ID, "desktop"]]);
    await settle(4);
    expect(t.sockets.desktops.at(-1)?.url).toContain("&mode=control&keyboard=br");
    expect(t.sockets.desktops[0]?.closed).toBe(true);
    expect(rfb()).toMatchObject({ viewOnly: false, qualityLevel: 6, focusOnClick: true });
    await connected();
    // The person's keys go to the screen at once.
    expect(rfb().focused).toBeGreaterThan(0);
    expect(sub()).toBe("Você no controle · a Ada espera");
    expect(
      screen().getByText(
        "Enquanto você está no controle, os programas do computador da Ada podem ver a tela e o que você digita.",
      ),
    ).toBeTruthy();

    // Esc in control goes to the computer: the dialog stays.
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    expect(t.closed()).toBe(0);

    await click(view().getByRole("button", { name: "Devolver" }));
    const note = view().getByRole("textbox", { name: "Recado para a Ada" });
    await act(async () => fireEvent.change(note, { target: { value: "Deixei o arquivo na mesa" } }));
    await click(view().getAllByRole("button", { name: "Devolver" }).at(-1) as HTMLElement);
    expect(calls(t, "browser.done")).toEqual([[ORG_ID, "takeover-1", "Deixei o arquivo na mesa"]]);
    await settle(4);
    expect(t.sockets.desktops.at(-1)?.url).toContain("mode=watch");
  });

  test("full screen is the page's, so leaving it with Esc lets the first click on Devolver work", async () => {
    let requested = null as Element | null;
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: function (this: Element) {
        requested = this;
        return Promise.resolve();
      },
    });
    const t = await dialog();
    await connected();
    await click(view().getByRole("button", { name: "Assumir o controle" }));
    await settle(4);
    await connected();
    await click(view().getByRole("button", { name: "Tela cheia" }));
    // The page goes full screen, not the dialog: noVNC's capture layer on the page stays inside it.
    expect(requested).toBe(document.documentElement);
    expect(document.querySelector(".cmp-dialog")?.classList.contains("is-full")).toBe(true);
    // In full screen Esc only leaves full screen, even in control.
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await settle(2);
    expect(document.querySelector(".cmp-dialog")?.classList.contains("is-full")).toBe(false);
    expect(t.closed()).toBe(0);
    await click(view().getByRole("button", { name: "Devolver" }));
    expect(view().getByRole("textbox", { name: "Recado para a Ada" })).toBeTruthy();
    delete (document.documentElement as { requestFullscreen?: unknown }).requestFullscreen;
  });

  test("Colar texto: the screen's clipboard, then Shift+Insert; what the screen copies waits behind Copiar", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (v: string) => void copied.push(v) },
    });
    const t = await dialog();
    await connected();
    await click(view().getByRole("button", { name: "Assumir o controle" }));
    await settle(4);
    await connected();
    expect(t.sockets.desktops.at(-1)?.url).toContain("mode=control");
    // The watching socket's close can arrive after the control one opened: the paste still goes.
    await act(async () => t.sockets.desktops[0]?.serverClose(1000));
    await settle(2);

    const field = view().getByRole("textbox", { name: "Texto para colar no computador da Ada" });
    await act(async () => fireEvent.change(field, { target: { value: "Olá, ação: êõú ç — 日本" } }));
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    expect(rfb().pasted).toEqual(["Olá, ação: êõú ç — 日本"]);
    expect(rfb().keys).toEqual([
      [0xffe1, "ShiftLeft", true],
      [0xff63, "Insert", undefined],
      [0xffe1, "ShiftLeft", false],
    ]);

    await act(async () => rfb().emit("clipboard", { text: "ls -la /tmp" }));
    await settle(2);
    expect(copied).toEqual([]);
    expect(screen().getByText("ls -la /tmp")).toBeTruthy();
    expect(screen().getByText("Copiado no computador da Ada:")).toBeTruthy();
    await click(view().getByRole("button", { name: "Copiar" }));
    expect(copied).toEqual(["ls -la /tmp"]);
  });

  test("a page kept for the Back button lets its screen go, and opens it again when the person comes back", async () => {
    const t = await dialog();
    await connected();
    const page = (type: "pagehide" | "pageshow", persisted: boolean) =>
      act(async () => void window.dispatchEvent(Object.assign(new Event(type), { persisted })));
    // A page really going away is the browser's to close.
    await page("pagehide", false);
    expect(t.sockets.desktops[0]?.closed).toBe(false);

    await page("pagehide", true);
    expect(t.sockets.desktops[0]?.closed).toBe(true);
    // Its close arrives when the page is back: not a reason to stop opening the screen.
    await act(async () => t.sockets.desktops[0]?.serverClose(1000));
    await page("pageshow", true);
    await settle(4);
    expect(t.sockets.desktops).toHaveLength(2);
    expect(t.sockets.desktops[1]?.url).toContain("mode=watch");
    await connected();
    expect(sub()).toBe("Ao vivo · você está assistindo");
  });

  test("can't show on self-host: the reason, and for whoever paired it the command to run there", async () => {
    const t = await dialog({ ...RUNNING, available: false, reason: "not_allowed" });
    expect(t.sockets.desktops).toHaveLength(0);
    expect(screen().getByText("As telas estão desligadas no Servidor de casa. Ligue lá:")).toBeTruthy();
    // A system-mode computer's settings are its administrator's.
    expect(document.querySelector(".machine-command__code")?.textContent).toBe(
      "sudo agentes-runner tools enable desktop",
    );
    expect(view().getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    cleanup();

    const outdated = await dialog({ ...RUNNING, available: false, reason: "runner_outdated" });
    expect(outdated.sockets.desktops).toHaveLength(0);
    expect(screen().getByText("Atualize o agentes no Servidor de casa para ver a tela da Ada.")).toBeTruthy();
  });
});
