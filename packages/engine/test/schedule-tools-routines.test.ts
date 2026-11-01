import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  createScheduleToolSource,
  createWebhookEndpoint,
  getRoutineView,
  insertMessage,
  type ToolContext,
  type ToolDefinition,
  undoAgentAction,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/**
 * A real run of the agent in #general whose trigger is `author`'s message: the tools read who is
 * behind it from the run (authority.ts), so the run row must exist.
 */
async function runContext(fx: Fixture, author: "person" | "agent" = "person"): Promise<ToolContext> {
  const trigger = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author:
      author === "person"
        ? { type: "person", userId: fx.owner.id }
        : { type: "agent", agentId: fx.agent.id, runId: null, hop: 0, stretchId: null },
    body: "rotinas, por favor",
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
      hop: 0,
      status: "running",
    })
    .returning();
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    channelId: fx.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

async function tools(fx: Fixture, ctx: ToolContext) {
  const all: ToolDefinition[] = await createScheduleToolSource({ pubsub: fx.pubsub, context: fx.context }).tools(ctx);
  return (name: string, input: Record<string, unknown>) => {
    const tool = all.find((t) => t.name === name);
    if (!tool) throw new Error(`no ${name}`);
    return tool.execute(input, ctx);
  };
}

type RoutineRow = typeof schema.routines.$inferSelect;
const routineOf = async (id: string) =>
  (await f.db.select().from(schema.routines).where(eq(schema.routines.id, id)))[0] as RoutineRow;
const receipts = (runId: string) => f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, runId));

