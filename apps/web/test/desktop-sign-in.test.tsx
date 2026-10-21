import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { SignInOptions } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

/**
 * agentes for Mac (D79): in the app's window, Google/GitHub/Apple sign in
 * through the browser; the browser page hands the fresh sign-in back.
 */

const app = window as { __agentesDesktop?: unknown };
afterEach(() => {
  cleanup();
  delete app.__agentesDesktop;
  sessionStorage.clear();
});

const ACCOUNT: SignInOptions = { account: true, password: true, providers: [], canSignUp: false };
const KEY = /^[A-Za-z0-9_-]{43}$/;
const heading = () => screen().getByRole("heading").textContent;

/** `window.location.assign` recorded instead of followed. */
function recordAssign() {
  const urls: string[] = [];
  const spy = spyOn(window.location, "assign").mockImplementation((url: string | URL) => {
    urls.push(String(url));
  });
  return { urls, restore: () => spy.mockRestore() };
}

describe("in the Mac app's window", () => {
  test("GitHub opens in the browser and the window waits, then enters", async () => {
    app.__agentesDesktop = { version: "0.6.0" };
    const assign = recordAssign();
    let redeemed = false;
    const { auth, calls } = createFakeAuth();
    auth.desktopRedeem = async (verifier) => {
      calls.push({ method: "desktopRedeem", args: [verifier] });
      return redeemed;
    };
    const state = seedState({ me: null });
    const api = createFakeApi(state);
    api.account.signInOptions = async () => ACCOUNT;
    try {
      await renderApp("/login", { api, auth });
      await act(async () => fireEvent.click(screen().getByRole("button", { name: /Continuar com GitHub/ })));
      await settle(6);
      expect(calls.some((c) => c.method === "signInSocial")).toBe(false);
      expect(heading()).toBe("Continue no navegador");
      const opened = new URL(assign.urls[0] ?? "", "https://agentes.chat");
      expect(opened.pathname).toBe("/desktop/sign-in");
      expect(opened.searchParams.get("provider")).toBe("github");
      expect(opened.searchParams.get("challenge")).toMatch(KEY);

      // Not yet: stays. Back in front after the browser finished: enters.
      await act(async () => window.dispatchEvent(new Event("focus")));
      await settle(3);
      expect(assign.urls).toHaveLength(1);
      redeemed = true;
      await act(async () => window.dispatchEvent(new Event("focus")));
      await settle(3);
      expect(assign.urls[1]).toBe("/desktop/signed-in?to=%2F");
      const verifiers = calls.filter((c) => c.method === "desktopRedeem").map((c) => c.args[0]);
      expect(verifiers[0]).toMatch(KEY);
      // The verifier never left the window: only its hash went to the browser.
      expect(opened.searchParams.get("challenge")).not.toBe(verifiers[0]);
    } finally {
      assign.restore();
    }
  });

  test("outside the app, GitHub signs in right here as before", async () => {
    const { auth, calls } = createFakeAuth();
    const api = createFakeApi(seedState({ me: null }));
    await renderApp("/login", { api, auth });
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /Continuar com GitHub/ })));
    await settle(3);
    expect(calls[0]).toEqual({ method: "signInSocial", args: ["github", "/"] });
  });
});

describe("in the browser, for the app", () => {
  const challenge = "c".repeat(43);

  test("goes to the provider, and back from it hands the sign-in over", async () => {
    const first = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=github&challenge=${challenge}`, {
      api: createFakeApi(seedState({ me: null })),
      auth: first.auth,
    });
    await settle(3);
    expect(first.calls[0]).toEqual({
      method: "signInSocial",
      args: ["github", `/desktop/sign-in?provider=github&challenge=${challenge}&done=1`],
    });
    cleanup();

    const back = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=github&challenge=${challenge}&done=1`, {
      api: createFakeApi(seedState()),
      auth: back.auth,
    });
    await settle(3);
    expect(back.calls).toEqual([{ method: "desktopHandoff", args: [challenge] }]);
    expect(heading()).toBe("Tudo certo.");
  });

  test("a link straight to the end hands nothing over", async () => {
    const { auth, calls } = createFakeAuth();
    await renderApp(`/desktop/sign-in?provider=google&challenge=${challenge}&done=1`, {
      api: createFakeApi(seedState()),
      auth,
    });
    await settle(3);
    expect(calls).toEqual([]);
    expect(heading()).toBe("Esse pedido expirou.");
  });
});
