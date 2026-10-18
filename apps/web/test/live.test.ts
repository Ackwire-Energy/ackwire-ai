import { describe, expect, test } from "bun:test";
import type { ChannelEvent, Message } from "@agenteschat/client";
import {
  applyChannelEvent,
  applyReceiptEvent,
  applyTyping,
  emptyStreams,
  expectReply,
  receiptView,
  runsInChannel,
  seedReceipt,
  stopTyping,
  TYPING_TTL_MS,
  typingIn,
  typingThrottle,
} from "@agenteschat/client";

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

describe("server confirmation and the safety timeout", () => {
  test("message.routed is authoritative: a guessed 'picked' falls back to 'seen' and the provisional row goes", async () => {
    const { guessReceipt } = await import("@agenteschat/client");
    let r = guessReceipt({}, "m1", ["theo"]);
    expect(receiptView(r.m1).status?.kind).toBe("picked");
    expect(r.m1?.confirmed).toBe(false);
    r = applyReceiptEvent(r, {
      type: "message.routed",
      channelId: "c",
      messageId: "m1",
      seenBy: ["theo"],
      pickedBy: [],
    });
    expect(receiptView(r.m1).status).toEqual({ kind: "nobody" });
    let s = expectReply(emptyStreams, { channelId: "c", threadId: "m1", agentId: "theo" });
    s = applyChannelEvent(s, {
      type: "message.routed",
      channelId: "c",
      messageId: "m1",
      seenBy: ["theo"],
      pickedBy: [],
    });
    expect(runsInChannel(s, "c")).toEqual([]);
  });

  test("an unconfirmed 'pensando…' is dropped after 20 s and its channel resyncs", async () => {
    const { createStreamsStore, PROVISIONAL_TTL_MS } = await import("@/realtime/context");
    let now = 1000;
    const store = createStreamsStore(undefined, () => now);
    store.expect("c1", "m1", ["theo"]);
    expect(runsInChannel(store.get().streams, "c1")).toHaveLength(1);
    now += PROVISIONAL_TTL_MS - 1;
    expect(store.sweep()).toEqual([]);
    now += 2;
    expect(store.sweep()).toEqual(["c1"]);
    expect(runsInChannel(store.get().streams, "c1")).toEqual([]);
    expect(store.get().receipts.m1).toBeUndefined();
  });

  test("server receipts from a refetch replace the client's guess", () => {
    const guessed = applyReceiptEvent(
      {},
      { type: "agent.thinking", channelId: "c", threadId: "x", agentId: "a", runId: null },
    );
    expect(guessed.x?.confirmed).toBe(true);
    const local = seedReceipt({}, {
      id: "m1",
      author: { type: "person", id: "u" },
      mentionedAgentIds: ["theo"],
    } as unknown as Message);
    expect(local.m1?.confirmed).toBe(false);
    const fromServer = seedReceipt(local, {
      id: "m1",
      author: { type: "person", id: "u" },
      mentionedAgentIds: ["theo"],
      receipts: { seenBy: ["theo"], pickedBy: [], handled: [], blocked: ["theo"] },
    } as unknown as Message);
    // Only when the server says the mentioned agent can't answer this person.
    expect(receiptView(fromServer.m1).status).toEqual({ kind: "nobody" });
  });
});

