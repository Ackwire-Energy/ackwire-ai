import { describe, expect, test } from "bun:test";
import type { ChannelEvent, Message } from "../src/index";
import {
  agentStateIn,
  agentStateOfRun,
  applyChannelEvent,
  emptyStreams,
  expectReply,
  MISSED_MESSAGE_GRACE_MS,
  parseServerFrame,
  RealtimeConnection,
  realtimeUrl,
  retargetProvisional,
  runningAgents,
  runsInChannel,
  type Timers,
} from "../src/index";
import { barEntries } from "../src/lib/activity";
import { fakeSockets } from "./fake-socket";

function manualTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = [];
  let next = 1;
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.push({ fn, ms, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = pending.findIndex((p) => p.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    setInterval: () => next++,
    clearInterval: () => {},
  };
  return { timers, pending, runNext: () => pending.shift()?.fn() };
}

describe("RealtimeConnection", () => {
  test("url uses ws/wss and the org id", () => {
    expect(realtimeUrl({ protocol: "https:", host: "agentes.chat" }, "o 1")).toBe(
      "wss://agentes.chat/api/ws?orgId=o%201",
    );
    expect(realtimeUrl({ protocol: "http:", host: "localhost:5173" }, "o1")).toBe(
      "ws://localhost:5173/api/ws?orgId=o1",
    );
    expect(realtimeUrl("https://app.agentes.chat/", "o1")).toBe("wss://app.agentes.chat/api/ws?orgId=o1");
    expect(realtimeUrl("http://192.168.0.2:3000", "o1")).toBe("ws://192.168.0.2:3000/api/ws?orgId=o1");
    expect(() => realtimeUrl("agentes.chat", "o1")).toThrow();
  });

  test("subscribes once per channel after open, routes events, unsubscribes when the last listener leaves", () => {
    const { factory, last } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x/api/ws?orgId=o", createSocket: factory, pingMs: 0 });
    const got: ChannelEvent[] = [];
    const offA = conn.subscribe("c1", (e) => got.push(e));
    const offB = conn.subscribe("c1", () => {});
    conn.start();
    const socket = last();
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual([{ type: "subscribe", channelId: "c1" }]);
    const event = { type: "agent.delta", channelId: "c1", threadId: "t", runId: "r", agentId: "a", seq: 1, text: "Oi" };
    socket.push({ type: "event", channelId: "c1", event });
    socket.push({ type: "event", channelId: "other", event });
    socket.push("not json");
    expect(got).toEqual([event as ChannelEvent]);
    offA();
    expect(socket.sent).toHaveLength(1);
    offB();
    expect(socket.sent).toEqual([
      { type: "subscribe", channelId: "c1" },
      { type: "unsubscribe", channelId: "c1" },
    ]);
  });

  test("reconnects with backoff, re-subscribes, and asks to catch up over HTTP", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({
      url: "ws://x",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 0,
      backoffMs: [100, 200],
    });
    let caughtUp = 0;
    const statuses: string[] = [];
    conn.onReconnect(() => caughtUp++);
    conn.onStatus((s) => statuses.push(s));
    conn.subscribe("c1", () => {});
    conn.start();
    sockets[0]?.open();
    expect(caughtUp).toBe(0);
    sockets[0]?.drop();
    expect(clock.pending.map((p) => p.ms)).toEqual([100]);
    clock.runNext();
    sockets[1]?.drop();
    expect(clock.pending.map((p) => p.ms)).toEqual([200]);
    clock.runNext();
    sockets[2]?.open();
    expect(sockets[2]?.sent).toEqual([{ type: "subscribe", channelId: "c1" }]);
    expect(caughtUp).toBe(1);
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  test("says when the server confirms a channel's subscription, again after a reconnect: its events start there", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({ url: "ws://x", createSocket: factory, timers: clock.timers, pingMs: 0 });
    const live: string[] = [];
    const off = conn.onSubscribed((channelId) => live.push(channelId));
    conn.subscribe("c1", () => {});
    conn.start();
    sockets[0]?.open();
    // Asked for, not confirmed yet: whatever the channel sends meanwhile doesn't reach us.
    expect(live).toEqual([]);
    sockets[0]?.push({ type: "subscribed", channelId: "c1" });
    expect(live).toEqual(["c1"]);
    sockets[0]?.drop();
    clock.runNext();
    sockets[1]?.open();
    sockets[1]?.push({ type: "subscribed", channelId: "c1" });
    expect(live).toEqual(["c1", "c1"]);
    off();
    sockets[1]?.push({ type: "subscribed", channelId: "c1" });
    expect(live).toEqual(["c1", "c1"]);
  });

  test("a socket that stops answering (asleep, a network change) is replaced, re-subscribes and catches up", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    let ping: (() => void) | null = null;
    clock.timers.setInterval = (fn) => {
      ping = fn;
      return 999;
    };
    const conn = new RealtimeConnection({
      url: "ws://x",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 30_000,
      pongTimeoutMs: 10_000,
      backoffMs: [100],
    });
    let caughtUp = 0;
    conn.onReconnect(() => caughtUp++);
    const got: unknown[] = [];
    conn.subscribe("c1", (e) => got.push(e));
    conn.start();
    sockets[0]?.open();
    // Answered: still the same socket.
    (ping as unknown as () => void)();
    sockets[0]?.push({ type: "pong" });
    expect(clock.pending).toEqual([]);
    // Silent (half-open: the browser never fires close): replaced.
    conn.checkAlive();
    expect(sockets[0]?.sent.at(-1)).toEqual({ type: "ping" });
    expect(clock.pending.map((p) => p.ms)).toEqual([10_000]);
    clock.runNext();
    expect(sockets[0]?.closed).toBe(true);
    expect(conn.status).toBe("reconnecting");
    clock.runNext();
    sockets[1]?.open();
    expect(sockets[1]?.sent).toEqual([{ type: "subscribe", channelId: "c1" }]);
    expect(caughtUp).toBe(1);
    // A late close of the dead socket changes nothing.
    sockets[0]?.drop();
    expect(conn.status).toBe("open");
    const event = { type: "agent.thinking", channelId: "c1", threadId: null, agentId: "a", runId: "r" };
    sockets[1]?.push({ type: "event", channelId: "c1", event });
    expect(got).toEqual([event]);
  });

  test("a channel the server drops or refuses on a live socket is asked for again and caught up", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({
      url: "ws://x",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 0,
      backoffMs: [100, 200],
    });
    const live: string[] = [];
    conn.onSubscribed((channelId) => live.push(channelId));
    const got: unknown[] = [];
    conn.subscribe("c1", (e) => got.push(e));
    conn.subscribe("c2", () => {});
    conn.start();
    const socket = sockets[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    socket.push({ type: "subscribed", channelId: "c1" });
    socket.push({ type: "subscribed", channelId: "c2" });
    socket.sent.length = 0;
    // Dropped server-side (after a membership recheck): the socket stays up, the channel goes silent.
    socket.push({ type: "unsubscribed", channelId: "c1", reason: "revoked" });
    expect(clock.pending.map((p) => p.ms)).toEqual([100]);
    clock.runNext();
    expect(socket.sent).toEqual([{ type: "subscribe", channelId: "c1" }]);
    // Refused once, then allowed.
    socket.push({ type: "error", code: "forbidden", channelId: "c1" });
    expect(clock.pending.map((p) => p.ms)).toEqual([200]);
    clock.runNext();
    socket.push({ type: "subscribed", channelId: "c1" });
    expect(live).toEqual(["c1", "c2", "c1"]);
    const event = { type: "agent.thinking", channelId: "c1", threadId: null, agentId: "a", runId: "r" };
    socket.push({ type: "event", channelId: "c1", event });
    expect(got).toEqual([event]);
    // A real refusal stops after the last backoff step.
    socket.push({ type: "unsubscribed", channelId: "c1", reason: "archived" });
    clock.runNext();
    socket.push({ type: "error", code: "forbidden", channelId: "c1" });
    clock.runNext();
    socket.push({ type: "error", code: "forbidden", channelId: "c1" });
    expect(clock.pending).toEqual([]);
    // No listener left: nothing to ask for.
    socket.push({ type: "unsubscribed", channelId: "gone" });
    expect(clock.pending).toEqual([]);
  });

  test("a subscribe refused by the rate limit (no channel id) is sent again for the channels not confirmed", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({
      url: "ws://x",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 0,
      backoffMs: [100],
    });
    conn.subscribe("c1", () => {});
    conn.subscribe("c2", () => {});
    conn.start();
    const socket = sockets[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    socket.push({ type: "subscribed", channelId: "c1" });
    socket.push({ type: "error", code: "rate_limited" });
    socket.sent.length = 0;
    clock.runNext();
    expect(socket.sent).toEqual([{ type: "subscribe", channelId: "c2" }]);
  });

  test("a notification for a message whose message.created never came subscribes its channel anew and catches up", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({ url: "ws://x", createSocket: factory, timers: clock.timers, pingMs: 0 });
    const caughtUp: string[] = [];
    conn.onSubscribed((channelId) => caughtUp.push(channelId));
    conn.subscribe("c1", () => {});
    conn.start();
    const socket = sockets[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    socket.push({ type: "subscribed", channelId: "c1" });
    socket.sent.length = 0;
    const reply = (messageId: string, channelId = "c1", readAt: string | null = null) =>
      socket.push({
        type: "event",
        scope: "user",
        event: { type: "notification.upserted", notification: { source: { channelId, messageId }, readAt } },
      });
    // Heard live first: nothing to do.
    socket.push({
      type: "event",
      channelId: "c1",
      event: { type: "message.created", channelId: "c1", messageId: "m1" },
    });
    reply("m1");
    // Read already, or in a channel nobody here listens to: nothing either.
    reply("m2", "c1", "2026-11-01T21:10:00Z");
    reply("m3", "c9");
    expect(clock.pending.map((p) => p.ms)).toEqual([]);
    // The channel went silent: the reply's notification comes, its message.created doesn't.
    reply("m4");
    expect(clock.pending.map((p) => p.ms)).toEqual([MISSED_MESSAGE_GRACE_MS]);
    clock.runNext();
    expect(socket.sent).toEqual([
      { type: "unsubscribe", channelId: "c1" },
      { type: "subscribe", channelId: "c1" },
    ]);
    socket.push({ type: "unsubscribed", channelId: "c1" });
    socket.push({ type: "subscribed", channelId: "c1" });
    expect(caughtUp).toEqual(["c1", "c1"]);
    // The answer to its own unsubscribe asked for no extra retry once the channel was confirmed.
    expect(clock.pending).toEqual([]);
    // The message.created arriving within the grace cancels it.
    reply("m5");
    socket.push({
      type: "event",
      channelId: "c1",
      event: { type: "message.created", channelId: "c1", messageId: "m5" },
    });
    socket.sent.length = 0;
    clock.runNext();
    expect(socket.sent).toEqual([]);
  });

  test("stop closes the socket and never reconnects", () => {
    const { factory, last } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({ url: "ws://x", createSocket: factory, timers: clock.timers, pingMs: 0 });
    conn.start();
    last().open();
    conn.stop();
    expect(last().closed).toBe(true);
    expect(clock.pending).toEqual([]);
    expect(conn.status).toBe("closed");
  });

  test("server errors reach error listeners; unknown frames are ignored", () => {
    expect(parseServerFrame('{"type":"error","code":"forbidden","channelId":"c"}')).toEqual({
      type: "error",
      code: "forbidden",
      channelId: "c",
    });
    expect(parseServerFrame("{}")).toBeNull();
    expect(parseServerFrame(42)).toBeNull();
    const { factory, last } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x", createSocket: factory, pingMs: 0 });
    const errors: string[] = [];
    conn.onError((code) => errors.push(code));
    conn.start();
    last().open();
    last().push({ type: "error", code: "forbidden", channelId: "c" });
    last().push({ type: "membership.revoked" });
    expect(errors).toEqual(["forbidden"]);
  });
});

