import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { BrowserHandoff, DesktopStatus, SocketFactory } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { DesktopView } from "@/components/desktop/DesktopView";
import { ADA_ID, createFakeApi, fakeBrowserOf, ORG_ID, seedState } from "./fake-api";
import { fakeSockets } from "./fake-socket";
import { renderApp, renderPage, screen, settle } from "./render";

/** A person's socket to the desktop: the server side closes it with a code. */
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

/** noVNC's RFB as the panel drives it: how it was set, what it pasted and pressed; `emit` plays its events. */
class FakeRfb {
  static all: FakeRfb[] = [];
  viewOnly = false;
  qualityLevel = 6;
  compressionLevel = 2;
  scaleViewport = false;
  resizeSession = false;
  focusOnClick = true;
  background = "";
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
  focus() {}
  disconnect() {
    this.ws.close();
  }
}
mock.module("@novnc/novnc", () => ({ default: FakeRfb }));

const RUNNING: Partial<DesktopStatus> = {
  available: true,
  reason: null,
  running: true,
  canControl: true,
  canStart: true,
};

/** The desktop sockets apart from the realtime one. */
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

function backend(desktop: Partial<DesktopStatus>) {
  const state = seedState();
  const api = createFakeApi(state);
  const fake = fakeBrowserOf.get(api);
  if (!fake) throw new Error("no fake browser");
  fake.desktops.set(ADA_ID, desktop);
  return { state, api, fake, sockets: socketsFor() };
}

async function panel(desktop: Partial<DesktopStatus> = RUNNING) {
  const b = backend(desktop);
  const r = await renderPage(<DesktopView agentId={ADA_ID} name="Ada" />, {
    api: b.api,
    org: true,
    createSocket: b.sockets.factory,
  });
  await settle(6);
  return { ...r, ...b };
}

const calls = (s: { state: ReturnType<typeof seedState> }, method: string) =>
  s.state.calls.filter((c) => c.method === method).map((c) => c.args);
const rfb = () => FakeRfb.all.at(-1) as FakeRfb;
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

describe("the agent's desktop panel", () => {
  test("watching: a socket of its own in binary, view-only at quality 3, scaled; live once noVNC connects", async () => {
    const t = await panel();
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
    expect(screen().getByText("Abrindo a tela da Ada…")).toBeTruthy();
    await connected();
    expect(screen().queryByText("Abrindo a tela da Ada…")).toBeNull();
    expect(screen().getByText("Ao vivo · você só assiste")).toBeTruthy();
    expect(screen().getByRole("button", { name: "Assumir o controle" })).toBeTruthy();
    // Watching gives no way to type into it.
    expect(screen().queryByRole("textbox", { name: "Texto para colar na tela da Ada" })).toBeNull();
  });

  test("4409: someone else took control, the screen hides; once handed back it opens again", async () => {
    const t = await panel();
    await connected();
    const joao = controlOf(ADA_ID, "u-joao");
    t.fake.handoffs.set(joao.id, joao);
    await act(async () => t.sockets.desktops[0]?.serverClose(4409, "someone_in_control"));
    await settle(6);
    expect(screen().getByText("João está no controle")).toBeTruthy();
    expect(screen().getByText("João no controle · tela oculta")).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Assumir o controle" })).toBeNull();
    expect(t.sockets.desktops).toHaveLength(1);

    t.fake.handoffs.set(joao.id, { ...joao, status: "done" });
    await act(async () => t.services.queryClient.invalidateQueries({ queryKey: keys.agentDesktop(ORG_ID, ADA_ID) }));
    await settle(6);
    expect(t.sockets.desktops).toHaveLength(2);
    expect(t.sockets.desktops[1]?.url).toContain("mode=watch");
    await connected();
    expect(screen().getByText("Ao vivo · você só assiste")).toBeTruthy();
  });

  test("off: Ligar only for who may turn it on; it starts and the screen opens", async () => {
    const viewer = await panel({ ...RUNNING, running: false, canStart: false });
    expect(screen().getByText("A tela da Ada está desligada")).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Ligar" })).toBeNull();
    expect(viewer.sockets.desktops).toHaveLength(0);
    cleanup();

    const t = await panel({ ...RUNNING, running: false });
    await click(screen().getByRole("button", { name: "Ligar" }));
    expect(calls(t, "desktop.start")).toEqual([[ORG_ID, ADA_ID]]);
    await settle(4);
    expect(t.sockets.desktops).toHaveLength(1);
  });

  test("the bar: Assumir takes the desktop's own handoff, control opens at quality 6 with the person's keyboard; Devolver hands it back", async () => {
    localStorage.setItem("agentes.screen.keyboard", "br");
    const t = await panel();
    await connected();
    await click(screen().getByRole("button", { name: "Assumir o controle" }));
    expect(calls(t, "browser.takeover")).toEqual([[ORG_ID, ADA_ID, "desktop"]]);
    await settle(4);
    expect(t.sockets.desktops.at(-1)?.url).toContain("&mode=control&keyboard=br");
    expect(t.sockets.desktops[0]?.closed).toBe(true);
    expect(rfb()).toMatchObject({ viewOnly: false, qualityLevel: 6, focusOnClick: true });
    await connected();
    expect(screen().getByText("Você no controle · a Ada espera")).toBeTruthy();
    expect(screen().getByText(/os programas do computador do agente podem ver a tela/)).toBeTruthy();

    await click(screen().getByRole("button", { name: "Devolver" }));
    await click(screen().getByRole("button", { name: "Devolver" }));
    expect(calls(t, "browser.done")).toEqual([[ORG_ID, "takeover-1"]]);
    await settle(4);
    expect(t.sockets.desktops.at(-1)?.url).toContain("mode=watch");
  });

  test("Colar texto: the desktop's clipboard, then Shift+Insert; what the desktop copies waits behind Copiar", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (v: string) => void copied.push(v) },
    });
    const t = await panel();
    await connected();
    await click(screen().getByRole("button", { name: "Assumir o controle" }));
    await settle(4);
    await connected();
    expect(t.sockets.desktops.at(-1)?.url).toContain("mode=control");

    const field = screen().getByRole("textbox", { name: "Texto para colar na tela da Ada" });
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
    await click(screen().getByRole("button", { name: "Copiar" }));
    expect(copied).toEqual(["ls -la /tmp"]);
  });

  test("the agent's page: a line under its browser; Ver a tela opens the live panel, as does ?desktop=1", async () => {
    const b = backend(RUNNING);
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: b.api, createSocket: b.sockets.factory });
    await settle(8);
    expect(screen().getByText("Ligada · ao vivo")).toBeTruthy();
    expect(b.sockets.desktops).toHaveLength(0);
    await click(screen().getByRole("button", { name: "Ver a tela" }));
    await settle(4);
    expect(screen().getByRole("group", { name: "Tela da Ada" })).toBeTruthy();
    expect(b.sockets.desktops).toHaveLength(1);
    cleanup();

    const asked = backend(RUNNING);
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?desktop=1`, {
      api: asked.api,
      createSocket: asked.sockets.factory,
    });
    await settle(8);
    expect(screen().getByRole("group", { name: "Tela da Ada" })).toBeTruthy();
    expect(asked.sockets.desktops).toHaveLength(1);
  });
});
