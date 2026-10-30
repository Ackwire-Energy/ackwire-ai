import { afterEach, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  AGENT_AWAY_AFTER_MS,
  AGENT_HEAVY_AFTER_MS,
  agentStatuses,
  announcePresence,
  createSetStatusToolSource,
  listMembers,
  loadAgentStatuses,
  memberPresence,
  memberStatus,
  postPersonMessage,
  setMyStatus,
  touchLastSeen,
  ValidationError,
} from "../src";
import { toolPolicy } from "../src/tools/run-policy";
import type { ToolContext } from "../src/tools/types";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const orgEvents = (fx: Fixture) => {
  const events: { type: string; event?: { type: string; userId?: string; agentId?: string } }[] = [];
  fx.pubsub.subscribe(orgTopic(fx.org.id), (e) => events.push(e as (typeof events)[number]));
  return events;
};

test("a hidden person reads as offline to everyone else, hidden to themselves", () => {
  expect(memberPresence({ availability: "auto" }, true, false)).toBe("online");
  expect(memberPresence({ availability: "auto" }, false, false)).toBe("offline");
  expect(memberPresence({ availability: "busy" }, true, false)).toBe("busy");
  expect(memberPresence({ availability: "busy" }, false, false)).toBe("offline");
  expect(memberPresence({ availability: "away" }, true, false)).toBe("away");
  expect(memberPresence({ availability: "hidden" }, true, false)).toBe("offline");
  expect(memberPresence({ availability: "hidden" }, true, true)).toBe("hidden");
});

test("a written status clears itself when its time is up", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  const row = { statusText: "Em reunião", statusEmoji: "📅", statusUntil: new Date("2026-10-30T13:00:00Z") };
  expect(memberStatus(row, now)).toEqual({ text: "Em reunião", emoji: "📅", until: "2026-10-30T13:00:00.000Z" });
  expect(memberStatus(row, new Date("2026-10-30T13:00:00Z"))).toBeNull();
  expect(memberStatus({ statusText: null, statusEmoji: null, statusUntil: null }, now)).toBeNull();
});

