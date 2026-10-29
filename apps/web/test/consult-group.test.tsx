import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { RunConsultation } from "@agenteschat/client";
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
  test("still out: 'Perguntou a 1 colega' open, the agent working, the count", async () => {
    await open(withAsk([consultation({})]));
    const block = group();
    expect(block).not.toBeNull();
    const text = block?.textContent ?? "";
    expect(text).toContain("Perguntou a 1 colega");
    expect(text).toContain("0 de 1");
    expect(text).toContain("Atlas está trabalhando");
  });

  test("waiting on a person: says what it waits for", async () => {
    await open(withAsk([consultation({ waiting: "approval" })]));
    expect(group()?.textContent).toContain("espera uma aprovação");
  });

  test("waiting for its computer: says so, still out, not as waiting on a person", async () => {
    await open(withAsk([consultation({ waiting: "computer" })]));
    const text = group()?.textContent ?? "";
    expect(text).toContain("Atlas espera o computador voltar");
    expect(text).toContain("0 de 1");
    expect(text).not.toContain("espera uma");
  });

  test("answered: the line opens to the question and the answer, and the notice folds away", async () => {
    await open(withAsk([consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) })], true));
    const block = group() as HTMLElement;
    // Closed once every answer is in: the head opens it.
    fireEvent.click(within(block).getByRole("button", { name: /Perguntou a 1 colega/ }));
    await settle(1);
    const line = within(block).getByRole("button", { name: /Atlas respondeu/ });
    fireEvent.click(line);
    await settle(1);
    expect(block.textContent).toContain(QUESTION);
    expect(block.textContent).toContain("subiu 6 pb");
    // The answer is shown once: the `consult_reply` card isn't drawn again under it, nor a line (it's close).
    expect(document.querySelectorAll(".ac-consult").length).toBe(0);
    expect(document.body.textContent).not.toContain("respondeu à pergunta");
  });

  test("the answer far below its question: one line where it arrived, 'Ver' goes to the reply, open at the answer", async () => {
    const state = withAsk([consultation({ status: "answered", answer: ANSWER, answeredAt: ago(5) })], true);
    await open(talkAfter(state, 3));
    expect(document.querySelectorAll(".ac-consult").length).toBe(0);
    const line = screen().getByText(/Atlas respondeu à pergunta da Ada/).closest(".cn-line") as HTMLElement;
    expect(line).not.toBeNull();
    // Every answer is in: the block is closed.
    const head = () => within(group() as HTMLElement).getByRole("button", { name: /Perguntou a 1 colega/ });
    expect(head().getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Ver" })));
    // To the reply that asked, highlighted as a quote's jump does.
    expect(document.querySelector('[data-message-id="msg-asked"]')?.classList.contains("ac-msg--focus")).toBe(true);
    await settle(2);
    // Its block open at that answer: the question and the whole answer.
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(group()?.textContent).toContain(QUESTION);
    expect(group()?.textContent).toContain("subiu 6 pb");
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
    // Every answer is in: the block folds by itself, without the count; it opens to the answer.
    const block = group() as HTMLElement;
    expect(block.textContent).not.toContain("de 1");
    fireEvent.click(within(block).getByRole("button", { name: /Perguntou a 1 colega/ }));
    await settle(1);
    expect(block.textContent).toContain("Atlas respondeu");
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
    expect(bar()).toBe("Ada está trabalhando…");
  });

  test("the reply that asked is farther up: the line still says it (the only sign at the bottom)", async () => {
    const { socket } = await open(talkAfter(withAsk([consultation({})]), 3));
    await push(socket, asking);
    await settle(2);
    expect(bar()).toBe("Ada está perguntando ao Atlas…");
    expect(typingBar().querySelector(".ac-typing__clock")).not.toBeNull();
  });
});
