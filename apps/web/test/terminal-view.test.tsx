import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { DesktopStatus, SocketFactory } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { TerminalView } from "@/components/desktop/TerminalView";
import { ADA_ID, createFakeApi, fakeBrowserOf, ORG_ID, seedState } from "./fake-api";
import { fakeSockets } from "./fake-socket";
import { renderApp, renderPage, screen, settle } from "./render";

type SocketEvent = { data?: unknown; code?: number; reason?: string };

/** A person's terminal socket: what the panel sent; the server side opens it, sends bytes and frames, closes it. */
class TerminalSocket {
  binaryType = "blob";
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  closed = false;
  closedWith?: number;
  private listeners = new Map<string, ((e: SocketEvent) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (e: SocketEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closed = true;
    this.closedWith = code;
  }
  private emit(type: string, e: SocketEvent) {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  open() {
    this.readyState = 1;
    this.emit("open", {});
  }
  output(text: string) {
    this.emit("message", { data: new TextEncoder().encode(text).buffer });
  }
  frame(value: unknown) {
    this.emit("message", { data: JSON.stringify(value) });
  }
  serverClose(code: number, reason = "") {
    this.readyState = 3;
    this.closed = true;
    this.emit("close", { code, reason });
  }
}

/** xterm.js as the panel drives it: where it opened, what it wrote; `type` and `mouse` play the person. */
class FakeTerminal {
  static all: FakeTerminal[] = [];
  cols = 80;
  rows = 24;
  parent: HTMLElement | null = null;
  written: Uint8Array[] = [];
  focused = false;
  disposed = false;
  private data: ((d: string) => void)[] = [];
  private binary: ((d: string) => void)[] = [];
  private resized: ((size: { cols: number; rows: number }) => void)[] = [];
  constructor(readonly options: Record<string, unknown>) {
    FakeTerminal.all.push(this);
  }
  loadAddon(addon: { activate(term: FakeTerminal): void }) {
    addon.activate(this);
  }
  open(el: HTMLElement) {
    this.parent = el;
  }
  onData(fn: (d: string) => void) {
    this.data.push(fn);
    return { dispose: () => {} };
  }
  onBinary(fn: (d: string) => void) {
    this.binary.push(fn);
    return { dispose: () => {} };
  }
  onResize(fn: (size: { cols: number; rows: number }) => void) {
    this.resized.push(fn);
    return { dispose: () => {} };
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    for (const fn of this.resized) fn({ cols, rows });
  }
  write(data: Uint8Array) {
    this.written.push(data);
  }
  focus() {
    this.focused = true;
  }
  dispose() {
    this.disposed = true;
  }
  type(text: string) {
    for (const fn of this.data) fn(text);
  }
  mouse(report: string) {
    for (const fn of this.binary) fn(report);
  }
}

/** The fit add-on: proposes the panel's size, `FakeFit.size`. */
class FakeFit {
  static size: { cols: number; rows: number } = { cols: 100, rows: 30 };
  activate() {}
  dispose() {}
  proposeDimensions() {
    return FakeFit.size;
  }
}
mock.module("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
mock.module("@xterm/addon-fit", () => ({ FitAddon: FakeFit }));

/** The page's ResizeObserver: `resizePanel` plays the terminal's box changing size. */
let observed: { fn: () => void; el: Element }[] = [];
class FakeResizeObserver {
  constructor(private readonly fn: () => void) {}
  observe(el: Element) {
    observed.push({ fn: this.fn, el });
  }
  unobserve(el: Element) {
    observed = observed.filter((o) => o.el !== el);
  }
  disconnect() {
    observed = observed.filter((o) => o.fn !== this.fn);
  }
}
const nativeResizeObserver = globalThis.ResizeObserver;
const resizePanel = async (size: { cols: number; rows: number }) => {
  FakeFit.size = size;
  await act(async () => {
    for (const o of observed) if (o.el.classList.contains("trm-host")) o.fn();
  });
};

const ALLOWED: Partial<DesktopStatus> = { terminal: { available: true, reason: null, allowed: true } };

function backend(desktop: Partial<DesktopStatus> = ALLOWED) {
  const api = createFakeApi(seedState());
  const fake = fakeBrowserOf.get(api);
  if (!fake) throw new Error("no fake browser");
  fake.desktops.set(ADA_ID, desktop);
  const terminals: TerminalSocket[] = [];
  const realtime = fakeSockets();
  const factory: SocketFactory = (url) => {
    if (!url.includes("/api/terminal")) return realtime.factory(url);
    const s = new TerminalSocket(url);
    terminals.push(s);
    return s as unknown as ReturnType<SocketFactory>;
  };
  return { api, factory, terminals };
}

async function panel() {
  const b = backend();
  await renderPage(<TerminalView agentId={ADA_ID} name="Ada" />, { api: b.api, org: true, createSocket: b.factory });
  await settle(6);
  return {
    terminals: b.terminals,
    ws: () => b.terminals.at(-1) as TerminalSocket,
    term: () => FakeTerminal.all.at(-1) as FakeTerminal,
  };
}

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const server = async (fn: () => void) => {
  await act(async () => fn());
  await settle(4);
};
const bytes = (text: string) => new TextEncoder().encode(text);

beforeEach(() => {
  FakeTerminal.all = [];
  FakeFit.size = { cols: 100, rows: 30 };
  observed = [];
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = nativeResizeObserver;
});

describe("a terminal on the agent's computer", () => {
  test("opens at the panel's size on a binary socket; keys go out as bytes, the shell's come back", async () => {
    const t = await panel();
    expect(t.terminals).toHaveLength(1);
    expect(t.ws().url).toBe(`ws://localhost:3000/api/terminal?orgId=${ORG_ID}&agentId=${ADA_ID}&cols=100&rows=30`);
    expect(t.ws().binaryType).toBe("arraybuffer");
    expect(t.term().parent).toBeTruthy();
    expect(screen().getByText("Abrindo o terminal…")).toBeTruthy();
    expect(
      screen().getByText("Você está no computador da Ada, como a Ada. O que você roda aqui fica no computador dela."),
    ).toBeTruthy();

    // Typed before the socket opens: nothing goes (the person sees it opening).
    t.term().type("x");
    await server(() => {
      t.ws().open();
      t.ws().output("ada@computador:~$ ");
    });
    expect(screen().queryByText("Abrindo o terminal…")).toBeNull();
    expect(t.term().written.map((b) => new TextDecoder().decode(b))).toEqual(["ada@computador:~$ "]);
    expect(t.term().focused).toBe(true);

    t.term().type("ls -lá\r");
    t.term().type("\x03");
    // A mouse report that isn't UTF-8: one byte per character.
    t.term().mouse("\x1b[M \xff!");
    expect(t.ws().sent).toEqual([
      bytes("ls -lá\r"),
      bytes("\x03"),
      Uint8Array.from([0x1b, 0x5b, 0x4d, 0x20, 0xff, 0x21]),
    ]);
  });

  test("the panel's size goes out as a JSON resize, within what the server takes; one sent before the socket opens waits for it", async () => {
    const t = await panel();
    await resizePanel({ cols: 132, rows: 40 });
    expect(t.term()).toMatchObject({ cols: 132, rows: 40 });
    expect(t.ws().sent).toEqual([]);
    await server(() => t.ws().open());
    expect(t.ws().sent).toEqual(['{"type":"resize","cols":132,"rows":40}']);

    await resizePanel({ cols: 8, rows: 2 });
    expect(t.ws().sent.at(-1)).toBe('{"type":"resize","cols":20,"rows":5}');
    await resizePanel({ cols: 10, rows: 3 });
    expect(t.ws().sent).toHaveLength(2);
  });

  test("the shell ends: A sessão terminou, and only Abrir de novo opens a new one", async () => {
    const t = await panel();
    await server(() => {
      t.ws().open();
      t.ws().output("$ ");
    });
    await server(() => t.ws().frame({ type: "exit", code: 0 }));
    expect(screen().getByText("A sessão terminou.")).toBeTruthy();
    await server(() => t.ws().serverClose(1000, "the computer closed the stream"));
    await settle(6);
    expect(screen().getByText("A sessão terminou.")).toBeTruthy();
    expect(t.terminals).toHaveLength(1);

    const first = t.term();
    await click(screen().getByRole("button", { name: "Abrir de novo" }));
    expect(first.disposed).toBe(true);
    expect(t.terminals).toHaveLength(2);
    expect(FakeTerminal.all).toHaveLength(2);
    expect(screen().getByText("Abrindo o terminal…")).toBeTruthy();
  });

  test("a page kept for the Back button ends its shell: back, it says so, and only Abrir de novo opens one", async () => {
    const t = await panel();
    await server(() => {
      t.ws().open();
      t.ws().output("$ ");
    });
    const page = (type: "pagehide" | "pageshow", persisted: boolean) =>
      act(async () => void window.dispatchEvent(Object.assign(new Event(type), { persisted })));
    await page("pagehide", false);
    expect(t.ws().closed).toBe(false);

    await page("pagehide", true);
    expect(t.ws().closedWith).toBe(1000);
    await server(() => t.ws().serverClose(1000));
    await page("pageshow", true);
    await settle(4);
    expect(screen().getByText("A sessão terminou.")).toBeTruthy();
    expect(t.terminals).toHaveLength(1);
  });

  test("a dropped connection or a refusal says why and never opens again by itself", async () => {
    const t = await panel();
    await server(() => {
      t.ws().open();
      t.ws().output("$ ");
    });
    await server(() => t.ws().serverClose(1006));
    await settle(6);
    expect(screen().getByText("A conexão com o computador caiu.")).toBeTruthy();
    expect(t.terminals).toHaveLength(1);

    await click(screen().getByRole("button", { name: "Abrir de novo" }));
    await server(() => t.ws().serverClose(4502, "not_allowed"));
    expect(screen().getByText("O terminal não está disponível no computador da Ada.")).toBeTruthy();
    expect(screen().getByText(/Só quem está no computador liga/)).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Abrir de novo" })).toBeNull();
    cleanup();

    const other = await panel();
    await server(() => other.ws().serverClose(4403, "forbidden"));
    expect(screen().getByText("Você não pode abrir este terminal.")).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Abrir de novo" })).toBeNull();
  });

  test("on the agent's page only for who may run commands there as the agent; ?terminal=1 opens it", async () => {
    // A channel member who may watch the agent's desktop, not use its computer: nothing, even when asked.
    const member = backend({ terminal: { available: true, reason: null, allowed: false } });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?terminal=1`, { api: member.api, createSocket: member.factory });
    await settle(8);
    expect(screen().queryByRole("button", { name: "Abrir o terminal" })).toBeNull();
    expect(screen().queryByRole("group", { name: "Terminal da Ada" })).toBeNull();
    expect(member.terminals).toHaveLength(0);
    cleanup();

    const owner = backend();
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}`, { api: owner.api, createSocket: owner.factory });
    await settle(8);
    expect(screen().getByText("Comandos no computador da Ada, como a Ada")).toBeTruthy();
    expect(owner.terminals).toHaveLength(0);
    await click(screen().getByRole("button", { name: "Abrir o terminal" }));
    expect(screen().getByRole("group", { name: "Terminal da Ada" })).toBeTruthy();
    expect(owner.terminals).toHaveLength(1);
    await click(screen().getByRole("button", { name: "Fechar o terminal" }));
    expect(owner.terminals[0]?.closed).toBe(true);
    expect(FakeTerminal.all.at(-1)?.disposed).toBe(true);
    expect(screen().getByRole("button", { name: "Abrir o terminal" })).toBeTruthy();
    cleanup();

    const asked = backend();
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?terminal=1`, { api: asked.api, createSocket: asked.factory });
    await settle(8);
    expect(screen().getByRole("group", { name: "Terminal da Ada" })).toBeTruthy();
    expect(asked.terminals).toHaveLength(1);
  });
});
