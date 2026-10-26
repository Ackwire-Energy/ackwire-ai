import { afterAll, beforeAll, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppProvider } from "../src/app";
import { DesktopStore } from "../src/control/store";
import { createFakeHost } from "../src/host/fake";
import { createDesktopI18n } from "../src/i18n";
import { ToastProvider } from "../src/ui/Toast";
import { Popover } from "../src/windows/Popover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The menu checks agentes.chat for a desktop update: tests stay off the network, so no release yet. And
// intersections come by hand (happy-dom reports none), to the observer watching inside a given root.
const realFetch = globalThis.fetch;
const realObserver = globalThis.IntersectionObserver;
const observers: { root: unknown; callback: IntersectionObserverCallback }[] = [];
beforeAll(() => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      observers.push({ root: options?.root, callback });
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  globalThis.IntersectionObserver = realObserver;
});

/** The menu with agentes.chat on this Mac, a folder request and two jobs: taller than the menu gets. */
async function withMenu(check: (el: HTMLElement) => unknown) {
  const host = createFakeHost("popover", "here");
  const store = new DesktopStore(host, {});
  const stop = store.start();
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  try {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={createDesktopI18n("en", host.platform)}>
          <AppProvider host={host} store={store}>
            <ToastProvider>
              <Popover />
            </ToastProvider>
          </AppProvider>
        </I18nextProvider>,
      );
    });
    for (let i = 0; i < 100 && !el.querySelector(".dk-req"); i++) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    }
    await check(el);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
    for (const runner of host.runners.values()) runner.stop();
  }
}

test("the menu bar menu: what goes on here scrolls, and Open, Preferences and Quit stay below it", () =>
  withMenu((el) => {
    const body = el.querySelector(".dk-pop__body");
    const foot = el.querySelector(".dk-pop__foot");
    expect(body?.querySelector(".dk-req")).toBeTruthy();
    expect(body?.querySelector(".dk-job")).toBeTruthy();
    expect(body?.querySelector("button.dk-mi")).toBeNull();
    const actions = [...(foot?.querySelectorAll("button.dk-mi") ?? [])].map((b) => b.textContent ?? "");
    for (const label of ["Open agentes.chat", "Preferences…", "Quit agentes.chat"]) {
      expect(actions.some((text) => text.includes(label))).toBe(true);
    }
  }));

test("on a short screen the card's cap is lower, so the window and the actions at its bottom stay on it", async () => {
  const screen = window.screen as { availHeight: number };
  const height = screen.availHeight;
  screen.availHeight = 640;
  try {
    await withMenu((el) => {
      // 640 less the window's margins around the card (6 above, 34 below).
      const shell = el.querySelector<HTMLElement>(".dk-pop-shell");
      expect(shell?.style.getPropertyValue("--pop-room")).toBe("600px");
    });
  } finally {
    screen.availHeight = height;
  }
});

test("the middle fades out at the bottom while its end is out of sight, by the latest crossing", () =>
  withMenu(async (el) => {
    const body = el.querySelector(".dk-pop__body");
    const watcher = observers.findLast((o) => o.root === body);
    expect(watcher).toBeDefined();
    const cross = (...seen: boolean[]) =>
      act(async () => watcher?.callback(seen.map((isIntersecting) => ({ isIntersecting })) as never, {} as never));
    await cross(true, false);
    expect(body?.hasAttribute("data-more")).toBe(true);
    await cross(false, true);
    expect(body?.hasAttribute("data-more")).toBe(false);
  }));
