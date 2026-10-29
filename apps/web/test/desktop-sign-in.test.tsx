import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { SignInOptions } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { createFakeApi, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

/**
 * agentes for Mac (ADR 0036): in the app's window, Google/GitHub/Apple sign in
 * through the browser; the browser page hands the fresh sign-in back as a one-time
 * code through the app's own link, and the window redeems it with its verifier.
 */

const app = () => window as { __agentesDesktop?: unknown };
afterEach(() => {
  cleanup();
  delete app().__agentesDesktop;
  sessionStorage.clear();
});

const ACCOUNT: SignInOptions = { account: true, password: true, providers: [], canSignUp: false };
const KEY = /^[A-Za-z0-9_-]{43}$/;
const heading = () => screen().getByRole("heading").textContent;

/** `window.location.assign` and `replace` recorded instead of followed. */
function recordAssign() {
  const urls: string[] = [];
  const replaced: string[] = [];
  const spy = spyOn(window.location, "assign").mockImplementation((url: string | URL) => {
    urls.push(String(url));
  });
  const replace = spyOn(window.location, "replace").mockImplementation((url: string | URL) => {
    replaced.push(String(url));
  });
  return {
    urls,
    replaced,
    restore: () => {
      spy.mockRestore();
      replace.mockRestore();
    },
  };
}

describe("in the Mac app's window", () => {
  test("GitHub opens in the browser; the window keeps the verifier and never polls", async () => {
    app().__agentesDesktop = { version: "0.6.0", signInReturn: true };
    const assign = recordAssign();
    const { auth, calls } = createFakeAuth({ redeem: true });
    const state = seedState({ me: null });
    const api = createFakeApi(state);
    api.account.signInOptions = async () => ACCOUNT;
    try {
      await renderApp("/login", { api, auth });
      await act(async () => fireEvent.click(screen().getByRole("button", { name: /Continuar com GitHub/ })));
      await settle(6);
      expect(calls.some((c) => c.method === "signInSocial")).toBe(false);
      expect(heading()).toBe("Continue no navegador");
      expect(document.querySelector(".auth__lead")?.textContent).toBe(
        "A gente volta para cá quando você entrar com GitHub.",
      );
      const opened = new URL(assign.urls[0] ?? "", "https://app.agentes.chat");
      expect(opened.pathname).toBe("/desktop/sign-in");
      expect(opened.searchParams.get("provider")).toBe("github");
      expect(opened.searchParams.get("challenge")).toMatch(KEY);

      // The verifier stays in this window; only its hash went to the browser.
      const kept = JSON.parse(sessionStorage.getItem("agentes.desktopVerifier") ?? "{}") as { verifier?: string };
      expect(kept.verifier).toMatch(KEY);
      expect(opened.searchParams.get("challenge")).not.toBe(kept.verifier);

      // Coming back to the front redeems nothing by itself: only the app's link, with the browser's code, does.
      await act(async () => window.dispatchEvent(new Event("focus")));
      await settle(3);
      expect(calls.some((c) => c.method === "desktopRedeem")).toBe(false);
      expect(assign.urls).toHaveLength(1);
    } finally {
      assign.restore();
    }
  });

  test("an app that can't take the sign-in back offers no browser sign-in", async () => {
    app().__agentesDesktop = { version: "0.5.0" };
    const { auth } = createFakeAuth();
    const api = createFakeApi(seedState({ me: null }));
    api.account.signInOptions = async () => ACCOUNT;
    await renderApp("/login", { api, auth });
    await settle(3);
    expect(screen().queryByRole("button", { name: /Continuar com GitHub/ })).toBeNull();
  });

  test("the app's link brings the code: redeemed with the kept verifier, then in", async () => {
    app().__agentesDesktop = { version: "0.6.0", signInReturn: true };
    const verifier = "v".repeat(43);
    sessionStorage.setItem("agentes.desktopVerifier", JSON.stringify({ verifier, to: "/org/o1" }));
    const assign = recordAssign();
    const { auth, calls } = createFakeAuth({ redeem: true });
    try {
      await renderApp(`/desktop/signed-in?code=${"k".repeat(43)}`, {
        api: createFakeApi(seedState({ me: null })),
        auth,
      });
      await settle(4);
      expect(calls).toEqual([{ method: "desktopRedeem", args: ["k".repeat(43), verifier] }]);
      expect(assign.replaced).toEqual(["/desktop/signed-in?to=%2Forg%2Fo1"]);
      // Taken once.
      expect(sessionStorage.getItem("agentes.desktopVerifier")).toBeNull();
    } finally {
      assign.restore();
    }
  });

  test("a code this window didn't ask for signs nobody in", async () => {
    app().__agentesDesktop = { version: "0.6.0", signInReturn: true };
    const { auth, calls } = createFakeAuth({ redeem: true });
    await renderApp(`/desktop/signed-in?code=${"k".repeat(43)}`, {
      api: createFakeApi(seedState({ me: null })),
      auth,
    });
    await settle(4);
    expect(calls).toEqual([]);
    expect(heading()).toBe("Esse pedido expirou.");
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

  test("goes to the provider, and back from it gives the code to the app on this computer", async () => {
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

    const assign = recordAssign();
    const back = createFakeAuth({ handoffCode: "k".repeat(43) });
    try {
      await renderApp(`/desktop/sign-in?provider=github&challenge=${challenge}&done=1`, {
        api: createFakeApi(seedState()),
        auth: back.auth,
      });
      await settle(3);
      expect(back.calls).toEqual([{ method: "desktopHandoff", args: [challenge] }]);
      // Only through the app's own link: nothing the page that made the link could read.
      expect(assign.urls).toEqual([`agenteschat://desktop/sign-in?code=${"k".repeat(43)}`]);
      expect(heading()).toBe("Continue no app agentes.chat");
      await act(async () => fireEvent.click(screen().getByRole("button", { name: "Abrir o app" })));
      expect(assign.urls).toHaveLength(2);
    } finally {
      assign.restore();
    }
  });

  test("a refused handoff opens nothing", async () => {
    const assign = recordAssign();
    sessionStorage.setItem("agentes.desktopChallenge", challenge);
    const { auth } = createFakeAuth({ handoffCode: null });
    try {
      await renderApp(`/desktop/sign-in?provider=github&challenge=${challenge}&done=1`, {
        api: createFakeApi(seedState()),
        auth,
      });
      await settle(3);
      expect(assign.urls).toEqual([]);
      expect(heading()).toBe("Esse pedido expirou.");
    } finally {
      assign.restore();
    }
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
