import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentBrowserSettings, BrowserHandoff } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { isBlankPage, openRefusalKey } from "@/components/browser/sites";
import { agentSearch } from "@/lib/agent-edit";
import { ADA_ID, createFakeApi, fakeBrowserOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const READY: AgentBrowserSettings = {
  allowedDomains: null,
  available: true,
  reason: null,
  detail: null,
  machine: { id: "machine-1", name: "MacBook do Walter" },
};
/** A JPEG's first bytes (SOI + a start-of-frame for 1280×800): enough for the page's size. */
const FRAME_DATA = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 3, 32, 5, 0, 3, 0, 0, 0));
const frame = (url = "https://loja.example.com/carrinho") => ({
  type: "browser.frame",
  agentId: ADA_ID,
  seq: 1,
  data: FRAME_DATA,
  metadata: { deviceWidth: 1280, deviceHeight: 800, url },
});

/** Ada may use its browser, on a computer that serves it; `as`: who I am to Ada. */
function setup(options: { as?: "admin" | "owner" | "member"; sites?: string[] | null } = {}) {
  const state = seedState();
  if (options.as === "owner" || options.as === "member") {
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  }
  if (options.as === "owner") {
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.ownerUserId = "u-walter";
  }
  state.scopes[ADA_ID] = [...(state.scopes[ADA_ID] ?? []), { connectionId: null, scope: "browser:use" }];
  const api = createFakeApi(state);
  const browser = fakeBrowserOf.get(api);
  if (!browser) throw new Error("no fake browser");
  browser.settings.set(ADA_ID, { ...READY, allowedDomains: options.sites ?? null });
  return { state, api, browser };
}

async function open(path: string, s: ReturnType<typeof setup>) {
  const r = await renderApp(path, { api: s.api });
  await settle(8);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  const push = async (message: Record<string, unknown>) => {
    await act(async () => socket.push(message));
    await settle(2);
  };
  return { ...r, socket, push };
}

const calls = (s: ReturnType<typeof setup>, method: string) =>
  s.state.calls.filter((c) => c.method === method).map((c) => c.args);
const block = () => screen().queryByRole("region", { name: "Navegador da Ada" });
const card = () => document.querySelector(".brw-ac") as HTMLElement;
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};

/** The DM with Ada, its header's Navegador opened. */
async function dialogOf(s: ReturnType<typeof setup>) {
  const r = await open(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, s);
  await click(screen().getByRole("button", { name: /^Navegador/ }));
  const dialog = screen().getByRole("dialog", { name: "Navegador da Ada" });
  return { ...r, dialog };
}

