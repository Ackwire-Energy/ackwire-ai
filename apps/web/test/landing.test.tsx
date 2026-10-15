import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { ApiError } from "@/api/http";
import { createFakeApi, type FakeState, seedState } from "./fake-api";
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
    expect(screen().getByRole("heading", { level: 1, name: /Seu time e seus.*na mesma conversa/ })).toBeTruthy();
    // The only call to action is the waiting list: no sign-up or sign-in link.
    expect(screen().queryByRole("link", { name: /criar conta|entrar$/i })).toBeNull();
    expect(screen().getAllByRole("button", { name: "Entrar na lista" }).length).toBe(2);
  });

  test("joining the waiting list sends the email and the locale, then shows the done state", async () => {
    const { state, api } = signedOut();
    await renderApp("/", { api });
    await joinWith("ana@empresa.com");
    expect(joins(state)).toEqual([{ method: "waitlist.join", args: [{ email: "ana@empresa.com", locale: "pt-BR" }] }]);
    // Both forms (hero and closing) switch to the done state.
    expect(screen().getAllByText("Você está na lista.").length).toBe(2);
    expect(screen().getAllByText(/Avisamos em ana@empresa.com/).length).toBe(2);
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

  test("any other error shows the generic message", async () => {
    const { api } = signedOut({ waitlistError: new ApiError(403, "bad_origin", "Bad origin") });
    await renderApp("/", { api });
    await joinWith("ana@empresa.com");
    expect(screen().getByRole("alert").textContent).toContain("Não deu para entrar na lista agora.");
  });

  test("someone already on the list sees the done state", async () => {
    localStorage.setItem("agentes.waitlist", "bia@empresa.com");
    const { api } = signedOut();
    await renderApp("/", { api });
    expect(screen().getAllByText("Você está na lista.").length).toBe(2);
    expect(screen().queryByPlaceholderText("voce@empresa.com")).toBeNull();
  });

  test("in English the page is in English and the join sends locale en", async () => {
    const { state, api } = signedOut();
    const { services } = await renderApp("/", { api });
    await act(async () => {
      await services.i18n.changeLanguage("en");
    });
    await settle();
    expect(
      screen().getByRole("heading", { level: 1, name: /Your team and your.*in the same conversation/ }),
    ).toBeTruthy();
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
    expect(screen().getAllByText("You're on the list.").length).toBe(2);
  });
});
