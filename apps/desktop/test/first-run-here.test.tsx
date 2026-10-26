import { describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AppProvider } from "../src/app";
import type { Tailnet } from "../src/control/local-server";
import { DesktopStore } from "../src/control/store";
import { createFakeHost, type FakeHost, type HereOptions, type Scenario } from "../src/host/fake";
import { type AppLocale, createDesktopI18n } from "../src/i18n";
import { ToastProvider } from "../src/ui/Toast";
import { FirstRun } from "../src/windows/FirstRun";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REACH_TEXT =
  "With Tailscale, a private network for your devices: your phone and the people you invite join it, and nobody else can reach agentes.chat.";
const USAGE_TEXT = "Counts such as people, agents, machine sizes and AI tokens used. Never messages, files or names.";

/** The first run on a fake host, with what it opened in the browser and in Tailscale; `host` changes the host first. */
async function firstRun(
  scenario: Scenario,
  check: (screen: ReturnType<typeof screenOf>) => Promise<void>,
  options: { here?: HereOptions; lang?: AppLocale; host?: (host: FakeHost) => void } = {},
) {
  const host = createFakeHost("welcome", scenario, { here: options.here });
  options.host?.(host);
  const opened: string[] = [];
  host.openExternal = async (url) => {
    opened.push(url);
  };
  const tailscale: string[] = [];
  host.openTailscale = async (page) => {
    tailscale.push(page);
  };
  // Nothing else answers on this computer, and at once (the fake host waits like a network would).
  host.checkServer = async (server) => ({ ok: false, server, problem: "unreachable" });
  const store = new DesktopStore(host, {});
  const stop = store.start();
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  try {
    await act(async () =>
      root.render(
        <I18nextProvider i18n={createDesktopI18n(options.lang ?? "en", host.platform)}>
          <AppProvider host={host} store={store}>
            <ToastProvider>
              <FirstRun />
            </ToastProvider>
          </AppProvider>
        </I18nextProvider>,
      ),
    );
    // Whether this build runs agentes.chat here arrives from the host first.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await check(screenOf(el, opened, tailscale));
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
    for (const runner of host.runners.values()) runner.stop();
  }
}

function screenOf(el: HTMLElement, opened: string[], tailscale: string[]) {
  const button = (name: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(name));
  return {
    el,
    opened,
    tailscale,
    button,
    press: async (name: string) => {
      const target = button(name);
      expect({ name, found: !!target }).toEqual({ name, found: true });
      await act(async () => target?.click());
    },
    until: async (ready: () => unknown) => {
      for (let i = 0; i < 100 && !ready(); i++) await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
      expect(Boolean(ready())).toBe(true);
    },
  };
}

/** Each switch row of the card: its label, its ⓘ, the hint that describes the switch, and the line under it. */
function switchRows(el: HTMLElement) {
  return [...el.querySelectorAll(".dk-card > .dk-crow")].map((row) => {
    const control = row.querySelector(':scope > .dk-crow__end > [role="switch"]');
    const info = row.querySelector("button.ac-hint");
    return {
      label: row.querySelector("label.dk-crow__title")?.textContent,
      about: info?.getAttribute("aria-label"),
      // The switch and its ⓘ read the same hint, while the bubble is closed too.
      hint: document.getElementById(control?.getAttribute("aria-describedby") ?? "")?.textContent,
      same: !!info && info.getAttribute("aria-describedby") === control?.getAttribute("aria-describedby"),
      line: row.querySelector(".dk-crow__text > small")?.textContent ?? null,
    };
  });
}

