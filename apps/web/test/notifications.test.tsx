import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { AgentQuestion, AppNotification } from "@/api/types";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = (el: Element | Window, k: string, extra: KeyboardEventInit = {}) =>
  act(async () => fireEvent.keyDown(el, { key: k, ...extra }));
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const yesterdayNoon = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12).toISOString();
};

const question: AgentQuestion = {
  id: "q-1",
  agentId: ADA_ID,
  channelId: ENG_ID,
  threadId: "m-1",
  messageId: "m-q",
  text: "Uso o cupom antigo quando o novo falhar, ou bloqueio o checkout?",
  choices: ["Usa o cupom antigo", "Bloqueia o checkout"],
  status: "open",
  answer: null,
  answeredByUserId: null,
};

/** The inbox of the approved screen, on the fake backend's people and agents. */
function inbox(): AppNotification[] {
  return [
    notification({
      id: "n-q",
      kind: "agent_question",
      waiting: true,
      actors: [{ type: "agent", id: ADA_ID }],
      source: { channelId: ENG_ID, threadId: "m-1", questionId: "q-1" },
      latest: {
        title: question.text,
        text: "O serviço de cupons novo caiu 2 vezes hoje.",
        suggestions: question.choices ?? [],
      },
      createdAt: ago(25),
      updatedAt: ago(25),
    }),
    notification({
      id: "n-thread",
      kind: "thread_reply",
      actors: [
        { type: "user", id: "u-joao" },
        { type: "agent", id: ADA_ID },
      ],
      count: 2,
      source: { channelId: ENG_ID, threadId: "m-1", label: "Login 401" },
      latest: { text: "@walter dá para subir hoje ainda?" },
      updatedAt: ago(9),
    }),
    notification({
      id: "n-rx",
      kind: "reaction",
      actors: [
        { type: "user", id: "u-joao" },
        { type: "agent", id: ATLAS_ID },
      ],
      count: 2,
      source: { channelId: ENG_ID, messageId: "m-1" },
      latest: { emojis: ["🎉", "🚀"], quote: "A 2.4.0 está no ar." },
      updatedAt: ago(118),
    }),
    notification({
      id: "n-routine",
      kind: "routine_failed",
      actors: [{ type: "agent", id: ATLAS_ID }],
      source: { routineId: "r-1", label: "Resumo diário de vendas" },
      latest: { text: "O CRM pediu para conectar de novo.", steps: { done: 3, total: 5, failedAt: 4 } },
      readAt: yesterdayNoon(),
      updatedAt: yesterdayNoon(),
    }),
  ];
}

const go = async (state: FakeState = seedState({ notifications: inbox() })) => {
  state.messages.push({
    id: "m-q",
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ADA_ID },
    body: "",
    mentionedAgentIds: [],
    agentRunId: "r-1",
    meta: { question },
    createdAt: ago(25),
  });
  const r = await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};