describe("live agent runs (streaming)", () => {
  const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "atlas" };
  const delta = (seq: number, text: string): ChannelEvent => ({ type: "agent.delta", ...base, seq, text });

  test("a piece of the text that never arrived: no glued text, it shows again from the next turn", () => {
    const piece = (seq: number, turn: number, at: number, text: string): ChannelEvent => ({
      type: "agent.delta",
      ...base,
      seq,
      turn,
      at,
      text,
    });
    const text = (s: typeof emptyStreams) => s.runs.r1?.text;
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "running" });
    s = applyChannelEvent(s, piece(0, 1, 0, "O bot já existe "));
    // Pieces 1 and 2 were lost (the socket went down a moment, or this conversation was closed meanwhile).
    s = applyChannelEvent(s, piece(3, 1, 40, "no Entra ID."));
    expect(text(s)).toBe("");
    s = applyChannelEvent(s, piece(4, 1, 52, " Qual dos dois?"));
    expect(text(s)).toBe("");
    s = applyChannelEvent(s, piece(5, 2, 0, "Pronto: "));
    s = applyChannelEvent(s, piece(6, 2, 8, "conferi."));
    expect(text(s)).toBe("Pronto: conferi.");
    // Opened in the middle of a turn: what came before is missing too.
    let late = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "running" });
    late = applyChannelEvent(late, piece(9, 3, 120, "metade de uma frase"));
    expect(text(late)).toBe("");
    // Nothing missed: every piece in place, also after a tool call moved the text so far to the narration.
    let whole = applyChannelEvent(emptyStreams, piece(0, 1, 0, "Vou olhar. "));
    whole = applyChannelEvent(whole, { type: "agent.tool", ...base, tool: "azure_monitor", toolUseId: "t1" });
    whole = applyChannelEvent(whole, piece(1, 1, 11, "Achei."));
    expect(text(whole)).toBe("Achei.");
  });

  test("running → ordered deltas (duplicates ignored) → final message replaces the stream", () => {
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "running" });
    expect(runningAgents(s)).toEqual(new Set(["atlas"]));
    s = applyChannelEvent(s, delta(1, "Os 401 no Sentry "));
    s = applyChannelEvent(s, delta(2, "caíram de 312 para"));
    s = applyChannelEvent(s, delta(2, "caíram de 312 para"));
    expect(runsInChannel(s, "c1")[0]?.text).toBe("Os 401 no Sentry caíram de 312 para");
    const message = { id: "m9", agentRunId: "r1", channelId: "c1" } as Message;
    s = applyChannelEvent(s, { type: "message.created", channelId: "c1", messageId: "m9", message });
    expect(runsInChannel(s, "c1")).toEqual([]);
    // Late events for a finished run don't bring it back.
    s = applyChannelEvent(s, delta(3, "x"));
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "done" });
    expect(runsInChannel(s, "c1")).toEqual([]);
  });

  test("waiting (for its computer, or an answer) isn't working: the row goes and the agent rests", () => {
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "running" });
    expect(agentStateIn(s, "atlas")).toBe("thinking");
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "waiting_input" } as unknown as ChannelEvent);
    expect(runsInChannel(s, "c1")).toEqual([]);
    expect(runningAgents(s)).toEqual(new Set());
    expect(agentStateIn(s, "atlas")).toBe("idle");
    // A row that still says waiting_input (an older event order) rests too.
    const row = { ...base, status: "waiting_input", text: "" } as unknown as Parameters<typeof agentStateOfRun>[0];
    expect(agentStateOfRun(row)).toBe("idle");
    // Back: the resumed run works again.
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "running" });
    expect(agentStateIn(s, "atlas")).toBe("thinking");
  });

  test("a delta before the run event still opens the stream; failures keep the reason", () => {
    let s = applyChannelEvent(emptyStreams, delta(1, "Oi"));
    expect(runsInChannel(s, "c1")[0]).toMatchObject({ status: "running", text: "Oi" });
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "failed", error: "budget_exceeded" });
    expect(runsInChannel(s, "c1")[0]).toMatchObject({ status: "failed", error: "budget_exceeded" });
    expect(runningAgents(s).size).toBe(0);
  });

  test("what a run posts inside a call (a tool's card, a DM) doesn't end it: the call's end and the reply still come", () => {
    const tool = (name: string | null, id: string) =>
      ({ type: "agent.tool", ...base, tool: name, toolUseId: id }) as unknown as ChannelEvent;
    const posted = (id: string, channelId: string, meta: Record<string, unknown>) =>
      ({
        type: "message.created",
        channelId,
        messageId: id,
        message: {
          id,
          agentRunId: "r1",
          channelId,
          threadId: channelId === "c1" ? "m1" : null,
          author: { type: "agent", id: "atlas" },
          meta,
        } as unknown as Message,
      }) as ChannelEvent;
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "running" });
    // As in production: the card propose_agent posts, while its call runs.
    s = applyChannelEvent(s, tool("propose_agent", "tu1"));
    s = applyChannelEvent(s, posted("m8", "c1", { actionCard: { kind: "agent_proposal" } }));
    s = applyChannelEvent(s, tool(null, "tu1"));
    // Any tool's post: a forum topic's card here, a DM to another agent.
    s = applyChannelEvent(s, tool("suggest_forum_topic", "tu2"));
    s = applyChannelEvent(s, posted("m7", "c1", { forumSuggestion: { title: "Rotinas" } }));
    s = applyChannelEvent(s, posted("m6", "dm1", { agentNote: { runId: "r1" } }));
    s = applyChannelEvent(s, tool(null, "tu2"));
    s = applyChannelEvent(s, delta(1, "Propus o Caio."));
    const [row] = runsInChannel(s, "c1");
    expect(row?.work).toMatchObject([
      { kind: "call", tool: "propose_agent", running: false },
      { kind: "call", tool: "suggest_forum_topic", running: false },
    ]);
    expect(row?.text).toBe("Propus o Caio.");
    // Its reply, with no call running, ends it.
    s = applyChannelEvent(s, posted("m9", "c1", {}));
    expect(runsInChannel(s, "c1")).toEqual([]);
  });

  test("a new run of the same agent in the channel clears its failed row", () => {
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "failed", error: "budget_exceeded" });
    // Another agent's run leaves it.
    s = applyChannelEvent(s, { type: "agent.run", ...base, runId: "r2", agentId: "iris", status: "running" });
    expect(runsInChannel(s, "c1").map((r) => r.runId)).toEqual([base.runId, "r2"]);
    s = applyChannelEvent(s, { type: "agent.run", ...base, runId: "r3", status: "running" });
    expect(runsInChannel(s, "c1").map((r) => r.runId)).toEqual(["r2", "r3"]);
  });
});

