import { describe, expect, test } from "bun:test";
import type { ChannelEvent, Message } from "@/api/types";
import { applyReceiptEvent, receiptView, seedReceipt } from "@/realtime/receipts";
import { applyChannelEvent, emptyStreams, expectReply, runsInChannel } from "@/realtime/streams";
import { applyTyping, stopTyping, TYPING_TTL_MS, typingIn, typingThrottle } from "@/realtime/typing";

const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };

describe("agent activity: thinking → typing → idle", () => {
  test("a mention shows 'pensando' at once; the first server event replaces the provisional row", () => {
    // The server announces at post time (runId null), then the run thinks.
    let s = applyChannelEvent(emptyStreams, { type: "agent.thinking", ...base, runId: null });
    expect(runsInChannel(s, "c1")).toMatchObject([{ status: "thinking", provisional: true }]);
    s = expectReply(s, { channelId: "c1", threadId: "m1", agentId: "ada" });
    expect(runsInChannel(s, "c1")).toHaveLength(1);
    s = applyChannelEvent(s, { type: "agent.thinking", ...base });
    expect(runsInChannel(s, "c1")).toMatchObject([{ runId: "r1", status: "thinking" }]);
    expect(runsInChannel(s, "c1").some((r) => r.provisional)).toBe(false);
    s = applyChannelEvent(s, { type: "agent.typing", ...base });
    s = applyChannelEvent(s, { type: "agent.delta", ...base, seq: 1, text: "Achei" });
    expect(runsInChannel(s, "c1")).toMatchObject([{ status: "running", text: "Achei" }]);
    s = applyChannelEvent(s, { type: "agent.idle", ...base });
    expect(runsInChannel(s, "c1")).toEqual([]);
  });

  test("today's events work the same way: agent.run running without text is 'thinking'", () => {
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "running" });
    expect(runsInChannel(s, "c1")[0]?.status).toBe("thinking");
    s = applyChannelEvent(s, { type: "agent.delta", ...base, seq: 1, text: "Oi" });
    expect(runsInChannel(s, "c1")[0]?.status).toBe("running");
    s = applyChannelEvent(s, { type: "run.finished", ...base, status: "failed", error: "budget_exceeded" });
    expect(runsInChannel(s, "c1")[0]?.status).toBe("failed");
  });

  test("an agent's reply message settles its provisional row", () => {
    let s = expectReply(emptyStreams, { channelId: "c1", threadId: "m1", agentId: "ada" });
    const reply = { id: "m2", agentRunId: "r1", threadId: "m1", author: { type: "agent", id: "ada" } } as Message;
    s = applyChannelEvent(s, { type: "message.created", channelId: "c1", messageId: "m2", message: reply });
    expect(runsInChannel(s, "c1")).toEqual([]);
  });
});

describe("typing", () => {
  test("people typing expire after a few seconds and stop when their message arrives", () => {
    let s = applyTyping({}, "c1", "marina", 1000);
    expect(typingIn(s, "c1", 1000 + TYPING_TTL_MS - 1)).toEqual(["marina"]);
    expect(typingIn(s, "c1", 1000 + TYPING_TTL_MS + 1)).toEqual([]);
    expect(typingIn(s, "c1", 1000, "marina")).toEqual([]);
    s = stopTyping(s, "c1", "marina");
    expect(typingIn(s, "c1", 1000)).toEqual([]);
  });

  test("our own typing frames are throttled to one every 3 s", () => {
    const shouldSend = typingThrottle(3000);
    expect([0, 500, 2999, 3000, 3100, 6000].map(shouldSend)).toEqual([true, false, false, true, false, true]);
  });
});

describe("receipts", () => {
  const person = (mentioned: string[] = []) =>
    ({ id: "m1", author: { type: "person", id: "u" }, mentionedAgentIds: mentioned }) as unknown as Message;
  const step = (s: ReturnType<typeof seedReceipt>, e: Partial<ChannelEvent> & { type: string }) =>
    applyReceiptEvent(s, { channelId: "c1", ...e } as ChannelEvent);

  test("mentioned → vai responder → respondendo → esperando aprovação → respondendo → respondeu", () => {
    let s = seedReceipt({}, person(["ada"]));
    expect(receiptView(s.m1).status).toEqual({ kind: "picked", agents: ["ada"] });
    s = step(s, { type: "agent.run", threadId: "m1", runId: "r", agentId: "ada", status: "running" });
    expect(receiptView(s.m1).status?.kind).toBe("claimed");
    s = step(s, { type: "agent.run", threadId: "m1", runId: "r", agentId: "ada", status: "waiting_approval" });
    expect(receiptView(s.m1).status?.kind).toBe("waiting");
    s = step(s, { type: "agent.run", threadId: "m1", runId: "r", agentId: "ada", status: "running" });
    expect(receiptView(s.m1).status?.kind).toBe("claimed");
    s = step(s, { type: "message.handled", messageId: "m1", agentId: "ada" });
    expect(receiptView(s.m1)).toMatchObject({ status: { kind: "handled", agents: ["ada"] }, done: true });
    // A late "routed" doesn't move it back.
    s = step(s, { type: "message.routed", messageId: "m1", seenBy: ["ada"], pickedBy: ["ada"] });
    expect(receiptView(s.m1).status?.kind).toBe("handled");
  });

  test("seen by two, picked by nobody: 'Nenhum agente vai responder'", () => {
    let s = seedReceipt({}, person());
    expect(receiptView(s.m1).status).toBeNull();
    s = step(s, { type: "message.routed", messageId: "m1", seenBy: ["ada", "atlas"], pickedBy: [] });
    expect(receiptView(s.m1)).toMatchObject({ seen: ["ada", "atlas"], status: { kind: "nobody" } });
  });

  test("claimed and failed; server receipts seed the row", () => {
    let s = step({}, { type: "message.claimed", messageId: "m1", agentId: "atlas" });
    expect(receiptView(s.m1).status).toEqual({ kind: "claimed", agents: ["atlas"] });
    s = step(s, { type: "message.handled", messageId: "m1", agentId: "atlas", status: "failed" });
    expect(receiptView(s.m1).status).toEqual({ kind: "failed", agents: ["atlas"] });
    const seeded = seedReceipt(
      {},
      {
        ...person(),
        receipts: { seenBy: ["ada", "atlas"], pickedBy: ["ada"], handled: [{ agentId: "ada", status: "done" }] },
      },
    );
    expect(receiptView(seeded.m1)).toMatchObject({ seen: ["ada", "atlas"], status: { kind: "handled" } });
  });
});
