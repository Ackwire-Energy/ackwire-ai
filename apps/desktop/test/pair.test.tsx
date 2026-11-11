import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { CLOUD_SERVER } from "@agenteschat/client/lib/server";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppProvider } from "../src/app";
import {
  nextOffer,
  PAIR_OFFER_PREF,
  PAIR_OFFERED_PREF,
  type PairTarget,
  parsePairLink,
  unpairedWorkspaces,
} from "../src/control/pair";
import type { ServerWorkspaces } from "../src/control/server";
import { DesktopStore, pairedHomes, type Snapshot } from "../src/control/store";
import { FAKE_LINKS, FAKE_SERVER } from "../src/dev/fake-runner";
import { readPref, writePref } from "../src/hooks";
import { createFakeHost, type FakeHost } from "../src/host/fake";
import { createDesktopI18n } from "../src/i18n";
import { ToastProvider } from "../src/ui/Toast";
import { WindowView } from "../src/WindowView";
import { General } from "../src/windows/prefs/General";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function until(ready: () => unknown) {
  for (let i = 0; i < 250 && !ready(); i++) await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(Boolean(ready())).toBe(true);
}

async function mount(
  window: "prefs" | "welcome",
  view: ReactNode,
  check: (el: HTMLElement, host: FakeHost, store: DesktopStore) => Promise<void>,
  link?: string,
) {
  const host = createFakeHost(window, "selfhost", { link });
  await host.setAutostart(false);
  const store = new DesktopStore(host, {});
  const stop = store.start();
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  try {
    await act(async () =>
      root.render(
        <I18nextProvider i18n={createDesktopI18n("en", host.platform)}>
          <AppProvider host={host} store={store}>
            <ToastProvider>{view}</ToastProvider>
          </AppProvider>
        </I18nextProvider>,
      ),
    );
    await check(el, host, store);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
    for (const runner of host.runners.values()) runner.stop();
  }
}

afterEach(() => {
  writePref(PAIR_OFFER_PREF, null);
  writePref(PAIR_OFFERED_PREF, []);
});

const button = (root: ParentNode | undefined, text: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === text);
const rowOf = (el: HTMLElement, title: string) =>
  [...el.querySelectorAll<HTMLElement>(".dk-crow")].find(
    (r) => r.querySelector(".dk-crow__title")?.textContent === title,
  );
const pairLink = (code: string) => `agenteschat://pair?server=${encodeURIComponent(FAKE_SERVER)}&link=${code}`;
const pairedWith = (store: DesktopStore, orgId: string) =>
  pairedHomes(store.getSnapshot()).some((h) => h.status?.org?.id === orgId);

