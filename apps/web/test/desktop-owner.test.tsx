import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { SignInOptions } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { ThisMacStatus } from "@/lib/desktop";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { createFakeAuth } from "./fake-auth";
import { renderApp, screen, settle } from "./render";

/**
 * The server the desktop app runs on this computer: its owner has no password, and the app signs them in
 * (ADR 0060 §6). The sign-in screen offers it only there; anywhere else it is the ordinary sign-in.
 */

const win = () =>
  window as { __agentesDesktop?: unknown; __TAURI_INTERNALS__?: unknown; __agentesNavigate?: (p: string) => void };
afterEach(() => {
  cleanup();
  delete win().__agentesDesktop;
  delete win().__TAURI_INTERNALS__;
  localStorage.removeItem("agentes.signedOut");
});
/** The person signed out by hand: the screen waits for their click (no sign-in at once). */
const byHand = () => localStorage.setItem("agentes.signedOut", "1");

/** The app around the site: answers `this_mac` with `status`, records every request; `refuse`: its signIn's refusal. */
function inTheApp(status: ThisMacStatus, refuse?: string) {
  const asked: Record<string, unknown>[] = [];
  win().__agentesDesktop = { version: "0.6.0", platform: "mac" };
  win().__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: { request: Record<string, unknown> }) => {
      if (cmd === "page_ready") return null;
      if (cmd !== "this_mac") throw new Error(`unexpected ${cmd}`);
      asked.push(args.request);
      if (refuse && args.request.kind === "signIn") throw refuse;
      return args.request.kind === "status" ? status : {};
    },
  };
  return asked;
}

const signedOut = (options?: SignInOptions, instance?: { cloud: boolean }) => {
  const state = seedState({ me: null });
  if (instance) state.instance = instance;
  const api = createFakeApi(state);
  if (options) api.account.signInOptions = async () => options;
  return api;
};
const continueHere = () => screen().queryByRole("button", { name: /^Continuar neste/ });

