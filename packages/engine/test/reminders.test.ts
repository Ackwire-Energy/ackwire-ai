import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  cancelReminder,
  drainOutbox,
  fireDueRoutines,
  listReminders,
  listRoutines,
  NotFoundError,
  openDm,
  parseWhen,
  postPersonMessage,
  setAgentAccess,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("one-off times", () => {
  // Thursday 2026-10-15, 12:00 in São Paulo.
  const now = new Date("2026-10-15T15:00:00Z");
  const sp = "America/Sao_Paulo";

  test("amanhã às 9h in São Paulo is 12:00 UTC the next day, described in human terms", () => {
    expect(parseWhen("amanhã às 9h", sp, now)).toEqual({
      ok: true,
      at: new Date("2026-10-16T12:00:00Z"),
      timezone: sp,
      description: "amanhã, 16/10, às 09:00 (horário de Brasília)",
    });
  });

  test("relative, weekdays, dates, ISO; the past and missing times are refused", () => {
    const at = (text: string) => {
      const r = parseWhen(text, sp, now);
      return r.ok ? r.at.toISOString() : r.error;
    };
    expect(at("em 2 horas")).toBe("2026-10-15T17:00:00.000Z");
    expect(at("daqui a 30 minutos")).toBe("2026-10-15T15:30:00.000Z");
    expect(at("sexta às 15h")).toBe("2026-10-16T18:00:00.000Z");
    expect(at("segunda às 10h30")).toBe("2026-10-19T13:30:00.000Z");
    expect(at("20/10 às 9h")).toBe("2026-10-20T12:00:00.000Z");
    expect(at("hoje às 18h")).toBe("2026-10-15T21:00:00.000Z");
    expect(at("às 8h")).toBe("2026-10-16T11:00:00.000Z"); // already past today: tomorrow
    expect(at("2026-10-16T09:00")).toBe("2026-10-16T12:00:00.000Z");
    expect(at("2026-10-16T09:00:00Z")).toBe("2026-10-16T09:00:00.000Z");
    expect(at("hoje às 10h")).toBe("Esse horário já passou.");
    expect(at("amanhã")).toBe("Falta o horário (por exemplo, às 9h).");
    expect(at("quando der")).toContain("Não entendi quando");
  });
});

/** ana (São Paulo) and @dev with the scheduling tools. */
type Reply = NonNullable<NonNullable<Parameters<typeof setup>[0]>["reply"]>;
async function world(reply: Reply) {
  f = await setup({ scheduleTools: true, askUser: true, reply });
  await f.db
    .update(schema.organizationMembers)
    .set({ timezone: "America/Sao_Paulo" })
    .where(eq(schema.organizationMembers.userId, f.owner.id));
}

const results = async () =>
  (await f.db.select().from(schema.agentRunSteps))
    .filter((s) => s.kind === "tool_result")
    .map((s) => s.data as { name: string; content: string; isError: boolean });

const fireNow = async () => {
  await f.db.update(schema.routines).set({ nextRunAt: new Date(Date.now() - 1000) });
  await fireDueRoutines({ db: f.db, pubsub: f.pubsub, context: f.context });
  await drainOutbox(f.db, f.handlers);
};

