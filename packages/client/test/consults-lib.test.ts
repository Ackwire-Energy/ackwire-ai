import { describe, expect, test } from "bun:test";
import type { ChannelEvent } from "../src/api/types";
import { applyConsultEvent, type ConsultsState, consultsIn } from "../src/realtime/consults";

type Ev = Parameters<typeof applyConsultEvent>[1];
const at = 1_000;
const asked = (runId: string) =>
  ({
    type: "agent.consulting",
    channelId: "c1",
    threadId: "t1",
    runId,
    agentId: "theo",
    consultedAgentId: "ada",
  }) as Ev;
const answered = (runId: string) =>
  ({
    type: "agent.consulted",
    channelId: "c1",
    threadId: "t1",
    runId,
    agentId: "theo",
    consultedAgentId: "ada",
    status: "answered",
  }) as Ev;
const apply = (events: Ev[]) => events.reduce<ConsultsState>((s, e) => applyConsultEvent(s, e, at), {});

describe("live consultations", () => {
  test("the answer woke another run of the asker: that run writing ends the line", () => {
    const back = apply([asked("r1"), answered("r1")]);
    expect(consultsIn(back, "c1", at)).toHaveLength(1);
    const delta = { type: "agent.delta", channelId: "c1", threadId: "t1", runId: "r2", agentId: "theo" } as Ev;
    expect(consultsIn(applyConsultEvent(back, delta, at), "c1", at)).toEqual([]);
  });

  test("the asker's message from another run ends the line; the notice itself does not", () => {
    const back = apply([asked("r1"), answered("r1")]);
    const message = (agentRunId: string | null) =>
      ({
        type: "message.created",
        channelId: "c1",
        messageId: "m1",
        message: { channelId: "c1", author: { type: "agent", id: "theo" }, agentRunId },
      }) as unknown as ChannelEvent;
    expect(consultsIn(applyConsultEvent(back, message(null), at), "c1", at)).toHaveLength(1);
    expect(consultsIn(applyConsultEvent(back, message("r2"), at), "c1", at)).toEqual([]);
  });

  test("a question still out stays while another run of the asker writes", () => {
    const out = apply([asked("r1")]);
    const delta = { type: "agent.delta", channelId: "c1", threadId: "t1", runId: "r2", agentId: "theo" } as Ev;
    expect(consultsIn(applyConsultEvent(out, delta, at), "c1", at)).toHaveLength(1);
  });

  test("another agent writing in the channel leaves the line", () => {
    const back = apply([asked("r1"), answered("r1")]);
    const delta = { type: "agent.delta", channelId: "c1", threadId: "t1", runId: "r9", agentId: "lisa" } as Ev;
    expect(consultsIn(applyConsultEvent(back, delta, at), "c1", at)).toHaveLength(1);
  });
});
