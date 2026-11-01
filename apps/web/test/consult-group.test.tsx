import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message, RunConsultation } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const RUN = "r-asked";
const QUESTION = "Como está a curva de juros hoje?";
const ANSWER = "A curva de 2 anos subiu 6 pb desde ontem.";
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();

const consultation = (over: Partial<RunConsultation>): RunConsultation => ({
  id: "q1",
  runId: RUN,
  agentId: ADA_ID,
  consultedAgentId: ATLAS_ID,
  consultedRunId: "atlas-run",
  status: "open",
  waiting: null,
  question: QUESTION,
  answer: null,
  createdAt: ago(40),
  answeredAt: null,
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  ...over,
});

/** Ada's reply after asking (its run carries the questions), and the notice an answer came with. */
function withAsk(list: RunConsultation[], notice = false) {
  const state = seedState();
  state.messages.push({
    id: "msg-asked",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: "Pedi a parte de juros ao Atlas; junto tudo quando chegar.",
    mentionedAgentIds: [],
    agentRunId: RUN,
    meta: {},
    createdAt: ago(45),
  });
  if (notice)
    state.messages.push({
      id: "msg-notice",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: ANSWER,
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        notice: {
          kind: "consult_reply",
          text: ANSWER,
          from: "@atlas",
          refs: {
            consultationId: "q1",
            runId: RUN,
            askerAgentId: ADA_ID,
            agentId: ATLAS_ID,
            status: "answered",
            question: QUESTION,
            answer: ANSWER,
          },
        },
      },
      createdAt: ago(5),
    });
  state.consultations = { [ENG_ID]: list };
  return state;
}

/** What Ada and Atlas said for a question, as the panel loads it (`GET …/consultations/{id}`): in their DM. */
function withTalk(state: ReturnType<typeof seedState>, c: RunConsultation, extra: Message[] = []) {
  const said = (id: string, from: string, body: string, runId: string, at: string): Message => ({
    id,
    channelId: "dm-ada-atlas",
    threadId: null,
    author: { type: "agent", id: from },
    body,
    mentionedAgentIds: [],
    agentRunId: runId,
    meta: {},
    createdAt: at,
  });
  state.consultationConversations = {
    [c.id]: {
      consultation: c,
      messages: [
        said("dm-q", ADA_ID, QUESTION, RUN, ago(40)),
        ...(c.answer ? [said("dm-a", ATLAS_ID, c.answer, "atlas-run", ago(5))] : []),
        ...extra,
      ],
    },
  };
  return state;
}
const panel = () => document.querySelector("aside.thread-panel") as HTMLElement | null;

/** The conversation went on after the reply that asked: `count` people's messages, so it sits farther up. */
function talkAfter(state: ReturnType<typeof seedState>, count: number) {
  for (let i = 0; i < count; i++)
    state.messages.push({
      id: `msg-talk-${i}`,
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-joao" },
      body: `Enquanto isso, item ${i + 1}.`,
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: ago(30 - i * 5),
    });
  state.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return state;
}

const open = async (state: ReturnType<typeof seedState>) => {
  const api = createFakeApi(state);
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(3);
  return { ...r, socket, state };
};
const asked = () =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes("Pedi a parte de juros")) as HTMLElement;
const group = () => asked().querySelector(".ac-consult-group") as HTMLElement | null;
const typingBar = () => document.querySelector(".ac-typing") as HTMLElement;
const bar = () => typingBar().querySelector(".ac-typing__text")?.textContent ?? "";
const push = (socket: { push: (f: unknown) => void }, event: Record<string, unknown>) =>
  act(async () =>
    socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, threadId: null, ...event } }),
  );
/** Ada's question going out, live: "Ada está perguntando ao Atlas…" on the working line. */
const asking = { type: "agent.consulting", runId: RUN, agentId: ADA_ID, consultedAgentId: ATLAS_ID };

