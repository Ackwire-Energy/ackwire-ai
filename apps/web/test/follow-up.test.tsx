import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { formatTime } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

test("an agent's follow-up shows as a quiet line with when it comes back, and anyone here can cancel it", async () => {
  const state = seedState();
  const at = new Date(Date.now() + 30 * 60_000).toISOString();
  const line = (id: string, refs: Record<string, string>, minutesAgo: number) => ({
    id,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent" as const, id: ATLAS_ID },
    body: "Check CI run 42 and give the per-job times.",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: { notice: { kind: "follow_up", text: "Check CI run 42 and give the per-job times.", refs } },
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
  state.messages.push(
    line("m-set", { runId: "r1", at, about: "ver o CI", state: "pending" }, 3),
    line("m-old", { runId: "r0", at, about: "ver o deploy", state: "canceled" }, 2),
  );
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(6);

  const time = formatTime("pt-BR", at);
  expect(screen().getByText(new RegExp(`Atlas volta às ${time} para ver o CI`))).toBeTruthy();
  expect(screen().getByText(new RegExp(`Atlas não volta mais às ${time} para ver o deploy`))).toBeTruthy();
  // Only the one still to come can be canceled.
  const cancel = screen().getAllByRole("button", { name: "Cancelar" });
  expect(cancel.length).toBe(1);
  await act(async () => fireEvent.click(cancel[0] as HTMLElement));
  expect(state.calls.filter((c) => c.method === "chat.cancelFollowUp").map((c) => c.args)).toEqual([[ORG_ID, "m-set"]]);
});
