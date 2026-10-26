import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AiStatus, MachineAccount, Message } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, fakeMachinesOf, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

type State = ReturnType<typeof seedState>;

/** Ada and Atlas: the ones listed have no AI; `any` as the organization's. */
const aiStatus = (any: boolean, ...without: string[]): AiStatus => ({
  any,
  agents: [ADA_ID, ATLAS_ID].map((agentId) =>
    without.includes(agentId) ? { agentId, state: "no_ai", reason: "no_key" } : { agentId, state: "ready" },
  ),
});

/** Ada's card in #eng: she can't answer Walter's message (`intent`: what Jev read in it). */
const card = (noAi: Record<string, unknown> = {}): Message => ({
  id: "m-noai",
  channelId: ENG_ID,
  threadId: null,
  author: { type: "agent", id: ADA_ID },
  body: "I can't answer yet: I have no AI connected.",
  mentionedAgentIds: [],
  agentRunId: "r-noai",
  meta: {
    bodyCode: "no_ai",
    noAi: { agentId: ADA_ID, forUserId: "u-walter", reason: "no_key", intent: "task", runId: "r-noai", ...noAi },
  },
  createdAt: NOW.toISOString(),
});

/** A plan thinks only for its owner's agents (ADR 0059 §3): these become Walter's, so he may connect his. */
const walters = (state: State, ...agentIds: string[]) => {
  for (const a of state.agents) if (agentIds.includes(a.id)) a.ownerUserId = "u-walter";
  return state;
};

const withCard = (noAi: Record<string, unknown> = {}, status = aiStatus(false, ADA_ID, ATLAS_ID)) => {
  const state = seedState({ aiStatus: status });
  state.messages.push(card(noAi));
  return state;
};

const open = async (state: State = seedState(), path = `c/${ENG_ID}`) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, api, socket, state };
};
const push = (socket: { push: (f: unknown) => void }, event: Record<string, unknown>) =>
  act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
const click = async (el: HTMLElement, rounds = 4) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};
const calls = (state: State, method: string) => state.calls.filter((c) => c.method === method);
const banner = () => document.querySelector(".noai-banner") as HTMLElement | null;
const cardRow = () =>
  screen()
    .getAllByRole("article")
    .find((a) => a.querySelector(".waitcard")) as HTMLElement;
const dialog = (name: string | RegExp) => screen().queryByRole("dialog", { name });
/** The receipt under my message with this text. */
const receiptOf = (text: string) =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes(text))
    ?.querySelector(".ac-receipt") as HTMLElement;
const sendText = async (text: string) => {
  const box = screen().getByRole("combobox", { name: /Mensagem para/ });
  await act(async () => fireEvent.change(box, { target: { value: text } }));
  await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
  await settle(4);
};

describe("no AI connected: above the composer", () => {
  test("the organization has none: everyone sees it in a channel with agents; Connect opens the first step", async () => {
    await open(walters(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }), ADA_ID));
    const shown = banner();
    expect(shown?.textContent).toContain("Os agentes ainda não têm uma IA para pensar.");
    expect(shown?.textContent).toContain("escreva o que quer, como “usar meu plano do Claude”");
    await click(within(shown as HTMLElement).getByRole("button", { name: "Conectar uma IA" }));
    const first = dialog("Conectar uma IA") as HTMLElement;
    for (const option of [/^Plano do Claude/, /^Plano do ChatGPT/, /^Chave de API/])
      expect(within(first).getByRole("button", { name: option })).toBeTruthy();
  });

  test("an admin with no agent of their own: only an API key (a plan thinks only for its owner's agents)", async () => {
    await open(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }));
    await click(within(banner() as HTMLElement).getByRole("button", { name: "Conectar uma IA" }));
    const first = dialog("Conectar uma IA") as HTMLElement;
    expect(within(first).getByRole("button", { name: /^Chave de API/ })).toBeTruthy();
    for (const option of [/^Plano do Claude/, /^Plano do ChatGPT/])
      expect(within(first).queryByRole("button", { name: option })).toBeNull();
  });

  test("a DM with an agent that has none says so for that agent; an organization with AI shows nothing in channels", async () => {
    const state = seedState({ aiStatus: aiStatus(true, ADA_ID) });
    await open(state, `dm/agent/${ADA_ID}`);
    expect(banner()?.textContent).toContain("Ada não vai responder porque não tem uma IA conectada.");
    cleanup();
    await open(seedState({ aiStatus: aiStatus(true, ADA_ID) }));
    expect(banner()).toBeNull();
  });

  test("the agent's page: 'Sem IA' by its name opens Connect for that agent", async () => {
    await open(seedState({ aiStatus: aiStatus(true, ADA_ID) }), `agents/${ADA_ID}`);
    await click(screen().getByRole("button", { name: "Sem IA" }));
    expect(dialog("Conectar uma IA")).not.toBeNull();
  });
});

