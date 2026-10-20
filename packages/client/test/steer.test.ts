import { afterEach, describe, expect, test } from "bun:test";
import type { ActiveRun, ChannelEvent, Message } from "../src/index";
import {
  applyChannelEvent,
  applySteerEvent,
  continuedRunIdOf,
  emptySteer,
  emptyStreams,
  RealtimeConnection,
  reconcileSteer,
  seedSteerMessages,
  steerStateIn,
  steerStateOf,
  steerStore,
} from "../src/index";
import { fakeSockets } from "./fake-socket";

type Ev = Parameters<typeof applyChannelEvent>[1];
const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
const steered = (messageId: string, extra: Record<string, unknown> = {}) =>
  ({ type: "agent.run.steered", channelId: "c1", runId: "r1", agentId: "ada", messageId, ...extra }) as Ev;
const read = (...messageIds: string[]) => ({ type: "agent.run.read", ...base, messageIds }) as Ev;

/** A person's message that went into these runs (its receipts name the agent). */
const person = (id: string, runIds: string[]) =>
  ({
    id,
    channelId: "c1",
    author: { type: "person", id: "u1" },
    meta: { steeredRunIds: runIds },
    receipts: {
      seenBy: ["ada"],
      pickedBy: ["ada"],
      handled: runIds.map((runId) => ({ agentId: "ada", runId, status: "running" })),
    },
  }) as unknown as Message;

describe("what became of a message sent while an agent works", () => {
  test("steered → waiting; steered with now → now until read; read → read", () => {
    let s = applySteerEvent(emptySteer, steered("m2"));
    expect(steerStateIn(s, "m2")).toEqual({ runId: "r1", agentId: "ada", state: "waiting" });
    s = applySteerEvent(s, steered("m3", { now: true }));
    expect(steerStateIn(s, "m3")?.state).toBe("now");
    s = applySteerEvent(s, read("m2", "m3"));
    expect(steerStateIn(s, "m2")?.state).toBe("read");
    expect(steerStateIn(s, "m3")?.state).toBe("read");
    // Events can cross: a late steered never takes "read" back.
    s = applySteerEvent(s, steered("m2"));
    expect(steerStateIn(s, "m2")?.state).toBe("read");
    expect(steerStateIn(s, "other")).toBeNull();
  });

  test("a stop (judged after the send) drops it; the run's end settles what it never read", () => {
    let s = applySteerEvent(emptySteer, steered("m2"));
    s = applySteerEvent(s, steered("m2", { stop: true }));
    expect(steerStateIn(s, "m2")).toBeNull();
    s = applySteerEvent(s, steered("m4"));
    s = applySteerEvent(s, { type: "run.finished", ...base, status: "done" });
    expect(steerStateIn(s, "m4")?.state).toBe("read");
    s = applySteerEvent(s, { ...steered("m5"), runId: "r2" } as Ev);
    s = applySteerEvent(s, { type: "run.canceled", ...base, runId: "r2" });
    expect(steerStateIn(s, "m5")).toBeNull();
  });

  test("reload: from meta.steeredRunIds and the channel's active runs (pendingMessageIds)", () => {
    let s = seedSteerMessages(emptySteer, "c1", [person("m2", ["r1"]), person("m3", ["r1"]), person("m4", ["r0"])]);
    // Not known until the active runs are listed.
    expect(steerStateIn(s, "m2")).toBeNull();
    const active: ActiveRun = {
      runId: "r1",
      agentId: "ada",
      channelId: "c1",
      threadId: "m1",
      status: "running",
      pendingMessageIds: ["m3"],
    };
    s = reconcileSteer(s, "c1", [active]);
    expect(steerStateIn(s, "m2")).toEqual({ runId: "r1", agentId: "ada", state: "read" });
    expect(steerStateIn(s, "m3")).toEqual({ runId: "r1", agentId: "ada", state: "waiting" });
    // Its run is no longer active: it read it (and answered).
    expect(steerStateIn(s, "m4")?.state).toBe("read");
  });

  test("reconnect: a live 'waiting' heard before the list asked is settled by it, a newer one isn't", () => {
    let s = applySteerEvent(emptySteer, steered("m2"), 1_000);
    s = applySteerEvent(s, steered("m3"), 3_000);
    s = reconcileSteer(s, "c1", [], 2_000);
    expect(steerStateIn(s, "m2")?.state).toBe("read");
    expect(steerStateIn(s, "m3")?.state).toBe("waiting");
  });

  test("run.continued and meta.canceled.continuedRunId mark the stopped reply", () => {
    const stopped = {
      id: "m9",
      channelId: "c1",
      author: { type: "agent", id: "ada" },
      meta: { canceled: { byUserId: "u1", text: "Parcial", continuedRunId: "r2" } },
    } as unknown as Message;
    expect(continuedRunIdOf(stopped)).toBe("r2");
    let s = seedSteerMessages(emptySteer, "c1", [stopped]);
    expect(s.continued.m9).toBe("r2");
    s = applySteerEvent(s, { type: "run.continued", channelId: "c1", runId: "r1", newRunId: "r3", messageId: "m8" });
    expect(s.continued.m8).toBe("r3");
  });
});

