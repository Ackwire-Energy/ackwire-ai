import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  answerNow,
  createCredential,
  createTeam,
  drainOutbox,
  noAiCardOf,
  OrgPausedError,
  postPersonMessage,
  type RouterStrategy,
  routeMessage,
  runRoutineNow,
  sendPlanWaitingEmail,
  setBillingHold,
  setOrgStanding,
  useTeamTemplate,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { channelRoutine, routineDeps } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const hold = (code: "payment" | "unpaid" | "ended" | null) => setBillingHold({ db: f.db }, f.org.id, code);
const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
const cards = async () =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.orgId, f.org.id))).filter((m) =>
    noAiCardOf({ authorType: m.authorType, meta: m.meta }),
  );
const reminders = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "plan.waiting"));
const answerDeps = () => ({ db: f.db, pubsub: f.pubsub, gateway: f.gateway });

describe("the first send on a hold", () => {
  test("the agent keeps the message with no model call, and after the plan the same message is answered", async () => {
    f = await setup({ reply: () => ({ chunks: ["On it."] }) });
    await hold("payment");
    await post("@dev reply to this customer");
    await drainOutbox(f.db, f.handlers);

    expect(f.provider.calls).toHaveLength(0);
    const [card] = await cards();
    expect(card?.meta.noAi).toMatchObject({ reason: "plan_hold", intent: "task" });
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({ status: "failed", error: "no_ai" });

    // A key saved earlier reads as ready: the card must not restart a run that would only be refused again.
    const refused = await answerNow(answerDeps(), f.owner.id, f.org.id, card?.id as string).catch((e) => e);
    expect(refused).toBeInstanceOf(OrgPausedError);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);

    await hold(null);
    const { runs } = await answerNow(answerDeps(), f.owner.id, f.org.id, card?.id as string);
    expect(runs).toHaveLength(1);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
  });

  test("a second message within the 6 hours gets no second card, and the reminders are queued once", async () => {
    f = await setup();
    await hold("payment");
    await post("@dev one");
    await drainOutbox(f.db, f.handlers);
    await post("@dev two");
    await drainOutbox(f.db, f.handlers);
    expect(await cards()).toHaveLength(1);
    expect((await reminders()).map((r) => r.payload.step).sort()).toEqual([0, 1]);
  });

  test("a trust hold still ends the run saying why, with no card", async () => {
    f = await setup();
    await setOrgStanding({ db: f.db, pubsub: f.pubsub }, f.org.id, { state: "hold", reason: "review", notice: "shown" });
    await post("@dev hello");
    await drainOutbox(f.db, f.handlers);
    expect(await cards()).toHaveLength(0);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.error).not.toBe("no_ai");
  });
});

describe("a channel message nobody mentioned", () => {
  const strategy: RouterStrategy = {
    name: "test",
    decide: () => {
      throw new Error("asked a strategy on a hold");
    },
  } as unknown as RouterStrategy;
  const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3 };
  const decision = (messageId: string) =>
    f.db.select().from(schema.routingDecisions).where(eq(schema.routingDecisions.messageId, messageId));

  test("with agents there it is stored as `no_ai`, asking nothing", async () => {
    f = await setup();
    await hold("payment");
    const m = await post("anyone there?");
    const routed = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: m.id });
    expect(routed).toMatchObject({ runs: [], reason: "no_ai", held: true });
    expect((await decision(m.id))[0]?.error).toBe("no_ai");
  });

  test("with no agent there nothing is stored, and on an `unpaid` hold nothing is asked or stored either", async () => {
    f = await setup();
    await hold("payment");
    await f.db
      .delete(schema.channelMembers)
      .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.agentId, f.agent.id)));
    const m = await post("anyone there?");
    expect(await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: m.id })).toEqual({
      runs: [],
      skipped: "org_paused",
    });
    expect(await decision(m.id)).toHaveLength(0);

    await hold("unpaid");
    const other = await post("still there?");
    expect(await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: other.id })).toEqual({
      runs: [],
      skipped: "org_paused",
    });
  });
});

