import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { activityText, toolActivity } from "@agenteschat/client/lib/activity";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createI18n } from "@/i18n";
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

describe("Fórum: the list", () => {
  test("discussing now, what needs me, aligned rows with status and no money; filters", async () => {
    await go("forum");
    expect(screen().getByRole("heading", { name: "Discutindo agora" })).toBeTruthy();
    expect(screen().getByRole("heading", { name: "Precisa de você" })).toBeTruthy();
    // The concluded topic of mine waits for its issues to be approved.
    expect(document.body.textContent).toContain("A síntese sugere 2 tarefas");
    const row = screen().getByRole("link", { name: "Plano de preços do Q1" });
    expect(row.textContent).toContain("Em discussão");
    expect(row.textContent).toContain("Decidir se mudamos o plano de entrada");
    expect(row.textContent).toContain("rodada 2 de 3");
    // No spend cap anymore: each agent runs on its own budget.
    expect(document.body.textContent).not.toContain("limite de gasto");
    expect(screen().queryByRole("link", { name: "Onboarding em 5 minutos" })).toBeNull();
    const filters = screen().getByRole("radiogroup", { name: "Filtrar tópicos" });
    await click(within(filters).getByRole("radio", { name: /Concluídos/ }));
    const done = screen().getByRole("link", { name: "Onboarding em 5 minutos" });
    expect(done.textContent).toContain("Concluído");
    expect(done.textContent).toContain("Cortar a escolha de chave");
  });

  test("Novo tópico: from scratch, the table in order (two agents at least), rounds → opens it", async () => {
    const { state, router } = await go("forum");
    await click(screen().getByRole("button", { name: "Novo tópico" }));
    await click(within(screen().getByRole("dialog", { name: "Novo tópico" })).getByRole("button", { name: /Do zero/ }));
    const dialog = screen().getByRole("dialog", { name: "Novo tópico" });
    const open = within(dialog).getByRole("button", { name: "Abrir tópico" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(dialog.textContent).toContain("Escolha pelo menos 2 agentes");
    // No money in the forum.
    expect(dialog.textContent).not.toContain("Limite de gasto");
    await type(within(dialog).getByLabelText("Pergunta"), "Roadmap do Q2");
    await type(within(dialog).getByLabelText("Objetivo"), "O que entra no Q2?");
    await click(within(dialog).getByRole("button", { name: "Adicionar Ada à mesa" }));
    expect(dialog.textContent).toContain("Com um agente só");
    await click(within(dialog).getByRole("button", { name: "Adicionar Atlas à mesa" }));
    // Atlas speaks first.
    await click(within(dialog).getByRole("button", { name: "Subir Atlas" }));
    await click(within(within(dialog).getByRole("radiogroup", { name: "Rodadas" })).getByRole("radio", { name: "4" }));
    await click(within(dialog).getByRole("button", { name: "Abrir tópico" }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "forum.create")?.args[1]).toEqual({
      title: "Roadmap do Q2",
      goal: "O que entra no Q2?",
      agentIds: [ATLAS_ID, ADA_ID],
      userIds: [],
      rounds: 4,
      format: "decision",
    });
    expect(router.state.location.pathname).toStartWith(`/org/${ORG_ID}/forum/topic_`);
    expect(screen().getByRole("heading", { level: 1, name: "Roadmap do Q2" })).toBeTruthy();
  });
});

describe("a topic", () => {
  test("the table, posts by round with stances and replies, a person's post leads a round; post and conclude", async () => {
    const { state } = await go("forum/topic-pricing");
    expect(screen().getByRole("heading", { level: 1, name: "Plano de preços do Q1" })).toBeTruthy();
    expect(screen().getByRole("region", { name: "A mesa" })).toBeTruthy();
    const r1 = screen().getByRole("region", { name: "Rodada 1" });
    const r2 = screen().getByRole("region", { name: "Rodada 2" });
    expect(within(r1).getAllByRole("article").length).toBe(2);
    expect(r1.textContent).toContain("Concorda com Ada");
    expect(within(r1).getByRole("button", { name: "Ir para o post de Ada" })).toBeTruthy();
    expect(r2.querySelector(".forum-post--person")?.textContent).toContain("Lembrem do custo do PC");
    expect(r2.textContent).toContain("A rodada 2 começou por aqui");
    const box = screen().getByRole("textbox", { name: "Entrar na discussão" });
    await type(box, "E o plano anual?");
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "forum.post")?.args).toEqual([
      ORG_ID,
      "topic-pricing",
      { body: "E o plano anual?" },
    ]);
    await click(screen().getByRole("button", { name: "Concluir" }));
    const dialog = screen().getByRole("dialog", { name: "Concluir o tópico?" });
    await click(within(dialog).getByRole("button", { name: "Concluir" }));
    await settle(6);
    expect(state.calls.some((c) => c.method === "forum.conclude")).toBe(true);
    expect(document.body.textContent).toContain("Concluído");
  });

  test("another person's turn: the round waits for them, their face leading the line", async () => {
    const api = createFakeApi(seedState());
    const get = api.forum.get;
    api.forum.get = async (orgId, id) => ({
      ...(await get(orgId, id)),
      phase: "waiting_person",
      waitingUserId: "u-joao",
    });
    await renderApp(`/org/${ORG_ID}/forum/topic-pricing`, { api });
    await settle(8);
    const live = document.getElementById("forum-live") as HTMLElement;
    expect(live.textContent).toContain("A rodada espera João");
    expect(live.classList.contains("ac-iconline")).toBe(true);
    expect(live.firstElementChild?.matches(".ac-avatar")).toBe(true);
  });

  test("the synthesis: the decision, suggested issues checked inline, create the chosen ones", async () => {
    const { state } = await go("forum/topic-onboarding");
    const synthesis = screen().getByRole("region", { name: "Síntese" });
    expect(synthesis.textContent).toContain("Cortar a escolha de chave");
    expect(synthesis.textContent).toContain("Prós e contras de cada um");
    expect(synthesis.querySelector(".artifact-card")).not.toBeNull();
    const issues = within(synthesis).getByRole("region", { name: "Tarefas sugeridas" });
    const boxes = within(issues).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    await click(boxes[1] as HTMLElement);
    await click(within(issues).getByRole("button", { name: "Criar 1 tarefa" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "forum.createIssues")?.args[2]).toEqual([
      { title: "Pular a escolha de chave no onboarding", description: "Usar a chave da plataforma por padrão." },
    ]);
    expect(document.body.textContent).toContain("1 tarefa criada.");
  });

  test("participants: 'Editar participantes' → Editar sends only the difference", async () => {
    const { state } = await go("forum/topic-pricing");
    const more = screen().getByRole("button", { name: "Mais ações" });
    more.focus();
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Editar participantes" }));
    const dialog = screen().getByRole("dialog", { name: "Participantes" });
    await click(within(dialog).getByRole("button", { name: "Editar" }));
    await click(within(dialog).getByRole("checkbox", { name: "João" }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "forum.participants")?.args[2]).toEqual({
      addAgentIds: [],
      removeAgentIds: [],
      addUserIds: ["u-joao"],
      removeUserIds: [],
      seatUserIds: [],
      unseatUserIds: [],
    });
  });
});

describe("in channels and the palette", () => {
  test("an agent opened a topic: the card with the track and 'Ver discussão' (no %)", async () => {
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
    expect(forumCard.textContent).toContain("rodada 2 de 3");
    expect(forumCard.textContent).not.toContain("%");
    expect(within(forumCard).getByRole("link", { name: "Ver discussão" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/forum/topic-pricing`,
    );
  });

  test("an agent suggests a topic: 'Vale um fórum?' → Abrir fórum (only a person opens it)", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-sug",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: 'Worth a forum? "Entrar só por link mágico?"',
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        bodyCode: "forum_suggestion",
        bodyParams: { title: "Entrar só por link mágico?" },
        forumSuggestion: {
          title: "Entrar só por link mágico?",
          goal: "Decidir se o cadastro troca a senha por um link no e-mail.",
          agentIds: [ADA_ID, ATLAS_ID],
          rounds: 3,
          format: "decision",
          suggestedByAgentId: ADA_ID,
          state: "pending",
          topicId: null,
          decidedByUserId: null,
          decidedAt: null,
        },
      },
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    const card = screen().getByRole("region", { name: "Sugestão de fórum" });
    expect(card.textContent).toContain("Vale um fórum?");
    expect(card.textContent).toContain("Ada sugere");
    expect(card.textContent).toContain("3 rodadas");
    await click(within(card).getByRole("button", { name: "Abrir fórum" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "forum.acceptSuggestion")?.args.slice(0, 2)).toEqual([ORG_ID, "m-sug"]);
    expect(screen().getByRole("region", { name: "Fórum aberto" })).toBeTruthy();
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

  test("Rotinas: a routine can open a forum topic with chosen agents and rounds, each agent by its face", async () => {
    const state = seedState();
    const [ada, atlas] = state.agents;
    if (ada) ada.appearance = { color: "green", accessory: "headphones" };
    if (atlas) atlas.appearance = { color: "rose", accessory: "crown" };
    const api = createFakeApi(state);
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
    const accessoryOf = (el: Element | null | undefined) =>
      el?.querySelector(".ac-avatar--agent")?.getAttribute("data-accessory");
    const agent = within(dialog).getByRole("combobox", { name: "Agente" });
    agent.focus();
    await act(async () => fireEvent.keyDown(agent, { key: "Enter" }));
    const options = within(screen().getByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => [o.textContent, accessoryOf(o.querySelector(".ac-menu__leading"))])).toEqual([
      ["AdaDev", "headphones"],
      ["AtlasOps", "crown"],
    ]);
    await click(screen().getByRole("option", { name: /Ada/ }));
    const target = within(dialog).getByRole("combobox", { name: "Onde entregar" });
    target.focus();
    await act(async () => fireEvent.keyDown(target, { key: "Enter" }));
    await click(screen().getByRole("option", { name: "Um tópico no fórum" }));
    await settle();
    const seat = (name: string) => within(dialog).getByRole("checkbox", { name }).closest("label");
    expect([accessoryOf(seat("Ada")), accessoryOf(seat("Atlas"))]).toEqual(["headphones", "crown"]);
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
