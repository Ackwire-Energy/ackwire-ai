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
    // The answer is shown once: the `consult_reply` card isn't drawn again under it.
    expect(document.querySelectorAll(".ac-consult").length).toBe(0);
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