describe("Run agentes.chat on this Mac", () => {
  test("the title, one sentence, the two fields alone, two one-line switches with their ⓘ, and Start", () =>
    firstRun("first", async ({ el, press, until, button }) => {
      await press("Use your own server");
      await press("Run agentes.chat on this Mac");
      // Tailscale connected: the reach row has nothing under its label.
      await until(() => el.querySelector("form.dk-fr__here") && switchRows(el)[0]?.line === null);
      const form = el.querySelector("form.dk-fr__here") as HTMLElement;
      expect(el.querySelector("h1")?.textContent).toBe("Run agentes.chat on this Mac");
      const lead = el.querySelector(".dk-lead")?.textContent ?? "";
      expect(lead).toBe(
        "It runs inside this app, with its own database built in, and keeps everything in one folder on this Mac.",
      );
      expect(lead).not.toContain("Docker");
      // The two fields, the card of switches and Start: no notes under the card.
      expect([...form.children].map((c) => c.className)).toEqual(["dk-fr__who", "dk-card", "dk-fr__end"]);
      expect([...form.querySelectorAll(".ac-field label")].map((l) => l.textContent)).toEqual([
        "Your name",
        "Your email",
      ]);
      expect(form.querySelector(".ac-field__label-row")).toBeNull();
      expect(el.textContent).not.toContain("Your team sees it");
      expect(switchRows(el)).toEqual([
        {
          label: "Reach it from your phone and teammates",
          about: "About Reach it from your phone and teammates",
          hint: REACH_TEXT,
          same: true,
          line: null,
        },
        {
          label: "Send anonymous usage statistics to agentes.chat",
          about: "About Send anonymous usage statistics to agentes.chat",
          hint: USAGE_TEXT,
          same: true,
          line: null,
        },
      ]);
      expect(el.textContent).not.toContain("Your agents work here too");
      expect(el.textContent).not.toContain("Made for you or a small team");
      expect(button("Start agentes.chat")?.getAttribute("type")).toBe("submit");
    }));

  test("having run here before: where its data is, as the one sentence, and no fields", () =>
    firstRun(
      "here",
      async ({ el, press, until }) => {
        await press("Use your own server");
        await press("Run agentes.chat on this Mac");
        await until(() => el.querySelector("form.dk-fr__here"));
        expect(el.querySelector(".dk-lead")?.textContent).toBe(
          "It ran here before, and its data is still in ~/.agentes.",
        );
        expect(el.querySelector(".dk-fr__who")).toBeNull();
      },
      { here: { run: false } },
    ));

  test("running here already: where, in one sentence", () =>
    firstRun("here", async ({ el, press, until }) => {
      await press("Use your own server");
      await press("Run agentes.chat on this Mac");
      await until(() => el.querySelector("h1")?.textContent === "agentes.chat already runs on this Mac");
      expect(el.querySelector(".dk-lead")?.textContent).toBe("This app runs it, at http://127.0.0.1:4310.");
    }));

  test("without Tailscale the switch can't be used, and one line says why, with what fixes it", async () => {
    await firstRun(
      "first",
      async ({ el, press, until, tailscale }) => {
        await press("Use your own server");
        await press("Run agentes.chat on this Mac");
        await until(() => switchRows(el)[0]?.line);
        const [reach] = switchRows(el);
        expect(reach?.line).toBe("Needs Tailscale, which is free. Get Tailscale");
        expect(reach?.hint).toBe(REACH_TEXT);
        expect(el.querySelector("#here-reach")?.hasAttribute("disabled")).toBe(true);
        await press("Get Tailscale");
        expect(tailscale).toEqual(["download"]);
      },
      { here: { tailscale: "missing" } },
    );
    await firstRun(
      "first",
      async ({ el, press, until, tailscale }) => {
        await press("Use your own server");
        await press("Run agentes.chat on this Mac");
        await until(() => switchRows(el)[0]?.line?.startsWith("Tailscale"));
        expect(switchRows(el)[0]?.line).toBe("Tailscale isn't connected. Open Tailscale");
        await press("Open Tailscale");
        expect(tailscale).toEqual(["app"]);
      },
      { here: { tailscale: "off" } },
    );
    await firstRun(
      "linux",
      async ({ el, press, until }) => {
        await press("Use your own server");
        await press("Run agentes.chat on this computer");
        await until(() => switchRows(el)[0]?.line?.startsWith("Tailscale"));
        const row = el.querySelector(".dk-card > .dk-crow");
        expect(row?.querySelector("small")?.textContent?.trim()).toBe(
          "Tailscale isn't connected. Connect it in the terminal: sudo tailscale up",
        );
        expect(row?.querySelector("small code")?.textContent).toBe("sudo tailscale up");
        expect(row?.querySelector("small button[aria-label='Copy']")).toBeTruthy();
      },
      { here: { tailscale: "off" } },
    );
  });
});

describe("Run here, while Tailscale is read", () => {
  test("nothing shows under reach and its switch waits, so no wrong line flashes", async () => {
    // Tailscale is connected, but its read takes a moment (up to 2 s on a Mac).
    const answers: ((tailnet: Tailnet) => void)[] = [];
    await firstRun(
      "first",
      async ({ el, press, until }) => {
        await press("Use your own server");
        await press("Run agentes.chat on this Mac");
        await until(() => el.querySelector("form.dk-fr__here"));
        expect(switchRows(el)[0]?.line).toBeNull();
        expect(el.textContent).not.toContain("Needs Tailscale");
        expect(el.querySelector("#here-reach")?.hasAttribute("disabled")).toBe(true);
        await act(async () => {
          for (const answer of answers) answer({ state: "on", device: "macbook" });
        });
        await until(() => !el.querySelector("#here-reach")?.hasAttribute("disabled"));
        expect(switchRows(el)[0]?.line).toBeNull();
      },
      {
        host: (host) => {
          host.tailscale = () => new Promise((resolve) => answers.push(resolve));
        },
      },
    );
  });
});

describe("Your own server", () => {
  test("Which one to choose? opens the page's answer in the browser, in the app's language", async () => {
    await firstRun("first", async ({ el, press, button, opened }) => {
      await press("Use your own server");
      expect(el.querySelector("h1")?.textContent).toBe("Your own server");
      expect(el.textContent).toContain("This Mac becomes the server, while it's on.");
      expect(button("Which one to choose?")?.className).toBe("ac-link ac-link--muted dk-link");
      await press("Which one to choose?");
      expect(opened).toEqual(["https://agentes.chat/help/run-on-your-computer?lang=en#who"]);
    });
    await firstRun(
      "first",
      async ({ press, opened }) => {
        await press("Usar o seu próprio servidor");
        await press("Qual escolher?");
        expect(opened).toEqual(["https://agentes.chat/help/run-on-your-computer?lang=pt-BR#who"]);
      },
      { lang: "pt-BR" },
    );
  });

  test("on Windows it runs here too: the same card and its help", () =>
    firstRun("windows", async ({ el, press, button }) => {
      await press("Use your own server");
      expect(el.textContent).toContain("This PC becomes the server, while it's on.");
      expect(button("Which one to choose?")).toBeDefined();
    }));
});
