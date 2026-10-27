import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent, AgentQuestion, AppNotification } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
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
    expect(document.querySelector(".nt-calm")?.textContent).toBe(
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
    expect(panel.textContent).toContain("O Computador da Acme está pronto.");
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

  test("a plain click opens Connect an AI while no agent has one; then it picks the row, its actions in reach", async () => {
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

    // An agent thinks already: the click picks the row as any row's does, so Feito and Lembrar depois (shown by that
    // tap on a phone) stay one tap away; Abrir still goes to the computer's page.
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
  });

  test("its headline's line sits in the middle of the face beside it, and its text as far from the top as the bottom", async () => {
    const css = (await Bun.file(new URL("../src/pages/notifications.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    const phone = css.split("\n@media (max-width: 720px) {")[1]?.split("\n}")[0] ?? "";
    const px = (selector: string, prop: string, sheet = css) =>
      Number(
        new RegExp(`\\n *${selector.replace(/[.()>:]/g, "\\$&")} \\{[^}]*\\b${prop}: (-?\\d+)(px)?;`).exec(sheet)?.[1],
      );
    const face = px(".nt-sys", "height");
    expect(px(".nt-av28", "height")).toBe(face);
    const line = px(".nt-tags .ac-chip", "height");
    const pad = px(".nt-who", "padding-top");
    // A headline alone comes down to the face's middle.
    expect(px(".nt-l1:only-child", "margin-top")).toBe(pad + (face - line) / 2);
    // With lines under it the face goes up to the headline's, which keeps the row's padding; on a phone, where a
    // headline wraps, in every row.
    const up = (sheet: string, selector: string) => pad + px(selector, "margin-top", sheet) + face / 2;
    expect(up(css, ".nt-item:has(> .nt-c > :nth-child(2)) > .nt-who")).toBe(line / 2);
    expect(up(phone, ".nt-who")).toBe(line / 2);
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
});
