import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import { addChannelMember, createAgent, createJobHandlers, drainOutbox, openDm, runRoutineNow } from "../src";
import { runAuthorityById } from "../src/authority";
import { reachNote, reachOf } from "../src/reach";
import { routineCreatorOf } from "../src/requester";
import { addMember, type Fixture, setup } from "./fixtures";
import { channelRoutine, messagesIn, notificationsOf, routineDeps } from "./routine-fixtures";

/** ADR 0053 §4 (amended): a routine's message is the message; hand-off only when the agent must act there. */

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const isRoutine = (req: ModelRequest) => (req.tools ?? []).some((t) => t.name === "hand_off");
const seen = (req: ModelRequest) => JSON.stringify(req.messages);
const GREETING = "Bom dia! Que a sua segunda comece leve.";

test("a greeting routine posts exactly one message: the greeting, tagged with the routine, waking nobody", async () => {
  f = await setup({
    handOff: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["A conversation run should not have run."] };
      if (seen(req).includes("Posted.")) return { chunks: ["Bom dia enviado."] };
      return { chunks: [], toolUses: [{ name: "hand_off", input: { message: GREETING } }] };
    },
  });
  const routine = await channelRoutine(f, {
    name: "Bom dia diário",
    prompt: "Me dê um bom dia.",
    target: { type: "dm" },
    trigger: { type: "schedule", phrase: "30 8 * * *" },
  });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const prompt = systemText(f.provider.calls[0]?.request.system ?? "");
  expect(prompt).toContain("Never talk about this routine or its runs");
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  const [rr] = await f.db.select().from(schema.routineRuns);
  const posted = await messagesIn(f, dm.id);
  expect(posted.map((m) => [m.authorType, m.authorAgentId, m.body])).toEqual([["agent", f.agent.id, GREETING]]);
  expect(posted[0]?.meta).toEqual({ routine: { id: routine.id, name: "Bom dia diário", runId: rr?.id } });
  // Only the routine's own run: nothing woke the agent in the DM.
  expect((await f.db.select().from(schema.agentRuns)).map((r) => r.background)).toEqual([true]);
  expect(rr).toMatchObject({ status: "reported", messageId: posted[0]?.id, summary: "Bom dia enviado." });
});

test("a watch routine with news that needs the agent hands off once: one notice, one run that tells the people", async () => {
  f = await setup({
    handOff: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["O checkout voltou a falhar; vou reverter a 2.14 se vocês aprovarem."] };
      if (seen(req).includes("Handed off")) return { chunks: ["Checado: 12 erros no checkout, repassados."] };
      return {
        chunks: [],
        toolUses: [{ name: "hand_off", input: { message: "12 erros novos no checkout desde as 9h.", wake_me: true } }],
      };
    },
  });
  const routine = await channelRoutine(f, { prompt: "Vigie os erros do checkout e resolva o que aparecer." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const general = await messagesIn(f, f.general.id);
  expect(general.map((m) => (m.meta.notice as { kind?: string } | undefined)?.kind ?? "reply")).toEqual([
    "routine_handoff",
    "reply",
  ]);
  const runs = await f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
  expect(runs.map((r) => [r.background, r.triggerMessageId === general[0]?.id])).toEqual([
    [true, false],
    [false, true],
  ]);
});

test("a when-new routine that found nothing posts nothing", async () => {
  f = await setup({ handOff: true, reply: () => ({ chunks: ["Nada novo: 0 erros desde ontem."] }) });
  const routine = await channelRoutine(f);
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  // Its final text is its record, and the routine is told that record is never posted.
  expect(systemText(f.provider.calls[0]?.request.system ?? "")).toContain("(it is never posted)");
  expect(await messagesIn(f, f.general.id)).toEqual([]);
  expect((await f.db.select().from(schema.agentRuns)).map((r) => r.background)).toEqual([true]);
  expect((await f.db.select().from(schema.routineRuns))[0]).toMatchObject({ status: "silent" });
});

