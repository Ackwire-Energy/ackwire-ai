import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { BrowserHandoff } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, fakeBrowserOf, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

const HANDOFF_ID = "h-card";

/** Ada asked for help in its browser: the request card in #eng (its id is the handoff's). */
function seedRequest() {
  const state = seedState();
  const handoff: BrowserHandoff = {
    id: HANDOFF_ID,
    agentId: ADA_ID,
    runId: "r-ask",
    machineId: "machine-1",
    kind: "ask",
    instructions: "Entrar no painel com a conta de teste",
    status: "pending",
    requestedForUserId: "u-walter",
    controllerUserId: null,
    note: null,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
  state.messages.push({
    id: HANDOFF_ID,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: "Help needed in the browser: Entrar no painel com a conta de teste",
    mentionedAgentIds: [],
    agentRunId: "r-ask",
    createdAt: new Date().toISOString(),
    meta: { browserHandoff: handoff, bodyCode: "browser_handoff", bodyParams: { instructions: handoff.instructions } },
  } as (typeof state.messages)[number]);
  return { state, handoff };
}

describe("a help request opens the agent's browser in its card (NavegadorNoChat A)", () => {
  test("Abrir aqui takes control in place: Pronto in the header, the app's own text field, no page change", async () => {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const request = document.querySelector(".brw-rq") as HTMLElement;
    expect(request).toBeTruthy();
    expect(within(request).getByText("Abre neste card, sem sair do chat.")).toBeTruthy();

    await act(async () => fireEvent.click(within(request).getByRole("button", { name: "Abrir aqui" })));
    await settle(4);
    expect(state.calls.some((c) => c.method === "browser.takeControl")).toBe(true);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);

    const card = document.querySelector(".brw-ac") as HTMLElement;
    expect(card.classList.contains("is-open")).toBe(true);
    expect(card.classList.contains("is-control")).toBe(true);
    expect(card.querySelector(".brw-ac__tx small")?.textContent).toContain(
      "Você no controle · Entrar no painel com a conta de teste",
    );
    expect(within(card).getByRole("button", { name: "Pronto" })).toBeTruthy();
    expect(within(card).getByRole("textbox", { name: "Texto para a página" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Não consegui" })).toBeTruthy();
    expect(document.querySelector(".brw-rq")?.textContent).toContain("Você está ajudando · neste card");

    // Pronto hands back: the card folds away, the request says it's done.
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Pronto" })));
    await settle(4);
    expect(state.calls.some((c) => c.method === "browser.done")).toBe(true);
    expect(document.querySelector(".brw-ac")).toBeNull();
  });
});
