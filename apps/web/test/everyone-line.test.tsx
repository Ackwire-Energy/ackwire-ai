import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, comfortable, createFakeApi, ENG_ID, NOW, ORG_ID, seedState } from "./fake-api";
import { renderApp, settle } from "./render";

afterEach(() => cleanup());

/** A person's @todos one agent answered for all of them (`meta.everyoneShape`). */
const everyone = (id: string, author: string, by: string | null, done: boolean): Message =>
  ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: author },
    body: "@todos regra para todos: nada de nome real de cliente em nada público",
    mentionedAgentIds: [ADA_ID, ATLAS_ID],
    agentRunId: null,
    meta: { mentionsEveryone: true, everyoneShape: by ? { answer: "one", by } : { answer: "none" } },
    createdAt: new Date(NOW.getTime() - 2 * 60_000).toISOString(),
    receipts: {
      seenBy: [ADA_ID, ATLAS_ID],
      pickedBy: by ? [by] : [],
      handled: by ? [{ agentId: by, runId: "r1", status: done ? ("done" as const) : ("running" as const) }] : [],
      blocked: [],
      referenced: by ? [ADA_ID, ATLAS_ID].filter((a) => a !== by) : [ADA_ID, ATLAS_ID],
    },
  }) as Message;
const lineOf = (id: string) =>
  document.querySelector(`article[data-message-id="${id}"] .ac-receipt--everyone`) as HTMLElement | null;

describe("a mention of everyone one agent answered for all", () => {
  test("one quiet line under it: who saw it, who answered for everyone, why behind its ⓘ", async () => {
    const state = comfortable(seedState());
    state.messages = [everyone("e1", "u-joao", ATLAS_ID, true), everyone("e2", "u-walter", null, false)];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const line = lineOf("e1");
    expect(line?.textContent).toContain("2 agentes viram · Atlas respondeu por todos");
    // The one who answered leads the faces.
    expect(line?.querySelectorAll(".ac-avatar")).toHaveLength(2);
    expect(line?.querySelector(".ac-hint")?.getAttribute("aria-label")).toBe("Sobre quem respondeu");
    // Asked nothing of the agents: only who saw it.
    expect(lineOf("e2")?.textContent).toContain("2 agentes viram");
    expect(lineOf("e2")?.textContent).not.toContain("por todos");
  });

  test("worst case: a long agent name wraps whole under its faces", async () => {
    const state = comfortable(seedState());
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.name = "Atlas Operações Financeiras e Conciliação Bancária Internacional";
    state.messages = [everyone("e3", "u-joao", ATLAS_ID, false)];
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(8);
    expect(lineOf("e3")?.textContent).toContain(
      "2 agentes viram · Atlas Operações Financeiras e Conciliação Bancária Internacional responde por todos",
    );
  });
});
