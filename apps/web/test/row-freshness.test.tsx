import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type Message, steerStore } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

/*
 * A row draws again only when its own props change. What it shows from ANOTHER message of the conversation (the
 * routine report its reply folds in, the message a run read) still shows when that message reaches the cache after
 * the row is on screen.
 */

afterEach(() => {
  steerStore.reset();
  cleanup();
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;

async function open(state = seedState()) {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
  await settle(3);
  const ev = (event: Record<string, unknown>) =>
    act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
  const heard = (m: Message) => ev({ type: "message.created", messageId: m.id, message: m });
  return { ev, heard };
}

describe("a row shows another message that reaches the cache after it", () => {
  test("a routine's reply, then the report it points to: the reply offers the report", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-told",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "Achei 3 erros novos no checkout.",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: { routine: { id: "rt-s", name: "Sentry diário", runId: "rr-1", noticeId: "m-report" } },
      createdAt: ago(2),
    });
    const { heard } = await open(state);
    expect(within(row("m-told")).queryByRole("button", { name: "Ver relatório" })).toBeNull();
    await heard({
      id: "m-report",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: {
        notice: {
          kind: "routine_handoff",
          text: "Relatório: 3 erros novos no checkout desde ontem.",
          refs: { routineName: "Sentry diário", routineId: "rt-s" },
        },
      },
      createdAt: ago(3),
    });
    await settle(4);
    await act(async () => fireEvent.click(within(row("m-told")).getByRole("button", { name: "Ver relatório" })));
    expect(row("m-told").textContent).toContain("Relatório: 3 erros novos no checkout desde ontem.");
  });

  test("a reply whose run read a message heard only after the reply: its steps quote that message", async () => {
    const { ev, heard } = await open();
    const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.typing", ...ids });
    await settle(2);
    await ev({ type: "agent.run.steered", ...ids, messageId: "m-steer" });
    await ev({ type: "agent.run.read", ...ids, messageIds: ["m-steer"] });
    await heard({
      id: "m-reply",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "O refresh também estava errado.",
      mentionedAgentIds: [],
      agentRunId: "r-live",
      createdAt: new Date(Date.now() + 20_000).toISOString(),
    });
    await ev({ type: "agent.run", ...ids, status: "done" });
    await settle(4);
    const well = () => row("m-reply").querySelector(".live-work__steer")?.textContent ?? "";
    expect(well()).not.toContain("Olha também o refresh");
    await heard({
      id: "m-steer",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "person", id: "u-walter" },
      body: "Olha também o refresh",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date(Date.now() + 10_000).toISOString(),
    });
    await settle(4);
    expect(well()).toContain("Olha também o refresh");
  });
});
