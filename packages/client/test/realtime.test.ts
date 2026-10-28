import { describe, expect, test } from "bun:test";
import type { ChannelEvent, Message } from "../src/index";
import {
  agentStateIn,
  agentStateOfRun,
  applyChannelEvent,
  emptyStreams,
  expectReply,
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
    expect(realtimeUrl("https://agentes.chat/", "o1")).toBe("wss://agentes.chat/api/ws?orgId=o1");
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
