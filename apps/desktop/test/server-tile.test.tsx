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
import { ServerTile } from "../src/ui/here";
import { ToastProvider } from "../src/ui/Toast";
import { FirstRun } from "../src/windows/FirstRun";
import { Servers } from "../src/windows/prefs/Servers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("a server's tile: Tailscale's own icon for one on the Tailscale network, a glyph for the rest, all 48 px", async () => {
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  await act(async () =>
    root.render(
      <>
        <ServerTile kind="tailnet" />
        <ServerTile kind="cloud" />
        <ServerTile kind="here" />
        <ServerTile kind="own" />
      </>,
    ),
  );
  const tiles = [...el.children];
  expect(tiles.map((tile) => tile.className)).toEqual(Array(4).fill("dk-logo dk-logo--soft dk-logo--lg"));
  expect(tiles.map((tile) => tile.getAttribute("aria-hidden"))).toEqual(Array(4).fill("true"));
  // Its two layers: the full dots, then the dots at 40%, as in its press kit.
  const tailscale = tiles[0]?.querySelector("svg.dk-tailscale");
  expect(tailscale?.getAttribute("viewBox")).toBe("0 0 24 24");
  expect([...(tailscale?.querySelectorAll("path") ?? [])].map((p) => p.getAttribute("fill-opacity"))).toEqual([
    null,
    "0.4",
  ]);
  expect(
    tiles.slice(1).every((tile) => tile.querySelector("svg.ac-icon") && !tile.querySelector(".dk-tailscale")),
  ).toBe(true);
  await act(async () => root.unmount());
  el.remove();

  const css = await Bun.file(new URL("../src/styles.css", import.meta.url).pathname).text();
  const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
  // The smallest size Tailscale's brand rules allow, and its own black and white files' colors by the app's theme.
  expect(rule(".dk-logo--lg")).toContain("width: 48px");
  expect(rule(".dk-logo--lg")).toContain("height: 48px");
  expect(rule(".dk-tailscale")).toContain("fill: #1e1e1f");
  expect(rule('[data-theme="dark"] .dk-tailscale')).toContain("fill: #fff");
});

test("Preferences › Servers: the server on the Tailscale network by Tailscale's icon, the Cloud by its glyph", async () => {
  const host = createFakeHost("prefs", "selfhost");
  const store = new DesktopStore(host, {});
  const stop = store.start();
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  try {
    await act(async () =>
      root.render(
        <I18nextProvider i18n={createDesktopI18n("en", host.platform)}>
          <AppProvider host={host} store={store}>
            <ToastProvider>
              <Servers />
            </ToastProvider>
          </AppProvider>
        </I18nextProvider>,
      ),
    );
    for (let i = 0; i < 50 && el.querySelectorAll(".dk-crow").length < 2; i++) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    }
    const rows = [...el.querySelectorAll(".dk-crow")].map((row) => [
      row.querySelector(".dk-crow__title")?.textContent,
      row.querySelector(".dk-logo--lg svg")?.getAttribute("class"),
    ]);
    expect(rows).toEqual([
      ["agentes.tail1234.ts.net", "dk-tailscale"],
      ["agentes.chat", "ac-icon"],
    ]);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
  }
});

test("Connect to my server: what it finds on the Tailscale network by Tailscale's icon, this Mac by its glyph", async () => {
  const host = createFakeHost("welcome", "first");
  // Discovery answers at once (the fake host waits like a network would); both still get checked.
  host.discover = async () => [
    { server: "http://127.0.0.1:4310", where: "here" },
    { server: "https://agentes.tail1234.ts.net", where: "tailnet" },
  ];
  const store = new DesktopStore(host, {});
  const stop = store.start();
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  const button = (name: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes(name));
  try {
    await act(async () =>
      root.render(
        <I18nextProvider i18n={createDesktopI18n("en", host.platform)}>
          <AppProvider host={host} store={store}>
            <ToastProvider>
              <FirstRun />
            </ToastProvider>
          </AppProvider>
        </I18nextProvider>,
      ),
    );
    await act(async () => button("Use your own server")?.click());
    await act(async () => button("Connect to my server")?.click());
    for (let i = 0; i < 100 && !el.querySelector(".dk-fr__foundrow"); i++) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    }
    const rows = [...el.querySelectorAll(".dk-fr__foundrow")].map((row) => [
      row.querySelector(".dk-fr__foundtext small")?.textContent,
      row.querySelector(".dk-logo--lg svg")?.getAttribute("class"),
    ]);
    expect(rows).toEqual([
      ["agentes.chat is running here", "ac-icon"],
      ["On your Tailscale network", "dk-tailscale"],
    ]);
  } finally {
    await act(async () => root.unmount());
    el.remove();
    stop();
  }
});