describe("what a hold closes", () => {
  test("no key is saved as a way around it", async () => {
    f = await setup();
    await hold("payment");
    const refused = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "openai",
      label: "OpenAI",
      apiKey: "sk-test-1234567890",
    }).catch((e) => e);
    expect(refused).toMatchObject({ code: "credentials.plan_hold" });
  });

  test("embeddings fall back to full text, so search keeps working", async () => {
    f = await setup({ embeddings: true });
    await hold("payment");
    expect(await f.gateway.embed({ orgId: f.org.id, texts: ["hi"], inputType: "query" })).toBeNull();
  });

  test("Rodar agora says so instead of a slot that silently passes", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    await hold("payment");
    await expect(runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id)).rejects.toBeInstanceOf(OrgPausedError);
  });
});

describe("the team before paying", () => {
  const lodiDm = async (channelId: string) =>
    f.db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId));

  test("a tap is kept as the person's message with no run, then the card, with no question", async () => {
    f = await setup({ rightHand: true });
    await hold("payment");
    const used = await useTeamTemplate(
      { db: f.db, pubsub: f.pubsub },
      f.owner.id,
      f.org.id,
      "store",
      "pt-BR",
      "Loja online",
    );
    await drainOutbox(f.db, f.handlers);
    const rows = await lodiDm(used.channelId);
    expect(rows.find((m) => m.authorType === "person")?.body).toBe("Loja online");
    expect(rows.some((m) => m.meta.replyChips)).toBe(false);
    expect(await cards()).toHaveLength(0);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(0);
    expect(f.provider.calls).toHaveLength(0);

    const card = rows.find((m) => m.id === used.messageId)?.meta.actionCard as {
      expiresAt: string;
      params: { example?: string };
    };
    expect(Date.parse(card.expiresAt) - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
    expect(card.params.example).toContain("Marina");
  });

  test("with a plan in force the same template asks its question and shows no example", async () => {
    f = await setup({ rightHand: true });
    const used = await useTeamTemplate({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "store", "pt-BR", "Loja");
    const rows = await lodiDm(used.channelId);
    expect(rows.some((m) => m.authorType === "person")).toBe(false);
    expect(rows.some((m) => m.meta.replyChips)).toBe(true);
    const card = rows.find((m) => m.id === used.messageId)?.meta.actionCard as { params: { example?: string } };
    expect(card.params.example).toBeUndefined();
  });

  test("creating the team queues the two reminders", async () => {
    f = await setup({ rightHand: true });
    await hold("payment");
    const used = await useTeamTemplate({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, "support", "en");
    await createTeam({ db: f.db, pubsub: f.pubsub, gateway: f.gateway }, f.owner.id, f.org.id, used.messageId);
    expect(await reminders()).toHaveLength(2);
  });
});

describe("the plan_waiting email", () => {
  const sent = () =>
    f.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, "email.send"), sql`${schema.outbox.payload}->'template'->>'kind' = 'plan_waiting'`));

  test("goes to who can pay at a confirmed address, with the billing page, while it still waits", async () => {
    f = await setup();
    await hold("payment");
    await addMember(f.db, f.org.id, "member");
    await f.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, f.owner.id));
    await sendPlanWaitingEmail(f.db, "https://app.example.com/", f.org.id, 0);
    const [row] = await sent();
    const payload = row?.payload as { to: string[]; template: { url: string; agents: number } };
    expect(payload.to).toHaveLength(1);
    expect(payload.template.url).toBe(`https://app.example.com/org/${f.org.id}/settings/billing`);
    expect(payload.template.agents).toBeGreaterThan(0);
  });

  test("nothing at an unconfirmed address, or once the workspace has its plan", async () => {
    f = await setup();
    await hold("payment");
    await f.db.update(schema.users).set({ emailVerified: false }).where(eq(schema.users.id, f.owner.id));
    await sendPlanWaitingEmail(f.db, "https://app.example.com", f.org.id, 0);
    expect(await sent()).toHaveLength(0);
    await f.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, f.owner.id));
    await hold(null);
    await sendPlanWaitingEmail(f.db, "https://app.example.com", f.org.id, 1);
    expect(await sent()).toHaveLength(0);
  });
});
