import { expect, test } from "bun:test";
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

test("the menu bar menu: what goes on here scrolls, and Open, Preferences and Quit stay below it", async () => {
  // agentes.chat on this Mac, a folder request and two jobs: taller than the menu gets.
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
    const body = el.querySelector(".dk-pop__body");
    const foot = el.querySelector(".dk-pop__foot");
    expect(body?.querySelector(".dk-req")).toBeTruthy();
    expect(body?.querySelector(".dk-job")).toBeTruthy();
    expect(body?.querySelector("button.dk-mi")).toBeNull();
    const actions = [...(foot?.querySelectorAll("button.dk-mi") ?? [])].map((b) => b.textContent ?? "");
    for (const label of ["Open agentes.chat", "Preferences…", "Quit agentes.chat"]) {
      expect(actions.some((text) => text.includes(label))).toBe(true);
    }
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
    for (const runner of host.runners.values()) runner.stop();
  }
});