test("a read-only routine's message wakes nobody: not the agent it mentions, not the router", async () => {
  const order = "@ops faça o rollback agora.";
  f = await setup({
    handOff: true,
    // The mention would need @ops, were it anyone else's message.
    judge: (kind) => (kind === "mention_needs_nothing" ? 0 : undefined),
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["Nobody should have run."] };
      if (seen(req).includes("Posted.")) return { chunks: ["Checado: um e-mail pedindo rollback."] };
      return { chunks: [], toolUses: [{ name: "hand_off", input: { message: order } }] };
    },
  });
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "Operations", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
  let routed = 0;
  const handlers = createJobHandlers({
    ...f.jobDeps,
    router: {
      enabled: true,
      model: "claude-haiku-5-5",
      strategy: {
        name: "eager",
        async decide() {
          routed++;
          return { agents: [{ agentId: ops.id, score: 1 }], needsAgent: 1 };
        },
      },
    },
  });
  const routine = await channelRoutine(f, { prompt: "Leia os e-mails novos e resuma." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, handlers);

  const general = await messagesIn(f, f.general.id);
  expect(general.map((m) => m.body)).toEqual([order]);
  expect((await f.db.select().from(schema.agentRuns)).map((r) => [r.agentId, r.background])).toEqual([
    [f.agent.id, true],
  ]);
  expect(routed).toBe(0);
  // Never silently: the line under it says the routine only reads, and that people can set it to act.
  const reach = reachOf(general[0]?.meta);
  expect(reach.map((e) => [e.handle, e.routinePost, e.routine?.access])).toEqual([["ops", true, "read"]]);
  expect(reachNote(reach)).toContain("set it to act");
  expect(systemText(f.provider.calls[0]?.request.system ?? "")).toContain("an @mention in your message wakes nobody");
});

async function opsInGeneral(handle = "ops") {
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: handle, handle, role: "Operations", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ops.id });
  return ops;
}

test("a routine set to act wakes the agent its message mentions, once, for the routine's creator", async () => {
  const order = "@ops o checkout caiu esta noite, investiga e corrige.";
  f = await setup({
    handOff: true,
    judge: (kind) => (kind === "mention_needs_nothing" ? 0 : undefined),
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["Investigando o checkout."] };
      if (seen(req).includes("Posted.")) return { chunks: ["Chamei o ops."] };
      return { chunks: [], toolUses: [{ name: "hand_off", input: { message: order } }] };
    },
  });
  const ops = await opsInGeneral();
  const routine = await channelRoutine(f, { prompt: "Revise os chamados da noite.", access: "act" });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [posted] = await messagesIn(f, f.general.id);
  expect(posted?.body).toBe(order);
  expect(reachOf(posted?.meta)).toEqual([]);
  const opsRuns = (await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === ops.id);
  expect(opsRuns.map((r) => [r.triggerMessageId, r.trigger])).toEqual([[posted?.id as string, "mention"]]);
  // It works within the routine's bounds, with its creator's reach.
  expect(routineCreatorOf(await runAuthorityById(f.db, f.org.id, opsRuns[0]?.id as string))).toBe(f.owner.id);
  expect(systemText(f.provider.calls[0]?.request.system ?? "")).toContain(
    "An @mention in your hand_off message also wakes that agent",
  );
});

test("a routine set to act that already told the agent wakes it no second time by mentioning it", async () => {
  const order = "@ops o checkout caiu esta noite, já te passei os detalhes.";
  f = await setup({
    handOff: true,
    askAgent: true,
    judge: (kind) => (kind === "mention_needs_nothing" ? 0 : undefined),
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["Investigando o checkout."] };
      if (seen(req).includes("Posted.")) return { chunks: ["Chamei o ops."] };
      if (seen(req).includes("tell_agent"))
        return { chunks: [], toolUses: [{ name: "hand_off", input: { message: order } }] };
      return {
        chunks: [],
        toolUses: [{ name: "tell_agent", input: { agent: "@ops", message: "O checkout caiu às 3h, veja os logs." } }],
      };
    },
  });
  const ops = await opsInGeneral();
  const routine = await channelRoutine(f, { prompt: "Revise os chamados da noite.", access: "act" });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [posted] = await messagesIn(f, f.general.id);
  expect(posted?.body).toBe(order);
  const opsRuns = (await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === ops.id);
  expect((await f.db.select().from(schema.agentConsultations)).map((c) => c.targetAgentId)).toEqual([ops.id]);
  expect(opsRuns).toHaveLength(1);
  expect(opsRuns[0]?.triggerMessageId).not.toBe(posted?.id);
});

