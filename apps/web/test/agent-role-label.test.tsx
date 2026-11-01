import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { click, typeIn } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** The count beside a field's label: what shows ("6/16") and what a screen reader hears. */
const count = (input: HTMLInputElement) => {
  const box = input.closest(".ac-field")?.querySelector(".ac-field__count");
  return {
    shown: box?.querySelector("[aria-hidden='true']")?.textContent,
    said: box?.querySelector(".ac-visually-hidden")?.textContent,
    over: box?.hasAttribute("data-over"),
  };
};

test("Criar agente › Do zero: the role is one or two words, 16 characters at most, counted as typed", async () => {
  await renderApp(`/org/${ORG_ID}/agents/new`, { api: createFakeApi(seedState()) });
  await settle(8);
  await click(screen().getByRole("button", { name: /^Do zero/ }));
  const role = screen().getByLabelText("Cargo") as HTMLInputElement;
  expect(role.maxLength).toBe(16);
  expect(count(role)).toEqual({ shown: "0/16", said: "0 de 16 caracteres", over: false });
  await typeIn(role, "E-mail");
  expect(count(role)).toEqual({ shown: "6/16", said: "6 de 16 caracteres", over: false });
});

test("a role saved before roles were short: whole in the field, past the count, and kept when another field saves", async () => {
  const state = seedState();
  const api = createFakeApi(state);
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.role = "Assistente de e-mails";
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=settings&sec=identity`, { api });
  await settle(10);
  const role = screen().getByLabelText("Cargo") as HTMLInputElement;
  expect(role.value).toBe("Assistente de e-mails");
  expect(role.maxLength).toBe(16);
  expect(count(role)).toEqual({ shown: "21/16", said: "21 de 16 caracteres", over: true });
  await typeIn(screen().getByLabelText("Nome") as HTMLInputElement, "Ada Lovelace");
  await settle(2);
  await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Salvar/ })));
  await settle(6);
  const saved = state.calls.find((c) => c.method === "agents.update")?.args[2] as Record<string, unknown> | undefined;
  expect(saved).toMatchObject({ name: "Ada Lovelace" });
  expect(saved && "role" in saved).toBe(false);
});

test("where a role is cut to the line, it shows whole on hover", async () => {
  const state = seedState();
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.role = "Assistente de e-mails";
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);
  // The sidebar's row.
  const row = document.querySelector(`[data-agent-row="${ADA_ID}"] .sidebar__item`);
  expect(row?.getAttribute("title")).toContain("Assistente de e-mails");
  // The channel's members.
  await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Membros do canal/ })));
  await settle(4);
  const line = [...document.querySelectorAll(".members-pop__meta")].find((m) => m.textContent?.includes("Assistente"));
  expect(line?.getAttribute("title")).toEndWith(" · Assistente de e-mails");
});