describe("the guessed 'pensando…' when the server is faster than the send", () => {
  test("the real run already shows: the guess goes instead of moving to the server id", () => {
    let s = expectReply(emptyStreams, { channelId: "dm", threadId: "local-1", agentId: "theo" }, 1000);
    // The run starts with the insert, so its event beats the POST answer.
    s = applyChannelEvent(s, {
      type: "agent.run",
      channelId: "dm",
      threadId: "m1",
      runId: "r1",
      agentId: "theo",
      status: "running",
    });
    expect(runsInChannel(s, "dm")).toHaveLength(2);
    s = retargetProvisional(s, "local-1", "m1");
    expect(runsInChannel(s, "dm").map((r) => r.runId)).toEqual(["r1"]);
  });

  test("no run yet: the guess moves to the server id", () => {
    let s = expectReply(emptyStreams, { channelId: "dm", threadId: "local-1", agentId: "theo" }, 1000);
    s = retargetProvisional(s, "local-1", "m1");
    expect(runsInChannel(s, "dm").map((r) => r.runId)).toEqual(["pending:theo:m1"]);
  });

  test("the send answers first, then a flat DM run starts: the run takes the guess's place", () => {
    let s = expectReply(emptyStreams, { channelId: "dm", threadId: "local-1", agentId: "theo" }, 1000);
    s = retargetProvisional(s, "local-1", "m1");
    s = applyChannelEvent(s, {
      type: "agent.run",
      channelId: "dm",
      threadId: null,
      runId: "r1",
      agentId: "theo",
      status: "running",
    } as unknown as ChannelEvent);
    const runs = runsInChannel(s, "dm");
    expect(runs.map((r) => r.runId)).toEqual(["r1"]);
    expect(runs[0]?.triggerMessageId).toBe("m1");
  });
});

