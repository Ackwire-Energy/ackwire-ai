import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
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

/** A key event as the log reads it: `keydown a KeyA ctrl`. */
const keyText = (e: KeyboardEvent) =>
  [e.type, e.key, e.code, ...(["ctrl", "shift", "alt", "meta"] as const).filter((m) => e[`${m}Key`])]
    .filter(Boolean)
    .join(" ");

/**
 * noVNC's RFB as the screen drives it: how it was set and what it pasted; `log` holds, in order, the key events
 * replayed on its canvas and the keys it sent (`send Insert down`); `emit` plays its events.
 */
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
  log: string[] = [];
  /** It took its socket in the tick the socket was made, before anything could arrive on it. */
  readonly onTime: boolean;
  /** Like noVNC, it draws into a canvas of its own inside the screen, and takes its keys there. */
  readonly canvas = document.createElement("canvas");
  private listeners = new Map<string, ((e: Event) => void)[]>();
  constructor(
    readonly el: HTMLElement,
    readonly ws: DesktopSocket,
    readonly options?: { shared?: boolean },
  ) {
    this.onTime = !ws.late;
    FakeRfb.all.push(this);
    this.canvas.width = 1280;
    this.canvas.height = 900;
    for (const type of ["keydown", "keyup"]) {
      this.canvas.addEventListener(type, (e) => this.log.push(keyText(e as KeyboardEvent)));
    }
    el.appendChild(this.canvas);
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
  sendKey(_keysym: number, code: string | null, down?: boolean) {
    this.log.push(`send ${code} ${down ? "down" : "up"}`);
  }
  focus() {}
  disconnect() {
    this.canvas.remove();
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
/** The browser's full screen: which element asked for it; `document.fullscreenElement` follows. */
function fullScreen() {
  const page = { requested: [] as Element[] };
  const doc = document as { fullscreenElement: Element | null };
  replaceOn(document, "fullscreenElement", null);
  replaceOn(document.documentElement, "requestFullscreen", function (this: Element) {
    page.requested.push(this);
    doc.fullscreenElement = this;
    return Promise.resolve();
  });
  replaceOn(document, "exitFullscreen", () => {
    doc.fullscreenElement = null;
    return Promise.resolve();
  });
  return page;
}
/** The dialog's classes. */
const classes = () => [...(document.querySelector(".cmp-dialog")?.classList ?? [])];

/** Ada's screen in this person's control, live: the field over it has the person's keys. */
async function controlled() {
  const t = await dialog();
  await connected();
  await click(view().getByRole("button", { name: "Assumir o controle" }));
  await settle(4);
  await connected();
  return {
    ...t,
    field: () => view().getByRole("textbox", { name: "Digitar no computador da Ada" }) as HTMLTextAreaElement,
  };
}
/** The line under the screen in control: its words. */
const line = () => document.querySelector(".dsk-line > .muted")?.textContent;
const pasteOn = (el: Element, text: string) =>
  act(
    async () =>
      void fireEvent.paste(el, { clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") } }),
  );
const SHIFT_INSERT = ["send ShiftLeft down", "send Insert down", "send Insert up", "send ShiftLeft up"];

/** Globals a test replaced (the person's clipboard, the platform), put back after it. */
const restores: (() => void)[] = [];
function replaceOn(target: object, key: string, value: unknown) {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => {
    if (own) Object.defineProperty(target, key, own);
    else delete (target as Record<string, unknown>)[key];
  });
}

/** The person's clipboard as the browser keeps it: what was written there, and whether a write is let in. */
function clipboard({ refuses = false } = {}) {
  const board = { writes: 0, failed: 0, written: [] as string[], texts: [] as string[] };
  class Item {
    constructor(readonly data: Record<string, Promise<Blob>>) {}
  }
  replaceOn(globalThis, "ClipboardItem", Item);
  replaceOn(navigator, "clipboard", {
    write: async ([item]: Item[]) => {
      board.writes++;
      if (refuses) throw new Error("NotAllowedError");
      try {
        const blob = await item?.data["text/plain"];
        board.written.push((await blob?.text()) ?? "");
      } catch (err) {
        board.failed++;
        throw err;
      }
    },
    writeText: async (text: string) => void board.texts.push(text),
  });
  return board;
}

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
afterEach(() => {
  cleanup();
  for (const put of restores.splice(0).reverse()) put();
});

/**
 * What the screen's canvas shows, read back the way the screen reads it (a small copy, off the page): black until
 * `picture()`. The DOM here draws nothing, so that copy's context is this stand-in while it's on; the canvases
 * on the page keep their own.
 */
function screenPixels() {
  let shows = false;
  const proto = Object.getPrototypeOf(document.createElement("canvas")) as HTMLCanvasElement;
  const getContext = proto.getContext;
  const copy = {
    drawImage() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      // One spot of the desktop's sky is enough to tell a picture from a black screen.
      if (shows) data.set([75, 147, 255, 255], 4 * (w + 1));
      return { data };
    },
  };
  proto.getContext = function (this: HTMLCanvasElement, ...args: Parameters<HTMLCanvasElement["getContext"]>) {
    return this.isConnected ? getContext.apply(this, args) : copy;
  } as unknown as typeof proto.getContext;
  return {
    picture: () => {
      shows = true;
    },
    restore: () => {
      proto.getContext = getContext;
    },
  };
}
const waitLooks = () => act(async () => new Promise((r) => setTimeout(r, 260)));

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
    expect(view().queryByRole("textbox", { name: "Digitar no computador da Ada" })).toBeNull();
  });

  test("Live once a picture is there: a screen that just started stays black a moment, and says Opening meanwhile", async () => {
    const pixels = screenPixels();
    try {
      await dialog({ ...RUNNING, running: false });
      await connected();
      await waitLooks();
      expect(sub()).toBe("Abrindo…");
      expect(screen().getByText("Abrindo o computador da Ada…")).toBeTruthy();
      expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();
      pixels.picture();
      await waitLooks();
      expect(sub()).toBe("Ao vivo · você está assistindo");
      expect(screen().queryByText("Abrindo o computador da Ada…")).toBeNull();
      expect(view().getByRole("button", { name: "Assumir o controle" })).toBeTruthy();
    } finally {
      pixels.restore();
    }
  });

  test("a screen that stays one flat color for good is shown as it is after a while, not Opening forever", async () => {
    const pixels = screenPixels();
    try {
      await dialog();
      await connected();
      await waitLooks();
      expect(sub()).toBe("Abrindo…");
      setSystemTime(new Date(Date.now() + 10_500));
      await waitLooks();
      expect(sub()).toBe("Ao vivo · você está assistindo");
    } finally {
      setSystemTime();
      pixels.restore();
    }
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

  test("held, its screen not running: nothing starts it, the pause said once; once the hold ends it opens", async () => {
    const t = await dialog({ ...RUNNING, running: false, held: true });
    expect(t.sockets.desktops).toHaveLength(0);
    expect(view().getAllByText("A Ada está em pausa por enquanto")).toHaveLength(1);
    expect(sub()).toBe("Em pausa por enquanto · dá para assistir");
    expect(screen().queryByText("Abrindo o computador da Ada…")).toBeNull();
    expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();

    t.fake.desktops.set(ADA_ID, { ...RUNNING, running: false });
    await act(async () => t.services.queryClient.invalidateQueries({ queryKey: keys.agentDesktop(ORG_ID, ADA_ID) }));
    await settle(6);
    expect(t.sockets.desktops).toHaveLength(1);
    await connected();
    expect(sub()).toBe("Ao vivo · você está assistindo");
  });

  test("held while watching: the pause over the live screen; the stream's `held` close is the held cover, not opening", async () => {
    const t = await dialog({ ...RUNNING, held: true });
    await connected();
    expect(view().getByText("A Ada está em pausa por enquanto")).toBeTruthy();
    expect(sub()).toBe("Em pausa por enquanto · dá para assistir");
    expect(view().queryByRole("button", { name: "Assumir o controle" })).toBeNull();

    // Its screen went away meanwhile: the server starts none for a held agent. The close alone says so, before
    // the screen's state (asked again at the close, and still saying it runs) could.
    await act(async () => t.sockets.desktops[0]?.serverClose(4502, "held"));
    await settle(6);
    expect(screen().queryByText("Abrindo o computador da Ada…")).toBeNull();
    expect(view().getAllByText("A Ada está em pausa por enquanto")).toHaveLength(1);
    expect(sub()).toBe("Em pausa por enquanto · dá para assistir");
    // Not running and held: no socket tries again until the hold ends.
    t.fake.desktops.set(ADA_ID, { ...RUNNING, running: false, held: true });
    await act(async () => t.services.queryClient.invalidateQueries({ queryKey: keys.agentDesktop(ORG_ID, ADA_ID) }));
    await act(async () => new Promise((r) => setTimeout(r, 1100)));
    await settle(4);
    expect(t.sockets.desktops).toHaveLength(1);
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

  test("Assumir takes the screen's own handoff, control opens at quality 6 with no keyboard to pick; Devolver hands it back", async () => {
    // A layout an older version kept is never sent: what a key types is the person's own layout's.
    localStorage.setItem("agentes.screen.keyboard", "br");
    const t = await dialog();
    await connected();
    await click(view().getByRole("button", { name: "Assumir o controle" }));
    expect(calls(t, "browser.takeover")).toEqual([[ORG_ID, ADA_ID, "desktop"]]);
    await settle(4);
    expect(t.sockets.desktops.at(-1)?.url).toEndWith("&mode=control");
    expect(t.sockets.desktops[0]?.closed).toBe(true);
    expect(rfb()).toMatchObject({ viewOnly: false, qualityLevel: 6, focusOnClick: false });
    await connected();
    // The person's keys go to the screen at once, through a field over it.
    expect(document.activeElement).toBe(view().getByRole("textbox", { name: "Digitar no computador da Ada" }));
    expect(sub()).toBe("Você no controle · a Ada espera");
    expect(line()).toBe(
      "Copiar e colar como sempre: Ctrl C, Ctrl V. Os programas do computador da Ada podem ver a tela e o que você digita ou cola.",
    );
    // No box to paste into and no keyboard to pick: the person's own keys paste, and type in their own layout.
    expect(view().queryByRole("textbox", { name: "Texto para colar no computador da Ada" })).toBeNull();
    expect(view().queryByRole("combobox")).toBeNull();
    expect(document.querySelector(".dsk-line")?.textContent).toBe(line());

    // Esc in control goes to the computer: the dialog stays.
    await act(async () =>
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" }),
    );
    await settle(2);
    expect(t.closed()).toBe(0);
    expect(rfb().log).toContain("keydown Escape Escape");

    await click(view().getByRole("button", { name: "Devolver" }));
    const note = view().getByRole("textbox", { name: "Recado para a Ada" });
    await act(async () => fireEvent.change(note, { target: { value: "Deixei o arquivo na mesa" } }));
    await click(view().getAllByRole("button", { name: "Devolver" }).at(-1) as HTMLElement);
    expect(calls(t, "browser.done")).toEqual([[ORG_ID, "takeover-1", "Deixei o arquivo na mesa"]]);
    await settle(4);
    expect(t.sockets.desktops.at(-1)?.url).toContain("mode=watch");
  });

  test("in control each key is replayed on noVNC's canvas, never seen by the page; a blur lets go of what is held", async () => {
    const t = await controlled();
    const field = t.field();
    const page: string[] = [];
    const seen = (e: KeyboardEvent) => page.push(e.key);
    window.addEventListener("keydown", seen);
    try {
      // Taken from the browser (prevented) and replayed.
      expect(fireEvent.keyDown(field, { key: "a", code: "KeyA" })).toBe(false);
      fireEvent.keyUp(field, { key: "a", code: "KeyA" });
      fireEvent.keyDown(field, { key: "Shift", code: "ShiftLeft", shiftKey: true });
      await act(async () => field.blur());
      expect(rfb().log).toEqual([
        "keydown a KeyA",
        "keyup a KeyA",
        "keydown Shift ShiftLeft shift",
        "keyup Shift ShiftLeft shift",
      ]);
      expect(page).toEqual([]);
    } finally {
      window.removeEventListener("keydown", seen);
    }
  });

  test("Ctrl+V pastes the person's clipboard: the computer's clipboard, then Shift+Insert with Ctrl let go and held again", async () => {
    const t = await controlled();
    // The watching socket's close can arrive after the control one opened: the paste still goes.
    await act(async () => t.sockets.desktops[0]?.serverClose(1000));
    await settle(2);
    const field = t.field();
    fireEvent.keyDown(field, { key: "Control", code: "ControlLeft", ctrlKey: true });
    // V is the browser's own paste: neither replayed nor stopped.
    expect(fireEvent.keyDown(field, { key: "v", code: "KeyV", ctrlKey: true })).toBe(true);
    await pasteOn(field, "Olá, ação: êõú ç — 日本\r\nfim");
    expect(rfb().pasted).toEqual(["Olá, ação: êõú ç — 日本\nfim"]);
    expect(rfb().log).toEqual([
      "keydown Control ControlLeft ctrl",
      "keyup Control ControlLeft ctrl",
      ...SHIFT_INSERT,
      "keydown Control ControlLeft ctrl",
    ]);
  });

  test("a paste over 256 KB, or with no text, sends nothing and says why", async () => {
    const t = await controlled();
    await pasteOn(t.field(), "x".repeat(262_145));
    expect(screen().getByText("Grande demais para colar no computador da Ada. No máximo 256 KB.")).toBeTruthy();
    await pasteOn(t.field(), "");
    expect(screen().getByText("No computador da Ada só dá para colar texto.")).toBeTruthy();
    expect(rfb().pasted).toEqual([]);
    expect(rfb().log).toEqual([]);
    // The limit is the computer's, in bytes: 256 KB of two-byte letters goes.
    await pasteOn(t.field(), "ã".repeat(131_072));
    expect(rfb().pasted).toHaveLength(1);
  });

  test("a dead key composes in the field: é goes as one key, an emoji as a paste", async () => {
    const t = await controlled();
    const field = t.field();
    // Left to the browser, which composes it.
    expect(fireEvent.keyDown(field, { key: "Dead", code: "Quote" })).toBe(true);
    expect(rfb().log).toEqual([]);
    const compose = async (text: string) => {
      field.value = text;
      await act(async () => {
        field.dispatchEvent(new Event("compositionend"));
        await new Promise((r) => setTimeout(r, 0));
      });
    };
    await compose("é");
    expect(rfb().log).toEqual(["keydown é"]);
    expect(field.value).toBe("");
    await compose("👍");
    expect(rfb().pasted).toEqual(["👍"]);
    expect(rfb().log.slice(1)).toEqual(SHIFT_INSERT);
  });

  test("⌘C on a Mac: Ctrl+Insert there, and what it copies within 2 s lands in the person's clipboard; ⌘V pastes", async () => {
    replaceOn(navigator, "platform", "MacIntel");
    const board = clipboard();
    const t = await controlled();
    expect(line()).toStartWith("Copiar e colar como sempre: ⌘ C, ⌘ V. ");
    const field = t.field();
    fireEvent.keyDown(field, { key: "Meta", code: "MetaLeft", metaKey: true });
    fireEvent.keyDown(field, { key: "c", code: "KeyC", metaKey: true });
    // ⌘ is Alt there: let go of it around the copy keys, then held again.
    expect(rfb().log).toEqual([
      "keydown Meta MetaLeft meta",
      "keyup Meta MetaLeft meta",
      "send ControlLeft down",
      "send Insert down",
      "send Insert up",
      "send ControlLeft up",
      "keydown Meta MetaLeft meta",
    ]);
    await act(async () => rfb().emit("clipboard", { text: "ls -la /tmp" }));
    await settle(2);
    expect(board.written).toEqual(["ls -la /tmp"]);
    expect(screen().getByText("Copiado do computador da Ada.")).toBeTruthy();

    rfb().log = [];
    expect(fireEvent.keyDown(field, { key: "v", code: "KeyV", metaKey: true })).toBe(true);
    await pasteOn(field, "oi");
    expect(rfb().pasted).toEqual(["oi"]);
    expect(rfb().log).toEqual(["keyup Meta MetaLeft meta", ...SHIFT_INSERT, "keydown Meta MetaLeft meta"]);
  });

  test("Ctrl+C elsewhere stays an interrupt there; nothing is written when nothing is copied", async () => {
    const board = clipboard();
    const t = await controlled();
    const field = t.field();
    fireEvent.keyDown(field, { key: "Control", code: "ControlLeft", ctrlKey: true });
    fireEvent.keyDown(field, { key: "c", code: "KeyC", ctrlKey: true });
    expect(rfb().log).toEqual(["keydown Control ControlLeft ctrl", "keydown c KeyC ctrl"]);
    await act(() => new Promise((r) => setTimeout(r, 2_100)));
    expect(board).toMatchObject({ writes: 1, failed: 1, written: [] });
    // Too late to be that copy's.
    await act(async () => rfb().emit("clipboard", { text: "^C" }));
    await settle(2);
    expect(board.writes).toBe(1);
    expect(document.querySelector(".ac-toast")).toBeNull();
  });

  test("what the computer copies by itself never reaches the person's clipboard", async () => {
    const board = clipboard();
    await controlled();
    await act(async () => rfb().emit("clipboard", { text: "a selection" }));
    await settle(2);
    expect(board.writes).toBe(0);
    expect(document.querySelector(".ac-toast")).toBeNull();
  });

  test("a browser that won't let the copy in: a toast with the text and Copiar", async () => {
    const board = clipboard({ refuses: true });
    const t = await controlled();
    fireEvent.keyDown(t.field(), { key: "c", code: "KeyC", ctrlKey: true });
    await act(async () => rfb().emit("clipboard", { text: "ls -la /tmp" }));
    await settle(2);
    expect(screen().getByText("Copiado no computador da Ada:")).toBeTruthy();
    expect(screen().getByText("ls -la /tmp")).toBeTruthy();
    // The toasts sit outside the dialog, which hides the rest of the page from assistive tech while open.
    await click(screen().getByRole("button", { name: "Copiar", hidden: true }));
    expect(board.texts).toEqual(["ls -la /tmp"]);
    expect(screen().getByText("Copiado do computador da Ada.")).toBeTruthy();
  });

  test("watching: no field, nothing pasted, nothing copied", async () => {
    const board = clipboard();
    await dialog();
    await connected();
    expect(view().queryByRole("textbox", { name: "Digitar no computador da Ada" })).toBeNull();
    await pasteOn(document.body, "oi");
    fireEvent.keyDown(document.body, { key: "c", code: "KeyC", ctrlKey: true });
    await act(async () => rfb().emit("clipboard", { text: "ls" }));
    await settle(2);
    expect(rfb().pasted).toEqual([]);
    expect(rfb().log).toEqual([]);
    expect(board.writes).toBe(0);
  });

  test("a phone: a Keyboard button raises its keyboard, no keys hint; what it types goes to the computer", async () => {
    replaceOn(navigator, "maxTouchPoints", 5);
    const t = await controlled();
    const field = t.field();
    // Its keyboard comes up only when asked.
    expect(document.activeElement).not.toBe(field);
    const keyboard = view().getByRole("button", { name: "Teclado" });
    expect(keyboard.getAttribute("aria-pressed")).toBe("false");
    expect(line()).toBe("Os programas do computador da Ada podem ver a tela e o que você digita ou cola.");
    await click(keyboard);
    expect(document.activeElement).toBe(field);
    expect(keyboard.getAttribute("aria-pressed")).toBe("true");
    field.value = "oi";
    await act(async () => void field.dispatchEvent(new InputEvent("input", { inputType: "insertText" })));
    expect(rfb().log).toEqual(["keydown o", "keydown i"]);
    expect(field.value).toBe("");
    await act(async () => void field.dispatchEvent(new InputEvent("input", { inputType: "deleteContentBackward" })));
    expect(rfb().log.at(-1)).toBe("keydown Backspace");

    // Handed back with its keyboard up, then taken again: the button starts unpressed.
    await click(view().getByRole("button", { name: "Devolver" }));
    await click(view().getAllByRole("button", { name: "Devolver" }).at(-1) as HTMLElement);
    await settle(4);
    await connected();
    await click(view().getByRole("button", { name: "Assumir o controle" }));
    await settle(4);
    await connected();
    expect(view().getByRole("button", { name: "Teclado" }).getAttribute("aria-pressed")).toBe("false");
  });

  test("leaving the page asks first, only in control", async () => {
    await dialog();
    await connected();
    const leaving = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(leaving()).toBe(false);
    await click(view().getByRole("button", { name: "Assumir o controle" }));
    await settle(4);
    expect(leaving()).toBe(true);
  });

  test("full screen is the page's and shows the computer alone; Esc leaves it, and Devolver works on its first click", async () => {
    const page = fullScreen();
    const t = await controlled();
    await click(view().getByRole("button", { name: "Tela cheia" }));
    // The page goes full screen, not the dialog: noVNC's capture layer on the page stays inside it.
    expect(page.requested).toEqual([document.documentElement]);
    expect(classes()).toEqual(expect.arrayContaining(["is-full", "is-screen-only"]));
    expect(classes()).not.toContain("is-bar-hidden");
    // Without Keyboard Lock, Esc leaves full screen, even in control.
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" }));
    await settle(2);
    expect(classes()).not.toContain("is-full");
    expect(document.fullscreenElement).toBeNull();
    expect(t.closed()).toBe(0);
    await click(view().getByRole("button", { name: "Devolver" }));
    expect(view().getByRole("textbox", { name: "Recado para a Ada" })).toBeTruthy();
  });

  test("Devolver from full screen leaves it first: the note is the dialog's, never over the screen", async () => {
    fullScreen();
    await controlled();
    await click(view().getByRole("button", { name: "Tela cheia" }));
    expect(classes()).toContain("is-screen-only");
    await click(view().getByRole("button", { name: "Devolver" }));
    expect(classes()).not.toContain("is-full");
    expect(document.fullscreenElement).toBeNull();
    expect(view().getByRole("textbox", { name: "Recado para a Ada" })).toBeTruthy();
    // No full screen while the note is open.
    expect(view().queryByRole("button", { name: "Tela cheia" })).toBeNull();
  });

  test("the full-screen bar hides itself; in control only the display's top edge brings it back", async () => {
    fullScreen();
    await controlled();
    await click(view().getByRole("button", { name: "Tela cheia" }));
    const move = (clientY: number) => act(async () => void fireEvent.pointerMove(document.body, { clientY }));
    await act(() => new Promise((r) => setTimeout(r, 2_600)));
    expect(classes()).toContain("is-bar-hidden");
    // The pointer is the computer's: a move over the screen leaves it hidden.
    await move(400);
    expect(classes()).toContain("is-bar-hidden");
    await move(4);
    expect(classes()).not.toContain("is-bar-hidden");
    // On the bar it stays.
    await act(
      async () => void fireEvent.pointerMove(document.querySelector(".ac-dialog__head") as Element, { clientY: 30 }),
    );
    await act(() => new Promise((r) => setTimeout(r, 2_600)));
    expect(classes()).not.toContain("is-bar-hidden");
    // A phone has no pointer to bring to the edge: a tap anywhere brings it back.
    await move(400);
    await act(() => new Promise((r) => setTimeout(r, 2_600)));
    expect(classes()).toContain("is-bar-hidden");
    await act(async () => void fireEvent.pointerDown(document.body, { clientY: 400, pointerType: "touch" }));
    expect(classes()).not.toContain("is-bar-hidden");
    cleanup();

    // Watching, any move brings it back.
    await dialog();
    await connected();
    await click(view().getByRole("button", { name: "Tela cheia" }));
    await act(() => new Promise((r) => setTimeout(r, 2_600)));
    expect(classes()).toContain("is-bar-hidden");
    await move(400);
    expect(classes()).not.toContain("is-bar-hidden");
  });

  test("Keyboard Lock in control: Esc goes to the computer, and the lock goes with full screen", async () => {
    fullScreen();
    const lock = { locked: 0, unlocked: 0 };
    replaceOn(navigator, "keyboard", {
      lock: async () => void lock.locked++,
      unlock: () => void lock.unlocked++,
    });
    const t = await controlled();
    // Only full screen locks it.
    expect(lock.locked).toBe(0);
    await click(view().getByRole("button", { name: "Tela cheia" }));
    expect(lock.locked).toBe(1);
    t.field().focus();
    await act(async () => fireEvent.keyDown(t.field(), { key: "Escape", code: "Escape" }));
    await settle(2);
    expect(classes()).toContain("is-full");
    expect(t.closed()).toBe(0);
    expect(rfb().log).toContain("keydown Escape Escape");
    await click(view().getByRole("button", { name: "Devolver" }));
    expect(lock.unlocked).toBe(1);
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

describe("the dialog's size (computer.css)", () => {
  const css = () => Bun.file(new URL("../src/components/computer/computer.css", import.meta.url).pathname).text();
  const rule = (text: string, selector: string) => text.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";

  test("the screen fills what its stage gets, keeping its shape; no mode sizes it on its own", async () => {
    const text = await css();
    const stage = rule(text, ".cmp-body .dsk-stage,\n.cmp-body > .cmp-stage");
    expect(stage).toContain("container-type: size");
    expect(stage).toContain("flex: 1 1 0");
    expect(rule(text, ".cmp-body .dsk-screen,\n.cmp-body .cmp-stage__box")).toContain(
      "width: min(100cqw, 100cqh * 1280 / 900)",
    );
    // In control and in full screen alike: nothing outranks the stage's own measure.
    expect(text).not.toMatch(/is-control \.dsk-screen\s*\{[^}]*width/);
    expect(text).not.toMatch(/is-full \.(dsk-screen|cmp-stage__box)/);
    const full = rule(text, ".ac-dialog.cmp-dialog.is-full");
    expect(full).toContain("width: 100%");
    expect(full).toContain("height: 100%");
  });

  test("one frame for the screen, its covers and the agent's page, its steps' line kept while there are none", async () => {
    const text = await css();
    // The wait for the workspace's computer is as wide, so its screen opens in place.
    expect(rule(text, ".ac-dialog.cmp-dialog:where(:has(.dsk, .cmp-stage, .cmp-prep, .brw-ac.is-surface))")).toContain(
      "width: calc(var(--cmp-screen) + 32px)",
    );
    expect(rule(text, ".ac-dialog.cmp-dialog:where(:has(.dsk, .cmp-stage, .brw-ac.is-surface))")).toContain(
      "height: calc(var(--cmp-screen) * 900 / 1280 + 130px)",
    );
    expect(rule(text, ".cmp-steps-row")).toContain("height: 22px");
    // The page at 16:10 takes the most of its stage in the same frame, never a size of its own.
    expect(rule(text, ".cmp-body .brw-ac__page")).toContain("width: min(100cqw, 100cqh * 16 / 10)");
    expect(text).not.toContain("--cmp-page-room");
  });

  test("one size watching or in control: the line under the screen takes the steps' line's place", async () => {
    const text = await css();
    // No column of tools beside the screen any more, on any window.
    expect(text).not.toContain("--cmp-side");
    expect(text).not.toContain("min-aspect-ratio");
    expect(rule(text, ".cmp-body:has(> .dsk.is-control) > .cmp-steps-row")).toContain("display: none");
    const desk = await Bun.file(new URL("../src/components/desktop/desktop.css", import.meta.url).pathname).text();
    expect(rule(desk, ".dsk-line")).toContain("min-height: 22px");
  });

  test("full screen on the agent's screen: the screen alone on its ground, what floats over it hidden after a while", async () => {
    const text = await css();
    const dialog = rule(text, ".ac-dialog.cmp-dialog.is-screen-only");
    expect(dialog).toContain("display: grid");
    expect(dialog).toContain("background: var(--screen-bg)");
    const stage = rule(text, ".cmp-dialog.is-screen-only .dsk-stage");
    expect(stage).toContain("grid-area: 1 / 1 / -1 / -1");
    expect(stage).toContain("container-type: size");
    expect(rule(text, ".cmp-dialog.is-screen-only .dsk-screen")).toContain("width: min(100cqw, 100cqh * 1280 / 900)");
    // A banner waiting for the person keeps the bar.
    expect(text).toContain(".is-bar-hidden:not(:has(.cmp-banner");
    // The ground is the screen's own in both themes, so the dialog has it, not only the screen.
    expect(rule(text, ".ac-dialog.cmp-dialog")).toContain("--screen-bg: #1f2128");
  });
});

describe("the person's clipboard", () => {
  test("is never read in the computer dialog: only a paste they make gives it", async () => {
    const dir = new URL("../src/components/", import.meta.url).pathname;
    const files = [...new Bun.Glob("{desktop,computer}/**/*.{ts,tsx}").scanSync({ cwd: dir })];
    expect(files.length).toBeGreaterThan(5);
    const reads: string[] = [];
    for (const file of files) {
      if (/clipboard\s*\??\.\s*read/.test(await Bun.file(dir + file).text())) reads.push(file);
    }
    expect(reads).toEqual([]);
  });
});