describe("Notificações", () => {
  test("waiting on top with the agent looking up, the rest by day, filters with counts, the badge and the tab title", async () => {
    await go();
    expect(screen().getByRole("heading", { level: 1, name: "Notificações" })).toBeTruthy();
    const waiting = screen().getByRole("region", { name: "Esperando você" });
    expect(waiting.textContent).toContain("Ada está parada até você responder.");
    expect(waiting.textContent).toContain(question.text);
    expect(within(waiting).getByRole("button", { name: "Usa o cupom antigo" })).toBeTruthy();
    const today = screen().getByRole("region", { name: "Hoje" });
    expect(today.textContent).toContain("João e Ada responderam em Login 401");
    expect(today.textContent).toContain("2 reações");
    expect(screen().getByRole("region", { name: "Ontem" }).textContent).toContain("Parou na etapa 4 de 5");
    // My own @mention is highlighted.
    expect(today.querySelector(".ac-mention")?.textContent).toBe("@walter");
    const filters = screen().getByRole("radiogroup", { name: "Filtrar notificações" });
    expect(within(filters).getByRole("radio", { name: /Tudo/ }).textContent).toContain("4");
    expect(within(filters).getByRole("radio", { name: /Não lidas/ }).textContent).toContain("3");
    // The bell in the sidebar, and the tab.
    expect(screen().getByLabelText("3 notificações não lidas")).toBeTruthy();
    expect(document.title).toBe("(3) Notificações");
    await click(within(filters).getByRole("radio", { name: /Reações/ }));
    await settle(4);
    expect(screen().queryByRole("region", { name: "Esperando você" })).toBeNull();
    expect(document.body.textContent).toContain("reagiram à sua mensagem");
  });

  test("Feito leaves at once (optimistic) and Desfazer brings it back", async () => {
    const { state } = await go();
    const row = document.querySelector('[data-n="n-thread"]') as HTMLElement;
    await click(within(row).getByRole("button", { name: "Feito" }));
    await settle(4);
    expect(document.querySelector('[data-n="n-thread"]')).toBeNull();
    expect(state.calls.find((c) => c.method === "notifications.done")?.args).toEqual([ORG_ID, "n-thread", true]);
    expect(document.body.textContent).toContain("Marcado como feito");
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "notifications.done").at(-1)?.args).toEqual([
      ORG_ID,
      "n-thread",
      false,
    ]);
    expect(document.querySelector('[data-n="n-thread"]')).toBeTruthy();
  });

  test("a refused Feito puts the item back", async () => {
    const state = seedState({ notifications: inbox() });
    const { state: s } = await go(state);
    s.notifications = s.notifications?.filter((n) => n.id !== "n-thread");
    const row = document.querySelector('[data-n="n-thread"]') as HTMLElement;
    await click(within(row).getByRole("button", { name: "Feito" }));
    await settle(6);
    expect(document.querySelector('[data-n="n-thread"]')).toBeTruthy();
  });

  test("grouped replies expand from the thread; an inline reply goes to the thread", async () => {
    const { state } = await go();
    const row = document.querySelector('[data-n="n-thread"]') as HTMLElement;
    await click(within(row).getByRole("button", { name: "Ver 2 respostas" }));
    await settle(4);
    expect(row.textContent).toContain("Achei a causa");
    // Opening it marked it read.
    expect(state.calls.find((c) => c.method === "notifications.read")?.args).toEqual([ORG_ID, "n-thread", true]);
    await click(within(row).getByRole("button", { name: "Responder" }));
    const box = within(row).getByRole("textbox", { name: "Responder na thread" });
    await type(box, "Sobe sim, às 17h.");
    await key(box, "Enter", { metaKey: true });
    await settle(6);
    const post = state.calls.find((c) => c.method === "chat.post");
    expect(post?.args[1]).toBe(ENG_ID);
    expect(post?.args[2]).toMatchObject({ body: "Sobe sim, às 17h.", threadId: "m-1" });
    expect(row.textContent).toContain("Você respondeu: Sobe sim, às 17h.");
  });

  test("an agent's question: a suggestion fills the answer, Enviar answers through the question", async () => {
    const { state } = await go();
    const waiting = screen().getByRole("region", { name: "Esperando você" });
    await click(within(waiting).getByRole("button", { name: "Usa o cupom antigo" }));
    const box = within(waiting).getByRole("textbox", { name: "Responder à Ada" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Usa o cupom antigo");
    await click(within(waiting).getByRole("button", { name: "Enviar" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "questions.answer")?.args).toEqual([
      ORG_ID,
      "q-1",
      { choice: "Usa o cupom antigo" },
    ]);
    expect(document.body.textContent).toContain("Ada recebeu sua resposta");
  });

  test("keys: J moves, E marks done; Lembrar depois snoozes until a local time", async () => {
    const { state } = await go();
    await key(window, "j");
    await key(window, "j");
    expect((document.activeElement as HTMLElement).dataset.n).toBe("n-thread");
    await key(document.activeElement as Element, "e");
    await settle(4);
    expect(state.calls.find((c) => c.method === "notifications.done")?.args[1]).toBe("n-thread");
    const row = document.querySelector('[data-n="n-rx"]') as HTMLElement;
    const later = within(row).getByRole("button", { name: "Lembrar depois" });
    later.focus();
    await act(async () => {
      fireEvent.keyDown(later, { key: "Enter" });
      fireEvent.keyUp(later, { key: "Enter" });
    });
    await settle(2);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: /Amanhã às 9h/ }));
    await settle(4);
    const until = new Date(String(state.calls.find((c) => c.method === "notifications.snooze")?.args[2]));
    expect(until.getHours()).toBe(9);
    expect(until.getDate()).toBe(new Date(Date.now() + 86_400_000).getDate());
    expect(document.querySelector('[data-n="n-rx"]')).toBeNull();
  });

  test("Marcar tudo como lido, then Desfazer marks the same ones unread", async () => {
    const { state } = await go();
    await click(screen().getByRole("button", { name: "Marcar tudo como lido" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "notifications.readAll")?.args).toEqual([ORG_ID, "all"]);
    expect(document.body.textContent).toContain("3 marcadas como lidas");
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(6);
    const undone = state.calls.filter((c) => c.method === "notifications.read").map((c) => c.args[1]);
    expect(undone.sort()).toEqual(["n-q", "n-rx", "n-thread"]);
  });

  test("Abrir goes to the source and marks it read", async () => {
    const { state, router } = await go();
    const row = document.querySelector('[data-n="n-thread"]') as HTMLElement;
    await click(within(row).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/threads/m-1`);
    expect(state.calls.find((c) => c.method === "notifications.read")?.args).toEqual([ORG_ID, "n-thread", true]);
  });

  test("live: a new notification lands from the WebSocket; a resolved one leaves; the badge follows", async () => {
    const { sockets } = await go();
    const socket = sockets.last();
    await act(async () => socket.open());
    await act(async () =>
      socket.push({
        type: "event",
        scope: "user",
        event: {
          type: "notification.upserted",
          notification: notification({
            id: "n-new",
            kind: "dm",
            actors: [{ type: "user", id: "u-joao" }],
            source: { dmId: "dm-1" },
            latest: { text: "Te mandei o contrato, dá uma olhada no item 4?" },
          }),
        },
      }),
    );
    await settle(4);
    expect(document.querySelector('[data-n="n-new"]')?.textContent).toContain("João mandou uma mensagem");
    await act(async () =>
      socket.push({ type: "event", scope: "user", event: { type: "notification.removed", id: "n-q" } }),
    );
    await act(async () =>
      socket.push({ type: "event", scope: "user", event: { type: "notification.counts", unread: 7, waiting: 0 } }),
    );
    await settle(4);
    expect(screen().queryByRole("region", { name: "Esperando você" })).toBeNull();
    expect(screen().getByLabelText("7 notificações não lidas")).toBeTruthy();
  });

  test("empty: Tudo em dia", async () => {
    await go(seedState({ notifications: [] }));
    expect(document.body.textContent).toContain("Tudo em dia");
    expect((screen().getByRole("button", { name: "Marcar tudo como lido" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