describe("a run parked waiting for its computer (never 'working' forever)", () => {
  test("a flat DM's 'pensando…' rows go when the agent's run stops; a waiting run is not in the working bar", () => {
    // Two quick messages to Ada in a DM: provisional rows on each message.
    let s = expectReply(emptyStreams, { channelId: "dm", threadId: "m1", agentId: "ada" });
    s = expectReply(s, { channelId: "dm", threadId: "m2", agentId: "ada" });
    s = expectReply(s, { channelId: "other", threadId: "m3", agentId: "ada" });
    expect(runsInChannel(s, "dm")).toHaveLength(2);
    // The server looked again and the run parks (flat DM: no thread).
    s = applyChannelEvent(s, {
      type: "agent.run",
      channelId: "dm",
      threadId: null,
      runId: "r1",
      agentId: "ada",
      status: "waiting_input",
    } as unknown as ChannelEvent);
    const names = (id: string) => id;
    expect(
      barEntries(
        runsInChannel(s, "dm").filter((r) => !r.provisional),
        [],
        names,
        names,
      ),
    ).toEqual([]);
    s = applyChannelEvent(s, {
      type: "agent.idle",
      channelId: "dm",
      threadId: null,
      runId: "r1",
      agentId: "ada",
    } as unknown as ChannelEvent);
    expect(runsInChannel(s, "dm")).toEqual([]);
    // Another channel's row is not this run's.
    expect(runsInChannel(s, "other")).toHaveLength(1);
  });
});

