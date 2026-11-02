import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async (state = seedState(), api = createFakeApi(state)) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state };
};
/**
 * The reply moved under João's post and that thread opened beside the channel: a thread view has no panel of its
 * own, so the pill there opens in place (in the channel it opens the two agents' conversation in the panel).
 */
const openInThread = async (state: ReturnType<typeof seedState>) => {
  const reply = state.messages.at(-1) as (typeof state.messages)[number];
  reply.threadId = "m-1";
  const api = createFakeApi(state);
  await state.openThread?.(ORG_ID, "m-1", reply.createdAt);
  const r = await open(state, api);
  const channel = screen().getByRole("region", { name: /Mensagens/ });
  await act(async () => fireEvent.click(within(channel).getByRole("button", { name: /1 resposta/ })));
  await settle(6);
  return { ...r, thread: screen().getByRole("complementary", { name: "Thread" }) };
};
const push = (socket: { push: (f: unknown) => void }, event: Record<string, unknown>, channelId = ENG_ID) =>
  act(async () => socket.push({ type: "event", channelId, event: { channelId, ...event } }));
const rowWith = (text: string) =>
  screen()
    .getAllByRole("article")
    .find((a) => a.textContent?.includes(text)) as HTMLElement;
const typingBar = () => document.querySelector(".ac-typing") as HTMLElement;
const bar = () => typingBar().querySelector(".ac-typing__text")?.textContent ?? "";

const QUESTION = "Como subo um fix em staging hoje?";
const ANSWER = "**Staging** sobe sozinho quando o PR entra.\n\nHoje use a fila reserva.";

function withReply(meta: Record<string, unknown>, body = "Já subi o fix em staging.") {
  const state = seedState();
  state.messages.push({
    id: "msg-reply",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body,
    mentionedAgentIds: [],
    agentRunId: "r-reply",
    meta,
    createdAt: new Date().toISOString(),
  });
  return state;
}

const pillsIn = (el: ParentNode) => [...el.querySelectorAll(".ac-talk")] as HTMLElement[];