describe("the app's steer store is fed by the socket", () => {
  afterEach(() => steerStore.reset());

  test("events on the connection reach steerStateOf", () => {
    const { factory, last } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x/api/ws?orgId=o", createSocket: factory, pingMs: 0 });
    conn.subscribe("c1", () => {});
    conn.start();
    last().open();
    last().push({ type: "event", channelId: "c1", event: steered("m2", { now: true }) });
    expect(steerStateOf("m2")?.state).toBe("now");
    last().push({ type: "event", channelId: "c1", event: read("m2") });
    expect(steerStateOf("m2")?.state).toBe("read");
    conn.stop();
  });
});

describe("the live work: what it read, when it read it", () => {
  const run = (events: Ev[]) => events.reduce((s, e) => applyChannelEvent(s, e), emptyStreams);
  const delta = (seq: number, turn: number, text: string) =>
    ({ type: "agent.delta", ...base, seq, turn, text }) as ChannelEvent;

  test("steered only notes it; read moves the text so far to narration and adds the step once", () => {
    let s = run([delta(0, 1, "Olhando os logs."), steered("m2")]);
    expect(s.runs.r1?.text).toBe("Olhando os logs.");
    expect(s.runs.r1?.work ?? []).toEqual([]);
    s = applyChannelEvent(s, read("m2"));
    expect(s.runs.r1?.text).toBe("");
    expect(s.runs.r1?.work).toEqual([
      { kind: "say", text: "Olhando os logs.", turn: 1 },
      { kind: "steer", messageId: "m2" },
    ]);
    s = applyChannelEvent(s, read("m2"));
    expect(s.runs.r1?.work).toHaveLength(2);
  });

  test("stop and send: the step says it stopped to read; the cut text of the turn is narration", () => {
    let s = run([delta(0, 1, "Começando a"), steered("m3", { now: true })]);
    s = applyChannelEvent(s, { type: "agent.narration", ...base, turn: 1, text: "Começando a" } as Ev);
    s = applyChannelEvent(s, read("m3"));
    expect(s.runs.r1?.work).toEqual([
      { kind: "say", text: "Começando a", turn: 1 },
      { kind: "steer", messageId: "m3", now: true },
    ]);
    expect(s.runs.r1?.steerNow).toEqual([]);
    s = applyChannelEvent(s, delta(1, 2, "Certo, mudando."));
    expect(s.runs.r1?.text).toBe("Certo, mudando.");
  });

  test("steered with stop: the row shows it's stopping", () => {
    const s = run([delta(0, 1, "Trabalhando"), steered("m9", { stop: true })]);
    expect(s.runs.r1?.stopping).toBe(true);
  });

  test("run.continued: the stopped row gives way to the new run, live as any other", () => {
    let s = run([delta(0, 1, "Parcial"), { type: "run.canceled", ...base, byUserId: "u1" } as Ev]);
    expect(s.runs.r1?.status).toBe("canceled");
    s = applyChannelEvent(s, {
      type: "run.continued",
      channelId: "c1",
      threadId: "m1",
      agentId: "ada",
      runId: "r1",
      newRunId: "r2",
      messageId: "m9",
    } as Ev);
    expect(s.runs.r1).toBeUndefined();
    expect(s.runs.r2).toMatchObject({ status: "thinking", agentId: "ada", threadId: "m1", triggerMessageId: "m9" });
  });
});