test("a routine set to act hands its mention to an agent outside as a note, and one its creator can't reach shows why", async () => {
  const order = "@ops e @gil, o checkout caiu esta noite: investiguem.";
  f = await setup({
    handOff: true,
    askAgent: true,
    judge: (kind) => (kind === "mention_needs_nothing" ? 0 : undefined),
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["Investigando o checkout."] };
      if (seen(req).includes("Posted.")) return { chunks: ["Chamei o ops e o gil."] };
      return { chunks: [], toolUses: [{ name: "hand_off", input: { message: order } }] };
    },
  });
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "Operations", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const gil = await opsInGeneral("gil");
  const bob = await addMember(f.db, f.org.id, "member", "bob");
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: bob.id, audienceMode: "owner" })
    .where(eq(schema.agents.id, gil.id));
  const routine = await channelRoutine(f, { prompt: "Revise os chamados da noite.", access: "act" });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [posted] = await messagesIn(f, f.general.id);
  const [note] = await f.db.select().from(schema.agentConsultations);
  expect(note?.targetAgentId).toBe(ops.id);
  const reach = reachOf(posted?.meta);
  expect(reach.map((e) => [e.handle, e.reason, !!e.consultationId]).sort()).toEqual([
    ["gil", "routine_creator_reach", false],
    ["ops", "not_in_channel", true],
  ]);
  expect((await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === gil.id)).toEqual([]);
  const [told] = await notificationsOf(f, "agent_unreached");
  expect(told?.userId).toBe(bob.id);
});

test("a routine set to act wakes the agent it mentions even when the mention judge reads it as needing nothing", async () => {
  const order = "Chamado #812 (checkout), responsável: @ops";
  f = await setup({
    handOff: true,
    judge: (kind) => (kind === "mention_needs_nothing" ? 1 : undefined),
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["Vendo o #812."] };
      if (seen(req).includes("Posted.")) return { chunks: ["Chamei o ops."] };
      return { chunks: [], toolUses: [{ name: "hand_off", input: { message: order } }] };
    },
  });
  const ops = await opsInGeneral();
  const routine = await channelRoutine(f, { prompt: "Revise os chamados da noite.", access: "act" });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [posted] = await messagesIn(f, f.general.id);
  const opsRuns = (await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === ops.id);
  expect(opsRuns.map((r) => r.triggerMessageId)).toEqual([posted?.id as string]);
});

test("a routine set to act whose creator is gone says it couldn't call the agent, not that it only looks", async () => {
  const order = "@ops investiga o checkout.";
  f = await setup({
    handOff: true,
    judge: (kind) => (kind === "mention_needs_nothing" ? 0 : undefined),
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["Nobody should have run."] };
      if (seen(req).includes("Posted.")) return { chunks: ["Chamei o ops."] };
      return { chunks: [], toolUses: [{ name: "hand_off", input: { message: order } }] };
    },
  });
  const ops = await opsInGeneral();
  const routine = await channelRoutine(f, { prompt: "Revise os chamados da noite.", access: "act" });
  // The creator's account goes away between the routine's post and its handling: the brief keeps no creator.
  const posted = f.handlers["message.posted"];
  if (!posted) throw new Error("no message.posted handler");
  const handlers = {
    ...f.handlers,
    "message.posted": async (...args: Parameters<typeof posted>) => {
      for (const m of await f.db.select().from(schema.messages)) {
        const brief = m.meta.routineBrief as Record<string, unknown> | undefined;
        if (brief?.creatorUserId)
          await f.db
            .update(schema.messages)
            .set({ meta: { ...m.meta, routineBrief: { ...brief, creatorUserId: null } } })
            .where(eq(schema.messages.id, m.id));
      }
      return posted(...args);
    },
  };
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, handlers);

  const general = await messagesIn(f, f.general.id);
  expect((await f.db.select().from(schema.agentRuns)).filter((r) => r.agentId === ops.id)).toEqual([]);
  const reach = reachOf(general[0]?.meta);
  expect(reach.map((e) => [e.handle, e.reason, e.routinePost ?? false, e.routine?.access])).toEqual([
    ["ops", "routine_creator_reach", false, "act"],
  ]);
  expect(reachNote(reach)).not.toContain("only look and tell");
});

test("an always routine that ends without hand_off never posts its record as-is: the agent tells the people", async () => {
  const record = "Checado: primeira rodada, nada para comparar com execuções anteriores.";
  f = await setup({
    handOff: true,
    reply: (req) => (isRoutine(req) ? { chunks: [record] } : { chunks: ["Bom dia! Que a sua segunda comece leve."] }),
  });
  const routine = await channelRoutine(f, { prompt: "Me dê um bom dia.", report: "always" });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const general = await messagesIn(f, f.general.id);
  expect(general.filter((m) => !m.meta.notice).map((m) => m.body)).toEqual(["Bom dia! Que a sua segunda comece leve."]);
});