test("a person sets and clears their availability and line; the workspace hears it", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const events = orgEvents(f);
  await setMyStatus({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, {
    availability: "busy",
    status: { text: "  Revisando   contratos ", emoji: "📄" },
  });
  let me = (await listMembers(f.db, f.org.id)).find((m) => m.userId === bia.id);
  expect(me).toMatchObject({ availability: "busy", statusText: "Revisando contratos", statusEmoji: "📄" });
  expect(events.at(-1)?.event).toMatchObject({ type: "member.status", userId: bia.id });

  // Only the line: the availability stays.
  await setMyStatus({ db: f.db }, bia.id, f.org.id, { status: null });
  me = (await listMembers(f.db, f.org.id)).find((m) => m.userId === bia.id);
  expect(me).toMatchObject({ availability: "busy", statusText: null, statusEmoji: null, statusUntil: null });

  await expect(
    setMyStatus({ db: f.db }, bia.id, f.org.id, { status: { text: "x".repeat(101) } }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    setMyStatus({ db: f.db }, bia.id, f.org.id, { status: { text: "Almoço", until: "2020-01-01T00:00:00Z" } }),
  ).rejects.toBeInstanceOf(ValidationError);
});

test("while hidden, last seen stops moving and coming online tells nobody", async () => {
  f = await setup();
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const seen = new Date("2026-10-30T10:00:00Z");
  await touchLastSeen(f.db, f.org.id, bia.id, seen);
  await setMyStatus({ db: f.db }, bia.id, f.org.id, { availability: "hidden" });
  await touchLastSeen(f.db, f.org.id, bia.id, new Date("2026-10-30T11:00:00Z"));
  const me = (await listMembers(f.db, f.org.id)).find((m) => m.userId === bia.id);
  expect(me?.lastSeenAt?.toISOString()).toBe(seen.toISOString());

  const events = orgEvents(f);
  await announcePresence({ db: f.db, pubsub: f.pubsub }, f.org.id, bia.id);
  expect(events).toHaveLength(0);
  await setMyStatus({ db: f.db }, bia.id, f.org.id, { availability: "auto" });
  events.length = 0;
  await announcePresence({ db: f.db, pubsub: f.pubsub }, f.org.id, bia.id);
  expect(events.map((e) => e.event?.type)).toEqual(["member.status"]);
});

/** A run of the fixture's agent in #general (the message names nobody, so it starts none of its own). */
async function runOf(fx: Fixture, values: Partial<typeof schema.agentRuns.$inferInsert> & { agoMs?: number } = {}) {
  const { agoMs = 0, ...rest } = values;
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: `oi ${Math.random()}`,
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(Date.now() - agoMs),
      ...rest,
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

const finish = (fx: Fixture, runId: string) =>
  fx.db.update(schema.agentRuns).set({ status: "done", finishedAt: new Date() }).where(eq(schema.agentRuns.id, runId));

const presenceOf = async (fx: Fixture, now = new Date()) =>
  (await loadAgentStatuses(fx.db, fx.org.id, now)).find((s) => s.agentId === fx.agent.id);

test("an agent's presence follows its work: busy on long or background work, away idle, offline held", async () => {
  f = await setup();
  expect((await presenceOf(f))?.presence).toBe("away");

  const run = await runOf(f);
  expect((await presenceOf(f))?.presence).toBe("online");
  expect((await presenceOf(f, new Date(Date.now() + AGENT_HEAVY_AFTER_MS + 1000)))?.presence).toBe("busy");

  await finish(f, run.id);
  expect((await presenceOf(f))?.presence).toBe("online");
  expect((await presenceOf(f, new Date(Date.now() + AGENT_AWAY_AFTER_MS + 1000)))?.presence).toBe("away");

  await runOf(f, { background: true });
  expect((await presenceOf(f))?.presence).toBe("busy");

  await f.db.update(schema.agents).set({ operatorHoldAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
  expect((await presenceOf(f))?.presence).toBe("offline");
  // A member reads it too.
  expect((await agentStatuses(f.db, f.owner.id, f.org.id)).length).toBeGreaterThan(0);
});

const ctxOf = (fx: Fixture, runId: string): ToolContext => ({
  db: fx.db,
  orgId: fx.org.id,
  agentId: fx.agent.id,
  runId,
  channelId: fx.general.id,
  threadRootId: runId,
  triggerMessageId: runId,
});

test("set_status: the agent's line lasts while its run does (or its minutes), busy makes it busy", async () => {
  f = await setup();
  const events = orgEvents(f);
  const [tool] = await createSetStatusToolSource({ pubsub: f.pubsub }).tools({} as ToolContext);
  if (!tool) throw new Error("no tool");
  const run = await runOf(f);

  await tool.execute({ text: "Rodando a migração", emoji: "🛠️", busy: true }, ctxOf(f, run.id));
  let s = await presenceOf(f);
  expect(s).toMatchObject({ presence: "busy", status: { text: "Rodando a migração", emoji: "🛠️", until: null } });
  expect(events.at(-1)?.event).toMatchObject({ type: "agent.status", agentId: f.agent.id });

  await finish(f, run.id);
  s = await presenceOf(f);
  expect(s?.status).toBeNull();
  expect(s?.presence).toBe("online");

  const next = await runOf(f);
  await tool.execute({ text: "Fora até amanhã", minutes: 60 }, ctxOf(f, next.id));
  await finish(f, next.id);
  expect((await presenceOf(f))?.status?.text).toBe("Fora até amanhã");
  expect((await presenceOf(f, new Date(Date.now() + 61 * 60_000)))?.status).toBeNull();

  await tool.execute({ text: "" }, ctxOf(f, next.id));
  expect((await presenceOf(f))?.status).toBeNull();
});

test("set_status is allowed for every kind of run", () => {
  const tool = { name: "set_status", scope: "" };
  expect(toolPolicy({ kind: "person", userId: "u" } as never, tool)).toEqual({ action: "allow" });
  expect(toolPolicy({ kind: "routine", brief: { access: "read" } } as never, tool)).toEqual({ action: "allow" });
  expect(toolPolicy({ kind: "unattended", reason: "routine", routineAccess: "read" } as never, tool)).toEqual({
    action: "allow",
  });
});
