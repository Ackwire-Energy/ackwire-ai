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
/** Ada's question going out, live: "Ada está perguntando para Atlas…" on the working line. */
const asking = { type: "agent.consulting", runId: RUN, agentId: ADA_ID, consultedAgentId: ATLAS_ID };

const pills = () => [...(group()?.querySelectorAll(".ac-talk") ?? [])] as HTMLElement[];
/** The pill of Ada and Atlas talking, by what it says after their names. */
const pill = (state: RegExp) => within(group() as HTMLElement).getByRole("button", { name: state });

describe("the questions inside the reply that asked: one pill per agent (ConsultGroup)", () => {
  test("still out: Ada's face, the arrows, Atlas's face, 'Ada ⇄ Atlas · conversando há 40 s'", async () => {
    await open(withAsk([consultation({})]));
    const [one] = pills();
    expect(pills()).toHaveLength(1);
    expect(one?.textContent).toMatch(/^Ada ⇄ Atlas · conversando há 4\d s$/);
    expect(one?.getAttribute("aria-label")).toMatch(/^Conversa entre Ada e Atlas · conversando há 4\d s$/);
    expect(one?.classList.contains("ac-talk--waiting")).toBe(true);
    // A face on each side of the arrows.
    const faces = one?.querySelector(".ac-talk__faces");
    expect(faces?.children).toHaveLength(3);
    expect(faces?.children[1]?.tagName.toLowerCase()).toBe("svg");
    // No tool block with "Perguntou a 1 colega", nor its lines.
    expect(group()?.querySelector(".ac-tools__head, .ac-tools__line")).toBeNull();
    expect(group()?.textContent).not.toContain("Perguntou a");
    cleanup();
    // Two questions: two pills, nothing to open first.
    await open(withAsk([consultation({}), consultation({ id: "q2", question: "E a de 5 anos?" })]));
    expect(pills()).toHaveLength(2);
    expect(group()?.textContent).not.toContain("Perguntou a 2 colegas");
  });

  test("work handed off: the same pill, opening the request in the panel", async () => {
    const c = consultation({ kind: "note", waiting: "agents" });
    await open(withTalk(withAsk([c]), c));
    expect(group()?.textContent).not.toContain("Passou para 1 colega");
    await act(async () => fireEvent.click(pill(/Conversa entre Ada e Atlas/)));
    await settle(3);
    const side = panel() as HTMLElement;
    expect(side.textContent).toContain("Ada fez um pedido para Atlas em #eng");
    expect(side.textContent).toContain("O Atlas passou uma parte adiante e espera o retorno");
  });

  test("one that couldn't finish: 'sem resposta'", async () => {
    await open(
      withAsk([consultation({ kind: "note", status: "failed", answer: "stopped by a person", answeredAt: ago(2) })]),
    );
    const [one] = pills();
    expect(one?.textContent).toBe("Ada ⇄ Atlas · sem resposta");
    expect(one?.classList.contains("ac-talk--failed")).toBe(true);
  });

  test("answered: 'respondeu em 35 s'; a click opens the two agents' conversation over the channel, read only", async () => {
    const c = consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) });
    await open(withTalk(withAsk([c], true), c));
    const one = pill(/respondeu em/);
    expect(one.textContent).toBe("Ada ⇄ Atlas · respondeu em 35 s");
    await act(async () => fireEvent.click(one));
    await settle(3);
    // Not in place: in the panel over the channel, the question as it went and the answer.
    expect(group()?.textContent).not.toContain(QUESTION);
    const side = panel() as HTMLElement;
    expect(side.getAttribute("aria-label")).toBe("Conversa entre Ada e Atlas");
    expect(side.textContent).toContain(QUESTION);
    expect(side.textContent).toContain("subiu 6 pb");
    expect(one.getAttribute("aria-pressed")).toBe("true");
    // Read only: no composer there, a note instead.
    expect(within(side).queryByRole("combobox")).toBeNull();
    expect(side.textContent).toContain("Só leitura.");
    // The answer is shown once in the channel: the notice draws no second pill (it's close), nor a line.
    expect(document.querySelectorAll(".ac-talk")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("respondeu à pergunta");
  });

  test("still out: the panel says Atlas works on it; 'Falar com a Ada' closes it and mentions her", async () => {
    const c = consultation({});
    await open(withTalk(withAsk([c]), c));
    const line = pill(/conversando/);
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
    const line = pill(/conversando/);
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
    expect(panel()?.getAttribute("aria-label")).toBe("Conversa entre Ada e Atlas");
  });

  test("the answer far below its question: the two agents' pill where it arrived, opening the conversation", async () => {
    const c = consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) });
    await open(talkAfter(withTalk(withAsk([c], true), c), 3));
    const all = [...document.querySelectorAll(".ac-talk")] as HTMLElement[];
    // One in the reply that asked, one where the answer arrived: no "Atlas respondeu à pergunta da Ada · Ver".
    expect(all).toHaveLength(2);
    expect(document.body.textContent).not.toContain("respondeu à pergunta");
    const arrived = all[1] as HTMLElement;
    expect(arrived.textContent).toBe("Ada ⇄ Atlas · respondeu em 35 s");
    await act(async () => fireEvent.click(arrived));
    await settle(3);
    // The two agents' conversation over the channel: the question and the whole answer.
    expect(panel()?.textContent).toContain(QUESTION);
    expect(panel()?.textContent).toContain("subiu 6 pb");
  });

  test("without questions the reply has no block, and the notice stays", async () => {
    const state = withAsk([], true);
    await open(state);
    expect(group()).toBeNull();
    expect(document.querySelectorAll(".ac-talk")).toHaveLength(1);
  });

  test("the reply that asked isn't loaded here: the notice keeps its card", async () => {
    const state = withAsk([consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) })], true);
    // The asking reply is further up, not paged in: only the notice is here.
    state.messages = state.messages.filter((m) => m.id !== "msg-asked");
    await open(state);
    expect(document.querySelectorAll(".ac-talk")).toHaveLength(1);
    expect(document.querySelector(".ac-consult-group")).toBeNull();
  });

  test("the notice's card opens the two agents' conversation in the panel, never in place", async () => {
    const c = consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) });
    const state = withTalk(withAsk([c], true), c);
    state.messages = state.messages.filter((m) => m.id !== "msg-asked");
    await open(state);
    const card = document.querySelector(".ac-consult") as HTMLElement;
    const head = within(card).getByRole("button", { name: /Atlas respondeu/ });
    expect(head.getAttribute("aria-expanded")).toBeNull();
    await act(async () => fireEvent.click(head));
    await settle(3);
    // A long answer reads beside the chat: the card stays one line.
    expect(card.querySelector(".ac-consult__body")).toBeNull();
    expect(panel()?.getAttribute("aria-label")).toBe("Conversa entre Ada e Atlas");
    expect(panel()?.textContent).toContain("subiu 6 pb");
    expect(head.getAttribute("aria-pressed")).toBe("true");
  });

  test("an event reloads the list: an answer that came shows in place", async () => {
    const { socket, state } = await open(withAsk([consultation({})]));
    expect(group()?.textContent).toContain("conversando");
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
    // The answer is in: the same pill says so, in place.
    expect(pills()[0]?.textContent).toBe("Ada ⇄ Atlas · respondeu em 39 s");
    expect(pills()[0]?.classList.contains("ac-talk--answered")).toBe(true);
  });
});

describe("the working line while the block shows the questions", () => {
  test("the reply that asked is close: its block says it, the line doesn't; the asker's own work stays", async () => {
    const { socket } = await open(withAsk([consultation({})]));
    await push(socket, asking);
    await settle(2);
    expect(group()?.textContent).toContain("conversando");
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
    expect(bar()).toBe("Ada está perguntando para Atlas…");
    expect(typingBar().querySelector(".ac-typing__clock")).not.toBeNull();
  });
});