describe("Entrar no servidor que o app roda neste computador", () => {
  test("the owner's session ended: the app signs them in again at once, with no click", async () => {
    const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    expect(asked.filter((r) => r.kind === "signIn")).toEqual([{ kind: "signIn" }]);
  });

  test("the owner deleted their account: the automatic try says so and sends the person to their own email", async () => {
    inTheApp({ orgs: [], agentsHere: false, local: true }, "owner_gone");
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    expect(screen().getByRole("alert").textContent).toBe(
      "O dono deste servidor apagou a conta, então Continuar neste Mac não consegue entrar com ninguém. Entre com o seu próprio e-mail.",
    );
    expect(screen().getByLabelText("E-mail")).toBeTruthy();
    // The button that can sign nobody in is gone: the address field is the one way in.
    expect(continueHere()).toBeNull();
  });

  test("no account left: Continue on this Mac points to the window the app opened; anything else stays general", async () => {
    byHand();
    inTheApp({ orgs: [], agentsHere: false, local: true }, "owner_none");
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    await act(async () => fireEvent.click(continueHere() as HTMLElement));
    await settle(2);
    expect(screen().getByRole("alert").textContent).toBe(
      "Não sobrou nenhuma conta no Ackwire AI deste Mac. Crie o novo dono na janela que abriu.",
    );
    // The refusal says nothing against the address field.
    expect(screen().getByLabelText("E-mail").getAttribute("aria-invalid")).toBeNull();
    cleanup();
    inTheApp({ orgs: [], agentsHere: false, local: true }, "too_soon");
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    await act(async () => fireEvent.click(continueHere() as HTMLElement));
    await settle(2);
    expect(screen().getByRole("alert").textContent).toBe("Algo deu errado. Tente de novo.");
  });

  test("after Sign out by hand, or with an address to sign in with, the screen waits", async () => {
    byHand();
    const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    expect(continueHere()).toBeTruthy();
    cleanup();
    localStorage.removeItem("agentes.signedOut");
    await renderApp("/login?email=bruno%40acme.com", { api: signedOut() });
    await settle(6);
    expect(asked.filter((r) => r.kind === "signIn")).toEqual([]);
  });

  test("one click asks the app, which signs the owner in; the e-mail stays for anyone else", async () => {
    byHand();
    const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    const button = continueHere();
    expect(button).toBeTruthy();
    expect(screen().getByText(/não precisa de senha/)).toBeTruthy();
    expect(screen().getByLabelText("E-mail")).toBeTruthy();
    await act(async () => fireEvent.click(button as HTMLElement));
    await settle(2);
    expect(asked.filter((r) => r.kind === "signIn")).toEqual([{ kind: "signIn" }]);
  });

  test("an account with no password, typed in: the same one click, never 'open the app'", async () => {
    byHand();
    inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: signedOut({ account: true, password: false, providers: [], canSignUp: false }) });
    await act(async () => fireEvent.change(screen().getByLabelText("E-mail"), { target: { value: "ana@acme.com" } }));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Continuar(?! neste| com)/ })));
    await settle(6);
    expect(continueHere()).toBeTruthy();
    expect(screen().queryByText(/abra o app e escolha Adicionar uma senha/)).toBeNull();
  });

  test("no Google or GitHub on the server here, even with their keys set; another server keeps them", async () => {
    const withProviders = () => {
      const state = seedState({ me: null });
      state.authConfig = { socialProviders: { google: true, github: true } };
      return createFakeApi(state);
    };
    const google = () => screen().queryByRole("button", { name: /Continuar com Google/ });
    byHand();
    inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: withProviders() });
    await settle(6);
    expect(continueHere()).toBeTruthy();
    expect(google()).toBeNull();
    expect(screen().queryByRole("button", { name: /Continuar com GitHub/ })).toBeNull();
    cleanup();
    inTheApp({ orgs: [], agentsHere: true, local: false });
    await renderApp("/login", { api: withProviders() });
    await settle(6);
    expect(google()).toBeTruthy();
  });

  test("the line under the sign-in names the server, Trocar opens the app's servers (ADR 0158)", async () => {
    byHand();
    const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
    (win().__agentesDesktop as Record<string, unknown>).servers = true;
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    const line = document.querySelector(".auth__place");
    expect(line?.textContent).toContain("Entrando no Ackwire AI deste Mac");
    await act(async () =>
      fireEvent.click(within(line as HTMLElement).getByRole("button", { name: "Trocar de servidor" })),
    );
    await settle(2);
    expect(asked.filter((r) => r.kind === "servers")).toEqual([{ kind: "servers" }]);
    cleanup();
    // Another server: by its address, never "this Mac".
    inTheApp({ orgs: [], agentsHere: true, local: false });
    (win().__agentesDesktop as Record<string, unknown>).servers = true;
    await renderApp("/login", { api: signedOut(undefined, { cloud: false }) });
    await settle(6);
    expect(document.querySelector(".auth__place")?.textContent).toContain(`Entrando em ${window.location.host}`);
    cleanup();
    // The Cloud: by its name.
    inTheApp({ orgs: [], agentsHere: true, local: false });
    (win().__agentesDesktop as Record<string, unknown>).servers = true;
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    expect(document.querySelector(".auth__place")?.textContent).toContain("Entrando no Ackwire AI Cloud");
  });

  test("forgot password on this computer's server: Continue on this Mac, then a new password (ADR 0158)", async () => {
    byHand();
    const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
    await renderApp("/login", { api: signedOut({ account: true, password: true, providers: [], canSignUp: false }) });
    await act(async () => fireEvent.change(screen().getByLabelText("E-mail"), { target: { value: "ana@acme.com" } }));
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Continuar(?! neste| com)/ })));
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Esqueci a senha" })));
    await settle(2);
    expect(screen().getByRole("heading").textContent).toBe("Aqui você não precisa de senha.");
    await act(async () => fireEvent.click(continueHere() as HTMLElement));
    await settle(2);
    expect(asked.filter((r) => r.kind === "signIn")).toEqual([{ kind: "signIn" }]);
    expect(sessionStorage.getItem("agentes.newPasswordAsk")).toBe("1");
    sessionStorage.removeItem("agentes.newPasswordAsk");
  });

  describe("from the screen of an account that waits for its deletion", () => {
    const waiting = () => {
      const state = seedState();
      if (!state.me) throw new Error("signed in");
      const dueAt = new Date(Date.now() + 6 * 86_400_000).toISOString();
      state.me.user.deletion = { dueAt, requestedAt: new Date().toISOString() };
      state.me.organizations = [];
      return state;
    };
    const press = async (name: string) => {
      await act(async () => fireEvent.click(screen().getByRole("button", { name })));
      await settle(8);
    };

    test("Sair is by hand: the sign-in waits for Continue on this Mac, the app is never asked", async () => {
      const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
      const state = waiting();
      const { auth } = createFakeAuth({ onSignOut: () => (state.me = null) });
      const { router } = await renderApp("/", { api: createFakeApi(state), auth });
      await settle(8);
      await press("Sair");
      expect(router.state.location.pathname).toBe("/login");
      expect(continueHere()).toBeTruthy();
      expect(asked.filter((r) => r.kind === "signIn")).toEqual([]);
    });

    test("Restaurar after the session ended: nobody signed out by hand, so the app signs its owner in again", async () => {
      const asked = inTheApp({ orgs: [], agentsHere: false, local: true });
      const state = waiting();
      const { router } = await renderApp("/", { api: createFakeApi(state) });
      await settle(8);
      state.me = null;
      await press("Restaurar conta");
      expect(router.state.location.pathname).toBe("/login");
      expect(asked.filter((r) => r.kind === "signIn")).toEqual([{ kind: "signIn" }]);
    });
  });

  test("another server in the app, or a browser: the ordinary sign-in", async () => {
    inTheApp({ orgs: [], agentsHere: true, local: false });
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    expect(continueHere()).toBeNull();
    cleanup();
    delete win().__agentesDesktop;
    delete win().__TAURI_INTERNALS__;
    await renderApp("/login", { api: signedOut() });
    await settle(6);
    expect(continueHere()).toBeNull();
  });
});

test("the app's “Show QR code” opens “Abrir no celular” over the page the person is on", async () => {
  inTheApp({ orgs: [], agentsHere: false, local: true });
  const state = seedState();
  const { router } = await renderApp(`/org/${ORG_ID}/issues`, { api: createFakeApi(state) });
  await settle(6);
  expect(screen().queryByRole("dialog", { name: "Abrir no celular" })).toBeNull();
  await act(async () => win().__agentesNavigate?.("/?open=phone"));
  await settle(6);
  expect(screen().getByRole("dialog", { name: "Abrir no celular" })).toBeTruthy();
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/issues`);
  expect(state.calls.filter((c) => c.method === "account.phoneSignIn")).toHaveLength(1);
});