describe("receipts when the mention doesn't start a new run", () => {
  const person = (id: string, mentioned: string[], extra: Partial<Message> = {}) =>
    ({ id, author: { type: "person", id: "u" }, mentionedAgentIds: mentioned, ...extra }) as unknown as Message;
  // Loose on purpose: some events (agent.run.steered) live in the client stream union, not ChannelEvent.
  const ev = (e: Record<string, unknown> & { type: string }) => ({ channelId: "c1", ...e }) as unknown as ChannelEvent;

  test("a mention steered into the agent's task: never 'nobody'; picked from the list receipts", () => {
    // The old list receipts (no run of its own, nothing blocked): seen only, not "nobody".
    const old = seedReceipt(
      {},
      person("m2", ["theo"], { receipts: { seenBy: ["theo"], pickedBy: [], handled: [], blocked: [] } }),
    );
    expect(receiptView(old.m2).status).toBeNull();
    // Today's: the steered run is the one answering it.
    const s = seedReceipt(
      {},
      person("m2", ["theo"], {
        receipts: {
          seenBy: ["theo"],
          pickedBy: ["theo"],
          handled: [{ agentId: "theo", runId: "r1", status: "running" }],
          blocked: [],
        },
      }),
    );
    expect(receiptView(s.m2).status).toEqual({ kind: "claimed", agents: ["theo"] });
  });

  test("live: agent.run.steered marks the agent on the message; the run's end settles it", () => {
    let s = seedReceipt({}, person("m2", ["theo"]));
    s = applyReceiptEvent(s, ev({ type: "agent.run.steered", runId: "r1", agentId: "theo", messageId: "m2" }));
    expect(receiptView(s.m2).status).toEqual({ kind: "claimed", agents: ["theo"] });
    // A late "nobody picked it" decision without `blocked` doesn't hide a mention.
    s = applyReceiptEvent(s, ev({ type: "message.routed", messageId: "m2", seenBy: ["theo"], pickedBy: [] }));
    expect(receiptView(s.m2).status?.kind).not.toBe("nobody");
    s = applyReceiptEvent(
      s,
      ev({ type: "run.finished", threadId: "m1", runId: "r1", agentId: "theo", status: "done" }),
    );
    expect(receiptView(s.m2)).toMatchObject({ status: { kind: "handled", agents: ["theo"] }, done: true });
  });

  test("a reply that answers the agent's question: message.routed with its run picks the agent", () => {
    let s = seedReceipt({}, person("m3", []));
    s = applyReceiptEvent(
      s,
      ev({
        type: "message.routed",
        messageId: "m3",
        seenBy: ["theo"],
        pickedBy: ["theo"],
        runs: [{ agentId: "theo", runId: "r1" }],
        strategy: "mention",
      }),
    );
    expect(receiptView(s.m3).status).toEqual({ kind: "picked", agents: ["theo"] });
    s = applyReceiptEvent(s, ev({ type: "agent.typing", threadId: "root", runId: "r1", agentId: "theo" }));
    expect(receiptView(s.m3).status?.kind).toBe("claimed");
  });

  test("a mention the agent can't answer (blocked) says 'nobody'", () => {
    let s = seedReceipt({}, person("m4", ["theo"]));
    s = applyReceiptEvent(
      s,
      ev({ type: "message.routed", messageId: "m4", seenBy: ["theo"], pickedBy: [], blocked: ["theo"] }),
    );
    expect(receiptView(s.m4).status).toEqual({ kind: "nobody" });
  });

  test("a thread reply's run events land on the reply, not on the thread's root", () => {
    // Root m1 was answered by ada; the reply m2 mentions theo, whose run r2 has threadId = m1.
    let s = seedReceipt({}, person("m1", ["ada"]));
    s = applyReceiptEvent(s, ev({ type: "message.handled", messageId: "m1", agentId: "ada", runId: "r1" }));
    s = seedReceipt(s, person("m2", ["theo"], { threadId: "m1" }));
    s = applyReceiptEvent(
      s,
      ev({
        type: "message.routed",
        messageId: "m2",
        seenBy: ["theo"],
        pickedBy: ["theo"],
        runs: [{ agentId: "theo", runId: "r2" }],
      }),
    );
    s = applyReceiptEvent(s, ev({ type: "agent.thinking", threadId: "m1", runId: "r2", agentId: "theo" }));
    s = applyReceiptEvent(
      s,
      ev({ type: "agent.run", threadId: "m1", runId: "r2", agentId: "theo", status: "running" }),
    );
    expect(receiptView(s.m2).status).toEqual({ kind: "claimed", agents: ["theo"] });
    expect(s.m1?.agents.map(([id]) => id)).toEqual(["ada"]);
    const reply = {
      id: "m5",
      threadId: "m1",
      agentRunId: "r2",
      author: { type: "agent", id: "theo" },
      meta: {},
    } as unknown as Message;
    s = applyReceiptEvent(s, ev({ type: "message.created", messageId: "m5", message: reply }));
    expect(receiptView(s.m2).status).toEqual({ kind: "handled", agents: ["theo"] });
    expect(s.m1?.agents).toEqual([["ada", "handled"]]);
  });
});
