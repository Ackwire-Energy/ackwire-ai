import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { ThisMacStatus } from "@/lib/desktop";
import { createFakeApi, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * agentes for Mac (D79): the site in the app's window connects this Mac in one
 * click (the app hands over the runner's code, the site confirms it) and opens
 * the app's Preferences for what is granted on the Mac itself.
 */

const win = window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown };
afterEach(() => {
  cleanup();
  delete win.__agentesDesktop;
  delete win.__TAURI_INTERNALS__;
});

/** The app around the site: answers `this_mac` from `mac`, records every request. */
function inTheApp(mac: { status: ThisMacStatus; code: string | null }) {
  const asked: Record<string, unknown>[] = [];
  win.__agentesDesktop = { version: "0.6.0" };
  win.__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: { request: Record<string, unknown> }) => {
      if (cmd !== "this_mac") throw new Error(`unexpected ${cmd}`);
      asked.push(args.request);
      if (args.request.kind === "status") return mac.status;
      if (args.request.kind === "connect") return { userCode: mac.code };
      return {};
    },
  };
  return asked;
}

describe("Configurações → Computadores, in the app", () => {
  test("“Usar este Mac”: one click, the site confirms the runner's code", async () => {
    const mac = { status: { orgs: [] } as ThisMacStatus, code: "WXYZ-1234" };
    const asked = inTheApp(mac);
    const state = seedState();
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.addDevice("WXYZ-1234");
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    const card = screen().getByRole("region", { name: "Conectar um computador" });
    expect(within(card).queryByRole("link", { name: "Baixar o app para Mac" })).toBeNull();

    // The runner picks its token up right after the site confirms.
    const connected: ThisMacStatus = { orgs: [{ orgId: ORG_ID, machineId: "m-this", connection: "online" }] };
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Usar este Mac" }));
      mac.status = connected;
    });
    await settle(8);
    expect(asked).toContainEqual({ kind: "connect", orgId: ORG_ID });
    expect(state.calls.find((c) => c.method === "machines.confirmDevice")?.args.slice(0, 2)).toEqual([
      ORG_ID,
      "WXYZ-1234",
    ]);

    // This Mac is in the organization now: the button opens its folders.
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Pastas deste Mac" })));
    expect(asked).toContainEqual({ kind: "prefs", tab: "folders" });
  });

  test("this Mac's page: allowing folders and turning the browser on open the app's Preferences", async () => {
    const mac = { status: { orgs: [] } as ThisMacStatus, code: null };
    const asked = inTheApp(mac);
    const api = createFakeApi(seedState());
    const machines = fakeMachinesOf.get(api) as NonNullable<ReturnType<typeof fakeMachinesOf.get>>;
    const m = machines.pair({
      name: "MacBook do Walter",
      os: "darwin",
      access: { folders: [], tools: { claude: true, codex: false, commands: false } },
    });
    mac.status = { orgs: [{ orgId: ORG_ID, machineId: m.id, connection: "online" }] };
    await renderApp(`/org/${ORG_ID}/settings/computers/${m.id}`, { api });
    await settle(8);
    expect(screen().queryByText(/Liberar é no próprio computador/)).toBeNull();
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Abrir Pastas" })));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Abrir Ferramentas" })));
    expect(asked).toContainEqual({ kind: "prefs", tab: "folders" });
    expect(asked).toContainEqual({ kind: "prefs", tab: "tools" });
  });

  test("another computer's page, in the app: the usual words", async () => {
    const mac = { status: { orgs: [{ orgId: ORG_ID, machineId: "m-this", connection: "online" }] }, code: null };
    inTheApp(mac);
    const api = createFakeApi(seedState());
    const m = fakeMachinesOf.get(api)?.pair({
      name: "Servidor",
      access: { folders: [], tools: { claude: true, codex: false, commands: false } },
    });
    await renderApp(`/org/${ORG_ID}/settings/computers/${m?.id}`, { api });
    await settle(8);
    expect(screen().getByText(/Liberar é no próprio computador/)).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Abrir Pastas" })).toBeNull();
  });

  test("outside the app: the download, and nothing asks the Mac", async () => {
    const api = createFakeApi(seedState());
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    expect(screen().queryByRole("button", { name: "Usar este Mac" })).toBeNull();
  });
});