describe("user events and resumed runs", () => {
  test("user-scope frames reach onUserEvent, not channel listeners", () => {
    const { factory, last } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x", createSocket: factory, pingMs: 0 });
    const user: unknown[] = [];
    const channel: unknown[] = [];
    conn.onUserEvent((e) => user.push(e));
    conn.subscribe("c1", (e) => channel.push(e));
    conn.start();
    last().open();
    const budget = { type: "budget.warning", agentId: "a", percent: 80 };
    last().push({ type: "event", scope: "user", event: budget });
    expect(user).toEqual([budget]);
    expect(channel).toEqual([]);
  });

  test("a run resumed after an approval streams again", () => {
    const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
    let s = applyChannelEvent(emptyStreams, { type: "agent.delta", ...base, seq: 1, text: "Vou pedir aprovação." });
    s = applyChannelEvent(s, {
      type: "message.created",
      channelId: "c1",
      messageId: "m2",
      message: { id: "m2", agentRunId: "r1" } as Message,
    });
    expect(runsInChannel(s, "c1")).toEqual([]);
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "running" });
    s = applyChannelEvent(s, { type: "agent.delta", ...base, seq: 1, text: "Merge feito." });
    expect(runsInChannel(s, "c1")[0]?.text).toBe("Merge feito.");
  });
});