describe("schedule tools: routines", () => {
  test("create_routine with an event trigger, report and access; the receipt carries no English schedule", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await tools(f, ctx);
    const out = await call("create_routine", {
      prompt: "Investigue o erro novo e diga o que fazer.",
      trigger: { type: "event", event: "sentry.issue_created" },
      report: "always",
      access: "act",
    });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("when a new error comes in from Sentry");
    expect(out.content).toContain("reports every run");
    const id = (out.data?.routine as { id: string } | undefined)?.id ?? "";
    expect(await routineOf(id)).toMatchObject({
      triggerType: "event",
      event: "sentry.issue_created",
      access: "act",
      report: "always",
    });
    const [created] = await receipts(ctx.runId);
    expect(created).toMatchObject({
      kind: "routine.created",
      params: { trigger: "event", event: "sentry.issue_created", access: "act", report: "always" },
    });

    // A schedule's receipt carries its rule: the app words it in the person's language.
    const weekly = await call("create_routine", { prompt: "Resumo da semana.", schedule: "toda segunda às 9h" });
    const weeklyId = (weekly.data?.routine as { id: string } | undefined)?.id ?? "";
    const receipt = (await receipts(ctx.runId)).find((r) => r.targetId === weeklyId);
    expect(receipt?.params).toMatchObject({
      trigger: "schedule",
      timezone: "UTC",
      rule: { freq: "weekly", byWeekday: ["MO"], times: ["09:00"] },
      access: "read",
      report: "when_new",
    });
    expect(receipt?.params).not.toHaveProperty("schedule");
  });

  test("an event no webhook brings here: the tools say what the routine needs, its view says it can't run yet", async () => {
    f = await setup();
    const call = await tools(f, await runContext(f));
    const out = await call("create_routine", {
      prompt: "Revise o PR novo e mande o resumo.",
      trigger: { type: "event", event: "github.pr_opened" },
    });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("Confirm it to the person. It can't run yet: no GitHub webhook sends this workspace");
    // In the person's words: our private app API is nothing they can call.
    expect(out.content).toContain("a GitHub webhook for this workspace, which a workspace admin sets up");
    expect(out.content).toContain("offer a schedule that checks instead");
    expect(out.content).not.toContain("/api/");
    const id = (out.data?.routine as { id: string } | undefined)?.id ?? "";
    expect((await getRoutineView(f.db, f.owner.id, f.org.id, id)).state).toBe("needs_webhook");
    expect((await call("list_routines", {})).content).toContain(
      "can't run yet: no GitHub webhook sends its event here",
    );
    // Paused, it says so first.
    const paused = await call("update_routine", { id, active: false });
    expect(paused.content).not.toContain("can't run yet");
    expect((await getRoutineView(f.db, f.owner.id, f.org.id, id)).state).toBe("paused");

    // With a GitHub webhook here, the next pull request starts it.
    await createWebhookEndpoint(
      { db: f.db, keyWrappers: [f.keyWrapper] },
      f.owner.id,
      f.org.id,
      "github",
      "http://localhost:3000",
    );
    const resumed = await call("update_routine", { id, active: true });
    expect(resumed.content).not.toContain("can't run yet");
    expect((await getRoutineView(f.db, f.owner.id, f.org.id, id)).state).toBe("active");
    // Sentry's events need Sentry's webhook; a task made here needs none.
    const sentry = await call("create_routine", {
      prompt: "Investigue o erro.",
      trigger: { type: "event", event: "sentry.issue_created" },
    });
    expect(sentry.content).toContain("It can't run yet: no Sentry webhook");
    const issues = await call("create_routine", {
      prompt: "Triagem.",
      trigger: { type: "event", event: "issue.created" },
    });
    expect(issues.content).not.toContain("can't run yet");
  });

  test("create_routine needs a schedule or a trigger, not both; an email trigger needs a mailbox the agent reads", async () => {
    f = await setup();
    const call = await tools(f, await runContext(f));
    const both = await call("create_routine", {
      prompt: "x",
      schedule: "todo dia às 9h",
      trigger: { type: "event", event: "issue.created" },
    });
    expect(both).toMatchObject({ isError: true });
    expect((await call("create_routine", { prompt: "x" })).isError).toBe(true);
    const mail = await call("create_routine", {
      prompt: "Leia os emails de clientes.",
      trigger: { type: "email", from: ["@cliente.com"] },
    });
    expect(mail).toMatchObject({ isError: true });
    expect(mail.content).toContain("can't read any mailbox");
    const unknown = await call("create_routine", { prompt: "x", trigger: { type: "event", event: "email.received" } });
    expect(unknown.content).toContain("Say which event");
  });

  test("update_routine changes report and access; delete_routine has Undo; run_routine_now queues a run", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await tools(f, ctx);
    const created = await call("create_routine", { prompt: "Veja os PRs abertos.", schedule: "todo dia às 9h" });
    const id = (created.data?.routine as { id: string } | undefined)?.id ?? "";

    const updated = await call("update_routine", { id, report: "always", access: "act" });
    expect(updated.isError).toBeFalsy();
    expect(await routineOf(id)).toMatchObject({ report: "always", access: "act" });

    const ran = await call("run_routine_now", { id });
    expect(ran.isError).toBeFalsy();
    expect(ran.content).toContain("works in the background");
    expect(await f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, id))).toMatchObject([
      { trigger: "manual", status: "queued" },
    ]);

    const deleted = await call("delete_routine", { id });
    expect(deleted.isError).toBeFalsy();
    expect((await routineOf(id)).deletedAt).not.toBeNull();
    const receipt = (await receipts(ctx.runId)).find((r) => r.kind === "routine.deleted");
    expect(receipt).toMatchObject({ targetId: id, params: { name: "Veja os PRs abertos." } });
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    const back = await routineOf(id);
    expect(back.deletedAt).toBeNull();
    expect(back.active).toBe(true);
    // Gone again: nothing to change.
    expect((await call("delete_routine", { id: crypto.randomUUID() })).isError).toBe(true);
  });

  test("list_routines shows state, next run and the last runs with their coded reasons", async () => {
    f = await setup();
    const ctx = await runContext(f);
    const call = await tools(f, ctx);
    const created = await call("create_routine", { prompt: "Olhe o Sentry.", schedule: "todo dia às 9h" });
    const id = (created.data?.routine as { id: string } | undefined)?.id ?? "";
    const run = (hoursAgo: number, values: Partial<typeof schema.routineRuns.$inferInsert>) => {
      const at = new Date(Date.now() - hoursAgo * 3600_000);
      return { orgId: f.org.id, routineId: id, at, createdAt: at, trigger: "schedule", ...values };
    };
    await f.db
      .insert(schema.routineRuns)
      .values([
        run(1, { status: "failed", code: "provider_error" }),
        run(2, { status: "skipped", code: "previous_running" }),
        run(3, { status: "reported", summary: "3 erros novos." }),
      ]);
    await f.db
      .update(schema.routines)
      .set({ active: false, nextRunAt: null, pausedReason: "failing", failuresInRow: 5 })
      .where(eq(schema.routines.id, id));
    const listed = await call("list_routines", {});
    expect(listed.content).toContain("(paused: failing)");
    expect(listed.content).toContain("next: none");
    expect(listed.content).toContain("failed (provider_error)");
    expect(listed.content).toContain("skipped (previous_running)");
    expect(listed.content).toContain("reported");
    expect(listed.content).toContain("Olhe o Sentry.");
  });

  test("nobody behind the run (an agent's own message): nothing is scheduled", async () => {
    f = await setup();
    const call = await tools(f, await runContext(f, "agent"));
    const out = await call("create_routine", { prompt: "x", schedule: "todo dia às 9h" });
    expect(out).toMatchObject({ isError: true });
    expect(out.content).toContain("no person is behind this run");
    expect(await f.db.select().from(schema.routines)).toEqual([]);
  });
});
