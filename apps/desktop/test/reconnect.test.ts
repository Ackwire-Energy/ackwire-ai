import { describe, expect, test } from "bun:test";
import type { ControlStatus } from "@agenteschat/adapters/runner-control";
import { type Home, isRefusedHome, reconnectTarget, type Snapshot } from "../src/control/store";
import { desktopEn } from "../src/i18n/keys.en";
import { desktopPtBR } from "../src/i18n/keys.pt-BR";

/** "Reconectar este Mac": which home the popover offers it for, and which one the connect window takes. */

const status = (over: Partial<ControlStatus> = {}): ControlStatus => ({
  paired: true,
  org: { id: "o1", name: "Acme" },
  connection: "online",
  version: "0.1.0",
  protocol: 10,
  paused: { paused: false },
  executors: {},
  agents: [],
  ...over,
});
const home = (homeId: string, st: ControlStatus | null): Home => ({
  homeId,
  dir: `/tmp/${homeId}`,
  running: true,
  hello: null,
  status: st,
  jobs: [],
  requests: [],
  access: null,
  logo: null,
});

describe("reconnect this Mac", () => {
  test("only a paired home the server refused offers it (not offline, outdated or unpaired)", () => {
    expect(isRefusedHome(home("a", status({ connection: "refused", refusedReason: "revoked" })))).toBe(true);
    expect(isRefusedHome(home("b", status({ connection: "offline" })))).toBe(false);
    expect(isRefusedHome(home("c", status({ connection: "outdated" })))).toBe(false);
    expect(isRefusedHome(home("d", status({ paired: false, connection: "refused" })))).toBe(false);
    expect(isRefusedHome(home("e", null))).toBe(false);
  });

  test("the connect window takes the home the pref names, while it is still paired", () => {
    const snap: Snapshot = {
      loaded: true,
      homes: [
        home("a", status({ connection: "refused" })),
        home("b", status({ paired: false, connection: "unpaired" })),
      ],
    };
    expect(reconnectTarget(snap, "a")?.homeId).toBe("a");
    expect(reconnectTarget(snap, "b")).toBeUndefined();
    expect(reconnectTarget(snap, "gone")).toBeUndefined();
    expect(reconnectTarget(snap, null)).toBeUndefined();
    expect(reconnectTarget(snap, 42)).toBeUndefined();
  });

  test("the banner speaks of coming back with the same agents", () => {
    expect(desktopPtBR.tray.reconnectMac).toBe("Reconectar este Mac");
    expect(desktopPtBR.tray.refusedBody).toBe("Reconecte para voltar com os mesmos agentes e permissões.");
    expect(desktopEn.tray.reconnectMac).toBe("Reconnect this Mac");
  });
});
