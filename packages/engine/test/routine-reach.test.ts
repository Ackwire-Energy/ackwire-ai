import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText } from "@agenteschat/providers";
import {
  addChannelMember,
  createAgent,
  createChannel,
  drainOutbox,
  grantScopes,
  openDm,
  runRoutineNow,
  STRETCH,
  STRETCH_REFUSAL,
  stretchCardOf,
} from "../src";
import { REFUSALS } from "../src/tools/run-policy";
import { addMember, type Fixture, setup } from "./fixtures";
import { briefs, channelRoutine, fire, messagesIn, routineDeps } from "./routine-fixtures";
import { fakeGithub } from "./tool-fixtures";

/**
 * A routine set to act reaches other agents and posts where its creator can (ADR 0053 §2, amended 2026-10-31):
 * `tell_agent`, `ask_agent`, `post_message` (an @mention there wakes the agent) and `send_dm` to its creator. One
 * that only looks and tells is refused with why. What a routine's run starts counts as work nobody asked for in
 * its stretch (ADR 0089), and its cards and the answers it gets go where it reports, never to its room.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

/** A routine's background run is the one offered `hand_off`. */
const isRoutine = (req: ModelRequest) => (req.tools ?? []).some((t) => t.name === "hand_off");
const inAgentDm = (req: ModelRequest) => systemText(req.system).includes("A private conversation between agents");
const isFor = (req: ModelRequest, name: string, handle: string) =>
  systemText(req.system).includes(`You are ${name} (@${handle})`);
const seen = (req: ModelRequest) => JSON.stringify(req.messages);
const NO_ROUTE = { chunks: ['{"needs_agent":0,"scores":[],"reason":"none"}'] };

