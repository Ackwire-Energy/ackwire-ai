import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { SecretBox } from "@agenteschat/client";
import { secretAad } from "@agenteschat/client/lib/secret-box";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
// The computer's side, from the server code: what the card seals must open there.
import { generateSecretKeyPair, openSecret } from "../../../packages/adapters/src/secret-box";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

async function withRequest(requestedForUserId: string, publicKey: string, expiresAt = Date.now() + 15 * 60_000) {
  const state = seedState();
  const secretRequest = {
    id: "00000000-0000-4000-8000-0000000000e1",
    agentId: ADA_ID,
    channelId: ENG_ID,
    threadId: null,
    messageId: "msg-s",
    requestedForUserId,
    name: "NPM_TOKEN",
    purpose: "publicar o pacote no npm",
    target: { kind: "env" as const },
    machineId: null,
    publicKey,
    status: "pending" as const,
    expiresAt: new Date(expiresAt).toISOString(),
    deliveredAt: null,
    removed: false,
  };
  state.messages.push({
    id: "msg-s",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: "Pedido de segredo: NPM_TOKEN",
    mentionedAgentIds: [],
    agentRunId: "r-s",
    meta: { secretRequestId: secretRequest.id, secretRequest },
    createdAt: new Date().toISOString(),
  });
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  await act(async () => r.sockets.last().open());
  await settle(2);
  return { state, secretRequest };
}

describe("secret requests (ADR 0027)", () => {
  test("the person asked types it; it leaves the browser sealed to the computer's key and opens there", async () => {
    const pair = await generateSecretKeyPair();
    const { state, secretRequest } = await withRequest("u-walter", pair.publicKey);
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    // The request card: what kind of request, that it waits for you, and the secret it names.
    expect(card.getAttribute("data-ask-kind")).toBe("secret");
    expect(card.textContent).toContain("Pede um segredo");
    expect(card.textContent).toContain("esperando você");
    expect(card.textContent).toContain("publicar o pacote no npm");
    expect(card.textContent).toContain("NPM_TOKEN");
    expect(card.textContent).toContain("Vai como a variável NPM_TOKEN no computador de Ada.");
    const field = within(card).getByLabelText("Valor de NPM_TOKEN") as HTMLInputElement;
    expect(field.type).toBe("password");
    await type(field, "npm_live_abc123");
    await click(within(card).getByRole("button", { name: "Enviar" }));
    await settle(6);

    const call = state.calls.find((c) => c.method === "secrets.deliver");
    expect(call?.args.slice(0, 2)).toEqual([ORG_ID, secretRequest.id]);
    const box = call?.args[2] as SecretBox;
    // What went to the server is a box, never the value.
    expect(JSON.stringify(call?.args)).not.toContain("npm_live_abc123");
    const aad = secretAad({ requestId: secretRequest.id, orgId: ORG_ID, name: "NPM_TOKEN", target: { kind: "env" } });
    expect(await openSecret(pair.privateKey, box, aad)).toBe("npm_live_abc123");

    // Once sent, one line takes its place (another element): look it up again.
    const done = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(done.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    expect(done.textContent).toContain("Você entregou às");
    expect(within(done).queryByLabelText("Valor de NPM_TOKEN")).toBeNull();
    expect(done.hasAttribute("data-ask-id")).toBe(false);
  });

  test("someone else sees who was asked, and no field", async () => {
    const pair = await generateSecretKeyPair();
    await withRequest("u-joao", pair.publicKey);
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(card.textContent).toContain("esperando João");
    expect(card.textContent).not.toContain("esperando você");
    expect(within(card).queryByLabelText("Valor de NPM_TOKEN")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Enviar" })).toBeNull();
    // Not the viewer's to answer: the activity bar never brings it back.
    expect(card.hasAttribute("data-ask-mine")).toBe(false);
  });

  test("Recusar closes it", async () => {
    const pair = await generateSecretKeyPair();
    const { state } = await withRequest("u-walter", pair.publicKey);
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    await click(within(card).getByRole("button", { name: "Recusar" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "secrets.decline")).toBe(true);
    const done = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(done.textContent).toContain("Recusado: NPM_TOKEN");
    expect(done.querySelector(".rq-done__mark[data-done]")).toBeNull();
  });

  // Real time passes in it (the request's own timer), so it gets more than the default 5 s.
  test("past its time with no event: the field goes and it reads as expired", async () => {
    const pair = await generateSecretKeyPair();
    const expiresAt = Date.now() + 3_000;
    await withRequest("u-walter", pair.publicKey, expiresAt);
    const card = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(card.hasAttribute("data-ask-mine")).toBe(true);
    // Nothing comes from the server: the card's own timer closes it at that moment.
    await act(() => new Promise((r) => setTimeout(r, Math.max(0, expiresAt - Date.now()) + 50)));
    await settle(2);
    const done = screen().getByRole("group", { name: "Pedido de segredo de Ada" });
    expect(done.hasAttribute("data-ask-id")).toBe(false);
    expect(within(done).queryByLabelText("Valor de NPM_TOKEN")).toBeNull();
    expect(done.textContent).toContain("Expirou: NPM_TOKEN");
  }, 15_000);
});
