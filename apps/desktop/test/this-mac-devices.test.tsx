import { describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppProvider, useSnapshot } from "../src/app";
import { IPHONE_SETUP_PREF } from "../src/control/devices";
import { DesktopStore, pairedHomes } from "../src/control/store";
import { readPref, writePref } from "../src/hooks";
import { createFakeHost, type FakeHost } from "../src/host/fake";
import { createDesktopI18n } from "../src/i18n";
import { ToastProvider } from "../src/ui/Toast";
import { WindowView } from "../src/WindowView";
import { ThisMacCards } from "../src/windows/prefs/ThisMac";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function until(ready: () => unknown) {
  for (let i = 0; i < 200 && !ready(); i++) await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(Boolean(ready())).toBe(true);
}

async function mount(
  window: "prefs" | "welcome",
  view: ReactNode,
  check: (el: HTMLElement, host: FakeHost) => Promise<void>,
) {
  const host = createFakeHost(window, "selfhost");
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
    await check(el, host);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
    for (const runner of host.runners.values()) runner.stop();
  }
}

/** The first workspace's cards alone (the fake has two). */
function OneWorkspace() {
  const homes = pairedHomes(useSnapshot()).slice(0, 1);
  return homes.length ? <ThisMacCards homes={homes} /> : null;
}

const rowOf = (el: HTMLElement, title: string) =>
  [...el.querySelectorAll<HTMLElement>(".dk-crow")].find(
    (r) => r.querySelector(".dk-crow__title")?.textContent === title,
  );
const button = (root: ParentNode | undefined, text: string) =>
  [...(root?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === text);

describe("Preferences › This Mac", () => {
  test("agents, commands as this user, who can use it, and each phone with its state and one way out", () =>
    mount("prefs", <OneWorkspace />, async (el, host) => {
      await until(() => rowOf(el, "Pixel 8") && rowOf(el, "Who can use it")?.querySelector('[role="combobox"]'));
      expect(rowOf(el, "Let agents use this Mac")?.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(document.getElementById("mac-commands-hint")?.textContent).toContain("They run as sam");
      expect(rowOf(el, "Who can use it")?.querySelector('[role="combobox"]')?.textContent).toBe("Only me");

      const pixel = rowOf(el, "Pixel 8");
      expect(pixel?.querySelector(".ac-chip")?.textContent).toBe("In use by Ada");
      expect(pixel?.querySelector("small")?.textContent).toMatch(/^for Rui since .+ · Everyone can use it$/);
      const iphone = rowOf(el, "Sam's iPhone 16");
      expect(iphone?.querySelector(".ac-chip")?.textContent).toBe("Needs you");
      expect(iphone?.querySelector("small")?.textContent).toBe("Developer Mode is off");

      // Stop: the web's own stop, on this computer's server; the phone is free once the list comes back.
      await act(async () => button(pixel, "Stop")?.click());
      await until(() => rowOf(el, "Pixel 8")?.querySelector(".ac-chip")?.textContent === "Ready");
      expect(host.site.calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
        "/api/app/organizations/org_acme/devices/phones/0b6c5a8e-0000-4000-8000-000000000001/stop",
      ]);

      // Show me how on the iPhone: the setup, in the welcome window.
      await act(async () => button(rowOf(el, "Sam's iPhone 16"), "Show me how")?.click());
      expect(readPref(IPHONE_SETUP_PREF, false)).toBe(true);
      expect(host.window).toBe("welcome");
      writePref(IPHONE_SETUP_PREF, false);
    }));

  test("signed out on that server: says so, with the way to sign in", () =>
    mount("prefs", <OneWorkspace />, async (el, host) => {
      host.site.signedOut = true;
      await until(() => rowOf(el, "Who can use it")?.querySelector("small"));
      expect(rowOf(el, "Who can use it")?.querySelector("small")?.textContent).toBe(
        "Sign in to agentes.tail1234.ts.net in the app to see who can use this Mac.",
      );
      expect(button(rowOf(el, "Who can use it"), "Open")).toBeTruthy();
    }));
});

describe("the iPhone setup window", () => {
  test("Preferences' Show me how opens it in the welcome window; the Mac downloads what Xcode needs by itself", async () => {
    writePref(IPHONE_SETUP_PREF, true);
    await mount("welcome", <WindowView name="welcome" />, async (el, host) => {
      await until(() => el.querySelector('[data-screen="iphone"]') && el.querySelector('[aria-current="step"]'));
      expect(readPref(IPHONE_SETUP_PREF, true)).toBe(false);
      // Asked again while it shows: taken at once, so the next welcome window is the first run again.
      writePref(IPHONE_SETUP_PREF, true);
      await act(() => host.showWindow("welcome"));
      expect(readPref(IPHONE_SETUP_PREF, true)).toBe(false);
      expect(el.querySelector("h1")?.textContent).toBe("Connect an iPhone");
      // Xcode is there, the iOS platform isn't: it starts downloading and reaches the iPhone's own step.
      await until(() => el.querySelector('[aria-current="step"] b')?.textContent === "Turn on Developer Mode");
      const steps = [...el.querySelectorAll(".dk-fr__steps > li")].map((li) => [
        li.querySelector("b")?.textContent,
        li.getAttribute("data-state"),
      ]);
      expect(steps).toEqual([
        ["Xcode", "done"],
        ["iPhone tools", "done"],
        ["Apple Account in Xcode", "done"],
        ["iPhone connected", "done"],
        ["Turn on Developer Mode", "warn"],
        ["Turn on UI Automation", "todo"],
        ["Test helper", "todo"],
      ]);
      expect(el.querySelector('[aria-current="step"] .ac-setpath')?.textContent).toBe(
        "SettingsPrivacy & SecurityDeveloper Mode",
      );
      expect(el.textContent).toContain("Sam Rivera · Personal Team");
      expect(
        el.querySelector('svg[role="img"][aria-label="QR code that opens these steps on the iPhone"]'),
      ).toBeTruthy();
      expect(button(el, "Back")).toBeTruthy();
      expect(button(el, "Cancel")).toBeTruthy();

      // The helper built, but the iPhone doesn't trust its developer yet: where on the iPhone to trust it.
      for (const runner of host.runners.values())
        runner.setPhones(runner.phones.map((p) => (p.platform === "ios" ? { ...p, reason: "helper_untrusted" } : p)));
      await until(() => el.querySelector('[aria-current="step"] b')?.textContent === "Test helper");
      expect(el.querySelector('[aria-current="step"]')?.textContent).toContain("Tap the developer's name, then Trust.");
      expect(el.querySelector('[aria-current="step"] .ac-setpath')?.textContent).toBe(
        "SettingsGeneralVPN & Device Management",
      );
    });
  });

  test("without the ask, the welcome window is the first run", () =>
    mount("welcome", <WindowView name="welcome" />, async (el) => {
      await until(() => el.querySelector(".dk-fr"));
      expect(el.querySelector('[data-screen="iphone"]')).toBeNull();
    }));
});
