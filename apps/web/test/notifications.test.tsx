import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, AgentQuestion, AppNotification } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { dispatchPushOpen, pushOpenPath } from "../src/lib/push-open";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = (el: Element | Window, k: string, extra: KeyboardEventInit = {}) =>
  act(async () => fireEvent.keyDown(el, { key: k, ...extra }));
/** Minutes ago, squeezed into today (same order) when the suite runs soon after midnight. */
const ago = (m: number) => {
  const now = Date.now();
  const sinceMidnight = (now - new Date().setHours(0, 0, 0, 0)) / 60_000 - 1;
  const k = sinceMidnight < 120 ? Math.max(0, sinceMidnight) / 120 : 1;
  return new Date(now - m * k * 60_000).toISOString();
};
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

/** The design's sample inbox, on the fake backend's people and agents. */
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
      latest: { reason: "budget_exceeded", steps: { done: 3, total: 5, failedAt: 4 } },
      readAt: yesterdayNoon(),
      updatedAt: yesterdayNoon(),
    }),
  ];
}

const go = async (state: FakeState = seedState({ notifications: inbox() })) => {
  // The "Login 401" thread: Ada's reply there (the seed's channel messages are all top-level).
  state.messages.push({
    id: "m-thread-ada",
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ADA_ID },
    body: "Corrigi o refresh: o PR #42 está aberto.",
    mentionedAgentIds: [],
    agentRunId: "r-1",
    createdAt: ago(30),
  });
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
  test("how many are unread is under the title from the first paint, before the list arrives", async () => {
    const state = seedState({
      notifications: [notification({ id: "n-a", kind: "mention" }), notification({ id: "n-b", kind: "mention" })],
    });
    const api = createFakeApi(state);
    // The list never answers: only the count the sidebar loads at start is there.
    api.notifications.list = () => new Promise(() => {});
    await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(4);
    const title = screen().getByRole("heading", { level: 1, name: "Notificações" });
    expect(title.nextElementSibling?.className).toBe("ac-pagehead__meta");
    expect(title.nextElementSibling?.textContent).toContain("2 não lidas");
  });

  test("waiting on top with the agent looking up, the rest by day, filters with counts, the badge and the tab title", async () => {
    await go();
    const title = screen().getByRole("heading", { level: 1, name: "Notificações" });
    // How many are unread: the header's line, right under the title.
    expect(title.nextElementSibling?.className).toBe("ac-pagehead__meta");
    expect(title.nextElementSibling?.textContent).toContain("3 não lidas");
    const waiting = screen().getByRole("region", { name: "Esperando você" });
    expect(waiting.textContent).toContain("Ada está parada até você responder.");
    expect(waiting.textContent).toContain(question.text);
    expect(within(waiting).getByRole("button", { name: "Usa o cupom antigo" })).toBeTruthy();
    const today = screen().getByRole("region", { name: "Hoje" });
    expect(today.textContent).toContain("João e Ada responderam em Login 401");
    expect(today.textContent).toContain("2 reações");
    const yesterday = screen().getByRole("region", { name: "Ontem" }).textContent ?? "";
    expect(yesterday).toContain("Parou na etapa 4 de 5");
    // A routine's failure in the person's words (its coded reason), never the server's English.
    expect(yesterday).toContain("O orçamento do mês acabou");
    // My own @mention is highlighted.
    expect(today.querySelector(".ac-mention")?.textContent).toBe("@walter");
    // The list ends with its last day: no note under it.
    expect(document.querySelector(".nt")?.lastElementChild?.getAttribute("aria-label")).toBe("Ontem");
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

  test("an approval says who wants what in one sentence, who asked, and the agent's why behind Por quê?", async () => {
    const asked = notification({
      id: "n-ap",
      kind: "approval",
      waiting: true,
      actors: [{ type: "agent", id: ATLAS_ID }],
      source: { approvalId: "ap-deploy", channelId: ENG_ID },
      latest: {
        title: "Run deploy workflow",
        text: "O erro 500 voltou depois do deploy 2.14.",
        origin: { kind: "routine", routineId: "rt-1", routineName: "Vigiar erros" },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      createdAt: ago(5),
      updatedAt: ago(5),
    });
    await go(seedState({ notifications: [asked] }));
    const region = screen().getByRole("region", { name: "Esperando você" });
    const text = region.textContent ?? "";
    expect(text).toContain("Pedido pela rotina «Vigiar erros» enquanto ninguém acompanhava");
    expect(text).toContain("Atlas quer fazer um deploy");
    expect(text).not.toContain("O erro 500 voltou depois do deploy 2.14.");
    await click(within(region).getByRole("button", { name: "Por quê?" }));
    expect(region.textContent).toContain("O erro 500 voltou depois do deploy 2.14.");
    // Decided right here: a deploy takes a hold, and Recusar asks for the reason.
    expect(within(region).getByRole("button", { name: /segure para confirmar/ })).toBeTruthy();
    await click(within(region).getByRole("button", { name: "Recusar" }));
    expect(region.querySelector("textarea")).toBeTruthy();
  });

  test("who is stopped until I answer: up to three agents by name, then how many more", async () => {
    const asking = (agentId: string, m: number) =>
      notification({
        id: `n-${agentId}`,
        kind: "approval",
        waiting: true,
        actors: [{ type: "agent", id: agentId }],
        source: { approvalId: `ap-${m}`, channelId: ENG_ID },
        latest: { title: "Run deploy workflow" },
        createdAt: ago(m),
        updatedAt: ago(m),
      });
    const stopped = async (count: number) => {
      const state = seedState();
      const ada = state.agents[0] as Agent;
      state.agents.push(
        { ...ada, id: "00000000-0000-4000-8000-0000000000a3", name: "Lia", handle: "lia" },
        { ...ada, id: "00000000-0000-4000-8000-0000000000a4", name: "Theo", handle: "theo" },
      );
      state.notifications = state.agents.slice(0, count).map((a, i) => asking(a.id, i + 1));
      await go(state);
      const text = screen().getByRole("region", { name: "Esperando você" }).querySelector(".nt-wh small")?.textContent;
      cleanup();
      return text;
    };
    expect(await stopped(2)).toBe("Ada e Atlas estão parados até você responder.");
    expect(await stopped(4)).toBe("Ada, Atlas, Lia e mais 1 estão parados até você responder.");
  });

  test("Feito leaves at once (optimistic) and Desfazer brings it back", async () => {
    const { state } = await go();
    const row = document.querySelector('[data-n="n-thread"]') as HTMLElement;
    await click(within(row).getByRole("button", { name: "Feito" }));
    await settle(4);
    expect(document.querySelector('[data-n="n-thread"]')).toBeNull();
    expect(state.calls.find((c) => c.method === "notifications.done")?.args).toEqual([ORG_ID, "n-thread", true]);
    expect(document.body.textContent).toContain("Marcado como feito");
    // Nobody waits on a thread's notice: the toast is one line.
    expect(document.querySelector(".ac-toast__detail")).toBeNull();
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
    expect(row.textContent).toContain("Corrigi o refresh: o PR #42 está aberto.");
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

  test("grouped task comments expand from the task's conversation (ADR 0145)", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const issue = await api.issues.get(ORG_ID, 131);
    const at = await api.issues.conversation(ORG_ID, issue.id);
    for (const [id, body, m] of [
      ["m-task-1", "Comecei pelo template.", 8],
      ["m-task-2", "Mandei o lembrete pelo WhatsApp.", 5],
    ] as const) {
      state.messages.push({
        id,
        channelId: at.channelId,
        threadId: at.rootId,
        author: { type: "agent", id: ADA_ID },
        body,
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: ago(m),
      });
    }
    state.notifications = [
      notification({
        id: "n-task",
        kind: "issue_comment",
        actors: [{ type: "agent", id: ADA_ID }],
        count: 2,
        source: { issueId: issue.id, issueNumber: 131, label: issue.title },
        latest: { text: "Mandei o lembrete pelo WhatsApp.", title: issue.title },
        updatedAt: ago(5),
      }),
    ];
    await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(8);
    const row = document.querySelector('[data-n="n-task"]') as HTMLElement;
    await click(within(row).getByRole("button", { name: "Ver 2 comentários" }));
    await settle(6);
    const shown = row.querySelector(".nt-reps")?.textContent;
    expect(shown).toContain("Comecei pelo template.");
    expect(shown).toContain("Mandei o lembrete pelo WhatsApp.");
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

  test("Lembrar depois, then Desfazer brings it back (snooze with until null)", async () => {
    const { state } = await go();
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
    expect(document.querySelector('[data-n="n-rx"]')).toBeNull();
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(6);
    const calls = state.calls.filter((c) => c.method === "notifications.snooze").map((c) => c.args[2]);
    expect(calls.at(-1)).toBeNull();
    expect(document.querySelector('[data-n="n-rx"]')).not.toBeNull();
  });

  test("Marcar tudo como lido, then Desfazer marks the same ones unread", async () => {
    const { state } = await go();
    await click(screen().getByRole("button", { name: "Marcar tudo como lido" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "notifications.readAll")?.args).toEqual([ORG_ID, "all"]);
    expect(document.body.textContent).toContain("3 marcadas como lidas");
    expect(document.querySelector(".ac-toast__detail")).toBeNull();
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
    expect(document.querySelector(".ac-empty--page")?.textContent).toBe(
      "Tudo em diaQuando alguém precisar de você, aparece aqui.",
    );
    expect((screen().getByRole("button", { name: "Marcar tudo como lido" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("a new computer connected (ADR 0036, admins)", () => {
  test("who connected which computer; Abrir goes to the computer's page", async () => {
    const connected = notification({
      id: "n-machine",
      kind: "machine_connected",
      actors: [{ type: "user", id: "u-joao" }],
      source: { machineId: "m-9", label: "MacBook do João" },
      latest: {},
      updatedAt: ago(3),
    });
    const { router } = await go(seedState({ notifications: [connected] }));
    const row = document.querySelector('[data-n="n-machine"]') as HTMLElement;
    expect(row.textContent).toContain("João conectou o computador MacBook do João");
    expect(row.textContent).toContain("Computador");
    await click(within(row).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/computers/m-9`);
  });
});

describe("someone gave an agent the person's plan (ADR 0059 §3)", () => {
  test("who connected it to which agent, and Tirar de volta takes it back from that agent or from all", async () => {
    const lent = notification({
      id: "n-lent",
      kind: "plan_lent",
      actors: [{ type: "user", id: "u-joao" }],
      source: { agentId: ADA_ID, accountId: "acct_wes", label: "Ada" },
      latest: { plan: "Claude" },
      updatedAt: ago(3),
    });
    const { state } = await go(seedState({ notifications: [lent] }));
    const row = document.querySelector('[data-n="n-lent"]') as HTMLElement;
    expect(row.textContent).toContain("João conectou o seu plano do Claude à\u00a0Ada");
    await click(within(row).getByRole("button", { name: "Tirar de volta" }));
    await settle(4);
    await click(within(row).getByRole("button", { name: "Tirar de todos os agentes" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "machines.takeBackPlan").map((c) => c.args)).toEqual([
      [ORG_ID, "acct_wes", ADA_ID],
      [ORG_ID, "acct_wes", undefined],
    ]);
    expect(document.body.textContent).toContain("Seu plano voltou");
  });
});

describe("an agent's model left its plan's list", () => {
  test("which model, which plan, what runs now; Escolher outro modelo opens the agent's Quem pensa", async () => {
    const dropped = notification({
      id: "n-dropped",
      kind: "plan_model_dropped",
      actors: [{ type: "agent", id: ADA_ID }],
      source: { agentId: ADA_ID, label: "Ada" },
      latest: { title: "DeepSeek V4.1 Flash", plan: "OpenCode Go", nowModel: "MiniMax M3" },
      updatedAt: ago(3),
    });
    const { router } = await go(seedState({ notifications: [dropped] }));
    const row = document.querySelector('[data-n="n-dropped"]') as HTMLElement;
    expect(row.textContent).toContain(
      "O DeepSeek V4.1 Flash saiu do OpenCode Go. Ada está usando o MiniMax M3 até você escolher outro modelo.",
    );
    await click(within(row).getByRole("button", { name: "Escolher outro modelo" }));
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${ADA_ID}`);
    expect(screen().getByRole("dialog", { name: "Quem pensa" })).toBeTruthy();
  });
});

describe("agents that failed for one cause (ADR 0097)", () => {
  const failure = (agentId: string, messageId: string) => ({
    key: `run_failed:${agentId}:${ENG_ID}:${messageId}`,
    agentId,
    channelId: ENG_ID,
    messageId,
    label: "eng",
  });
  test("one row says how many and why, opens to each agent, and each goes to its conversation", async () => {
    const grouped = notification({
      id: "n-fails",
      kind: "run_failed",
      count: 2,
      actors: [
        { type: "agent", id: ATLAS_ID },
        { type: "agent", id: ADA_ID },
      ],
      source: { channelId: ENG_ID, messageId: "m-a", agentId: ADA_ID, label: "eng" },
      latest: {
        reason: "not_logged_in",
        plan: "Claude",
        failures: [failure(ADA_ID, "m-a"), failure(ATLAS_ID, "m-b")],
      },
      updatedAt: ago(2),
    });
    const lone = notification({
      id: "n-fail",
      kind: "run_failed",
      actors: [{ type: "agent", id: ADA_ID }],
      source: { channelId: ENG_ID, messageId: "m-c", agentId: ADA_ID, label: "eng" },
      latest: { reason: "budget_exceeded", failures: [failure(ADA_ID, "m-c")] },
      updatedAt: ago(4),
    });
    const { router } = await go(seedState({ notifications: [grouped, lone] }));
    const row = document.querySelector('[data-n="n-fails"]') as HTMLElement;
    expect(row.querySelector(".nt-what")?.textContent).toBe(
      "2 agentes não conseguiram continuar: a conta do Claude foi desconectada",
    );
    // A lone failure reads as it always did.
    expect(document.querySelector('[data-n="n-fail"] .nt-what')?.textContent).toBe("Ada não conseguiu terminar");
    await click(within(row).getByRole("button", { name: "Ver 2 agentes" }));
    await settle(2);
    const agents = [...row.querySelectorAll(".nt-fails .nt-rep")];
    expect(agents.map((a) => a.textContent)).toEqual(["Ada#eng", "Atlas#eng"]);
    await click(agents[1] as Element);
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });
});

describe("what the workspace itself tells: nobody's face, its own", () => {
  test("its computer ready, its standing: an icon where the face goes, and unread in the headline's weight", async () => {
    const ready = notification({ id: "n-ready", kind: "computer_ready", updatedAt: ago(3) });
    const hold = notification({
      id: "n-hold",
      kind: "org_standing",
      latest: { statusTo: "hold" },
      readAt: ago(1),
      updatedAt: ago(2),
    });
    await go(seedState({ notifications: [ready, hold] }));
    const row = (id: string) => document.querySelector(`[data-n="${id}"]`) as HTMLElement;
    expect(row("n-ready").textContent).toContain("O computador do seu workspace está pronto");
    for (const id of ["n-ready", "n-hold"]) expect(row(id).querySelector(".nt-who .nt-sys svg")).toBeTruthy();
    expect(row("n-ready").classList.contains("is-unread")).toBe(true);
    expect(row("n-hold").classList.contains("is-unread")).toBe(false);
    // With nobody to name, a screen reader reads what it tells.
    expect(row("n-ready").getAttribute("aria-label")).toBe("O computador do seu workspace está pronto, não lida");
    expect(row("n-hold").getAttribute("aria-label")).toBe("O workspace está em espera: os agentes estão pausados");
    // A headline with no name in it carries the unread weight whole.
    const css = await Bun.file(new URL("../src/pages/notifications.css", import.meta.url).pathname).text();
    expect(css).toMatch(/\.nt-what:not\(:has\(b\)\) \{[^}]*font-weight: 600/);
    expect(css).toMatch(/\.nt-item:not\(\.is-unread\) \.nt-what:not\(:has\(b\)\) \{[^}]*font-weight: 500/);
  });

  test("an agent held on agentes.chat Cloud: its name, then the hold's whole line, never its reason", async () => {
    const held = notification({
      id: "n-held",
      kind: "org_standing",
      source: { agentId: ADA_ID, label: "Ada" },
      latest: { statusTo: "agent_hold", holdKind: "network" },
      updatedAt: ago(2),
    });
    await go(seedState({ notifications: [held] }));
    const row = document.querySelector('[data-n="n-held"]') as HTMLElement;
    expect(row.querySelector(".nt-what")?.textContent).toBe("Ada está em pausa");
    const line = row.querySelector(".nt-snip");
    expect(line?.textContent).toBe(
      "Este agente está pausado. As nossas regras de rede viram sinais de abuso no tráfego dele (Termos, seção 5). Para contestar, escreva para legal@agentes.chat.",
    );
    // How to contest it is never cut off.
    expect(line?.classList.contains("nt-snip--whole")).toBe(true);
    expect(row.querySelector(".nt-who .nt-sys svg")).toBeTruthy();
    expect(row.getAttribute("aria-label")).toBe("Ada está em pausa, não lida");
  });

  test("the workspace held or suspended on agentes.chat Cloud reads as the restriction, never 'review'", async () => {
    const contest = "Para contestar, escreva para legal@agentes.chat.";
    const standing = (id: string, latest: AppNotification["latest"]) =>
      notification({ id, kind: "org_standing", latest, updatedAt: ago(2) });
    await go(
      seedState({
        notifications: [
          standing("n-review", { statusTo: "hold", text: "review", cloud: true }),
          standing("n-flagged", { statusTo: "hold", text: "review.phishing_impersonation", cloud: true }),
          standing("n-new", { statusTo: "hold", text: "review.something_new", cloud: true }),
          standing("n-hold", { statusTo: "hold", text: "Termos 5: phishing", cloud: true }),
          standing("n-suspended", { statusTo: "suspended", text: "Termos 5: spam", cloud: true }),
          standing("n-self", { statusTo: "hold", text: "review" }),
        ],
      }),
    );
    const line = (id: string) => document.querySelector(`[data-n="${id}"] .nt-snip`);
    const review =
      "Pausado para uma análise de segurança, até a nossa equipe olhar o caso. As nossas verificações automáticas detectaram uma atividade que pode violar os nossos Termos (seção 5).";
    expect(line("n-review")?.textContent).toBe(`${review} ${contest}`);
    // What the automatic hold flagged, named; a category the app doesn't know reads as plain review.
    expect(line("n-flagged")?.textContent).toBe(
      `Pausado para uma análise de segurança, até a nossa equipe olhar o caso. As nossas verificações automáticas detectaram uma atividade que parece envolver phishing ou imitação de uma marca, o que os nossos Termos não permitem (seção 5). ${contest}`,
    );
    expect(line("n-new")?.textContent).toBe(`${review} ${contest}`);
    expect(line("n-hold")?.textContent).toBe(`Este workspace está em espera: Termos 5: phishing. ${contest}`);
    expect(line("n-suspended")?.textContent).toBe(`Este workspace está suspenso: Termos 5: spam. ${contest}`);
    for (const id of ["n-review", "n-flagged", "n-new", "n-hold", "n-suspended"])
      expect(line(id)?.classList.contains("nt-snip--whole")).toBe(true);
    // A self-hosted server: the reason, as it always read.
    expect(line("n-self")?.textContent).toBe("review");
    expect(line("n-self")?.classList.contains("nt-snip--whole")).toBe(false);
  });
});

describe("its computer is ready: what comes next", () => {
  test("no agent has an AI yet: Abrir opens Connect an AI, saying it's ready; with one, the computer's page", async () => {
    const ready = notification({
      id: "n-ready",
      kind: "computer_ready",
      source: { machineId: "m-9" },
      updatedAt: ago(3),
    });
    const noAi = { any: false, agents: [{ agentId: ADA_ID, state: "no_ai" as const, reason: "no_key" as const }] };
    const state = seedState({ notifications: [ready], aiStatus: noAi });
    // Ada is Walter's: a plan of his thinks for her.
    for (const a of state.agents) if (a.id === ADA_ID) a.ownerUserId = "u-walter";
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "m-9" });
    const brain = api.agents.brain;
    api.agents.brain = async (orgId, agentId) => ({ ...(await brain(orgId, agentId)), ownSignIn: false });
    const { router } = await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(8);
    const row = () => document.querySelector('[data-n="n-ready"]') as HTMLElement;
    await click(within(row()).getByRole("button", { name: "Abrir" }));
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: "Conectar uma IA" });
    const panel = within(dialog).getByRole("region", { name: "Seu plano do Claude" });
    expect(panel.textContent).toContain("O computador está pronto.");
    expect((within(panel).getByRole("button", { name: "Entrar com Claude" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(state.calls.filter((c) => c.method === "notifications.read").map((c) => c.args)).toEqual([
      [ORG_ID, "n-ready", true],
    ]);
    cleanup();

    // An agent thinks already: the computer's page, as before.
    const other = await go(seedState({ notifications: [ready] }));
    await click(within(row()).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(other.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/computers/m-9`);
  });

  test("a plain click opens Connect an AI while no agent has one; then the computer's page, and on a phone it picks the row first", async () => {
    const ready = () => notification({ id: "n-ready", kind: "computer_ready", source: { machineId: "m-9" } });
    const noAi = { any: false, agents: [{ agentId: ADA_ID, state: "no_ai" as const, reason: "no_key" as const }] };
    const state = seedState({ notifications: [ready()], aiStatus: noAi });
    for (const a of state.agents) if (a.id === ADA_ID) a.ownerUserId = "u-walter";
    const api = createFakeApi(state);
    fakeMachinesOf.get(api)?.setSetup({ state: "ready", machineId: "m-9" });
    const { router } = await renderApp(`/org/${ORG_ID}/notifications`, { api });
    await settle(8);
    const row = () => document.querySelector('[data-n="n-ready"]') as HTMLElement;
    await click(row().querySelector(".nt-what") as HTMLElement);
    await settle(8);
    expect(screen().getByRole("dialog", { name: "Conectar uma IA" })).toBeTruthy();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(state.calls.filter((c) => c.method === "notifications.read").map((c) => c.args)).toEqual([
      [ORG_ID, "n-ready", true],
    ]);
    cleanup();

    // An agent thinks already: on a wide screen the click opens the computer's page, as Abrir does.
    const wide = await go(seedState({ notifications: [ready()] }));
    await click(row());
    await settle(4);
    expect(wide.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/computers/m-9`);
    cleanup();

    // On a phone the first tap picks the row as any row's does, so Feito and Lembrar depois (shown by that tap) stay
    // in reach; Abrir still goes to the computer's page.
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
      query === "(max-width: 720px)"
        ? ({ matches: true, media: query } as MediaQueryList)
        : matchMedia.call(window, query)) as typeof window.matchMedia;
    try {
      const other = await go(seedState({ notifications: [ready()] }));
      await click(row());
      await settle(4);
      expect(other.router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
      expect(row().classList.contains("is-cur")).toBe(true);
      expect(other.state.calls.filter((c) => c.method === "notifications.read").map((c) => c.args)).toEqual([
        [ORG_ID, "n-ready", true],
      ]);
      for (const name of ["Feito", "Lembrar depois"]) expect(within(row()).getByRole("button", { name })).toBeTruthy();
      await click(within(row()).getByRole("button", { name: "Abrir" }));
      await settle(4);
      expect(other.router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/computers/m-9`);
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  test("its face's top is its headline's line's, and a headline alone sits in the middle of the face", async () => {
    const css = (await Bun.file(new URL("../src/pages/notifications.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const phone = css.split("\n@media (max-width: 720px) {")[1]?.split("\n}")[0] ?? "";
    const body = (selector: string, sheet = css) =>
      new RegExp(`\\n *${selector.replace(/[.()>:]/g, "\\$&")} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? "";
    const px = (selector: string, prop: string, sheet = css) =>
      Number(new RegExp(`\\b${prop}: (-?\\d+)(px)?;`).exec(body(selector, sheet))?.[1]);
    const face = px(".nt-sys", "height");
    expect(px(".nt-av28", "height")).toBe(face);
    const line = px(".nt-tags .ac-chip", "height");
    // The face's box starts at the row's top, as the headline's line does: no line box around it, and nothing moves
    // it, with lines under the headline or not, on a phone too.
    expect(body(".nt-who")).toContain("display: flex");
    expect(body(".nt-who")).not.toMatch(/\b(padding|margin)(-top)?:/);
    expect(css).not.toContain("> .nt-who {");
    expect(body(".nt-who", phone)).toBe("");
    // A headline alone comes down to the face's middle. On a phone, where a headline wraps, it stays at the top.
    expect(px(".nt-l1:only-child", "margin-top")).toBe((face - line) / 2);
    expect(px(".nt-l1:only-child", "margin-top", phone)).toBe(0);
  });
});

describe("an agent asks for a hand (ADR 0040, ADR 0058)", () => {
  test("in its browser, or on its computer when the request is on its desktop", async () => {
    const ask = (id: string, screen?: "desktop") =>
      notification({
        id,
        kind: "browser_handoff",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        source: { channelId: ENG_ID, handoffId: `h-${id}`, ...(screen ? { screen } : {}) },
        latest: { text: "Entrar no painel" },
        updatedAt: ago(2),
      });
    await go(seedState({ notifications: [ask("n-browser"), ask("n-desktop", "desktop")] }));
    const row = (id: string) => (document.querySelector(`[data-n="${id}"]`) as HTMLElement).textContent;
    expect(row("n-browser")).toContain("Ada precisa de você no navegador");
    expect(row("n-browser")).toContain("Navegador");
    expect(row("n-desktop")).toContain("Ada precisa de você no computador");
    expect(row("n-desktop")).toContain("Computador");
    expect(row("n-desktop")).not.toContain("Navegador");
  });

  test("one row: what to do on its second line, the expiry chip on its first, and a click goes to its conversation", async () => {
    const hand = notification({
      id: "n-hand",
      kind: "browser_handoff",
      waiting: true,
      actors: [{ type: "agent", id: ADA_ID }],
      source: { channelId: ENG_ID, handoffId: "h-1" },
      latest: { text: "Entrar no painel", expiresAt: new Date(Date.now() + 18 * 60_000).toISOString() },
      updatedAt: ago(2),
    });
    const { router } = await go(seedState({ notifications: [hand] }));
    const row = document.querySelector('[data-n="n-hand"]') as HTMLElement;
    expect(row.classList.contains("nt-wr")).toBe(true);
    expect(row.querySelector(".nt-wr__sub")?.textContent).toBe("Entrar no painel");
    expect(row.querySelector(".nt-wr__l1 > .nt-wr__left.ac-chip--waiting")?.textContent).toMatch(/^expira em /);
    // Two lines: the first one's capitals start at the face's top.
    expect(row.querySelector(".nt-wr__l1")?.classList.contains("ac-captop")).toBe(true);
    await click(row.querySelector(".nt-wr__sub") as HTMLElement);
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });
});

describe("an agent asks for a secret (ADR 0027)", () => {
  test("one row: who asks, the secret's name and what for, the expiry chip, and a click goes to its card's conversation", async () => {
    const ask = notification({
      id: "n-secret",
      kind: "secret_request",
      waiting: true,
      actors: [{ type: "agent", id: ADA_ID }],
      source: { channelId: ENG_ID, messageId: "msg-s" },
      latest: {
        title: "NPM_TOKEN",
        text: "publicar o pacote no npm",
        expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(),
      },
      updatedAt: ago(1),
    });
    const { router } = await go(seedState({ notifications: [ask] }));
    const row = document.querySelector('[data-n="n-secret"]') as HTMLElement;
    expect(row.classList.contains("nt-wr")).toBe(true);
    expect(row.querySelector(".nt-what")?.textContent).toBe("Ada pediu um segredo a você");
    expect(row.querySelector(".nt-wr__sub")?.textContent).toBe("NPM_TOKEN · publicar o pacote no npm");
    expect(row.querySelector(".nt-wr__l1 > .nt-wr__left.ac-chip--waiting")?.textContent).toMatch(/^expira em /);
    await click(row.querySelector(".nt-wr__sub") as HTMLElement);
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });
});

describe("Esperando você: what only points somewhere is one row", () => {
  const asks = (over: Partial<AppNotification> = {}) =>
    notification({
      id: "n-join",
      kind: "join_request",
      waiting: true,
      source: { label: "Acme" },
      latest: { title: "Felipe Ramos", names: ["Felipe Ramos"] },
      ...over,
    });
  const row = (id = "n-join") => document.querySelector(`[data-n="${id}"]`) as HTMLElement;

  test("its face, its words, then Abrir, Lembrar depois and Feito; Abrir the white button, with no icon", async () => {
    const read = asks({ id: "n-read", latest: { title: "Marina Alves", names: ["Marina Alves"] }, readAt: ago(1) });
    await go(seedState({ notifications: [asks(), read] }));
    expect(row().classList.contains("nt-wr")).toBe(true);
    expect(row().querySelector(".nt-meta, .nt-body")).toBeNull();
    // The words on one line: the headline, where it opens and when.
    const l1 = row().querySelector(".nt-wr__l1") as HTMLElement;
    expect(l1.querySelector(".nt-what")?.textContent).toBe("Felipe Ramos pede para entrar");
    expect(l1.querySelector(".nt-wr__src")?.textContent).toBe("Membros");
    expect(l1.querySelector(".nt-wr__tm")?.textContent).toBe("agora");
    // One line: it centres on the face, with the actions.
    expect(l1.classList.contains("ac-captop")).toBe(false);
    const acts = row().querySelector(".nt-wr__acts") as HTMLElement;
    expect(acts.classList.contains("ac-acts")).toBe(true);
    const buttons = within(acts).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Abrir",
      "Lembrar depois",
      "Feito",
    ]);
    expect(buttons[0]?.className).not.toContain("ac-btn--primary");
    expect(buttons[0]?.querySelector("svg")).toBeNull();
    // Remind me later and Done: a group nested in the same row of actions.
    expect(acts.lastElementChild?.matches(".nt-tail.ac-acts")).toBe(true);
    // Unread is the headline's weight, and a screen reader hears it; read, neither.
    expect(row().classList.contains("is-unread")).toBe(true);
    expect(row().getAttribute("aria-label")).toBe("Felipe Ramos pede para entrar, não lida");
    expect(row("n-read").classList.contains("is-unread")).toBe(false);
    expect(row("n-read").getAttribute("aria-label")).toBe("Marina Alves pede para entrar");
  });

  test("a click anywhere on it opens it, as Abrir does", async () => {
    const { state, router } = await go(seedState({ notifications: [asks()] }));
    await click(row().querySelector(".nt-what") as HTMLElement);
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/settings/members`);
    expect(state.calls.find((c) => c.method === "notifications.read")?.args).toEqual([ORG_ID, "n-join", true]);
  });

  test("Lembrar depois and Feito never open it, though the menu's clicks reach the row from its portal", async () => {
    const other = asks({ id: "n-other", latest: { title: "Marina Alves", names: ["Marina Alves"] } });
    const { state, router } = await go(seedState({ notifications: [asks(), other] }));
    const later = within(row()).getByRole("button", { name: "Lembrar depois" });
    later.focus();
    await act(async () => {
      fireEvent.keyDown(later, { key: "Enter" });
      fireEvent.keyUp(later, { key: "Enter" });
    });
    await settle(2);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: /Em 1 hora/ }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    const until = new Date(String(state.calls.find((c) => c.method === "notifications.snooze")?.args[2]));
    expect(Math.abs(until.getTime() - Date.now() - 3_600_000)).toBeLessThan(60_000);
    await click(within(row("n-other")).getByRole("button", { name: "Feito" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(state.calls.find((c) => c.method === "notifications.done")?.args).toEqual([ORG_ID, "n-other", true]);
    expect(state.calls.some((c) => c.method === "notifications.read")).toBe(false);
  });

  test("the cards end their action line with the same pair: Abrir em Aprovações before it, no spacer", async () => {
    const approval = notification({
      id: "n-ap",
      kind: "approval",
      waiting: true,
      actors: [{ type: "agent", id: ATLAS_ID }],
      source: { approvalId: "ap-deploy", channelId: ENG_ID },
      latest: { title: "Run deploy workflow" },
      updatedAt: ago(5),
    });
    const items = inbox();
    await go(seedState({ notifications: [...items, approval, asks()] }));
    for (const id of ["n-q", "n-ap"]) {
      const line = row(id).querySelector(".nt-wacts") as HTMLElement;
      expect(line.classList.contains("ac-acts")).toBe(true);
      expect(line.lastElementChild?.matches(".nt-tail.ac-acts")).toBe(true);
      expect(line.querySelector(".nt-grow")).toBeNull();
      expect(
        within(line.lastElementChild as HTMLElement)
          .getAllByRole("button")
          .map((b) => b.getAttribute("aria-label")),
      ).toEqual(["Lembrar depois", "Feito"]);
    }
    expect(row("n-ap").querySelector(".nt-wacts > .nt-tail")?.previousElementSibling?.textContent).toBe(
      "Abrir em Aprovações",
    );
    expect(row().querySelector(".nt-wr__acts > :last-child")?.matches(".nt-tail.ac-acts")).toBe(true);
  });

  test("its geometry, from the stylesheets: the kit's action rows, the face's middle, one column for every pair", async () => {
    const read = async (path: string) =>
      (await Bun.file(new URL(path, import.meta.url).pathname).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    const css = await read("../src/pages/notifications.css");
    const kit = await read("../../../packages/ui/src/styles/components.css");
    const block = (sheet: string, media: string) => sheet.split(`\n@media ${media} {`)[1]?.split("\n}")[0] ?? "";
    const phone = block(css, "(max-width: 720px)");
    const wraps = block(css, "(max-width: 1023px)");
    /** The body of a rule written at the top level of `sheet` (two-space indented inside a media block). */
    const rule = (selector: string, sheet = css) =>
      new RegExp(`\\n *${selector.replace(/[.()>:*[\]]/g, "\\$&")} \\{([^}]*)\\}`).exec(sheet)?.[1] ?? "";
    const value = (selector: string, prop: string, sheet = css) =>
      new RegExp(`(?:^|[;\\s])${prop}: ([^;]+);`).exec(rule(selector, sheet))?.[1];
    const px = (selector: string, prop: string, sheet = css) => Number.parseFloat(value(selector, prop, sheet) ?? "");
    const right = (selector: string, sheet = css) => {
      const [top, r = top] = (value(selector, "padding", sheet) ?? "").split(" ");
      return r;
    };

    // The pair is a nested `.ac-acts`: in a row it joins the row's actions. In a card's line, which wraps, it keeps a
    // box, so a wrap never splits it, and its margin pushes it to the end. The kit spaces what is in it.
    expect(value(".ac-acts > .ac-acts", "display", kit)).toBe("contents");
    expect(value(".nt-wacts > .nt-tail.ac-acts", "display")).toBe("flex");
    expect(value(".nt-wacts > .nt-tail.ac-acts", "margin-left")).toBe("auto");
    expect(value(".nt-wacts", "flex-wrap")).toBe("wrap");
    expect(css).not.toMatch(/\.nt-tail(?:\.ac-acts)? > [^{]*\{[^}]*margin/);
    // The words keep the gap the kit puts between actions, and the actions sit on the face's middle.
    expect(value(".nt-wr__main", "column-gap")).toBe(value(".ac-acts", "column-gap", kit));
    expect(px(".nt-wr__acts", "height")).toBe(px(".nt-av40", "height"));
    // Rows and cards end at one padding line, wide and on a phone: every clock and check share two columns.
    expect(right(".nt-wr")).toBe(right(".nt-wi"));
    expect(right(".nt-wr", phone)).toBe(right(".nt-wi", phone));
    // A line alone centres on the face, at every width, and the line is the chips'. Two or more take `.ac-captop`.
    const line = px(".nt-wr__l1", "line-height");
    expect(line).toBe(px(".ac-chip", "height", kit));
    expect(px(".nt-wr__l1:not(.ac-captop)", "margin-block-start")).toBe((px(".nt-av40", "height") - line) / 2);
    // Under 1024px the words wrap, three lines at most, the time at their end and never alone on the last line. A
    // chip on its line's top keeps every line the chips' height, and a name with no spaces breaks instead of running
    // under the clip.
    expect(value(".nt-wr__l1", "display", wraps)).toBe("-webkit-box");
    expect(value(".nt-wr__l1", "-webkit-line-clamp", wraps)).toBe("3");
    expect(value(".nt-wr__l1", "text-wrap", wraps)).toBe("pretty");
    expect(value(".nt-wr__l1", "overflow-wrap", wraps)).toBe("anywhere");
    expect(value(".nt-wr .nt-what", "white-space", wraps)).toBe("normal");
    expect(value(".nt-wr__l1 > .ac-chip", "vertical-align", wraps)).toBe("top");
    // On a phone the tap opens: Open leaves the eye but stays a button for screen readers and the keyboard, and the
    // source chip goes. The faces stay 40px.
    expect(css).not.toMatch(/\.nt-wr__open[^{]*\{[^}]*display: none/);
    expect(value(".nt-wr__open:not(:focus-visible)", "position", phone)).toBe("absolute");
    expect(value(".nt-wr__open:not(:focus-visible)", "clip-path", phone)).toBe("inset(50%)");
    expect(value(".nt-wr__src", "display", phone)).toBe("none");
    expect(rule(".nt-av40", phone)).toBe("");
    expect(value(".nt-wi", "grid-template-columns", phone)).toBeUndefined();
    // A ghost reaches into the item's padding and the item clips: its ring goes inside, as the item's own does.
    const ring = value("html:not([data-pointer]) .nt-item:focus-visible", "box-shadow");
    expect(ring).toBe("var(--focus-ring-inset)");
    expect(value("html:not([data-pointer]) .nt-wi .ac-acts > .ac-btn--ghost:focus-visible", "box-shadow")).toBe(ring);
  });
});

describe("a click on a browser notification (ADR 0071)", () => {
  test("no tab open: ?open= goes where Abrir goes and marks it read, in place of the inbox", async () => {
    const state = seedState({ notifications: inbox() });
    const { router } = await renderApp(`/org/${ORG_ID}/notifications?open=n-thread`, { api: createFakeApi(state) });
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/threads/m-1`);
    expect(state.calls.filter((c) => c.method === "notifications.read").map((c) => c.args)).toEqual([
      [ORG_ID, "n-thread", true],
    ]);
  });

  test("no tab open, a routine's trouble: its details over the inbox, without ?open", async () => {
    const state = seedState({ notifications: inbox() });
    const api = createFakeApi(state);
    const failed = (await api.routines.list(ORG_ID))[0];
    if (!failed) throw new Error("no routine seeded");
    for (const n of state.notifications ?? []) if (n.id === "n-routine") n.source.routineId = failed.id;
    const { router } = await renderApp(`/org/${ORG_ID}/notifications?open=n-routine`, { api });
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(router.state.location.search).toEqual({});
    expect(screen().getByRole("dialog", { name: failed.name })).toBeTruthy();
  });

  test("one that is gone: the inbox, without ?open", async () => {
    const state = seedState({ notifications: inbox() });
    const { router } = await renderApp(`/org/${ORG_ID}/notifications?open=n-gone`, { api: createFakeApi(state) });
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/notifications`);
    expect(router.state.location.search).toEqual({});
    expect(document.querySelector('[data-n="n-thread"]')).not.toBeNull();
  });

  test("a tab open in the workspace: it opens there at once, no stop at the inbox", async () => {
    const state = seedState({ notifications: inbox() });
    const api = createFakeApi(state);
    // The routine that failed: its details open over the page the person is on.
    const failed = (await api.routines.list(ORG_ID))[0];
    if (!failed) throw new Error("no routine seeded");
    for (const n of state.notifications ?? []) if (n.id === "n-routine") n.source.routineId = failed.id;
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const seen: string[] = [];
    const unsubscribe = router.subscribe("onResolved", (e) => seen.push(e.toLocation.pathname));
    await act(async () =>
      dispatchPushOpen(
        {
          path: pushOpenPath(ORG_ID, "n-routine"),
          data: { orgId: ORG_ID, notificationId: "n-routine", kind: "routine_failed" },
        },
        (path) => router.history.push(path),
      ),
    );
    await settle(8);
    unsubscribe();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(screen().getByRole("dialog", { name: failed.name })).toBeTruthy();
    expect(seen).not.toContain(`/org/${ORG_ID}/notifications`);
    expect(state.calls.find((c) => c.method === "notifications.read")?.args).toEqual([ORG_ID, "n-routine", true]);
  });
});

describe("catch-ups an agent skipped as already handled (ADR 0136)", () => {
  test("the owner's grouped row opens the agent's queue in place; the asker's names the place once", async () => {
    const skipped = notification({
      id: "n-skip",
      kind: "catch_up_closed",
      actors: [{ type: "agent", id: ATLAS_ID }],
      count: 2,
      source: { channelId: ENG_ID, messageId: "m-note", label: "Atlas" },
      latest: {},
      updatedAt: ago(3),
    });
    const asker = notification({
      id: "n-asker",
      kind: "catch_up_closed_asker",
      actors: [{ type: "agent", id: ATLAS_ID }],
      source: { channelId: ENG_ID, messageId: "m-note", label: "eng" },
      latest: { title: "Ada", reason: "solved" },
      updatedAt: ago(4),
    });
    const state = seedState({ notifications: [skipped, asker] });
    const at = new Date().toISOString();
    state.usageQueues = {
      [ATLAS_ID]: {
        agentId: ATLAS_ID,
        reason: "plan",
        plan: "Claude",
        resetsAt: null,
        sharedWith: [],
        rows: [
          {
            runId: "r-q",
            kind: "conversation",
            channelId: ENG_ID,
            threadId: null,
            channelKind: "channel",
            channelName: "eng",
            messageId: "m-q",
            askers: ["u-joao"],
            since: at,
            after: { count: 0, names: [] },
            state: "queued",
            title: null,
            mayStop: true,
          },
        ],
        hidden: 0,
        mayStopAll: true,
        closed: [
          {
            runId: "r-s",
            channelId: ENG_ID,
            threadId: null,
            channelKind: "channel",
            channelName: "eng",
            messageId: "m-note",
            closed: { reason: "solved", who: { name: "Nina" }, askers: ["u-joao"], at },
            continuedRunId: null,
            mayAnswer: true,
          },
        ],
      },
    };
    const { router } = await go(state);
    const owners = document.querySelector('[data-n="n-skip"]') as HTMLElement;
    expect(owners.textContent).toContain("Atlas retomou e pulou 2 conversas que não precisavam de resposta");
    // Two places: the queue lists each, so no single channel beside it.
    expect(owners.textContent).not.toContain("#eng");
    const askers = document.querySelector('[data-n="n-asker"]') as HTMLElement;
    expect(askers.textContent?.match(/#eng/g)).toHaveLength(1);
    const before = router.state.location.pathname;
    await click(within(owners).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(before);
    // Opened from a skip: on what it skipped, the line in line one tap away.
    const dialog = screen().getByRole("dialog");
    expect(dialog.textContent).toContain("Atlas");
    expect(
      within(dialog)
        .getByRole("radio", { name: /Puladas/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(dialog.textContent).toContain("Nina já cuidou disso");
    expect(within(dialog).getByRole("button", { name: "Responder mesmo assim" })).toBeTruthy();
  });
});
