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

  test("outside the app: the download, and nothing asks the Mac", async () => {
    const api = createFakeApi(seedState());
    await renderApp(`/org/${ORG_ID}/settings/computers`, { api });
    await settle(8);
    expect(screen().queryByRole("button", { name: "Usar este Mac" })).toBeNull();
  });
});