describe("the questions inside the reply that asked (ConsultGroup)", () => {
  test("still out: one question is its own line, the agent working, with no 'Perguntou a 1 colega' to open", async () => {
    await open(withAsk([consultation({})]));
    const block = group();
    expect(block).not.toBeNull();
    const text = block?.textContent ?? "";
    expect(block?.querySelector(".ac-tools__head")).toBeNull();
    expect(text).not.toContain("Perguntou a 1 colega");
    expect(text).toContain("Atlas está trabalhando");
    expect(block?.querySelector(".ac-tools__line")?.getAttribute("data-s")).toBe("run");
    cleanup();
    // Two questions keep the block: 'Perguntou a 2 colegas' open, the count, a line each.
    await open(withAsk([consultation({}), consultation({ id: "q2", question: "E a de 5 anos?" })]));
    const two = group()?.textContent ?? "";
    expect(two).toContain("Perguntou a 2 colegas");
    expect(two).toContain("0 de 2");
    expect(group()?.querySelectorAll(".ac-tools__line")).toHaveLength(2);
  });

  test("waiting on a person: says what it waits for", async () => {
    await open(withAsk([consultation({ waiting: "approval" })]));
    expect(group()?.textContent).toContain("espera uma aprovação");
  });

  test("work handed off: its own line (no 'Passou para 1 colega'), its part done and waiting to hear back, opened as a request", async () => {
    const c = consultation({ kind: "note", waiting: "agents" });
    await open(withTalk(withAsk([c]), c));
    const block = group() as HTMLElement;
    expect(block.getAttribute("aria-label")).toBe("Pedidos da Ada a outros agentes");
    expect(block.textContent).not.toContain("Passou para 1 colega");
    const line = within(block).getByRole("button", { name: /O Atlas passou uma parte adiante e espera o retorno/ });
    await act(async () => fireEvent.click(line));
    await settle(3);
    const side = panel() as HTMLElement;
    expect(side.textContent).toContain("Ada fez um pedido ao Atlas em #eng");
    expect(side.textContent).toContain("O Atlas passou uma parte adiante e espera o retorno");
  });

  test("questions and work handed off in one turn: 'Chamou 2 colegas'; a request that couldn't finish says so", async () => {
    await open(
      withAsk([
        consultation({}),
        consultation({ id: "q2", kind: "note", status: "failed", answer: "stopped by a person", answeredAt: ago(2) }),
      ]),
    );
    const text = group()?.textContent ?? "";
    expect(text).toContain("Chamou 2 colegas");
    expect(text).toContain("O Atlas não conseguiu terminar");
  });

  test("waiting for its computer: says so, still out, not as waiting on a person", async () => {
    await open(withAsk([consultation({ waiting: "computer" })]));
    const text = group()?.textContent ?? "";
    expect(text).toContain("Atlas espera o computador voltar");
    // Still out, on its own line: no head with the count.
    expect(group()?.querySelector(".ac-tools__head")).toBeNull();
    expect(group()?.querySelector(".ac-tools__line")?.getAttribute("data-s")).toBe("run");
    expect(text).not.toContain("espera uma");
  });

  test("answered: the line opens the two agents' conversation over the channel, read only", async () => {
    const c = consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) });
    await open(withTalk(withAsk([c], true), c));
    const block = group() as HTMLElement;
    // One question: its line is the card, no head to open first.
    const line = within(block).getByRole("button", { name: /Atlas respondeu/ });
    await act(async () => fireEvent.click(line));
    await settle(3);
    // Not in place: in the panel over the channel, the question as it went and the answer.
    expect(block.textContent).not.toContain(QUESTION);
    const side = panel() as HTMLElement;
    expect(side.getAttribute("aria-label")).toBe("Conversa entre a Ada e o Atlas");
    expect(side.textContent).toContain(QUESTION);
    expect(side.textContent).toContain("subiu 6 pb");
    expect(line.getAttribute("aria-pressed")).toBe("true");
    // Read only: no composer there, a note instead.
    expect(within(side).queryByRole("combobox")).toBeNull();
    expect(side.textContent).toContain("Só leitura.");
    // The answer is shown once in the channel: the `consult_reply` card isn't drawn, nor a line (it's close).
    expect(document.querySelectorAll(".ac-consult").length).toBe(0);
    expect(document.body.textContent).not.toContain("respondeu à pergunta");
  });

  test("still out: the panel says Atlas works on it; 'Falar com a Ada' closes it and mentions her", async () => {
    const c = consultation({});
    await open(withTalk(withAsk([c]), c));
    const line = within(group() as HTMLElement).getByRole("button", { name: /Atlas está trabalhando/ });
    await act(async () => fireEvent.click(line));
    await settle(3);
    const side = panel() as HTMLElement;
    expect(side.textContent).toContain(QUESTION);
    expect(side.textContent).toContain("Atlas está trabalhando");
    await act(async () => fireEvent.click(within(side).getByRole("button", { name: "Falar com a Ada" })));
    await settle(1);
    expect(panel()).toBeNull();
    const box = screen().getByRole("combobox", { name: "Mensagem para #eng" }) as HTMLTextAreaElement;
    expect(box.value).toContain("@ada");
  });

  test("a question card in the panel answers in place: 'Responder' opens its field there", async () => {
    const c = consultation({ waiting: "input" });
    const asks: Message = {
      id: "msg-atlas-question",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "Uso a fonte paga?",
      mentionedAgentIds: [],
      agentRunId: "atlas-run",
      meta: {
        question: {
          id: "aq1",
          agentId: ATLAS_ID,
          channelId: ENG_ID,
          threadId: null,
          messageId: "msg-atlas-question",
          runId: "atlas-run",
          text: "Uso a fonte paga para a curva?",
          choices: null,
          status: "open",
          answer: null,
          answeredByUserId: null,
        },
      },
      createdAt: ago(20),
    };
    const { state } = await open(withTalk(withAsk([c]), c, [asks]));
    const line = within(group() as HTMLElement).getByRole("button", { name: /Atlas espera uma resposta/ });
    await act(async () => fireEvent.click(line));
    await settle(3);
    const side = panel() as HTMLElement;
    expect(side.textContent).toContain("Uso a fonte paga para a curva?");
    await act(async () => fireEvent.click(within(side).getByRole("button", { name: "Responder" })));
    await settle(1);
    const field = within(side).getByRole("textbox", { name: "Sua resposta" });
    expect(document.activeElement).toBe(field);
    await act(async () => fireEvent.change(field, { target: { value: "Pode usar" } }));
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await settle(4);
    // The answer goes to the question itself, from the panel (the fake keeps the agents' DM elsewhere).
    expect(state.calls.find((call) => call.method === "questions.answer")?.args).toEqual([
      ORG_ID,
      "aq1",
      { text: "Pode usar" },
    ]);
  });

  test("a card the consulted agent posts here says whom it helps, and opens the conversation", async () => {
    const c = consultation({ waiting: "input" });
    const state = withTalk(withAsk([c]), c);
    state.messages.push({
      id: "msg-atlas-asks",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "Posso usar a fonte paga para a curva?",
      mentionedAgentIds: [],
      agentRunId: "atlas-run",
      meta: {},
      createdAt: ago(20),
    });
    await open(state);
    const card = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("fonte paga")) as HTMLElement;
    expect(card.textContent).toContain("ajudando a Ada");
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Ver conversa" })));
    await settle(3);
    expect(panel()?.getAttribute("aria-label")).toBe("Conversa entre a Ada e o Atlas");
  });

  test("the answer far below its question: one line where it arrived, 'Ver' opens the conversation", async () => {
    const c = consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) });
    await open(talkAfter(withTalk(withAsk([c], true), c), 3));
    expect(document.querySelectorAll(".ac-consult").length).toBe(0);
    const line = screen()
      .getByText(/Atlas respondeu à pergunta da Ada/)
      .closest(".cn-line") as HTMLElement;
    expect(line).not.toBeNull();
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Ver" })));
    await settle(3);
    // The two agents' conversation over the channel: the question and the whole answer.
    expect(panel()?.textContent).toContain(QUESTION);
    expect(panel()?.textContent).toContain("subiu 6 pb");
  });

  test("without questions the reply has no block, and the notice stays", async () => {
    const state = withAsk([], true);
    await open(state);
    expect(group()).toBeNull();
    expect(document.querySelectorAll(".ac-consult").length).toBe(1);
  });

  test("the reply that asked isn't loaded here: the notice keeps its card", async () => {
    const state = withAsk([consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) })], true);
    // The asking reply is further up, not paged in: only the notice is here.
    state.messages = state.messages.filter((m) => m.id !== "msg-asked");
    await open(state);
    expect(document.querySelectorAll(".ac-consult").length).toBe(1);
    expect(document.querySelector(".ac-consult-group")).toBeNull();
  });

  test("an event reloads the list: an answer that came shows in place", async () => {
    const { socket, state } = await open(withAsk([consultation({})]));
    expect(group()?.textContent).toContain("Atlas está trabalhando");
    state.consultations = {
      [ENG_ID]: [consultation({ status: "answered", answer: ANSWER, answeredAt: ago(1) })],
    };
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "agent.consulted",
          channelId: ENG_ID,
          threadId: null,
          runId: RUN,
          agentId: ADA_ID,
          consultedAgentId: ATLAS_ID,
          status: "answered",
        },
      }),
    );
    await settle(5);
    // The answer is in: the same line says so, in place.
    const block = group() as HTMLElement;
    expect(block.textContent).toContain("Atlas respondeu");
    expect(block.querySelector(".ac-tools__line")?.getAttribute("data-s")).toBe("done");
  });
});

describe("the working line while the block shows the questions", () => {
  test("the reply that asked is close: its block says it, the line doesn't; the asker's own work stays", async () => {
    const { socket } = await open(withAsk([consultation({})]));
    await push(socket, asking);
    await settle(2);
    expect(group()?.textContent).toContain("Atlas está trabalhando");
    expect(bar()).toBe("");
    expect(typingBar().getAttribute("data-active")).toBe("false");
    // Ada at work again (another turn): her own line, not the question.
    await push(socket, { type: "agent.thinking", runId: "r-next", agentId: ADA_ID });
    await settle(2);
    expect(bar()).toBe("Ada");
  });

  test("the reply that asked is farther up: the line still says it (the only sign at the bottom)", async () => {
    const { socket } = await open(talkAfter(withAsk([consultation({})]), 3));
    await push(socket, asking);
    await settle(2);
    expect(bar()).toBe("Ada está perguntando ao Atlas…");
    expect(typingBar().querySelector(".ac-typing__clock")).not.toBeNull();
  });
});
