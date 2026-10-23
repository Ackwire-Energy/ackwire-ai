import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema, sql } from "@agenteschat/db";
import { createAgent, insertMessage, normalizeNote, personOfMessage, type ToolContext } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function addInfra() {
  return createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    {
      name: "Infra",
      handle: "infra",
      role: "Infrastructure",
      instructions: "You run the servers.",
      credentialId: f.credential.id,
    },
    { model: "claude-sonnet-5-5" },
  );
}

/** A run of @dev in #general started by `userId`'s message, and its tool context. */
async function devRunFor(userId: string, body: string): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

const invoke = (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
  if (!f.tools) throw new Error("no tools");
  return f.tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
};

describe("the agents' DM works for one person at a time", () => {
  test("a question joins the consulted agent's run only when the same person is behind both", async () => {
    f = await setup({ askAgent: true });
    const infra = await addInfra();
    const bob = await addMember(f.db, f.org.id, "member", "bob");

    const ana1 = await devRunFor(f.owner.id, "@dev como faz deploy do staging?");
    expect(await invoke(ana1, "ask_agent", { agent: "@infra", question: "How is staging deployed?" })).toMatchObject({
      type: "result",
      output: { content: expect.stringContaining("Asked @infra") },
    });
    const bob1 = await devRunFor(bob.id, "@dev qual a senha do banco de staging?");
    await invoke(bob1, "ask_agent", { agent: "@infra", question: "Which database does staging use?" });
    const ana2 = await devRunFor(f.owner.id, "@dev e o de produção?");
    await invoke(ana2, "ask_agent", { agent: "@infra", question: "And production?" });

    const asked = await f.db.select().from(schema.agentConsultations).orderBy(asc(schema.agentConsultations.createdAt));
    expect(asked).toHaveLength(3);
    const [first, second, third] = asked;
    // Bob's question started a run of its own; Ana's second one joined the run working for her.
    expect(second?.targetRunId).not.toBe(first?.targetRunId);
    expect(third?.targetRunId).toBe(first?.targetRunId);
    const infraRuns = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, infra.id));
    expect(infraRuns).toHaveLength(2);
    const anaRun = infraRuns.find((r) => r.id === first?.targetRunId);
    expect(anaRun?.pendingMessageIds).toEqual([third?.messageId]);

    // Who each exchange is for is derivable from the question itself (the history keeps them apart).
    expect(await personOfMessage(f.db, f.org.id, first?.messageId ?? "")).toBe(f.owner.id);
    expect(await personOfMessage(f.db, f.org.id, second?.messageId ?? "")).toBe(bob.id);
  });
});

describe("tell_agent", () => {
  test("the same note to the same agent within an hour is dropped, and the model is told", async () => {
    f = await setup({ askAgent: true });
    await addInfra();
    const ctx = await devRunFor(f.owner.id, "@dev avisa o infra do deploy");
    const notes = () =>
      f.db
        .select({ body: schema.messages.body })
        .from(schema.messages)
        .where(sql`${schema.messages.meta} ? 'agentNote'`);

    expect(await invoke(ctx, "tell_agent", { agent: "@infra", message: "Deploy finished on staging." })).toMatchObject({
      output: { content: expect.stringContaining("Told @infra") },
    });
    const again = await invoke(ctx, "tell_agent", { agent: "@infra", message: "deploy  finished on Staging!" });
    expect(again).toMatchObject({
      output: {
        content: expect.stringContaining("already told @infra exactly this"),
        data: { agentNote: { duplicate: true } },
      },
    });
    expect(await notes()).toHaveLength(1);
    await invoke(ctx, "tell_agent", { agent: "@infra", message: "Deploy finished on production." });
    expect(await notes()).toHaveLength(2);
  });

  test("notes compare without case, accents, spacing or trailing punctuation", () => {
    expect(normalizeNote("  Deploy   concluído!! ")).toBe(normalizeNote("deploy concluido"));
    expect(normalizeNote("Deploy concluído")).not.toBe(normalizeNote("Deploy iniciado"));
  });
});
