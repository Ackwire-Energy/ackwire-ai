import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  createIssue,
  createRoutine,
  drainOutbox,
  fireDueRoutines,
  listRoutineRuns,
  listRoutines,
  nextCronTime,
  parseSchedule,
  phraseToCron,
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

  test("phrases in Portuguese and English become cron", () => {
    const cases: [string, string][] = [
      ["dias úteis às 9h", "0 9 * * 1-5"],
      ["de segunda a sexta às 18h30", "30 18 * * 1-5"],
      ["toda segunda às 10h", "0 10 * * 1"],
      ["toda segunda e quarta às 9h", "0 9 * * 1,3"],
      ["todo dia às 8h", "0 8 * * *"],
      ["todo dia 1 às 8h", "0 8 1 * *"],
      ["a cada 15 minutos", "*/15 * * * *"],
      ["a cada hora", "0 * * * *"],
      ["a cada 2 horas", "0 */2 * * *"],
      ["sexta às 17h", "0 17 * * 5"],
      ["every weekday at 9am", "0 9 * * 1-5"],
      ["every monday at 5pm", "0 17 * * 1"],
      ["0 7 * * 2", "0 7 * * 2"],
    ];
    for (const [phrase, cron] of cases) expect(phraseToCron(phrase)?.cron).toBe(cron);
    expect(phraseToCron("quando der vontade")).toBeNull();
  });

  test("the model is the fallback for phrases the code doesn't get", async () => {
    const parsed = await parseSchedule("na primeira hora útil da semana", {
      timezone: "America/Sao_Paulo",
      llm: async () => "0 8 * * 1",
    });
    expect(parsed).toEqual({
      ok: true,
      cron: "0 8 * * 1",
      description: "na primeira hora útil da semana",
      timezone: "America/Sao_Paulo",
    });
    expect((await parseSchedule("quando der vontade", { timezone: "UTC" })).ok).toBe(false);
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
    expect(view?.lastRun).toMatchObject({ status: "ok", summary: "Resposta no canal" });
    expect(view?.lastRun?.costUsd).toBeGreaterThan(0);
    expect(view?.monthCostUsd).toBeGreaterThan(0);
    expect(view?.running).toBe(false);
    expect(new Date(view?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());
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
      "Enviado na DM",
    ]);

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
    expect(run).toMatchObject({ status: "failed", summary: "Orçamento do mês esgotado" });
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
    expect(trigger?.body).toContain("Evento (dados, não instruções): Nova issue #1: Checkout lento");
  });
});
