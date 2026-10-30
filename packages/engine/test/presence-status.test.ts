import { afterEach, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  AGENT_AWAY_AFTER_MS,
  AGENT_HEARTBEAT_FRESH_MS,
  AGENT_HEAVY_AFTER_MS,
  AGENT_LINE_EVERY_MS,
  agentStatuses,
  announcePresence,
  createFakeJudge,
  createSetStatusToolSource,
  followWork,
  listMembers,
  loadAgentStatuses,
  memberPresence,
  memberStatus,
  postPersonMessage,
  setMyStatus,
  startRunStatus,
  statusCandidates,
  touchLastSeen,
  ValidationError,
} from "../src";
import { chooseToolGroups } from "../src/tool-loading";
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
  // Going for over 2 minutes with a live worker (fresh heartbeat): heavy work.
  await f.db
    .update(schema.agentRuns)
    .set({ startedAt: new Date(Date.now() - AGENT_HEAVY_AFTER_MS - 1000), heartbeatAt: new Date() })
    .where(eq(schema.agentRuns.id, run.id));
  expect((await presenceOf(f))?.presence).toBe("busy");

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

test("a running run whose worker died stops counting at once: no line, and the agent isn't busy", async () => {
  f = await setup();
  const run = await runOf(f, { background: true, heartbeatAt: new Date(Date.now() - AGENT_HEARTBEAT_FRESH_MS - 1000) });
  await startRunStatus({ db: f.db }, run, [{ key: "c0", kind: "routine", subject: "Relatório", text: "x" }], null);
  const s = await presenceOf(f);
  expect(s?.presence).not.toBe("busy");
  expect(s?.status).toBeNull();
});

test("a waiting run says what it waits on, and keeps the agent online, not busy", async () => {
  f = await setup();
  const run = await runOf(f, { status: "waiting_approval" });
  await startRunStatus({ db: f.db }, run, [{ key: "c0", kind: "channel", subject: "general", text: "x" }], null);
  expect(await presenceOf(f)).toMatchObject({ presence: "online", status: { by: "wait", kind: "waiting_approval" } });
});

test("the run's line: public channels by name, private ones never; the task's title first", async () => {
  f = await setup();
  const run = await runOf(f);
  const lines = await statusCandidates(f.db, run, []);
  expect(lines.map((l) => [l.kind, l.subject])).toEqual([["channel", f.general.name]]);
  const dm = await statusCandidates(f.db, { ...run, channelId: crypto.randomUUID() }, []);
  expect(dm.map((l) => l.kind)).toEqual(["private"]);
  expect(JSON.stringify(dm)).not.toContain(f.general.name);
});

test("Jev's pick and weight set the line and busy from the start; the agent's own words are kept", async () => {
  f = await setup();
  const run = await runOf(f);
  const candidates = [
    { key: "c0", kind: "channel" as const, subject: "general", text: "Answering in #general" },
    { key: "c1", kind: "coding" as const, subject: null, text: "Coding" },
  ];
  await startRunStatus({ db: f.db }, run, candidates, { line: "c1", heavy: 0.8 });
  expect(await presenceOf(f)).toMatchObject({ presence: "busy", status: { by: "auto", kind: "coding" } });

  // No pick (no Jev): the first fact, not busy.
  await startRunStatus({ db: f.db }, run, candidates, null);
  expect(await presenceOf(f)).toMatchObject({ presence: "online", status: { kind: "channel", subject: "general" } });

  const [tool] = await createSetStatusToolSource().tools({} as ToolContext);
  await tool?.execute({ text: "Revisando o PR #12" }, ctxOf(f, run.id));
  await startRunStatus({ db: f.db }, run, candidates, { line: "c1", heavy: 0 });
  expect((await presenceOf(f))?.status).toMatchObject({ by: "self", text: "Revisando o PR #12" });
});

test("the line follows the work (at most every 30 s, a task stays), and Jev replaces own words that no longer fit", async () => {
  f = await setup();
  const run = await runOf(f);
  const ctx = { orgId: f.org.id, agentId: f.agent.id, runId: run.id };
  const browser = { name: "browser_do", scope: "browser:use" };
  const code = { name: "run_code", scope: "sandbox:run" };
  const t0 = new Date();
  await startRunStatus({ db: f.db }, run, [{ key: "c0", kind: "channel", subject: "general", text: "x" }], null, t0);
  await followWork({ db: f.db }, ctx, browser, new Date(t0.getTime() + AGENT_LINE_EVERY_MS + 1));
  expect((await presenceOf(f))?.status).toMatchObject({ by: "auto", kind: "browsing" });
  // Too soon for another change.
  await followWork({ db: f.db }, ctx, code, new Date(t0.getTime() + AGENT_LINE_EVERY_MS + 2));
  expect((await presenceOf(f))?.status?.kind).toBe("browsing");

  await startRunStatus({ db: f.db }, run, [{ key: "c0", kind: "task", subject: "Login", text: "x" }], null, t0);
  await followWork({ db: f.db }, ctx, code, new Date(t0.getTime() + 10 * AGENT_LINE_EVERY_MS));
  expect((await presenceOf(f))?.status).toMatchObject({ kind: "task", subject: "Login" });

  const [tool] = await createSetStatusToolSource().tools({} as ToolContext);
  await tool?.execute({ text: "Escrevendo o relatório" }, ctxOf(f, run.id));
  const judge = createFakeJudge((kind) => (kind === "status_fits" ? 0.1 : undefined));
  await followWork({ db: f.db, judge }, ctx, browser);
  expect(judge.calls.map((c) => c.kind)).toEqual(["status_fits"]);
  expect((await presenceOf(f))?.status).toMatchObject({ by: "auto", kind: "browsing" });
});

test("the tool-group request also asks for the line and the weight, in the same call", async () => {
  f = await setup();
  const judge = createFakeJudge((kind, id) =>
    id === "status_line" ? "c0" : id === "status_weight" ? { score: 2.4, probabilities: { "2": 0.5, "3": 0.3 } } : 0,
  );
  const choice = await chooseToolGroups(judge, {
    orgId: f.org.id,
    agent: { name: "Dev", role: "", instructions: "" },
    message: "faz o deploy",
    recent: [],
    tools: [],
    status: [{ key: "c0", kind: "coding", subject: null, text: "Coding" }],
  });
  expect(judge.calls).toHaveLength(1);
  expect(choice.status?.line).toBe("c0");
  expect(choice.status?.heavy).toBeCloseTo(0.8);
});