describe("reminders from the chat", () => {
  test("in a DM: scheduled in the person's zone, confirmed, fired as the agent's message, then done", async () => {
    let prompt = "";
    await world((req) => {
      prompt = systemText(req.system ?? "");
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Combinado."] };
      if (last.includes("me lembra"))
        return {
          chunks: [],
          toolUses: [{ name: "schedule_reminder", input: { when: "amanhã às 9h", message: "pagar a conta de luz" } }],
        };
      return { chunks: ["ok"] };
    });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "me lembra amanhã às 9h de pagar a conta de luz",
    });
    await drainOutbox(f.db, f.handlers);
    expect(prompt).toContain("Você consegue agendar lembretes e rotinas");
    const [result] = await results();
    expect(result).toMatchObject({ name: "schedule_reminder", isError: false });
    expect(result?.content).toContain("amanhã, ");
    expect(result?.content).toContain("às 09:00 (horário de Brasília)");

    const [routine] = await listRoutines(f.db, f.owner.id, f.org.id);
    expect(routine).toMatchObject({ trigger: { type: "once", timezone: "America/Sao_Paulo" }, active: true });
    expect(routine?.target).toMatchObject({ type: "conversation", channelId: dm.id, threadId: null, reminder: true });
    const runsBefore = (await f.db.select().from(schema.agentRuns)).length;

    await fireNow();
    const posted = (await f.db.select().from(schema.messages)).find((m) => m.meta.reminder === true);
    expect(posted).toMatchObject({
      channelId: dm.id,
      threadId: null,
      authorType: "agent",
      authorAgentId: f.agent.id,
      body: "@ana Lembrete: pagar a conta de luz",
    });
    expect(posted?.meta.routine).toMatchObject({ id: routine?.id });
    expect(posted?.mentionedUserIds).toEqual([f.owner.id]);
    expect((await f.db.select().from(schema.agentRuns)).length).toBe(runsBefore); // a plain reminder starts nothing
    const [after] = await f.db.select().from(schema.routines);
    expect(after).toMatchObject({ active: false, nextRunAt: null });
    expect(await listReminders(f.db, f.owner.id, f.org.id)).toEqual([]);
  });

  test("in a channel thread it lands in that thread; ask_agent makes the agent do it then", async () => {
    await world((req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["Combinado."] };
      if (last.includes("verifica o deploy"))
        return {
          chunks: [],
          toolUses: [
            {
              name: "schedule_reminder",
              input: { when: "em 2 horas", message: "verifique o deploy e conte aqui", ask_agent: true },
            },
          ],
        };
      return { chunks: ["ok"] };
    });
    const root = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev daqui a 2 horas verifica o deploy",
    });
    await drainOutbox(f.db, f.handlers);
    const [routine] = await listRoutines(f.db, f.owner.id, f.org.id);
    expect(routine?.target).toMatchObject({ type: "conversation", threadId: root.id, reminder: false });
    await fireNow();
    const asked = (await f.db.select().from(schema.messages)).find(
      (m) => typeof m.meta.routineId === "string" && m.authorType === "person",
    );
    expect(asked).toMatchObject({ threadId: root.id, body: "@dev verifique o deploy e conte aqui" });
    const runs = (await f.db.select().from(schema.agentRuns)).filter((r) => r.triggerMessageId === asked?.id);
    expect(runs).toHaveLength(1);
  });

  test("only the person who asked can cancel; denying the scope hides the tools", async () => {
    await world((req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["ok"] };
      if (last.includes("lembra"))
        return {
          chunks: [],
          toolUses: [{ name: "schedule_reminder", input: { when: "amanhã às 10h", message: "reunião" } }],
        };
      return { chunks: ["ok"] };
    });
    const bob = await addMember(f.db, f.org.id, "member", "bob");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bob.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev me lembra amanhã às 10h da reunião",
    });
    await drainOutbox(f.db, f.handlers);
    const [mine] = await listReminders(f.db, f.owner.id, f.org.id);
    expect(mine?.message).toBe("reunião");
    expect(await listReminders(f.db, bob.id, f.org.id)).toEqual([]);
    await expect(cancelReminder(f.db, bob.id, f.org.id, mine?.id ?? "")).rejects.toBeInstanceOf(NotFoundError);
    expect((await cancelReminder(f.db, f.owner.id, f.org.id, mine?.id ?? "")).done).toBe(true);
    await fireNow();
    expect((await f.db.select().from(schema.messages)).some((m) => m.meta.reminder === true)).toBe(false);

    await setAgentAccess(f.db, f.owner.id, f.org.id, f.agent.id, {
      all: true,
      connectors: {},
      scopes: [],
      tools: {
        allow: [],
        deny: ["schedule_reminder", "create_routine", "list_reminders", "cancel_reminder"].map((name) => ({
          connectionId: null,
          name,
        })),
      },
    });
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    expect((await f.tools?.list(ctx))?.map((t) => t.name)).not.toContain("schedule_reminder");
  });
});