describe("the agent's no-AI card", () => {
  test("in place of its text, with Connect at the step the message asked for; a key saved there answers by itself", async () => {
    const state = withCard({ intent: "api_key", provider: "openai" });
    await open(state);
    const row = cardRow();
    expect(row.textContent).toContain("Ada não vai responder porque não tem uma IA conectada.");
    // Walter asked: the card tells him she answers once it's connected.
    expect(row.textContent).toContain("Depois de conectar, Ada responde a sua mensagem.");
    expect(row.textContent).not.toContain("Ainda não consigo responder");
    await click(within(row).getByRole("button", { name: "Conectar" }));
    const add = dialog("Adicionar uma chave de API") as HTMLElement;
    expect(within(add).getByRole("combobox", { name: "Provedor" }).textContent).toContain("OpenAI");
    await act(async () =>
      fireEvent.change(within(add).getByLabelText("Chave da API"), {
        target: { value: "sk-proj-abcdefghijklmnop1234" },
      }),
    );
    state.aiStatus = aiStatus(true);
    await click(within(add).getByRole("button", { name: "Salvar chave" }), 8);
    expect(calls(state, "agents.addCredential")[0]?.args[1]).toMatchObject({ provider: "openai" });
    expect(calls(state, "chat.answerNow").map((c) => c.args)).toEqual([[ORG_ID, "m-noai"]]);
    expect(cardRow().textContent).toContain("Ada está respondendo…");
  });

  test("a Claude plan: signed in on Ada's computer, then 'Usar meu plano do Claude' makes it her brain and she answers", async () => {
    const account: MachineAccount = {
      id: "acct_1",
      kind: "claude_code",
      label: "Walter",
      email: "walter@acme.com.br",
      plan: "max",
      status: "active",
      ownerId: "u-walter",
      ownerName: "Walter",
      mine: true,
      usedBy: [],
      usage: null,
      provider: null,
      keyHint: null,
    };
    const state = walters(withCard({ intent: "claude" }), ADA_ID);
    const api = createFakeApi(state);
    // The computer finishes the sign-in as soon as the page asks.
    fakeMachinesOf.get(api)?.endLogin("login_1", { state: "done", account });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    await click(within(cardRow()).getByRole("button", { name: "Conectar" }), 8);
    const plan = dialog("Conectar o seu plano do Claude") as HTMLElement;
    // Choosing a plan asks nothing: she then answers only him until he shares it (ADR 0059 §5).
    expect(plan.textContent).toContain("Usa o seu plano. Os outros veem que a Ada só responde a você.");
    // Claude's sign-in starts on its button, in a window of its own.
    const realOpen = window.open;
    const popup = { closed: false, opener: {}, location: { href: "" }, close: () => {} };
    window.open = (() => popup) as unknown as typeof window.open;
    try {
      await click(within(plan).getByRole("button", { name: "Entrar com Claude" }), 8);
    } finally {
      window.open = realOpen;
    }
    expect(calls(state, "machines.beginAccountLogin")[0]?.args).toEqual([ORG_ID, "machine_1", "claude_code"]);
    expect(plan.textContent).toContain("A conta Walter entrou no MacBook.");
    await click(within(plan).getByRole("button", { name: "Usar meu plano do Claude" }), 8);
    expect(calls(state, "agents.setBrain")[0]?.args).toEqual([
      ORG_ID,
      ADA_ID,
      { brain: "claude_code", account: "acct_1" },
    ]);
    expect(calls(state, "chat.answerNow").map((c) => c.args)).toEqual([[ORG_ID, "m-noai"]]);
    expect(dialog("Conectar o seu plano do Claude")).toBeNull();
  });

  test("a plan while the workspace's computer is on its way: it waits, for the time left; a key meanwhile", async () => {
    const state = walters(withCard({ intent: "claude" }), ADA_ID);
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ state: "preparing", step: "installing", secondsLeft: 330 });
    const brain = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({ ...(await brain(orgId, agentId)), computer: null });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    await click(within(cardRow()).getByRole("button", { name: "Conectar" }), 8);
    const plan = dialog("Conectar o seu plano do Claude") as HTMLElement;
    expect(plan.textContent).toContain(
      "Disponível quando o computador ficar pronto. Dá para usar uma chave de API agora.",
    );
    expect(plan.textContent).toContain("Faltam uns 6 min");
    expect(within(plan).getByRole("button", { name: "Chave de API" })).toBeTruthy();
  });

  test("connected elsewhere: 'Responder agora'; still no AI: it says so and keeps Connect", async () => {
    const state = withCard({}, aiStatus(true));
    await open(state);
    expect(cardRow().textContent).toContain("Pronto: Ada já tem uma IA.");
    state.answerNowError = new ApiError(409, "ai.still_missing", "There is still no AI connected");
    await click(within(cardRow()).getByRole("button", { name: "Responder agora" }));
    expect(calls(state, "chat.answerNow").map((c) => c.args)).toEqual([[ORG_ID, "m-noai"]]);
    expect(cardRow().textContent).toContain("Ainda falta conectar uma IA para Ada.");
    expect(within(cardRow()).getByRole("button", { name: "Conectar" })).toBeTruthy();
  });

  test("someone without the rights is told who connects it (an admin with a key, the owner with a plan)", async () => {
    const state = withCard();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await open(state);
    // Not who asked: no "it answers your message" line.
    await click(within(cardRow()).getByRole("button", { name: "Conectar" }));
    expect(dialog("Conectar uma IA")?.textContent).toContain(
      "Quem conecta a IA de Ada: um admin, com uma chave de API, ou João, com o próprio plano.",
    );
  });
});