describe("pairing from the app", () => {
  test("a pair link as Rust hands it over: the server and the stored code", () => {
    expect(parsePairLink(pairLink("ABCDEFGH"))).toEqual({ server: FAKE_SERVER, code: "ABCDEFGH" });
    expect(parsePairLink("agenteschat://pair/?link=abcd-efgh&server=https://app.agentes.chat")).toEqual({
      server: CLOUD_SERVER,
      code: "ABCDEFGH",
    });
    for (const bad of [
      "agenteschat://connect?server=https%3A%2F%2Fapp.agentes.chat",
      "agenteschat://pair?server=http%3A%2F%2Fagentes.example.com&link=ABCDEFGH",
      "agenteschat://pair?server=https%3A%2F%2Fapp.agentes.chat&link=ABCDEFG",
    ])
      expect(parsePairLink(bad)).toBeNull();
  });

  test("offered after sign-in: workspaces that may pair, where agents may work, not paired here yet, once each", () => {
    const list: ServerWorkspaces[] = [
      {
        server: FAKE_SERVER,
        signedIn: true,
        agentsHere: true,
        orgs: [
          { id: "org_acme", name: "Acme", logo: null, unread: 0, waiting: 0, pair: true },
          { id: "o-norte", name: "Estúdio Norte", logo: null, unread: 0, waiting: 0, pair: true },
          { id: "o-guest", name: "Guests", logo: null, unread: 0, waiting: 0, pair: false },
        ],
      },
      { server: CLOUD_SERVER, signedIn: false, agentsHere: true, orgs: [] },
      {
        server: "http://127.0.0.1:4310",
        signedIn: true,
        agentsHere: false,
        orgs: [{ id: "o-here", name: "Here", logo: null, unread: 0, waiting: 0, pair: true }],
      },
    ];
    const home = (orgId: string, running = true) => ({
      homeId: orgId,
      dir: "",
      running,
      hello: null,
      status: {
        paired: true,
        server: FAKE_SERVER,
        org: { id: orgId, name: orgId },
        connection: "online",
        paused: { paused: false },
      },
      jobs: [],
      requests: [],
      access: null,
      logo: null,
    });
    const snap = { loaded: true, homes: [home("org_acme")] } as unknown as Snapshot;
    expect(unpairedWorkspaces(list, snap).map((t) => t.orgId)).toEqual(["o-norte"]);
    // Offered right after signing in there: the read before had the server signed out.
    const signedOut = list.map((s) => ({ ...s, signedIn: false, orgs: [] }));
    expect(nextOffer(list, signedOut, snap, [])?.name).toBe("Estúdio Norte");
    expect(nextOffer(list, signedOut, snap, [`${FAKE_SERVER} o-norte`])).toBeNull();
    // The app's first read, and a read after one where it was already signed in (an unread count changed): nothing.
    expect(nextOffer(list, null, snap, [])).toBeNull();
    expect(nextOffer(list, list, snap, [])).toBeNull();
    // A home whose runner hasn't said yet whether it's paired: nothing offered until it has.
    const starting = { loaded: true, homes: [{ ...home("org_acme"), status: null }] } as unknown as Snapshot;
    expect(nextOffer(list, signedOut, starting, [])).toBeNull();
    expect(nextOffer(list, signedOut, { loaded: false, homes: [] }, [])).toBeNull();
  });

  test("the card after sign-in: Allow pairs with the window's session and turns on open at login", () => {
    const target: PairTarget = { server: FAKE_SERVER, orgId: "o-norte", name: "Estúdio Norte", logo: null };
    writePref(PAIR_OFFER_PREF, target);
    return mount("welcome", <WindowView name="welcome" />, async (el, host, store) => {
      await until(() => el.querySelector("h1")?.textContent === "Let Estúdio Norte's agents use this Mac?");
      expect(readPref(PAIR_OFFER_PREF, null)).toBeNull();
      expect(el.textContent).toContain("They start with no folders of yours and commands off.");
      expect(rowOf(el, "Who can use it")?.querySelector('[role="combobox"]')?.textContent).toBe("Only me");
      expect(rowOf(el, "Keep it ready: open agentes.chat at login")?.querySelector('[role="checkbox"]')).toBeTruthy();
      expect(button(el, "Not now")).toBeTruthy();
      expect(document.activeElement).not.toBe(button(el, "Allow"));

      await act(async () => button(el, "Allow")?.click());
      await until(() => el.querySelector("h1")?.textContent === "Connected to Estúdio Norte");
      expect(await host.autostart()).toBe(true);
      expect(host.site.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
        expect.stringMatching(/^\/api\/app\/organizations\/o-norte\/machines\/device\/[A-Z0-9]{6}\/confirm$/),
      ]);
      // Only me is the server's own default: nothing else is set.
      expect(host.site.calls.some((c) => c.method === "PATCH")).toBe(false);
      await until(() => pairedWith(store, "o-norte"));

      await act(async () => button(el, "Close")?.click());
      await until(() => el.querySelector('[data-screen="choose"]'));
    });
  });

  test("a pair link: who asked, from where, this computer; Connect waits for its maker, then it's in", () =>
    mount(
      "welcome",
      <WindowView name="welcome" />,
      async (el, host, store) => {
        await until(() => el.querySelector("h1")?.textContent === "Connect this Mac to Estúdio Norte?");
        expect(rowOf(el, "Asked by")?.textContent).toContain("Sam Rivera");
        expect(rowOf(el, "From")?.textContent).toContain("agentes.tail1234.ts.net");
        expect(rowOf(el, "This Mac")?.textContent).toContain("Sam's MacBook Pro");
        expect(el.textContent).toContain("If you didn't ask for this, choose Not now.");
        expect(document.activeElement).not.toBe(button(el, "Connect"));

        await act(async () => button(el, "Connect")?.click());
        await until(() => el.textContent?.includes("Waiting for Sam Rivera to let it in…"));
        expect(button(el, "Cancel")).toBeTruthy();
        await until(() => el.querySelector("h1")?.textContent === "Connected to Estúdio Norte");
        expect(await host.autostart()).toBe(true);
        await until(() => pairedWith(store, "o-norte"));
      },
      pairLink(FAKE_LINKS.live),
    ));

  test("a pair link cancelled while waiting: the runner stops asking and nothing joins", () =>
    mount(
      "welcome",
      <WindowView name="welcome" />,
      async (el, host, store) => {
        await until(() => button(el, "Connect"));
        await act(async () => button(el, "Connect")?.click());
        await act(async () => button(el, "Cancel")?.click());
        expect(el.textContent).not.toContain("Waiting for Sam Rivera");
        // Longer than the fake maker takes to let it in.
        await act(() => new Promise((resolve) => setTimeout(resolve, 2500)));
        expect(pairedWith(store, "o-norte")).toBe(false);
        expect([...host.runners.values()].some((r) => r.pendingCode)).toBe(false);
        expect(await host.autostart()).toBe(false);
      },
      pairLink(FAKE_LINKS.live),
    ));

  test("a pair link whose maker says no, and one that expired", async () => {
    await mount(
      "welcome",
      <WindowView name="welcome" />,
      async (el, host) => {
        await until(() => button(el, "Connect"));
        await act(async () => button(el, "Connect")?.click());
        await until(() => el.textContent?.includes("Sam Rivera didn't let it in. Nothing changed."));
        expect(button(el, "Close")).toBeTruthy();
        expect(button(el, "Try again")).toBeUndefined();
        // Open at login only comes with a computer that joined.
        expect(await host.autostart()).toBe(false);
      },
      pairLink(FAKE_LINKS.denied),
    );
    await mount(
      "welcome",
      <WindowView name="welcome" />,
      async (el, host) => {
        await until(() => el.textContent?.includes("This link expired. Make a new one under Settings › Devices."));
        expect(button(el, "Connect")).toBeUndefined();
        expect(host.runners.size).toBe(2);
        // Closed with a server open, the window hides; opened again ("Add a server…"), it starts over.
        await act(async () => button(el, "Close")?.click());
        await act(async () => host.showWindow("welcome"));
        await until(() => el.querySelector('[data-screen="choose"]'));
      },
      pairLink("WXYZWXYZ"),
    );
  });

  test("Preferences: a switch for every workspace signed in to; on for one not here yet pairs it", () =>
    mount("prefs", <General />, async (el, host, store) => {
      const norte = "Let Estúdio Norte's agents use this Mac";
      await until(() => rowOf(el, norte) && rowOf(el, "Let Acme's agents use this Mac")?.querySelector(".ac-chip"));
      const on = (title: string) => rowOf(el, title)?.querySelector('[role="switch"]')?.getAttribute("aria-checked");
      expect(on("Let Acme's agents use this Mac")).toBe("true");
      expect(on("Let Horizonte's agents use this Mac")).toBe("true");
      expect(rowOf(el, "Let Acme's agents use this Mac")?.querySelector("small")?.textContent).toBe(
        "Agents can use it",
      );
      expect(on(norte)).toBe("false");
      expect(rowOf(el, norte)?.querySelector("small")?.textContent).toBe("Its agents don't use this Mac");
      // agentes.chat's workspace too.
      expect(on("Let Oficina's agents use this Mac")).toBe("false");
      // Open at login closes the card.
      const card = rowOf(el, norte)?.closest(".dk-card");
      expect([...(card?.querySelectorAll(".dk-crow__title") ?? [])].at(-1)?.textContent).toBe("Open at login");

      // Pausing one workspace pauses only its own agents.
      await act(async () =>
        rowOf(el, "Let Horizonte's agents use this Mac")?.querySelector<HTMLElement>('[role="switch"]')?.click(),
      );
      await until(() => on("Let Horizonte's agents use this Mac") === "false");
      expect(on("Let Acme's agents use this Mac")).toBe("true");

      // One switch at a time: the others wait for the pause to answer.
      await until(() => !rowOf(el, norte)?.querySelector("[role=switch]")?.hasAttribute("disabled"));
      let asked = "";
      host.askToPair = async (_server, org) => {
        asked = org;
        return true;
      };
      await act(async () => rowOf(el, norte)?.querySelector<HTMLElement>('[role="switch"]')?.click());
      await until(() => pairedWith(store, "o-norte") && on(norte) === "true");
      expect(asked).toBe("Estúdio Norte");
      expect(await host.autostart()).toBe(true);
      expect(rowOf(el, norte)?.querySelector("small")?.textContent).toBe("Agents can use it");
    }));
});