describe("what another agent said before the reply (meta.consulted): the two agents' pill", () => {
  test("answered: 'Ada ⇄ Atlas · respondeu' on top of the reply; a click opens their conversation beside", async () => {
    await open(
      withReply({
        consulted: [
          { agentId: ATLAS_ID, consultationId: "k1", status: "answered", question: QUESTION, answer: ANSWER },
        ],
      }),
    );
    const row = rowWith("Já subi o fix");
    const [pill] = pillsIn(row);
    expect(pill?.textContent).toBe("Ada ⇄ Atlas · respondeu");
    expect(pill?.querySelectorAll(".ac-avatar--agent")).toHaveLength(2);
    // On top of the reply's text.
    expect(
      (pill as HTMLElement).compareDocumentPosition(row.querySelector(".ac-msg__text") as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await act(async () => fireEvent.click(pill as HTMLElement));
    await settle(3);
    // The panel beside the channel opens on that conversation (the fake backend has none stored for it).
    expect(document.querySelector("aside.thread-panel")?.getAttribute("aria-label")).toMatch(/^Conversa entre /);
  });

  test("in a thread (no panel): the pill opens in place to the question, the answer and who saw it", async () => {
    const { thread } = await openInThread(
      withReply({
        consulted: [
          { agentId: ATLAS_ID, consultationId: "k1", status: "answered", question: QUESTION, answer: ANSWER },
        ],
      }),
    );
    const [pill] = pillsIn(thread);
    expect(pill?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(pill as HTMLElement));
    const body = thread.querySelector(".ac-talk-detail") as HTMLElement;
    expect(body.textContent).toContain("Ada perguntou");
    expect(body.textContent).toContain(QUESTION);
    expect(body.textContent).toContain("Resposta do Atlas");
    expect(body.querySelector("strong")?.textContent).toBe("Staging");
    expect(body.textContent).toContain("Conversa só entre Ada e Atlas");
  });

  test("expired or failed: 'sem resposta'; one pill per agent asked", async () => {
    await open(
      withReply({
        consulted: [
          { agentId: ATLAS_ID, consultationId: "k2", status: "expired", question: QUESTION, answer: null },
          { agentId: ATLAS_ID, consultationId: "k3", status: "failed", question: QUESTION, answer: null },
          {
            agentId: ATLAS_ID,
            consultationId: "k4",
            status: "answered",
            question: "E o banco?",
            answer: "Em manutenção.",
          },
        ],
      }),
    );
    const pills = pillsIn(rowWith("Já subi o fix"));
    expect(pills.map((p) => p.textContent)).toEqual([
      "Ada ⇄ Atlas · sem resposta",
      "Ada ⇄ Atlas · sem resposta",
      "Ada ⇄ Atlas · respondeu",
    ]);
    expect(pills[0]?.classList.contains("ac-talk--failed")).toBe(true);
  });
});

describe("what came of work handed off (a `consult_reply` notice with `kind` `note`)", () => {
  /** Ada's conversation got what Atlas did with the work she handed it (`consultationId` none: nothing to open). */
  const withResult = (status: string, answer: string | null, consultationId?: string) => {
    const state = seedState();
    state.messages.push({
      id: "msg-result",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: answer ?? "",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        notice: {
          kind: "consult_reply",
          text: answer ?? "",
          from: "@atlas",
          refs: {
            kind: "note",
            ...(consultationId ? { consultationId } : {}),
            runId: "r-handed",
            askerAgentId: ADA_ID,
            agentId: ATLAS_ID,
            status,
            question:
              "[@ada mentioned you in a conversation, where you aren't a member, so it reaches you here]\n\nPassa a pasta ao Diogo e confirma que ele abre.",
            ...(answer ? { answer } : {}),
          },
        },
      },
      createdAt: new Date().toISOString(),
    });
    return state;
  };

  test("its pill opens what Ada wrote in place when there is no conversation to open, never the relay line", async () => {
    await open(withResult("answered", "Passei a pasta; o Diogo abriu."));
    const [pill] = pillsIn(document);
    expect(pill?.textContent).toBe("Ada ⇄ Atlas · respondeu");
    expect(pill?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(pill as HTMLElement));
    const body = document.querySelector(".ac-talk-detail") as HTMLElement;
    expect(body.textContent).toContain("Ada escreveu");
    expect(body.textContent).not.toContain("Ada perguntou");
    expect(body.textContent).toContain("Passa a pasta ao Diogo");
    expect(body.textContent).not.toContain("mentioned you");
  });

  test("one that couldn't be finished: 'sem resposta'; with its id, the pill opens the conversation", async () => {
    await open(withResult("failed", null, "k9"));
    const [pill] = pillsIn(document);
    expect(pill?.textContent).toBe("Ada ⇄ Atlas · sem resposta");
    expect(pill?.hasAttribute("aria-expanded")).toBe(false);
  });
});

describe("an agent that joined on its own (meta.joined)", () => {
  test("a faint 'entrou na conversa' next to the time, with a tip that says why", async () => {
    await open(withReply({ joined: true }, "Só um ponto: o vídeo fica pronto no dia 26."));
    const row = rowWith("o vídeo fica pronto");
    const note = row.querySelector(".ac-msg__note") as HTMLElement;
    expect(note.getAttribute("tabindex")).toBe("0");
    expect(note.textContent).toContain("entrou na conversa");
    expect(row.querySelector(".ac-msg__note-tip")?.textContent).toBe("Ninguém chamou a Ada. Ela entrou para ajudar.");
    expect(note.getAttribute("aria-describedby")).toBe(row.querySelector(".ac-msg__note-tip")?.id ?? "");
    // Others' replies don't say it.
    expect(rowWith("Achei a causa")?.querySelector(".ac-msg__note") ?? null).toBeNull();
  });
});

describe("the working line while an agent asks another", () => {
  test("'Ada está perguntando para Atlas…' with both bodies and a clock → 'Atlas respondeu. Ada está escrevendo…' → the reply", async () => {
    const { socket } = await open();
    const run = { threadId: null, runId: "r-ask", agentId: ADA_ID };
    await push(socket, { type: "agent.thinking", ...run });
    await settle();
    expect(bar()).toBe("Ada");
    await push(socket, { type: "agent.tool", ...run, tool: "ask_agent" });
    await push(socket, { type: "agent.consulting", ...run, consultedAgentId: ATLAS_ID });
    // The asking run pauses while it waits.
    await push(socket, { type: "agent.idle", ...run });
    await push(socket, { type: "run.finished", ...run, status: "waiting_input" });
    await settle();
    expect(bar()).toBe("Ada está perguntando para Atlas…");
    expect(typingBar().querySelectorAll(".ac-typing__text b")).toHaveLength(2);
    expect(typingBar().querySelectorAll(".ac-typing__tok .ac-avatar--agent")).toHaveLength(2);
    expect(typingBar().querySelector(".ac-typing__to svg")).not.toBeNull();
    // The one asked is thinking.
    expect(typingBar().querySelectorAll(".ac-typing__tok")[1]?.querySelector(".ac-avatar--thinking")).not.toBeNull();
    const clock = typingBar().querySelector(".ac-typing__clock") as HTMLElement;
    expect(clock.className).toContain("ac-num");
    expect(clock.textContent).toMatch(/^\d+:\d\d$/);
    // Both faces open the pill: no pixel orbit beside them.
    expect(typingBar().querySelector(".ac-pixspin")).toBeNull();
    await push(socket, { type: "agent.consulted", ...run, consultedAgentId: ATLAS_ID, status: "answered" });
    await push(socket, { type: "agent.thinking", ...run });
    await settle();
    expect(bar()).toBe("Atlas respondeu. Ada está escrevendo…");
    expect(typingBar().querySelector(".ac-typing__clock")).toBeNull();
    await push(socket, { type: "agent.delta", ...run, seq: 0, text: "O Atlas me passou" });
    await settle();
    // Writing now: the question is over; the card stays on while she works.
    expect(bar()).toBe("Ada");
    expect(typingBar().querySelector(".ac-typing__to")).toBeNull();
  });

  test("several agents: one line, stacked, 'Ada e Atlas estão trabalhando…'; it shrinks as each one finishes", async () => {
    const { socket } = await open();
    await push(socket, { type: "agent.thinking", threadId: null, runId: "r-a", agentId: ADA_ID });
    await push(socket, { type: "agent.thinking", threadId: null, runId: "r-b", agentId: ATLAS_ID });
    await settle();
    expect(bar()).toBe("Ada e Atlas estão trabalhando…");
    expect(typingBar().querySelectorAll(".ac-typing__tok")).toHaveLength(2);
    await push(socket, { type: "agent.idle", threadId: null, runId: "r-b", agentId: ATLAS_ID });
    await settle();
    expect(bar()).toBe("Ada");
    // Alone, with its row not in the conversation yet: the bar keeps its face until the row shows.
    expect(typingBar().querySelectorAll(".ac-typing__tok")).toHaveLength(1);
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    expect(typingBar().querySelectorAll(".ac-typing__tok")).toHaveLength(0);
  });
});
