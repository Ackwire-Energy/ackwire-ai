import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message, WorkView } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

const QUESTION = "Envio o lembrete agora ou espero a confirmação de amanhã?";
const work = (over: Partial<WorkView> = {}): WorkView => ({
  id: "w1",
  agentId: ADA_ID,
  channelId: ENG_ID,
  title: "Migrar os lembretes",
  status: "live",
  state: "waiting_input",
  how: "agent",
  anchorMessageId: "anchor",
  threadId: "anchor",
  homeThreadId: null,
  runId: "r1",
  requestedByUserId: "u-walter",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  nextUpdateAt: null,
  lastUpdate: { text: "Revisei a lista.", at: new Date().toISOString(), seq: 1 },
  question: { text: QUESTION, messageId: "ask" },
  plan: [],
  issue: { id: "i5", number: 5 },
  resultMessageId: null,
  queuePosition: null,
  pausedUntil: null,
  canceledByUserId: null,
  errorCode: null,
  ...over,
});

const message = (id: string, threadId: string | null, body: string, over: Partial<Message> = {}): Message =>
  ({
    id,
    channelId: ENG_ID,
    threadId,
    author: { type: "agent", id: ADA_ID },
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date().toISOString(),
    ...over,
  }) as Message;

let rendered: Awaited<ReturnType<typeof renderApp>>;

/** A channel with the work's anchor and a reply in its thread, so the thread's own line shows too. */
async function open(view: WorkView) {
  const state = seedState();
  state.messages = state.messages.filter((m) => m.channelId !== ENG_ID);
  state.messages.push(message("anchor", null, "Vou cuidar disso.", { longWork: view }));
  state.messages.push(message("ask", "anchor", QUESTION));
  const api = createFakeApi(state);
  await (api.threads as never as { openByReply: (org: string, root: string, at: string) => Promise<void> }).openByReply(
    ORG_ID,
    "anchor",
    new Date().toISOString(),
  );
  rendered = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  return document.querySelector(".ac-workline") as HTMLElement;
}

describe("Aguardando sua resposta, in the chat", () => {
  test("the row says what it asks, in place of the last update, and Abrir thread opens the panel beside the chat", async () => {
    const line = await open(work());
    expect(line.querySelector(".ac-workline__text")?.textContent).toContain("Aguardando sua resposta");
    const asked = line.querySelector(".ac-workline__question") as HTMLElement;
    expect(asked.textContent).toBe(QUESTION);
    expect(asked.getAttribute("title")).toBe(QUESTION);
    expect(line.querySelector(".ac-workline__update")).toBeNull();
    await act(async () => fireEvent.click(within(line).getByRole("button", { name: "Abrir thread" })));
    await settle(6);
    const panel = document.querySelector(".thread-panel") as HTMLElement;
    expect(panel.textContent).toContain(QUESTION);
    // Still the conversation's page: the panel opens beside it, never the task's.
    expect(rendered.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });

  test("waiting on an approval it opens the thread too; once working, the thread's own line is the one way in", async () => {
    const approval = await open(work({ state: "waiting_approval", question: null }));
    expect(within(approval).getByRole("button", { name: "Abrir thread" })).toBeTruthy();
    cleanup();
    const busy = await open(work({ state: "working", question: null }));
    expect(within(busy).queryByRole("button", { name: "Abrir thread" })).toBeNull();
    expect(busy.querySelector(".ac-workline__question")).toBeNull();
    expect(busy.querySelector(".ac-workline__update")?.textContent).toBe("Revisei a lista.");
  });
});