/** An agent of #general. */
async function agentIn(fx: Fixture, name: string, handle: string) {
  const agent = await createAgent(
    fx.db,
    fx.owner.id,
    fx.org.id,
    { name, handle, role: "Developer", credentialId: fx.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await fx.db.insert(schema.channelMembers).values({ orgId: fx.org.id, channelId: fx.general.id, agentId: agent.id });
  return agent;
}

/** The routine run's model: `calls` on its first turn, then `done`. */
const routineTurn = (req: ModelRequest, calls: { name: string; input: Record<string, unknown> }[], done: string) =>
  seen(req).includes("tool_result") ? { chunks: [done] } : { chunks: [], toolUses: calls };

const runsOf = (fx: Fixture) => fx.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
const cardsOf = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(asc(schema.messages.createdAt))).filter((m) =>
    stretchCardOf(m.meta),
  );

test("a routine set to act tells another agent: it wakes, and its reply reaches where the routine reports", async () => {
  f = await setup({
    handOff: true,
    askAgent: true,
    judge: (kind) => (kind === "note_reply" ? 0.9 : undefined),
    reply: (req) => {
      if (req.outputSchema) return NO_ROUTE;
      if (isRoutine(req))
        return routineTurn(
          req,
          [{ name: "tell_agent", input: { agent: "@iris", message: "O PR #42 já está pronto? Preciso dele hoje." } }],
          "Cobrei a Iris sobre o PR #42.",
        );
      if (inAgentDm(req)) return { chunks: ["Ainda não: faltam dois testes, termino em 1 hora."] };
      return { chunks: ["A Iris respondeu: faltam dois testes, termina em 1 hora."] };
    },
  });
  const iris = await agentIn(f, "Iris", "iris");
  const routine = await channelRoutine(f, { access: "act", prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [brief] = await briefs(f);
  if (!brief) throw new Error("the routine didn't fire");
  const [background, note, told] = await runsOf(f);
  // The routine's run, Iris's run on the note in the agents' DM, and the agent where the routine reports.
  expect([background, note, told].map((r) => [r?.agentId, r?.background, r?.hop, r?.status])).toEqual([
    [f.agent.id, true, 1, "done"],
    [iris.id, false, 2, "done"],
    [f.agent.id, false, 2, "done"],
  ]);
  // All of it in the routine's stretch: what it starts counts against its limits.
  expect([background, note, told].every((r) => r?.stretchId === brief.id)).toBe(true);
  const [dm] = await f.db
    .select()
    .from(schema.channels)
    .where(eq(schema.channels.id, note?.channelId ?? ""));
  expect(dm?.dmKey).toContain(`a:${iris.id}`);
  const [sent] = await messagesIn(f, dm?.id ?? "");
  expect(sent).toMatchObject({
    authorAgentId: f.agent.id,
    agentRunId: background?.id,
    body: "O PR #42 já está pronto? Preciso dele hoje.",
    meta: { agentNote: { runId: background?.id } },
  });
  // Iris's reply woke the agent where the routine reports, not in the routine's room (nobody reads it).
  expect(told?.channelId).toBe(f.general.id);
  const general = await messagesIn(f, f.general.id);
  expect(general.map((m) => [m.authorAgentId, (m.meta.notice as { kind?: string } | undefined)?.kind ?? null])).toEqual(
    [
      [f.agent.id, "agent_note"],
      [f.agent.id, null],
    ],
  );
  expect(general[0]?.meta.notice).toMatchObject({ from: "@iris", text: expect.stringContaining("faltam dois testes") });
  expect((await messagesIn(f, brief.channelId)).map((m) => m.id)).toEqual([brief.id]);
  // Its routine block says what it may reach.
  const asked = f.provider.calls.map((c) => c.request).find(isRoutine);
  expect(JSON.stringify(asked)).toContain("tell_agent leaves an agent a note");
});

test("a routine that only looks and tells can't reach other agents or post, and its run is told why", async () => {
  const results: string[] = [];
  f = await setup({
    handOff: true,
    askAgent: true,
    chatTools: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["ok"] };
      if (seen(req).includes("tool_result")) results.push(seen(req));
      return routineTurn(
        req,
        [
          { name: "tell_agent", input: { agent: "@iris", message: "O PR #42 já está pronto?" } },
          { name: "post_message", input: { channel: "general", text: "@iris o PR #42 já está pronto?" } },
        ],
        "Não consegui cobrar a Iris.",
      );
    },
  });
  await agentIn(f, "Iris", "iris");
  const routine = await channelRoutine(f, { prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  // Not offered, and refused with the reason when called anyway.
  const offered = f.provider.calls.map((c) => c.request).find(isRoutine);
  const names = (offered?.tools ?? []).map((t) => t.name);
  for (const name of ["tell_agent", "ask_agent", "post_message", "send_dm"]) expect(names).not.toContain(name);
  expect(JSON.stringify(offered)).toContain("don't post, send DMs, react");
  expect(JSON.stringify(offered)).not.toContain("tell_agent leaves an agent a note");
  expect(results[0]?.split(REFUSALS.routineReachReadOnly).length).toBe(3);
  // Nobody woke, and nothing was posted.
  expect((await runsOf(f)).map((r) => r.background)).toEqual([true]);
  expect(await messagesIn(f, f.general.id)).toEqual([]);
});

test("a routine posts only where its creator can post, and writes in a DM only to its creator; its @mention wakes the agent", async () => {
  const results: string[] = [];
  f = await setup({
    handOff: true,
    chatTools: true,
    judge: (kind) => (kind === "mention_handoff" ? 0.9 : undefined),
    reply: (req) => {
      if (req.outputSchema) return NO_ROUTE;
      if (isRoutine(req)) {
        if (seen(req).includes("tool_result")) results.push(seen(req));
        return routineTurn(
          req,
          [
            { name: "post_message", input: { channel: "vendas", text: "@iris o PR #42 já está pronto?" } },
            { name: "post_message", input: { channel: "dev", text: "@iris o PR #42 já está pronto?" } },
            { name: "send_dm", input: { person: "bob", text: "A Iris ainda não terminou o PR #42." } },
            { name: "send_dm", input: { person: "ana", text: "Cobrei a Iris no #dev sobre o PR #42." } },
          ],
          "Cobrei a Iris no #dev.",
        );
      }
      return { chunks: ["Ainda não: faltam dois testes."] };
    },
  });
  const iris = await agentIn(f, "Iris", "iris");
  // Iris answers only Ana, its owner: her routine's @mention wakes it.
  await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, iris.id));
  const bob = await addMember(f.db, f.org.id, "member", "bob");
  // #dev: Ana and Iris are in it. #vendas: Bob's, Ana isn't in it.
  const dev = await createChannel(f.db, f.owner.id, f.org.id, { name: "dev" });
  await addChannelMember(f.db, f.owner.id, f.org.id, dev.id, { agentId: iris.id });
  const vendas = await createChannel(f.db, bob.id, f.org.id, { name: "vendas" });
  const routine = await channelRoutine(f, { access: "act", prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  expect(results[0]).toContain("No channel #vendas that this routine's creator can post in.");
  expect(results[0]).toContain("sends a DM only to the person who set it up");
  expect(await messagesIn(f, vendas.id)).toEqual([]);
  const [background, woken] = await runsOf(f);
  const posted = await messagesIn(f, dev.id);
  expect(posted.map((m) => [m.authorAgentId, m.body])).toEqual([
    [f.agent.id, "@iris o PR #42 já está pronto?"],
    [iris.id, "Ainda não: faltam dois testes."],
  ]);
  expect(posted[0]).toMatchObject({ agentRunId: background?.id, hop: 1, mentionedAgentIds: [iris.id] });
  expect(woken).toMatchObject({ agentId: iris.id, channelId: dev.id, hop: 2, stretchId: background?.stretchId });
  // Its creator's DM with the agent, and nobody else's.
  const anaDm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  expect((await messagesIn(f, anaDm.id)).map((m) => m.body)).toEqual(["Cobrei a Iris no #dev sobre o PR #42."]);
  const bobDms = (await f.db.select().from(schema.channelMembers)).filter((m) => m.userId === bob.id);
  expect(bobDms.map((m) => m.channelId)).toEqual([vendas.id]);
});

test("a routine wakes only agents its creator can talk to", async () => {
  const results: string[] = [];
  f = await setup({
    handOff: true,
    askAgent: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["Ainda não."] };
      if (seen(req).includes("tool_result")) results.push(seen(req));
      return routineTurn(
        req,
        [{ name: "tell_agent", input: { agent: "@iris", message: "O PR #42 já está pronto?" } }],
        "ok",
      );
    },
  });
  const iris = await agentIn(f, "Iris", "iris");
  const bob = await addMember(f.db, f.org.id, "member", "bob");
  // Iris works only with Bob, its owner.
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: bob.id, audienceMode: "owner" })
    .where(eq(schema.agents.id, iris.id));
  const routine = await channelRoutine(f, { access: "act", prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await fire(f, routine.id, new Date(Date.now() - 60_000));
  await drainOutbox(f.db, f.handlers);
  expect(results[0]).toContain("@iris only works with some people");
  expect((await runsOf(f)).filter((r) => r.agentId === iris.id)).toEqual([]);

  // Bob lets Ana talk to Iris: her routine reaches it.
  await f.db
    .update(schema.agents)
    .set({ audienceMode: "people", audienceUserIds: [f.owner.id] })
    .where(eq(schema.agents.id, iris.id));
  await fire(f, routine.id, new Date());
  await drainOutbox(f.db, f.handlers);
  expect(results[1]).toContain("Told @iris");
  expect((await runsOf(f)).filter((r) => r.agentId === iris.id).map((r) => r.status)).toEqual(["done"]);
});

test("a consulted agent's approval for a routine's question shows where the routine reports", async () => {
  const github = fakeGithub();
  const WHY = "The PR #42 is stale and its branch was replaced by #57: closing it keeps the queue honest.";
  f = await setup({
    handOff: true,
    askAgent: true,
    toolSources: [github.source],
    reply: (req) => {
      if (req.outputSchema) return NO_ROUTE;
      if (isRoutine(req))
        return routineTurn(
          req,
          [
            {
              name: "ask_agent",
              input: { agent: "@iris", question: "Pode fechar o PR #42, que foi trocado pelo #57?" },
            },
          ],
          "Pedi à Iris para fechar o PR #42.",
        );
      return seen(req).includes("tool_result")
        ? { chunks: ["Fechado."] }
        : { chunks: [], toolUses: [{ name: "github_close_pr", input: { repo: "acme/app", pr: 42, why: WHY } }] };
    },
  });
  const iris = await agentIn(f, "Iris", "iris");
  await grantScopes(f.db, f.org.id, iris.id, [{ connectionId: null, scope: "github:pr.write" }]);
  const routine = await channelRoutine(f, { access: "act", prompt: "Cuide da fila de PRs." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);

  const [approval] = await f.db.select().from(schema.approvals);
  expect(approval).toMatchObject({ agentId: iris.id, channelId: f.general.id, status: "pending", why: WHY });
  const card = (await messagesIn(f, f.general.id)).find((m) => m.meta.approvalId === approval?.id);
  expect(card).toMatchObject({ authorAgentId: iris.id, threadId: null });
  expect(github.executed).toEqual([]);
});

/** Iris and Dev hand the work back to each other forever. */
const pingPong = (req: ModelRequest) => {
  if (req.outputSchema) return NO_ROUTE;
  if (isRoutine(req))
    return routineTurn(
      req,
      [{ name: "post_message", input: { channel: "dev", text: "@iris o PR #42 já está pronto?" } }],
      "Cobrei a Iris.",
    );
  return {
    chunks: [isFor(req, "Iris", "iris") ? "@dev ainda não: revisa os testes?" : "@iris revisei: corrige o lint?"],
  };
};

test("loops stay held: agents a routine's post set off stop at the limit of work nobody asked for, with one card for its creator", async () => {
  f = await setup({
    handOff: true,
    chatTools: true,
    judge: (kind) => (kind === "mention_handoff" ? 0.9 : undefined),
    reply: pingPong,
  });
  const iris = await agentIn(f, "Iris", "iris");
  const dev = await createChannel(f.db, f.owner.id, f.org.id, { name: "dev" });
  for (const agentId of [iris.id, f.agent.id]) await addChannelMember(f.db, f.owner.id, f.org.id, dev.id, { agentId });
  const routine = await channelRoutine(f, { access: "act", prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers, { maxBatches: 2000 });

  const [brief] = await briefs(f);
  const runs = await runsOf(f);
  expect(runs.filter((r) => r.hop >= 2).length).toBe(STRETCH.unattendedRuns);
  expect(runs.every((r) => r.stretchId === brief?.id && r.status === "done")).toBe(true);
  const [card, ...more] = await cardsOf(f);
  expect(more).toEqual([]);
  expect(card?.channelId).toBe(dev.id);
  expect(card?.meta.actionCard).toMatchObject({
    reason: "runs",
    limit: STRETCH.unattendedRuns,
    forUserId: f.owner.id,
  });
  const told = await f.db.select().from(schema.notifications);
  expect(told.some((n) => n.userId === f.owner.id && n.source.messageId === card?.id)).toBe(true);
});

test("a routine's tell_agent at the limit is refused, and the card goes where the routine reports", async () => {
  const results: string[] = [];
  f = await setup({
    handOff: true,
    askAgent: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["ok"] };
      if (seen(req).includes("tool_result")) results.push(seen(req));
      return routineTurn(
        req,
        [{ name: "tell_agent", input: { agent: "@iris", message: "O PR #42 já está pronto?" } }],
        "ok",
      );
    },
  });
  const iris = await agentIn(f, "Iris", "iris");
  const routine = await channelRoutine(f, { access: "act", prompt: "Cobre a Iris até o PR #42 ficar pronto." });
  await fire(f, routine.id, new Date());
  const [brief] = await briefs(f);
  if (!brief) throw new Error("the routine didn't fire");
  // The routine's work already started as many runs as work nobody asked for may.
  await f.db.insert(schema.agentRuns).values(
    Array.from({ length: STRETCH.unattendedRuns }, () => ({
      orgId: f.org.id,
      agentId: iris.id,
      channelId: f.general.id,
      threadRootId: brief.id,
      triggerMessageId: Bun.randomUUIDv7(),
      trigger: "mention" as const,
      hop: 2,
      stretchId: brief.id,
      status: "done" as const,
    })),
  );
  await drainOutbox(f.db, f.handlers);

  expect(results[0]?.split(STRETCH_REFUSAL).length).toBe(2);
  const [card] = await cardsOf(f);
  expect(card?.channelId).toBe(f.general.id);
  expect(card?.meta.actionCard).toMatchObject({ limit: STRETCH.unattendedRuns, forUserId: f.owner.id });
  expect((await runsOf(f)).filter((r) => r.agentId === iris.id && r.status !== "done")).toEqual([]);
});
