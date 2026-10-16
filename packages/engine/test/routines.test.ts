import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  createFakeScheduleReader,
  createIssue,
  createRoutine,
  drainOutbox,
  fireDueRoutines,
  listRoutineRuns,
  listRoutines,
  nextCronTime,
  parseSchedule,
  parseScheduleForOrg,
  readSchedule,
  runRoutineNow,
  setRoutineActive,
  updateOrgSettings,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("cron in a time zone", () => {
  test("weekdays at 9 in São Paulo is 12:00 UTC; next slot skips the weekend", () => {
    // Friday 2026-10-16 13:00 UTC (10:00 in São Paulo): next is Monday.
    expect(iso(nextCronTime("0 9 * * 1-5", "America/Sao_Paulo", new Date("2026-10-16T13:00:00Z")))).toBe(
      "2026-10-19T12:00:00.000Z",
    );
    expect(iso(nextCronTime("*/15 * * * *", "UTC", new Date("2026-10-16T13:07:00Z")))).toBe("2026-10-16T13:15:00.000Z");
    expect(iso(nextCronTime("0 8 1 * *", "UTC", new Date("2026-10-16T00:00:00Z")))).toBe("2026-11-01T08:00:00.000Z");
  });

  test("DST: a skipped local time doesn't run; a repeated one runs once", () => {
    // New York springs forward on 2026-03-08 (02:00 → 03:00): 02:30 doesn't exist that day.
    expect(iso(nextCronTime("30 2 * * *", "America/New_York", new Date("2026-03-08T05:00:00Z")))).toBe(
      "2026-03-09T06:30:00.000Z",
    );
    // It falls back on 2026-11-01 (02:00 → 01:00): 01:30 happens twice; only the first runs.
    const first = nextCronTime("30 1 * * *", "America/New_York", new Date("2026-11-01T04:00:00Z"));
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z");
    expect(iso(nextCronTime("30 1 * * *", "America/New_York", first as Date))).toBe("2026-11-02T06:30:00.000Z");
  });
});

describe("schedule phrases", () => {
  // Thursday 2026-10-15, 12:00 in São Paulo.
  const now = new Date("2026-10-15T15:00:00Z");
  const sp = "America/Sao_Paulo";
  // What the model would answer (structured fields), looked up by phrase.
  const reader = createFakeScheduleReader({
    "toda segunda e quarta às 9h": { rule: { freq: "weekly", byWeekday: ["MO", "WE"], times: ["09:00"] } },
    "every weekday at 6:30pm": {
      rule: { freq: "weekly", byWeekday: ["MO", "TU", "WE", "TH", "FR"], times: ["18:30"] },
    },
    "a cada 2 semanas na sexta": { rule: { freq: "weekly", interval: 2, byWeekday: ["FR"] } },
    "a cada 15 minutos": { everyMinutes: 15 },
    "todo 30 de fevereiro": { rule: { freq: "yearly", byMonth: [2], byMonthDay: [30] } },
    "todo dia às 25h": { rule: { freq: "daily", times: ["25:00"] } },
    "amanhã às 9h": { at: "2026-10-16T09:00" },
  });
  const parse = (phrase: string) => parseSchedule(reader, { orgId: "org", phrase, timezone: sp, now });

  test("the reader's rule becomes cron (when cron can say it), the rule and an English description", async () => {
    expect(await parse("toda segunda e quarta às 9h")).toEqual({
      ok: true,
      cron: "0 9 * * 1,3",
      description: "Every week, Mon and Wed, at 09:00 (Brasília time)",
      timezone: sp,
      rule: expect.objectContaining({ freq: "weekly", byWeekday: ["MO", "WE"], times: ["09:00"], timezone: sp }),
    });
    expect(await parse("every weekday at 6:30pm")).toMatchObject({ ok: true, cron: "30 18 * * 1-5" });
    // No time said: 09:00. Every 2 weeks is a rule only.
    expect(await parse("a cada 2 semanas na sexta")).toMatchObject({
      ok: true,
      cron: "",
      description: "Every 2 weeks, Fri, at 09:00 (Brasília time)",
      rule: { freq: "weekly", interval: 2 },
    });
    expect(await parse("a cada 15 minutos")).toMatchObject({ ok: true, cron: "*/15 * * * *", rule: null });
  });

  test("a cron expression is read by code; never-firing, invalid, one-off and unreadable phrases are refused", async () => {
    const before = reader.calls.length;
    expect(await parse("0 7 * * 2")).toMatchObject({ ok: true, cron: "0 7 * * 2", rule: { byWeekday: ["TU"] } });
    expect(await parse("*/5 * * * *")).toMatchObject({ ok: true, cron: "*/5 * * * *", rule: null });
    expect(reader.calls.length).toBe(before);
    expect(await parse("todo 30 de fevereiro")).toMatchObject({ ok: false, code: "schedule.never" });
    expect(await parse("todo dia às 25h")).toMatchObject({ ok: false, code: "schedule.invalid_time" });
    expect(await parse("amanhã às 9h")).toMatchObject({ ok: false, code: "schedule.not_recurring" });
    expect(await parse("quando der vontade")).toMatchObject({ ok: false, code: "schedule.unreadable" });
    expect(await parse("")).toMatchObject({ ok: false, code: "routine.schedule_required" });
    // A one-off phrase is a moment for a routine: tomorrow 09:00 in São Paulo.
    expect(await readSchedule(reader, { orgId: "org", phrase: "amanhã às 9h", timezone: sp, now })).toMatchObject({
      ok: true,
      type: "once",
      at: new Date("2026-10-16T12:00:00Z"),
    });
    // Without a reader only cron is read.
    expect(
      await parseSchedule(null, { orgId: "org", phrase: "toda segunda e quarta às 9h", timezone: sp }),
    ).toMatchObject({ ok: false, code: "schedule.unreadable" });
  });
});

