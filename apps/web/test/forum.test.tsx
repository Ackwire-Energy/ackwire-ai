import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { ForumTopic } from "@/api/types";
import { createI18n } from "@/i18n";
import { activityText, toolActivity } from "@/lib/activity";
import { filterTopics } from "@/pages/ForumPage";
import { postsByRound } from "@/pages/ForumTopicPage";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const go = async (path: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const card = (title: string) => screen().getByRole("article", { name: title });

describe("Fórum: the list", () => {
  test("cards: title, goal, participants, status with round, last activity, cost; filters", async () => {
    await go("forum");
    const pricing = card("Plano de preços do Q1");
    expect(pricing.textContent).toContain("Decidir se mudamos o plano de entrada");
    expect(pricing.textContent).toContain("Em discussão · rodada 2 de 3");
    expect(pricing.textContent).toContain("0,42");
    expect(pricing.textContent).toContain("Última atividade");
    expect(within(pricing).getByRole("img", { name: /Participantes: Ada/ })).toBeTruthy();
    expect(screen().queryByRole("article", { name: "Onboarding em 5 minutos" })).toBeNull();
    const filters = screen().getByRole("radiogroup", { name: "Filtrar tópicos" });
    await click(within(filters).getByRole("radio", { name: "Concluídos" }));
    expect(card("Onboarding em 5 minutos").textContent).toContain("Concluído");
    await click(within(filters).getByRole("radio", { name: "Meus" }));
    expect(card("Plano de preços do Q1")).toBeTruthy();
  });

  test("rules: filters and rounds", () => {
    const topic = (over: Partial<ForumTopic>): ForumTopic => ({
      id: "t",
      channelId: "c",
      originChannelId: null,
      activeAgentIds: [],
      title: "",
      goal: "",
      status: "open",
      round: 1,
      rounds: 3,
      agentIds: [],
      userIds: [],
      createdBy: { type: "agent", id: "a" },
      createdAt: "",
      lastActivityAt: "",
      costUsd: 0,
      budgetUsd: null,
      synthesis: null,
      ...over,
    });
    const list = [
      topic({ id: "1" }),
      topic({ id: "2", status: "done" }),
      topic({ id: "3", status: "canceled", userIds: ["me"] }),
    ];
    expect(filterTopics(list, "open", "me").map((t) => t.id)).toEqual(["1"]);
    expect(filterTopics(list, "done", "me").map((t) => t.id)).toEqual(["2", "3"]);
    expect(filterTopics(list, "mine", "me").map((t) => t.id)).toEqual(["3"]);
    const p = (id: string, round: number, m: number) => ({
      id,
      topicId: "t",
      round,
      author: { type: "agent" as const, id: "a" },
      body: "",
      agentRunId: null,
      createdAt: new Date(Date.UTC(2026, 9, 15, 10, m)).toISOString(),
    });
    expect(
      postsByRound({ round: 3, posts: [p("b", 2, 5), p("a", 1, 1), p("c", 2, 3)] }).map(([r, ps]) => [
        r,
        ps.map((x) => x.id),
      ]),
    ).toEqual([
      [1, ["a"]],
      [2, ["c", "b"]],
      [3, []],
    ]);
  });
});

describe("Novo tópico", () => {
  test("title, question, agents (only those that answer me), people, rounds, cap → opens the topic", async () => {
    const state = seedState();
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.audience = { mode: "owner", userIds: [] };
    const { router } = await go("forum", state);
    await click(screen().getByRole("button", { name: "Novo tópico" }));
    const dialog = screen().getByRole("dialog", { name: "Novo tópico" });
    await click(within(dialog).getByRole("button", { name: "Abrir tópico" }));
    expect(dialog.textContent).toContain("Dê um título, a pergunta e pelo menos um agente.");
    await type(within(dialog).getByLabelText("Título"), "Roadmap do Q2");
    await type(within(dialog).getByLabelText("Pergunta ou objetivo"), "O que entra no Q2?");
    // Atlas only answers its owner: can't be picked.
    const atlasBox = within(dialog).getByRole("checkbox", { name: "Atlas" });
    expect((atlasBox as HTMLButtonElement).disabled).toBe(true);
    expect(atlasBox.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(atlasBox.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "não responde a você",
    );
    await click(within(dialog).getByRole("checkbox", { name: "Ada" }));
    await click(within(within(dialog).getByRole("radiogroup", { name: "Rodadas" })).getByRole("radio", { name: "5" }));
    await type(within(dialog).getByLabelText("Limite de gasto (opcional)"), "3");
    await click(within(dialog).getByRole("button", { name: "Abrir tópico" }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "forum.create")?.args[1]).toEqual({
      title: "Roadmap do Q2",
      goal: "O que entra no Q2?",
      agentIds: [ADA_ID],
      userIds: [],
      rounds: 5,
      budgetUsd: 3,
    });
    expect(router.state.location.pathname).toStartWith(`/org/${ORG_ID}/forum/topic_`);
    expect(screen().getByRole("heading", { level: 1, name: "Roadmap do Q2" })).toBeTruthy();
    // The agents start: the living avatar and the words.
    expect(document.querySelector(".forum-live")?.textContent).toContain("Ada está pensando…");
    expect(document.querySelector(".forum-live .ac-avatar--thinking")).not.toBeNull();
  });
});

describe("a topic", () => {
  test("rounds grouped, people's posts stand out, composer before the next round; conclude", async () => {
    const { state } = await go("forum/topic-pricing");
    expect(screen().getByRole("heading", { level: 1, name: "Plano de preços do Q1" })).toBeTruthy();
    const r1 = screen().getByRole("region", { name: "Rodada 1" });
    const r2 = screen().getByRole("region", { name: "Rodada 2" });
    expect(within(r1).getAllByRole("article").length).toBe(3);
    expect(within(r2).getAllByRole("article").length).toBe(1);
    expect(r1.querySelector(".forum-post--person")?.textContent).toContain("Lembrem do custo do PC");
    expect(document.body.textContent).toContain("Sua mensagem entra antes da próxima rodada.");
    const box = screen().getByRole("textbox", { name: "Mensagem para o fórum" });
    await type(box, "E o plano anual?");
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "forum.post")?.args).toEqual([
      ORG_ID,
      "topic-pricing",
      "E o plano anual?",
    ]);
    await click(screen().getByRole("button", { name: "Concluir agora" }));
    await settle(6);
    expect(state.calls.some((c) => c.method === "forum.conclude")).toBe(true);
    expect(document.body.textContent).toContain("Concluído");
  });

  test("synthesis: the document card and 'Criar issues sugeridas' with a review", async () => {
    const { state } = await go("forum/topic-onboarding");
    const synthesis = screen().getByRole("region", { name: "Síntese" });
    expect(synthesis.querySelector(".artifact-card")).not.toBeNull();
    await click(within(synthesis).getByRole("button", { name: "Criar issues sugeridas (2)" }));
    const dialog = screen().getByRole("dialog", { name: "Criar issues sugeridas" });
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    await click(boxes[1] as HTMLElement);
    await click(within(dialog).getByRole("button", { name: "Criar 1 issue" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "forum.createIssues")?.args[2]).toEqual([
      { title: "Pular a escolha de chave no onboarding", description: "Usar a chave da plataforma por padrão." },
    ]);
    expect(document.body.textContent).toContain("1 issue criada.");
  });
});

describe("in channels and the palette", () => {
  test("an agent opened a topic: the message shows the card with 'Ver discussão'", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-forum",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Abri um tópico no fórum para decidir isso.",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: { forumTopic: { id: "topic-pricing", title: "Plano de preços do Q1" } },
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    const forumCard = screen().getByRole("region", { name: "Tópico no fórum" });
    expect(forumCard.textContent).toContain("Plano de preços do Q1");
    expect(within(forumCard).getByRole("link", { name: "Ver discussão" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/forum/topic-pricing`,
    );
  });

  test("⌘K lists topics", async () => {
    await go("issues");
    await act(async () => fireEvent.keyDown(window, { key: "k", metaKey: true }));
    await settle(4);
    await type(screen().getByRole("combobox", { name: "Ir para, ou pedir a um agente" }), "preços");
    expect(
      within(screen().getByRole("listbox", { name: "Resultados" })).getAllByRole("option")[0]?.textContent,
    ).toContain("Plano de preços do Q1");
  });

  test("activity verbs", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n);
    const say = (tool: string) =>
      activityText(t, [{ id: "a", type: "agent", name: "Iris", activity: toolActivity(tool) }]);
    expect(say("open_forum_topic")).toBe("Iris está abrindo um tópico no fórum…");
    expect(say("post_in_forum")).toBe("Iris está escrevendo no fórum…");
  });
});

describe("real backend shapes", () => {
  test("round 0 groups before round 1; the synthesis post stays out of the rounds", () => {
    const p = (id: string, round: number, m: number, meta?: Record<string, unknown>) => ({
      id,
      topicId: "t",
      round,
      author: { type: "agent" as const, id: "a" },
      body: "",
      agentRunId: null,
      meta,
      createdAt: new Date(Date.UTC(2026, 9, 15, 10, m)).toISOString(),
    });
    expect(
      postsByRound({ round: 2, posts: [p("z", 0, 0), p("a", 1, 1), p("s", 2, 9, { synthesis: true })] }).map(
        ([r, ps]) => [r, ps.map((x) => x.id)],
      ),
    ).toEqual([
      [0, ["z"]],
      [1, ["a"]],
      [2, []],
    ]);
  });

  test("participants: '…' → Participantes sends only the difference", async () => {
    const { state } = await go("forum/topic-pricing");
    const more = screen().getByRole("button", { name: "Mais ações" });
    more.focus();
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Participantes" }));
    const dialog = screen().getByRole("dialog", { name: "Participantes" });
    await click(within(dialog).getByRole("checkbox", { name: "Atlas" }));
    await click(within(dialog).getByRole("checkbox", { name: "João" }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "forum.participants")?.args[2]).toEqual({
      addAgentIds: [],
      removeAgentIds: [ATLAS_ID],
      addUserIds: ["u-joao"],
      removeUserIds: [],
    });
  });

  test("the synthesis section shows the closing post", async () => {
    await go("forum/topic-onboarding");
    const synthesis = screen().getByRole("region", { name: "Síntese" });
    expect(synthesis.textContent).toContain("Síntese: três passos a cortar.");
    expect(screen().getByRole("region", { name: "Rodada 2" }).textContent).not.toContain("três passos a cortar");
  });

  test("Rotinas: a routine can open a forum topic with chosen agents and rounds", async () => {
    const api = createFakeApi(seedState());
    const created: unknown[] = [];
    const real = api.routines.create;
    api.routines.create = (orgId, input) => {
      created.push(input);
      return real(orgId, input);
    };
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    const target = within(dialog).getByRole("combobox", { name: "Onde entregar" });
    target.focus();
    await act(async () => fireEvent.keyDown(target, { key: "Enter" }));
    await click(screen().getByRole("option", { name: "Um tópico no fórum" }));
    await settle();
    await click(within(dialog).getByRole("checkbox", { name: "Atlas" }));
    await click(within(within(dialog).getByRole("radiogroup", { name: "Rodadas" })).getByRole("radio", { name: "2" }));
    await type(within(dialog).getByLabelText("O que fazer"), "Discutam o que melhorar no onboarding.");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(6);
    expect((created[0] as { target: unknown }).target).toEqual({
      type: "forum",
      agentIds: [ADA_ID, ATLAS_ID],
      rounds: 2,
    });
  });
});