describe("the agent's browser outside a conversation", () => {
  test("its owner and admins get Navegador on the agent's page and in its DM header; a member doesn't", async () => {
    const admin = setup();
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, admin);
    const row = block() as HTMLElement;
    // Nothing going on: where it runs, no picture (watching would keep an idle browser open).
    expect(row.textContent).toContain("Pronto no MacBook do Walter");
    expect(row.querySelector("img")).toBeNull();
    expect(within(row).getByRole("button", { name: "Abrir o navegador" })).toBeTruthy();
    cleanup();

    const owner = setup({ as: "owner" });
    await open(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, owner);
    expect(screen().getByRole("button", { name: /^Navegador/ })).toBeTruthy();
    cleanup();

    const member = setup({ as: "member" });
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, member);
    expect(block()).toBeNull();
    cleanup();
    await open(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, member);
    expect(screen().queryByRole("button", { name: /^Navegador/ })).toBeNull();
    expect(calls(member, "browser.settings")).toEqual([]);
  });

  test("a browser that can't run (no computer serving it) shows nothing", async () => {
    const s = setup();
    s.browser.settings.set(ADA_ID, { ...READY, available: false, reason: "switched_off" });
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, s);
    expect(block()).toBeNull();
  });

  test("Abrir o navegador takes over with no run; closed, it says so calmly and the address bar opens a site", async () => {
    const s = setup({ sites: ["loja.example.com"] });
    const { push } = await open(`/org/${ORG_ID}/agents/${ADA_ID}`, s);
    await click(within(block() as HTMLElement).getByRole("button", { name: "Abrir o navegador" }));
    expect(calls(s, "browser.takeover")).toEqual([[ORG_ID, ADA_ID]]);
    expect(card().classList.contains("is-control")).toBe(true);
    expect(card().classList.contains("is-open")).toBe(true);

    // The runner says the browser isn't open: no spinner, no "opening", the address bar instead.
    await push({ type: "browser.unavailable", agentId: ADA_ID, reason: "closed" });
    expect(card().textContent).toContain("O navegador da Ada está fechado");
    expect(card().textContent).toContain("Digite um endereço acima para abrir um site.");
    expect(card().textContent).not.toContain("Abrindo o navegador");
    expect(card().querySelector(".ac-pixspin, .brw-skel")).toBeNull();
    // A retry's status doesn't flash "opening" in between: only a frame ends "closed".
    await push({
      type: "browser.status",
      agentId: ADA_ID,
      mode: "control",
      controllerUserId: "u-walter",
      handoff: null,
      hidden: false,
    });
    expect(card().textContent).toContain("O navegador da Ada está fechado");

    // Outside the agent's sites: said under the field, nothing opens.
    const address = within(card()).getByRole("textbox", { name: "Endereço do site" });
    await act(async () => fireEvent.change(address, { target: { value: "outro.com" } }));
    await click(within(card()).getByRole("button", { name: "Abrir" }));
    expect(within(card()).getByRole("alert").textContent).toBe("Fora dos sites que a Ada pode abrir.");

    await act(async () => fireEvent.change(address, { target: { value: "loja.example.com" } }));
    await click(within(card()).getByRole("button", { name: "Abrir" }));
    expect(calls(s, "browser.open").at(-1)).toEqual([ORG_ID, ADA_ID, "loja.example.com"]);
    expect(card().textContent).toContain("Abrindo loja.example.com…");
    // The page arrives: the card shows it, the address bar folds away.
    await push(frame("https://loja.example.com/"));
    expect(card().querySelector(".brw-ac__page img")).toBeTruthy();
    expect(within(card()).queryByRole("textbox", { name: "Endereço do site" })).toBeNull();
  });

  test("a request waiting for someone: an amber row with Abrir, which takes control here", async () => {
    const s = setup();
    const handoff: BrowserHandoff = {
      id: "h-ask",
      agentId: ADA_ID,
      runId: "r-ask",
      machineId: "machine-1",
      kind: "ask",
      instructions: "Entrar no Stripe",
      status: "pending",
      requestedForUserId: "u-walter",
      controllerUserId: null,
      note: null,
      expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    s.browser.handoffs.set(handoff.id, handoff);
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, s);
    const row = (block() as HTMLElement).querySelector('[data-tone="warn"]') as HTMLElement;
    expect(row.textContent).toContain("Ada precisa de você");
    expect(row.textContent).toContain("Entrar no Stripe · 8 min");
    await click(within(row).getByRole("button", { name: "Abrir" }));
    expect(calls(s, "browser.takeControl")).toEqual([[ORG_ID, "h-ask"]]);
    // In control of the request: it's the card's title, Pronto hands back.
    expect(card().classList.contains("is-control")).toBe(true);
    expect(card().querySelector(".brw-ac__tx b")?.textContent).toBe("Entrar no Stripe");
    expect(within(card()).getByRole("button", { name: "Pronto" })).toBeTruthy();
  });

  test("someone else in control: who and what for, with nothing to watch (their screen stays theirs)", async () => {
    const s = setup();
    s.browser.handoffs.set("h-joao", {
      id: "h-joao",
      agentId: ADA_ID,
      runId: null,
      machineId: "machine-1",
      kind: "takeover",
      instructions: "",
      status: "active",
      requestedForUserId: null,
      controllerUserId: "u-joao",
      note: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    await open(`/org/${ORG_ID}/agents/${ADA_ID}`, s);
    const row = block() as HTMLElement;
    expect(row.textContent).toContain("João está no controle");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  test("?browser=1 (the tray's link) opens the view on the agent's page", async () => {
    const s = setup();
    const r = await open(`/org/${ORG_ID}/agents/${ADA_ID}?browser=1`, s);
    expect(card().classList.contains("is-open")).toBe(true);
    // Used once: the link doesn't reopen it on a reload.
    expect((r.router.state.location.search as Record<string, unknown>).browser).toBeUndefined();
    // Folding it brings the line back.
    await click(within(card()).getByRole("button", { name: "Recolher" }));
    expect(document.querySelector(".brw-ac")).toBeNull();
    expect((block() as HTMLElement).textContent).toContain("Pronto no MacBook do Walter");
  });
});

describe("the DM header's Navegador", () => {
  test("opens the live view in a dialog; Assumir takes over with no run; closing it in control hands back", async () => {
    const s = setup();
    const { dialog, push } = await dialogOf(s);
    await push(frame());
    const view = within(dialog);
    expect(card().querySelector(".brw-ac__page img")).toBeTruthy();
    // Always open in its dialog: nothing to fold.
    expect(view.queryByRole("button", { name: "Recolher" })).toBeNull();
    await click(view.getByRole("button", { name: "Assumir" }));
    expect(calls(s, "browser.takeover")).toEqual([[ORG_ID, ADA_ID]]);
    expect(card().classList.contains("is-control")).toBe(true);

    // In control, Esc belongs to the page: the dialog stays.
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Navegador da Ada" })).toBeTruthy();
    expect(calls(s, "browser.done")).toEqual([]);

    // Closing hands the browser back now, not after the 2-minute grace.
    await click(view.getByRole("button", { name: "Fechar" }));
    expect(calls(s, "browser.done")).toEqual([[ORG_ID, "takeover-1"]]);
    expect(screen().queryByRole("dialog", { name: "Navegador da Ada" })).toBeNull();
    expect(document.body.textContent).toContain("Devolvido à Ada.");
  });

  test("closing it while in control of the agent's own request doesn't answer it: only Pronto or Desistir do", async () => {
    const s = setup();
    s.browser.handoffs.set("h-ask", {
      id: "h-ask",
      agentId: ADA_ID,
      runId: "r-ask",
      machineId: "machine-1",
      kind: "ask",
      instructions: "Entrar no Stripe",
      status: "pending",
      requestedForUserId: "u-walter",
      controllerUserId: null,
      note: null,
      expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    const { dialog } = await dialogOf(s);
    const view = within(dialog);
    await click(view.getByRole("button", { name: "Abrir" }));
    expect(calls(s, "browser.takeControl")).toEqual([[ORG_ID, "h-ask"]]);
    // In control: Esc belongs to the page.
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Navegador da Ada" })).toBeTruthy();

    await click(view.getByRole("button", { name: "Fechar" }));
    expect(screen().queryByRole("dialog", { name: "Navegador da Ada" })).toBeNull();
    expect(calls(s, "browser.done")).toEqual([]);
    expect(s.browser.handoffs.get("h-ask")?.status).toBe("active");
  });

  test("Parar says so, opens the browser again from the dialog, and gives way to the page when it's back", async () => {
    const s = setup();
    const { dialog, push } = await dialogOf(s);
    await push(frame());
    const view = within(dialog);
    await click(view.getByRole("button", { name: "Parar" }));
    await click(view.getByRole("button", { name: "Parar" }));
    expect(calls(s, "browser.stop")).toEqual([[ORG_ID, ADA_ID]]);
    expect(card().textContent).toContain("Navegador parado");
    expect(view.getByRole("button", { name: "Abrir o navegador" })).toBeTruthy();

    // The agent opens it again: the page shows, not the stop.
    await push(frame("https://loja.example.com/novo"));
    expect(card().textContent).not.toContain("Navegador parado");
    expect(card().querySelector(".brw-ac__page img")).toBeTruthy();
  });

  test("Abrir o navegador after Parar takes over right there", async () => {
    const s = setup();
    const { dialog, push } = await dialogOf(s);
    await push(frame());
    const view = within(dialog);
    await click(view.getByRole("button", { name: "Parar" }));
    await click(view.getByRole("button", { name: "Parar" }));
    await click(view.getByRole("button", { name: "Abrir o navegador" }));
    expect(calls(s, "browser.takeover")).toEqual([[ORG_ID, ADA_ID]]);
    expect(card().textContent).not.toContain("Navegador parado");
    expect(card().classList.contains("is-control")).toBe(true);
  });

  test("full screen opens while watching and Esc leaves it, keeping the dialog", async () => {
    const s = setup();
    const { dialog, push } = await dialogOf(s);
    await push(frame());
    await click(within(dialog).getByRole("button", { name: "Tela cheia" }));
    expect(card().classList.contains("is-full")).toBe(true);
    // Watching: no control was taken.
    expect(calls(s, "browser.takeover")).toEqual([]);
    expect(within(card()).getByRole("button", { name: "Assumir" })).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await settle(2);
    expect(card().classList.contains("is-full")).toBe(false);
    expect(screen().queryByRole("dialog", { name: "Navegador da Ada" })).toBeTruthy();
  });

  test("someone else in control: the page is hidden from me, and who has it is said", async () => {
    const s = setup();
    const { push } = await dialogOf(s);
    await push(frame());
    const held: BrowserHandoff = {
      id: "h-joao",
      agentId: ADA_ID,
      runId: null,
      machineId: "machine-1",
      kind: "takeover",
      instructions: "",
      status: "active",
      requestedForUserId: null,
      controllerUserId: "u-joao",
      note: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    await push({
      type: "browser.status",
      agentId: ADA_ID,
      mode: "control",
      controllerUserId: "u-joao",
      handoff: held,
      hidden: true,
    });
    expect(card().querySelector("img")).toBeNull();
    expect(card().textContent).toContain("João está no controle");
    expect(card().textContent).toContain("Por privacidade, a tela fica oculta até voltar para a Ada.");
    expect(card().textContent).toContain("João no controle · tela oculta");
    expect(within(card()).queryByRole("button", { name: "Assumir" })).toBeNull();
  });
});

describe("browser helpers", () => {
  test("the search param, blank pages and what a refused open says", () => {
    expect(agentSearch({ browser: 1 })).toEqual({ tab: undefined, sec: undefined, browser: 1 });
    expect(agentSearch({ browser: "1", tab: "memory" })).toMatchObject({ tab: "memory", browser: 1 });
    expect(agentSearch({ browser: "yes" })).not.toHaveProperty("browser");
    expect(isBlankPage("about:blank")).toBe(true);
    expect(isBlankPage("https://loja.example.com/")).toBe(false);
    expect(isBlankPage(undefined)).toBe(false);
    expect(openRefusalKey("browser.not_allowed")).toBe("browser.inCard.goNotAllowed");
    expect(openRefusalKey("browser.bad_address")).toBe("browser.inCard.goBadAddress");
    expect(openRefusalKey("machine.timeout")).toBe("browser.live.actionFailed");
  });
});
