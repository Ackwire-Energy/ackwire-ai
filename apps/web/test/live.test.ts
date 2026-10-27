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

  test("who picked: kept from the decision and from the list; a decision from before says nothing", () => {
    const plan = { step: "plan" as const, brand: "claude" as const, ownerId: "u" };
    let s = seedReceipt({}, person());
    s = step(s, { type: "message.routed", messageId: "m1", seenBy: ["ada"], pickedBy: ["ada"], decidedBy: plan });
    expect(receiptView(s.m1)).toMatchObject({ status: { kind: "picked", agents: ["ada"] }, decidedBy: plan });
    // The run's own events keep it.
    s = step(s, { type: "agent.run", threadId: "m1", runId: "r", agentId: "ada", status: "running" });
    expect(receiptView(s.m1).decidedBy).toEqual(plan);

    const reply = { step: "rule" as const, rule: "reply" as const };
    const listed = (receipts: NonNullable<Message["receipts"]>) => ({ ...person(), receipts }) as Message;
    const seeded = seedReceipt({}, listed({ seenBy: ["ada"], pickedBy: ["ada"], handled: [], decidedBy: reply }));
    expect(receiptView(seeded.m1).decidedBy).toEqual(reply);
    const old = seedReceipt({}, listed({ seenBy: ["ada"], pickedBy: ["ada"], handled: [] }));
    expect(receiptView(old.m1)).not.toHaveProperty("decidedBy");
  });

  test("nobody could read it: the reason, live and after a reload; another nobody has none", () => {
    let s = seedReceipt({}, person());
    s = step(s, {
      type: "message.routed",
      messageId: "m1",
      seenBy: ["ada"],
      pickedBy: [],
      strategy: "router",
      reason: "mention_needed",
    });
    expect(receiptView(s.m1).status).toEqual({ kind: "nobody", mentionNeeded: true });
    const reloaded = seedReceipt({}, {
      ...person(),
      receipts: { seenBy: ["ada"], pickedBy: [], handled: [], reason: "mention_needed" },
    } as Message);
    expect(receiptView(reloaded.m1).status).toEqual({ kind: "nobody", mentionNeeded: true });
    const jev = step(seedReceipt({}, person()), {
      type: "message.routed",
      messageId: "m1",
      seenBy: ["ada"],
      pickedBy: [],
      decidedBy: { step: "jev" },
    });
    expect(receiptView(jev.m1)).toMatchObject({ status: { kind: "nobody" }, decidedBy: { step: "jev" } });
    expect(receiptView(jev.m1).status).not.toHaveProperty("mentionNeeded");
  });

  test("'Picking who answers' while the author's plan reads it, until the decision", () => {
    let s = seedReceipt({}, person());
    expect(receiptView(s.m1).picking).toBeUndefined();
    s = step(s, { type: "message.routing", messageId: "m1", step: "plan" });
    expect(receiptView(s.m1)).toEqual({ seen: [], status: null, done: false, referenced: [], picking: true });
    s = step(s, { type: "message.routed", messageId: "m1", seenBy: ["ada"], pickedBy: [], reason: "mention_needed" });
    expect(receiptView(s.m1).picking).toBeUndefined();
    expect(receiptView(s.m1).status).toEqual({ kind: "nobody", mentionNeeded: true });
    // A late "routing" after the decision changes nothing.
    expect(step(s, { type: "message.routing", messageId: "m1", step: "plan" })).toBe(s);
  });

  test("a list read before the decision keeps 'Picking who answers', whichever comes first", () => {
    const undecided = { ...person(), receipts: { seenBy: [], pickedBy: [], handled: [], blocked: [] } } as Message;
    const picking = { seen: [], status: null, done: false, referenced: [], picking: true as const };
    let s = step(seedReceipt({}, person()), { type: "message.routing", messageId: "m1", step: "plan" });
    s = seedReceipt(s, undecided);
    expect(receiptView(s.m1)).toEqual(picking);
    s = seedReceipt({}, undecided);
    s = step(s, { type: "message.routing", messageId: "m1", step: "plan" });
    expect(receiptView(s.m1)).toEqual(picking);
    s = step(s, { type: "message.routed", messageId: "m1", seenBy: ["ada"], pickedBy: ["ada"] });
    expect(receiptView(s.m1)).toMatchObject({ status: { kind: "picked", agents: ["ada"] } });
    expect(receiptView(s.m1).picking).toBeUndefined();
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

  test("a question asked in the channel (no thread) reaches the message its run answers", () => {
    let s = step(seedReceipt({}, person(["ada"])), {
      type: "message.claimed",
      messageId: "m1",
      agentId: "ada",
      runId: "r",
    });
    const question = { id: "q", agentId: "ada", runId: "r" };
    s = step(s, { type: "question.asked", threadId: null, question } as never);
    expect(receiptView(s.m1).status).toEqual({ kind: "asking", agents: ["ada"] });
    s = step(s, { type: "question.answered", threadId: null, question } as never);
    expect(receiptView(s.m1).status?.kind).toBe("claimed");
  });

  /** A read of m1, as over HTTP: new objects each time. */
  const read = (handled: NonNullable<Message["receipts"]>["handled"]) =>
    ({ ...person(["ada"]), receipts: { seenBy: ["ada"], pickedBy: ["ada"], handled, blocked: [] } }) as Message;
  const running = () => read([{ agentId: "ada", runId: "r1", status: "running" }]);

  test("a later read shows how her run ended when its events were missed; an older one moves nothing, not even sideways", () => {
    // Read as her run started; it ended for want of an AI before the channel's events reached us.
    let s = seedReceipt({}, running());
    expect(receiptView(s.m1).status).toEqual({ kind: "claimed", agents: ["ada"] });
    s = seedReceipt(s, read([{ agentId: "ada", runId: "r1", status: "failed", reason: "no_ai" }]));
    expect(receiptView(s.m1).status).toEqual({ kind: "no_ai", agents: ["ada"] });
    s = seedReceipt(s, running());
    expect(receiptView(s.m1).status).toEqual({ kind: "no_ai", agents: ["ada"] });
    // She asks live; a read made before that lands after it.
    s = seedReceipt({}, running());
    s = step(s, {
      type: "question.asked",
      threadId: null,
      question: { id: "q", agentId: "ada", runId: "r1" },
    } as never);
    s = seedReceipt(s, running());
    expect(receiptView(s.m1).status).toEqual({ kind: "asking", agents: ["ada"] });
  });

  test("after 'Responder agora', a read of her old run's end never covers the new run", () => {
    const noAi = read([{ agentId: "ada", runId: "r1", status: "failed", reason: "no_ai" }]);
    let s = seedReceipt({}, noAi);
    s = step(s, { type: "message.claimed", messageId: "m1", agentId: "ada", runId: "r2" });
    s = step(s, { type: "agent.run", runId: "r2", agentId: "ada", status: "running" });
    expect(receiptView(s.m1).status).toEqual({ kind: "claimed", agents: ["ada"] });
    // The list seeding that read again, and a copy of it made before she started again (a refetch on its way).
    s = seedReceipt(s, noAi);
    s = seedReceipt(s, structuredClone(noAi));
    expect(receiptView(s.m1).status).toEqual({ kind: "claimed", agents: ["ada"] });
    s = step(s, { type: "message.handled", messageId: "m1", agentId: "ada", runId: "r2", status: "done" });
    s = seedReceipt(s, structuredClone(noAi));
    expect(receiptView(s.m1)).toMatchObject({ status: { kind: "handled", agents: ["ada"] }, done: true });
  });

  test("a read nothing changed the receipt since it was asked for is taken as it is", () => {
    let s = seedReceipt({}, running());
    // She asked before the channel's events reached us.
    s = seedReceipt(s, read([{ agentId: "ada", runId: "r1", status: "waiting_input" }]), true);
    expect(receiptView(s.m1).status).toEqual({ kind: "asking", agents: ["ada"] });
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

  test("an agent the message only references: 'only mentioned', never 'will answer' nor 'nobody'", () => {
    // The sender's copy carries meta.referencedAgentIds: Atlas will answer, Ada is only referenced.
    let s = seedReceipt({}, person("m5", ["atlas", "ada"], { meta: { referencedAgentIds: ["ada"] } }));
    expect(s.m5?.agents).toEqual([
      ["atlas", "picked"],
      ["ada", "seen"],
    ]);
    s = applyReceiptEvent(
      s,
      ev({
        type: "message.routed",
        messageId: "m5",
        seenBy: ["atlas", "ada"],
        pickedBy: ["atlas"],
        runs: [{ agentId: "atlas", runId: "r5" }],
        referenced: ["ada"],
        strategy: "mention",
      }),
    );
    expect(receiptView(s.m5).status).toEqual({ kind: "picked", agents: ["atlas"] });
    expect(receiptView(s.m5).referenced).toEqual(["ada"]);
    s = applyReceiptEvent(
      s,
      ev({ type: "run.finished", runId: "r5", threadId: "m5", agentId: "atlas", status: "done" }),
    );
    expect(receiptView(s.m5)).toMatchObject({ status: { kind: "handled", agents: ["atlas"] }, done: true });
    // From the list API: referenced, nothing blocked.
    const listed = seedReceipt(
      {},
      person("m6", ["atlas", "ada"], {
        receipts: { seenBy: ["atlas", "ada"], pickedBy: [], handled: [], blocked: [], referenced: ["ada", "atlas"] },
      }),
    );
    // Everyone only referenced: the decision is final, nobody answers.
    expect(receiptView(listed.m6).status).toEqual({ kind: "nobody" });
  });

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