describe("receipts and the live block", () => {
  test("routed to nobody for want of an AI: 'Ninguém vai responder: falta uma IA · Conectar' under the message", async () => {
    const { socket, state } = await open(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }));
    await sendText("alguém resume o canal?");
    const mine = state.messages.at(-1) as Message;
    await push(socket, {
      type: "message.routed",
      messageId: mine.id,
      seenBy: [],
      pickedBy: [],
      strategy: "none",
      reason: "no_ai",
      intent: "task",
    });
    const receipt = receiptOf("alguém resume o canal?");
    expect(receipt.textContent).toContain("Ninguém vai responder: falta uma IA ·");
    await click(within(receipt).getByRole("button", { name: "Conectar" }));
    expect(dialog("Conectar uma IA")).not.toBeNull();
  });

  test("a mentioned agent that can't think: its receipt says so, and its block leaves no failure behind", async () => {
    const { socket, state } = await open(seedState({ aiStatus: aiStatus(true, ADA_ID) }));
    await sendText("@ada e o login?");
    const mine = state.messages.at(-1) as Message;
    // Asked in the channel, answered in the channel: its events carry no thread.
    const run = { threadId: null, runId: "r-ada", agentId: ADA_ID, triggerMessageId: mine.id };
    await push(socket, { type: "agent.thinking", ...run });
    await push(socket, { type: "agent.run", ...run, status: "failed", error: "no_ai" });
    await push(socket, { type: "run.finished", ...run, status: "failed", error: "no_ai" });
    await push(socket, { type: "message.handled", messageId: mine.id, ...run, status: "failed", reason: "no_ai" });
    await settle();
    expect(document.querySelector(".ac-msg__error")).toBeNull();
    const receipt = receiptOf("e o login?");
    const check = receipt.querySelector(".ac-receipt__check") as HTMLElement;
    expect(check.getAttribute("aria-label")).toBe("Vista por Ada; Ninguém vai responder: falta uma IA");
    expect(receipt.textContent).toContain("Ninguém vai responder: falta uma IA ·");
    expect(receipt.textContent).not.toContain("Tentar de novo");
  });
});

describe("the dialog opens by itself only when Jev is sure, for the author, once", () => {
  const routed = (messageId: string, extra: Record<string, unknown>) => ({
    type: "message.routed",
    messageId,
    seenBy: [],
    pickedBy: [],
    strategy: "none",
    reason: "no_ai",
    ...extra,
  });

  test("my message asking for a Claude plan (≥ 0.9): the plan step opens; never twice, never for someone else's", async () => {
    const { socket, state } = await open(walters(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }), ADA_ID));
    // João's message: not mine.
    await push(socket, routed("m-1", { intent: "claude", autoOpen: true }));
    expect(dialog("Conectar o seu plano do Claude")).toBeNull();
    await sendText("quero usar meu plano do Claude");
    const mine = state.messages.at(-1) as Message;
    // Below 0.9 the step is only offered, never opened.
    await push(socket, routed(mine.id, { intent: "claude" }));
    expect(dialog("Conectar o seu plano do Claude")).toBeNull();
    await push(socket, routed(mine.id, { intent: "claude", autoOpen: true }));
    const plan = dialog("Conectar o seu plano do Claude") as HTMLElement;
    expect(plan).not.toBeNull();
    await click(within(plan).getByRole("button", { name: "Fechar" }));
    expect(dialog("Conectar o seu plano do Claude")).toBeNull();
    await push(socket, routed(mine.id, { intent: "claude", autoOpen: true }));
    expect(dialog("Conectar o seu plano do Claude")).toBeNull();
  });

  test("a card: only for who asked, never for `any`, never in a window nobody looks at", async () => {
    const { socket } = await open(seedState({ aiStatus: aiStatus(false, ADA_ID, ATLAS_ID) }));
    const created = (id: string, noAi: Record<string, unknown>) =>
      push(socket, { type: "message.created", messageId: id, message: { ...card(noAi), id } });
    await created("c-joao", { forUserId: "u-joao", intent: "api_key", autoOpen: true });
    await created("c-any", { intent: "any", autoOpen: true });
    expect(screen().queryByRole("dialog")).toBeNull();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      await created("c-hidden", { intent: "api_key", autoOpen: true });
      expect(screen().queryByRole("dialog")).toBeNull();
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
    await created("c-mine", { intent: "api_key", autoOpen: true });
    expect(dialog("Adicionar uma chave de API")).not.toBeNull();
  });
});
