import { afterEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { insertMessage, isSensitive, type RoutineAccess, type RoutineBrief, type ToolContext } from "../src";
import { WHY_REFUSAL } from "../src/tools/run-policy";
import { giveMail, imapAccount, type MailFixture, mailSetup, runContext } from "./mail-fixtures";

let m: MailFixture;
afterEach(async () => {
  await m?.f.close();
  m = undefined as never;
});

const WHY = "The customer asked for the invoice twice; this reply sends it once more with the right address.";
const SEND = { to: ["cliente@acme.com"], subject: "Fatura", body: "Segue a fatura." };

/** A run nobody watches: an unattended one (an agent's own message started it) or a routine's. */
async function unwatchedRun(kind: "unattended" | RoutineAccess): Promise<ToolContext> {
  const { f } = m;
  const brief: RoutineBrief | null =
    kind === "unattended"
      ? null
      : {
          routineId: crypto.randomUUID(),
          routineRunId: crypto.randomUUID(),
          name: "Caixa de suporte",
          creatorUserId: f.owner.id,
          deliverTo: { channelId: f.general.id, threadId: null },
          access: kind,
          report: "when_new",
          trigger: "event",
          dueAt: new Date().toISOString(),
        };
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: brief
      ? { type: "person", userId: f.owner.id }
      : { type: "agent", agentId: f.agent.id, runId: null, hop: 1 },
    body: "Answer the new support mail.",
    meta: brief ? { routineBrief: brief } : undefined,
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
      ...(brief ? { background: true } : {}),
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
    ...(brief ? { background: true } : {}),
  };
}

const sendTool = async (ctx: ToolContext) => (await m.tools.list(ctx)).find((t) => t.name === "mail_support_send");
const send = (ctx: ToolContext, input: Record<string, unknown>) =>
  m.tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: "mail_support_send", input });

test("a person's run sends without asking when the mailbox allows it; nobody's run always asks", async () => {
  m = await mailSetup();
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read_write", { allowedRecipients: ["@acme.com"], sendWithoutAsking: true });

  const person = await sendTool(await runContext(m.f));
  expect(person && isSensitive(person)).toBe(false);

  const ctx = await unwatchedRun("unattended");
  const tainted = await sendTool(ctx);
  expect(tainted && isSensitive(tainted)).toBe(true);
  expect(tainted?.inputSchema.required).toContain("why");
  expect(await send(ctx, SEND)).toMatchObject({ type: "result", output: { content: WHY_REFUSAL, isError: true } });
  const asked = await send(ctx, { ...SEND, why: WHY });
  if (asked.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(asked)}`);
  expect(asked.approval).toMatchObject({ why: WHY, origin: { kind: "unattended" }, params: SEND });
  expect(m.box.state.sent).toEqual([]);
});

test("a routine that may act gets a card for every send; one that only reads can't send at all", async () => {
  m = await mailSetup();
  const account = await imapAccount(m);
  await giveMail(m, account.id, "read_write", { allowedRecipients: ["@acme.com"], sendWithoutAsking: true });

  const acting = await unwatchedRun("act");
  expect((await sendTool(acting))?.sensitive).toBe(true);
  const asked = await send(acting, { ...SEND, why: WHY });
  if (asked.type !== "approval") throw new Error("expected an approval");
  expect(asked.approval.origin).toMatchObject({ kind: "routine", routineName: "Caixa de suporte" });

  const reading = await unwatchedRun("read");
  const names = (await m.tools.list(reading)).map((t) => t.name);
  expect(names).toContain("mail_support_search");
  expect(names).not.toContain("mail_support_send");
  expect(await send(reading, { ...SEND, why: WHY })).toMatchObject({ output: { isError: true } });
});
