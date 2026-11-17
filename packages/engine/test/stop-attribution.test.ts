import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { and, eq, rowsOf, schema, sql } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  canceledBy,
  canceledBySql,
  cancelRun,
  continuableEnd,
  continueRun,
  createMissionEngine,
  drainOutbox,
  personStopOf,
  postPersonMessage,
  RIGHT_HAND,
  reapRoutineRuns,
  runErrorDetail,
  stopError,
  stoppedText,
  stopRun,
  taskManager,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { channelRoutine, fire, minutesFromNow, routineRunRow } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const ask = (body: string) => postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body });
const runOf = async (triggerMessageId: string) => {
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.triggerMessageId, triggerMessageId));
  if (!run) throw new Error("no run");
  return run;
};
const runById = async (id: string) =>
  (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];
const messageById = async (id: string) =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0];
const refsOf = (m: { meta: Record<string, unknown> } | undefined) =>
  (m?.meta.notice as { refs?: Record<string, string> } | undefined)?.refs ?? {};
const stopNotices = async () =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.orgId, f.org.id))).filter(
    (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "run_stopped",
  );
const audits = () =>
  f.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, f.org.id), eq(schema.auditLog.action, "run.canceled")));
const lodiOf = async () => {
  const [lodi] = await f.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/**
 * The owner asks Dev to read the logs; the model holds after its first words until `stop` lands, then the run posts
 * its stopped reply. `events`: what the channel heard from the start.
 */
async function stoppedWhileWriting(stop: (runId: string) => Promise<unknown>, options: { rightHand?: boolean } = {}) {
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  f = await setup({
    ...options,
    reply: (_req: ModelRequest, call: number) =>
      call > 1 ? { chunks: ["Pronto."] } : { chunks: ["Lendo os logs. ", "nunca chega"], hold },
  });
  const events: RealtimeEvent[] = f.listen(f.general.id);
  const question = await ask("@dev analisa os logs");
  let seen = false;
  f.pubsub.subscribe(channelTopic(f.general.id), (event) => {
    if (seen || event.type !== "agent.typing") return;
    seen = true;
    void stop(String(event.runId)).finally(release);
  });
  await drainOutbox(f.db, f.handlers);
  const run = await runOf(question.id);
  const reply = run.replyMessageId ? await messageById(run.replyMessageId) : undefined;
  return { run, reply, events };
}

describe("who or what stopped a run, as its row keeps it", () => {
  test("a person, or the agent at their word; the system keeps its reason; old rows read as before", () => {
    const person = stopError({ type: "person", id: "user_ana" });
    const agent = stopError({ type: "person", id: "user_ana", agentId: "agent-lodi" });
    expect([person, agent]).toEqual(["canceled_by:user_ana", "canceled_by:user_ana|agent:agent-lodi"]);
    expect(personStopOf(person)).toEqual({ userId: "user_ana", agentId: null });
    expect(personStopOf(agent)).toEqual({ userId: "user_ana", agentId: "agent-lodi" });
    for (const error of [person, agent]) {
      expect(canceledBy(error)).toBe("user_ana");
      expect(runErrorDetail(error)).toEqual({ errorCode: "run.canceled", errorParams: { byUserId: "user_ana" } });
    }
    expect(stopError({ type: "system", reason: "agent_archived" })).toBe("agent_archived");
    expect(personStopOf("agent_archived")).toBeNull();
    expect(canceledBy("mission_stopped")).toBeNull();
    expect(canceledBy(null)).toBeNull();
  });

  test("the SQL reader finds the same person", async () => {
    f = await setup();
    const read = async (error: string | null) =>
      rowsOf<{ by: string | null }>(await f.db.execute(sql`select ${canceledBySql(sql`${error}::text`)} as by`))[0]?.by;
    expect(await read("canceled_by:user_ana")).toBe("user_ana");
    expect(await read("canceled_by:user_ana|agent:agent-lodi")).toBe("user_ana");
    expect(await read("agent_archived")).toBeNull();
    expect(await read(null)).toBeNull();
  });
});

describe("a person's stop", () => {
  test("their name on the stop, the notice and the live event; no agent, no cause", async () => {
    const { run, reply, events } = await stoppedWhileWriting((id) => cancelRun(deps(), f.owner.id, f.org.id, id));
    expect(run).toMatchObject({ status: "canceled", error: `canceled_by:${f.owner.id}` });
    expect(reply?.meta.canceled).toEqual({ byUserId: f.owner.id, text: "Lendo os logs." });
    expect(reply?.body).toBe("Lendo os logs.\n\n_Stopped by ana._");
    const [notice] = await stopNotices();
    expect(refsOf(notice)).toMatchObject({ runId: run.id, byUserId: f.owner.id, byName: "ana" });
    expect(refsOf(notice).byAgentId).toBeUndefined();
    const canceled = events.find((e) => e.type === "run.canceled");
    expect(canceled).toMatchObject({ runId: run.id, byUserId: f.owner.id });
    expect(canceled).not.toHaveProperty("byAgentId");
    const [audit] = await audits();
    expect(audit).toMatchObject({ actorType: "person", actorId: f.owner.id, onBehalfOfUserId: null });
  });
});

describe("the right hand's stop at a person's word", () => {
  test("the stop, its reply, the notice and the audit name the right hand; Continuar still works", async () => {
    const { run, reply, events } = await stoppedWhileWriting(
      async (id) => cancelRun(deps(), f.owner.id, f.org.id, id, { byAgentId: (await lodiOf()).id }),
      { rightHand: true },
    );
    const lodi = await lodiOf();
    expect(run.error).toBe(`canceled_by:${f.owner.id}|agent:${lodi.id}`);
    expect(reply?.meta.canceled).toEqual({ byUserId: f.owner.id, byAgentId: lodi.id, text: "Lendo os logs." });
    expect(reply?.body).toBe(`Lendo os logs.\n\n_Stopped by ${lodi.name} for ana._`);
    expect(events.find((e) => e.type === "run.canceled")).toMatchObject({ byUserId: f.owner.id, byAgentId: lodi.id });
    const [notice] = await stopNotices();
    expect(refsOf(notice)).toMatchObject({ byUserId: f.owner.id, byName: "ana", byAgentId: lodi.id });
    expect(notice?.body).toStartWith(`${lodi.name}, at ana's word, stopped your task`);
    const [audit] = await audits();
    expect(audit).toMatchObject({ actorType: "agent", actorId: lodi.id, onBehalfOfUserId: f.owner.id });
    const view = await taskManager(f.db, f.owner.id, f.org.id);
    expect(view.ended.find((e) => e.runId === run.id)?.stoppedBy).toEqual({
      userId: f.owner.id,
      name: "ana",
      agentId: lodi.id,
    });
    expect((await continueRun(deps(), f.owner.id, f.org.id, run.id)).runId).toBeString();
  });

  test("the notice with no name for the person still reads", () => {
    expect(
      stoppedText({ runId: "r", byUserId: "u", byName: "", byAgentName: "Lodi", label: "", was: "queued" }),
    ).toStartWith("Lodi, at a person's word, stopped your task before it started.");
    // The right hand wrote the reason: it isn't passed off as the person's own words.
    expect(
      stoppedText({
        runId: "r",
        byUserId: "u",
        byName: "Ana",
        byAgentName: "Lodi",
        label: "",
        was: "queued",
        reason: "Ana quer os logs como estão",
      }),
    ).toContain("The reason given: «Ana quer os logs como estão».");
  });
});

describe("the system's stop: its cause, nobody's name", () => {
  test("an archived agent: the reply carries the cause, no person, no notice, no Continuar", async () => {
    const { run, reply, events } = await stoppedWhileWriting(async (id) => {
      const live = await runById(id);
      if (live) await stopRun(deps(), f.org.id, live, "channel", { type: "system", reason: "agent_archived" });
    });
    expect(run.error).toBe("agent_archived");
    expect(reply?.meta.canceled).toEqual({ byUserId: null, code: "run.agent_archived", text: "Lendo os logs." });
    expect(events.some((e) => e.type === "run.canceled")).toBe(false);
    expect(await stopNotices()).toEqual([]);
    await expect(continueRun(deps(), f.owner.id, f.org.id, run.id)).rejects.toMatchObject({
      code: "run.not_continuable",
    });
    const view = await taskManager(f.db, f.owner.id, f.org.id);
    expect(view.ended.find((e) => e.runId === run.id)?.stoppedBy).toBeNull();
  });

  test("a mission's stop with nobody behind it is the mission's, never a person's", async () => {
    f = await setup();
    const engine = createMissionEngine(deps());
    const where = async (body: string) => {
      const run = await runOf((await ask(body)).id);
      return {
        run,
        input: { orgId: f.org.id, agentId: f.agent.id, channelId: f.general.id, threadRootId: run.threadRootId },
      };
    };
    const quiet = await where("@dev planeja a missão");
    await engine.cancelRuns({ ...quiet.input, actorId: null, reason: "stopped" });
    const stopped = await runById(quiet.run.id);
    expect(stopped?.error).toBe("mission_stopped");
    // Nobody to continue it for: Continuar refuses it.
    if (!stopped) throw new Error("no run");
    expect(continuableEnd({ ...stopped, transcript: { messages: [] } }, null)).toBe(false);
    const closed = await where("@dev fecha a missão");
    await engine.cancelRuns({ ...closed.input, actorId: f.owner.id, reason: "closed" });
    expect((await runById(closed.run.id))?.error).toBe(`canceled_by:${f.owner.id}`);
  });
});

test("the routine ledger reads the person through the right hand's suffix", async () => {
  f = await setup();
  const routine = await channelRoutine(f);
  const rr = await fire(f, routine.id, minutesFromNow(-60));
  await f.db
    .update(schema.agentRuns)
    .set({ status: "canceled", error: `canceled_by:${f.owner.id}|agent:agent-lodi`, updatedAt: minutesFromNow(-10) })
    .where(eq(schema.agentRuns.id, rr.agentRunId ?? ""));
  await reapRoutineRuns(deps());
  expect(await routineRunRow(f, rr.id)).toMatchObject({ status: "canceled", code: "stopped", summary: f.owner.id });
});
