import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, type FakeState, seedState } from "./fake-api";
import { installTurnstile, removeTurnstile } from "./fake-turnstile";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function signedOut(overrides: Partial<FakeState> = {}) {
  const state = seedState({ me: null, ...overrides });
  return { state, api: createFakeApi(state) };
}

/** Types into the hero form's email field and submits it. */
async function joinWith(email: string) {
  const input = screen().getAllByPlaceholderText("voce@empresa.com")[0] as HTMLInputElement;
  const form = input.closest("form");
  if (!form) throw new Error("no waiting list form");
  await act(async () => {
    fireEvent.change(input, { target: { value: email } });
  });
  await act(async () => {
    fireEvent.submit(form);
  });
  await settle();
}

const joins = (state: FakeState) => state.calls.filter((c) => c.method === "waitlist.join");

describe("landing page", () => {
  test("a signed-out visitor at / sees the landing page", async () => {
    const { api } = signedOut();
    const { router } = await renderApp("/", { api });
    expect(router.state.location.pathname).toBe("/");
    expect(
      screen().getByRole("heading", { level: 1, name: /Agentes de IA que.*trabalham com o seu time/ }),
    ).toBeTruthy();
    // The only call to action is the waiting list: no sign-up or sign-in link.
    expect(screen().queryByRole("link", { name: /criar conta|entrar$/i })).toBeNull();
    expect(screen().getAllByRole("button", { name: "Entrar na lista" }).length).toBe(2);
  });

  test("joining the waiting list sends the email and the locale, then asks to check the inbox", async () => {
    const { state, api } = signedOut();
    await renderApp("/", { api });
    await joinWith("ana@empresa.com");
    expect(joins(state)).toEqual([{ method: "waitlist.join", args: [{ email: "ana@empresa.com", locale: "pt-BR" }] }]);
    // Both forms (hero and closing) switch to "check your email" until the link is opened.
    expect(screen().getAllByText("Confira seu e-mail.").length).toBe(2);
    expect(screen().getAllByText(/Mandamos um link para ana@empresa.com/).length).toBe(2);
    expect(screen().queryByText("Você está na lista.")).toBeNull();
    expect(localStorage.getItem("agentes.waitlist")).toBe("ana@empresa.com");
  });

  test("an invalid email shows the error and calls nothing", async () => {
    const { state, api } = signedOut();
    await renderApp("/", { api });
    await joinWith("ana@empresa");
    expect(joins(state)).toEqual([]);
    expect(screen().getByRole("alert").textContent).toContain(
      "Confira o e-mail. Ele precisa ter o formato nome@empresa.com.",
    );
    expect(screen().queryByText("Você está na lista.")).toBeNull();
  });

  test("the server's invalid_email reads like the client-side check", async () => {
    const { state, api } = signedOut({ waitlistError: new ApiError(400, "invalid_email", "Invalid email") });
    await renderApp("/", { api });
    await joinWith("ana@empresa.com");
    expect(joins(state).length).toBe(1);
    expect(screen().getByRole("alert").textContent).toContain("Confira o e-mail.");
  });

  test("a 429 shows the rate-limit message", async () => {
    const { api } = signedOut({ waitlistError: new ApiError(429, "rate_limited", "Too many requests") });
    await renderApp("/", { api });
    await joinWith("ana@empresa.com");
    expect(screen().getByRole("alert").textContent).toContain("Muitas tentativas seguidas.");
    expect(screen().queryByText("Você está na lista.")).toBeNull();
    expect(localStorage.getItem("agentes.waitlist")).toBeNull();
  });

  test("with the bot check: it loads at the first focus of a form, for that form only, and its token goes with the join", async () => {
    const cf = installTurnstile();
    try {
      const { state, api } = signedOut({
        authConfig: { turnstileSiteKey: "1x00000000000000000000BB" },
        waitlistError: new ApiError(403, "human_check_blocked", "The bot check didn't load."),
      });
      await renderApp("/", { api });
      await settle();
      // A visitor who only reads reaches nothing of Cloudflare.
      expect(cf.scripts()).toEqual([]);
      const input = screen().getAllByPlaceholderText("voce@empresa.com")[0] as HTMLInputElement;
      await act(async () => fireEvent.focus(input));
      await settle();
      expect(cf.widgets.map((w) => [w.options.action, w.options.theme])).toEqual([["waitlist", "dark"]]);
      await joinWith("ana@empresa.com");
      expect(joins(state)).toEqual([
        { method: "waitlist.join", args: [{ email: "ana@empresa.com", locale: "pt-BR" }, "w1-1"] },
      ]);
      expect(screen().getByRole("alert").textContent).toContain("A verificação não carregou.");
    } finally {
      removeTurnstile();
    }
  });

  test("any other error shows the generic message", async () => {
    const { api } = signedOut({ waitlistError: new ApiError(403, "bad_origin", "Bad origin") });
    await renderApp("/", { api });
    await joinWith("ana@empresa.com");
    expect(screen().getByRole("alert").textContent).toContain("Não deu para entrar na lista agora.");
  });

  test("someone who joined but didn't confirm yet is still asked to check the inbox", async () => {
    localStorage.setItem("agentes.waitlist", "bia@empresa.com");
    const { api } = signedOut();
    await renderApp("/", { api });
    expect(screen().getAllByText("Confira seu e-mail.").length).toBe(2);
    expect(screen().queryByPlaceholderText("voce@empresa.com")).toBeNull();
  });

  test("someone who confirmed sees the done state", async () => {
    localStorage.setItem("agentes.waitlist", "bia@empresa.com");
    localStorage.setItem("agentes.waitlist.confirmed", "1");
    const { api } = signedOut();
    await renderApp("/", { api });
    expect(screen().getAllByText("Você está na lista.").length).toBe(2);
    expect(screen().getAllByText(/E-mail confirmado/).length).toBe(2);
  });

  test("opening the confirmation link confirms, shows the done state and drops the token from the address", async () => {
    const { state, api } = signedOut();
    const { router } = await renderApp("/?confirm=tok_abc", { api });
    await settle();
    expect(state.calls.filter((c) => c.method === "waitlist.confirm")).toEqual([
      { method: "waitlist.confirm", args: [{ token: "tok_abc" }] },
    ]);
    // Works on another device too: no email remembered here.
    expect(screen().getAllByText("Você está na lista.").length).toBe(2);
    expect(localStorage.getItem("agentes.waitlist.confirmed")).toBe("1");
    expect(router.state.location.search).toEqual({});
  });

  test("an expired confirmation link brings the form back with a way out", async () => {
    localStorage.setItem("agentes.waitlist", "bia@empresa.com");
    const { api } = signedOut({ waitlistConfirmError: new ApiError(400, "invalid_token", "Unknown or expired") });
    await renderApp("/?confirm=tok_old", { api });
    await settle();
    expect(screen().getByRole("alert").textContent).toContain("Esse link expirou");
    expect(screen().getAllByPlaceholderText("voce@empresa.com").length).toBe(2);
    expect(localStorage.getItem("agentes.waitlist")).toBeNull();
    expect(localStorage.getItem("agentes.waitlist.confirmed")).toBeNull();
  });

  test("in English the page is in English and the join sends locale en", async () => {
    const { state, api } = signedOut();
    const { services } = await renderApp("/", { api });
    await act(async () => {
      await services.i18n.changeLanguage("en");
    });
    await settle();
    expect(screen().getByRole("heading", { level: 1, name: /AI agents that.*work with your team/ })).toBeTruthy();
    const input = screen().getAllByPlaceholderText("you@company.com")[0] as HTMLInputElement;
    const form = input.closest("form");
    if (!form) throw new Error("no waiting list form");
    await act(async () => {
      fireEvent.change(input, { target: { value: "ana@company.com" } });
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    await settle();
    expect(joins(state)).toEqual([{ method: "waitlist.join", args: [{ email: "ana@company.com", locale: "en" }] }]);
    expect(screen().getAllByText("Check your email.").length).toBe(2);
  });

  test("the PT | EN switch in the nav changes the language, and a later join sends locale en", async () => {
    const lang = document.documentElement.lang;
    const { state, api } = signedOut();
    await renderApp("/", { api });
    const switcher = screen().getByRole("radiogroup", { name: "Idioma" });
    await act(async () => {
      fireEvent.click(within(switcher).getByRole("radio", { name: "EN" }));
    });
    await settle();
    expect(screen().getByRole("heading", { level: 1, name: /AI agents that.*work with your team/ })).toBeTruthy();
    expect(screen().getByRole("radiogroup", { name: "Language" })).toBeTruthy();
    expect(screen().getByRole("radio", { name: "EN" }).getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("agentes.locale")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    const input = screen().getAllByPlaceholderText("you@company.com")[0] as HTMLInputElement;
    const form = input.closest("form");
    if (!form) throw new Error("no waiting list form");
    await act(async () => {
      fireEvent.change(input, { target: { value: "ana@company.com" } });
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    await settle();
    expect(joins(state)).toEqual([{ method: "waitlist.join", args: [{ email: "ana@company.com", locale: "en" }] }]);
    document.documentElement.lang = lang;
  });
});
