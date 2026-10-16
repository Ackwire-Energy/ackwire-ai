import { describe, expect, test } from "bun:test";
import type { ChannelEvent, Message } from "@/api/types";
import { parseServerFrame, RealtimeConnection, realtimeUrl, type Timers } from "@/realtime/connection";
import { applyChannelEvent, emptyStreams, runningAgents, runsInChannel } from "@/realtime/streams";
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

  test("a delta before the run event still opens the stream; failures keep the reason", () => {
    let s = applyChannelEvent(emptyStreams, delta(1, "Oi"));
    expect(runsInChannel(s, "c1")[0]).toMatchObject({ status: "running", text: "Oi" });
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "failed", error: "budget_exceeded" });
    expect(runsInChannel(s, "c1")[0]).toMatchObject({ status: "failed", error: "budget_exceeded" });
    expect(runningAgents(s).size).toBe(0);
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