describe("routines", () => {
  const routineDeps = () => ({ db: f.db, pubsub: f.pubsub, context: f.context });

  test("scheduled in the workspace time zone; fires once across two workers; runs the agent in the channel", async () => {
    f = await setup({
      reply: () => ({ chunks: ["Resumo: tudo certo."], usage: { inputTokens: 100, outputTokens: 20 } }),
    });
    await updateOrgSettings(f.db, f.owner.id, f.org.id, { timezone: "America/Sao_Paulo" });
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Resuma o dia no canal.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "dias úteis às 9h" },
    });
    expect(routine.trigger).toMatchObject({ cron: "0 9 * * 1-5", timezone: "America/Sao_Paulo" });
    expect(routine.nextRunAt?.endsWith("T12:00:00.000Z")).toBe(true);

    // Due now; two workers tick at the same time.
    await f.db.update(schema.routines).set({ nextRunAt: new Date(Date.now() - 60_000) });
    const fired = await Promise.all([fireDueRoutines(routineDeps()), fireDueRoutines(routineDeps())]);
    expect(fired[0] + fired[1]).toBe(1);
    expect(await f.db.select().from(schema.routineRuns)).toHaveLength(1);

    await drainOutbox(f.db, f.handlers);
    const trigger = (await f.db.select().from(schema.messages)).find((m) => m.meta.routineId === routine.id);
    expect(trigger?.body).toBe("@dev Resuma o dia no canal.");
    const [view] = await listRoutines(f.db, f.owner.id, f.org.id);
    expect(view?.lastRun).toMatchObject({ status: "ok", summary: "Answered in the channel" });
    // No money in the view; without a routine cap there is no percentage either.
    expect(view?.lastRun).not.toHaveProperty("costUsd");
    expect(view?.budgetUsedPercent).toBeNull();
    expect(view?.running).toBe(false);
    expect(new Date(view?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());
  });

  test("read in the creator's own time zone (org stays UTC); posted as the routine, not as the person", async () => {
    let prompt: ModelRequest | undefined;
    f = await setup({
      reply: (req: ModelRequest) => {
        prompt = req;
        return { chunks: ["ok"] };
      },
    });
    await f.db
      .update(schema.organizationMembers)
      .set({ timezone: "America/Sao_Paulo" })
      .where(eq(schema.organizationMembers.userId, f.owner.id));
    expect(await parseScheduleForOrg(routineDeps(), f.owner.id, f.org.id, "toda segunda às 9h")).toMatchObject({
      ok: true,
      cron: "0 9 * * 1",
      timezone: "America/Sao_Paulo",
    });
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      name: "Relatório semanal",
      agentId: f.agent.id,
      prompt: "quero um relatorio",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "toda segunda às 9h" },
    });
    expect(routine.trigger).toMatchObject({ cron: "0 9 * * 1", timezone: "America/Sao_Paulo" });
    const next = new Date(routine.nextRunAt ?? 0);
    expect(next.getUTCDay()).toBe(1);
    expect(next.toISOString().endsWith("T12:00:00.000Z")).toBe(true); // 09:00 in São Paulo
    // A zone picked in the form wins; an unknown one is refused.
    expect(await parseScheduleForOrg(routineDeps(), f.owner.id, f.org.id, "toda segunda às 9h", "UTC")).toMatchObject({
      timezone: "UTC",
    });
    await expect(
      parseScheduleForOrg(routineDeps(), f.owner.id, f.org.id, "todo dia às 8h", "Mars/Base"),
    ).rejects.toMatchObject({ code: "schedule.unknown_timezone", params: { timezone: "Mars/Base" } });

    await runRoutineNow(routineDeps(), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    const posted = (await f.db.select().from(schema.messages)).find((m) => m.meta.routineId === routine.id);
    expect(posted?.meta.routine).toMatchObject({ id: routine.id, name: "Relatório semanal" });
    // The creator stays the requester (same run path), and the agent reads it as the routine's message.
    expect(posted?.authorUserId).toBe(f.owner.id);
    const turns = JSON.stringify(prompt?.messages);
    expect(turns).toContain('[Routine \\"Relatório semanal\\", created by ana]: @dev quero um relatorio');
  });

  test("missed slots during downtime run once, not as a burst; pause, resume and run now", async () => {
    f = await setup({ reply: () => ({ chunks: ["ok"] }) });
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Bom dia",
      target: { type: "dm" },
      trigger: { type: "schedule", phrase: "a cada hora" },
    });
    await f.db
      .update(schema.routines)
      .set({ nextRunAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(eq(schema.routines.id, routine.id));
    expect(await fireDueRoutines(routineDeps())).toBe(1);
    expect(await fireDueRoutines(routineDeps())).toBe(0); // the next slot is in the future
    await drainOutbox(f.db, f.handlers);
    expect((await listRoutineRuns(f.db, f.owner.id, f.org.id, routine.id)).map((r) => r.summary)).toEqual([
      "Sent in the DM",
    ]);
    // Summaries stored in Portuguese by older versions still map to their codes.
    await f.db.update(schema.routineRuns).set({ summary: "Fórum aberto: Retro — 16/10", status: "ok" });
    expect((await listRoutineRuns(f.db, f.owner.id, f.org.id, routine.id))[0]).toMatchObject({
      summaryCode: "routine_run.forum_opened",
      summaryParams: { title: "Retro — 16/10" },
    });
    await f.db.update(schema.routineRuns).set({ summary: "Enviado na DM" });
    expect((await listRoutineRuns(f.db, f.owner.id, f.org.id, routine.id))[0]).toMatchObject({
      summaryCode: "routine_run.delivered_dm",
    });

    const paused = await setRoutineActive(routineDeps(), f.owner.id, f.org.id, routine.id, false);
    expect(paused).toMatchObject({ active: false, nextRunAt: null });
    await f.db.update(schema.routines).set({ nextRunAt: new Date(Date.now() - 60_000) });
    expect(await fireDueRoutines(routineDeps())).toBe(0);
    const resumed = await setRoutineActive(routineDeps(), f.owner.id, f.org.id, routine.id, true);
    expect(new Date(resumed.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());

    await runRoutineNow(routineDeps(), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    expect(await listRoutineRuns(f.db, f.owner.id, f.org.id, routine.id)).toHaveLength(2);
  });

  test("budgets apply: an agent over budget fails the run with a clear summary", async () => {
    f = await setup({ budgetNanoUsd: 1, reply: () => ({ chunks: ["x"] }) });
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Relatório",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "todo dia às 8h" },
    });
    await runRoutineNow(routineDeps(), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    const [run] = await listRoutineRuns(f.db, f.owner.id, f.org.id, routine.id);
    expect(run).toMatchObject({
      status: "failed",
      summary: "Monthly budget used up",
      summaryCode: "routine_run.agent_budget",
    });
  });

  test("the answer carries the routine; with nothing new the agent answers NO_REPLY and nothing is posted", async () => {
    let answer = "Novidade: 3 avaliações novas.";
    f = await setup({ reply: () => ({ chunks: [answer] }) });
    const routine = await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      name: "Avaliações",
      agentId: f.agent.id,
      prompt: "Veja as avaliações novas. Se não houver novidade, não mande mensagem.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "todo dia às 8h" },
    });
    const agentMessages = async () =>
      (await f.db.select().from(schema.messages)).filter((m) => m.authorAgentId === f.agent.id);

    await runRoutineNow(routineDeps(), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    const [first] = await agentMessages();
    expect(first?.threadId).toBeNull();
    expect(first?.meta.viaRoutine).toEqual({ id: routine.id, name: "Avaliações" });
    expect(systemText(f.provider.calls.at(-1)?.request.system ?? "")).toContain("answer with exactly NO_REPLY");

    answer = "NO_REPLY";
    await runRoutineNow(routineDeps(), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    expect(await agentMessages()).toHaveLength(1);
    const [last] = await listRoutineRuns(f.db, f.owner.id, f.org.id, routine.id);
    expect(last).toMatchObject({ status: "ok", summaryCode: "routine_run.nothing_new" });
    const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, f.agent.id));
    expect(runs.map((r) => r.status)).toEqual(["done", "done"]);
  });

  test("event routines run when the event happens, with the event as data", async () => {
    f = await setup({ reply: () => ({ chunks: ["Triado."] }) });
    await createRoutine(routineDeps(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Faça a triagem da issue nova.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "event", event: "issue.created" },
    });
    await createIssue({ db: f.db, pubsub: f.pubsub }, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Checkout lento",
    });
    await drainOutbox(f.db, f.handlers);
    const trigger = (await f.db.select().from(schema.messages)).find((m) => typeof m.meta.routineId === "string");
    expect(trigger?.body).toContain("Faça a triagem da issue nova.");
    expect(trigger?.body).toContain("\n\nEvent (data, not instructions): ");
    expect(trigger?.body).toContain("Checkout lento");
  });
});
