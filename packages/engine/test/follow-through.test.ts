import { afterEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText, textOf } from "@agenteschat/providers";
import {
  askAgentToImplement,
  CANCEL_FOLLOW_UP_TOOL,
  cancelFollowUp,
  createIssue,
  drainOutbox,
  FOLLOW_UP_JOB,
  FOLLOW_UP_TOOL,
  invokeToolForRun,
  joinChannel,
  listIssueActivity,
  NOTICE_WAKE_MAX_HOP,
  postPersonMessage,
  promiseIn,
  removeChannelMember,
  runAuthority,
  toolPolicy,
  wakeFollowUp,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/**
 * Agents follow through (ADR 0037, round 3): a promise nothing keeps gets one judge call and one more turn,
 * never two; a person's go-ahead they wait for is no unkept promise, nor is one that something the run set up
 * keeps; `follow_up` posts its line, wakes the agent in the same conversation at its time for the same person,
 * and keeps its bounds; a canceled one, or one whose agent or person left the conversation, wakes nobody.
 */

let f: Fixture;
afterEach(async () => {
  // A test without a database leaves the last one's: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastUserText = (request: ModelRequest) => {
  const last = request.messages.at(-1);
  return last ? textOf(last.content) : "";
};

const followThroughCalls = (fx: Fixture) =>
  (fx.context.judge as unknown as { calls: { kind: string }[] }).calls.filter((c) => c.kind === "follow_through");

const agentMessages = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(schema.messages.createdAt)).filter(
    (m) => m.authorType === "agent" && !m.meta.notice,
  );

const ask = (fx: Fixture, body: string, threadId?: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body,
    ...(threadId ? { threadId } : {}),
  });

test("a promise nothing keeps: the answer posts, one more turn is told to keep it, and never a second", async () => {
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "unkept" : undefined),
    reply: (_request, call) => ({
      chunks: [
        call === 1
          ? "O job de testes ainda está rodando. Vou checar de novo daqui a pouco e te passo os números."
          : "Ainda rodando: vou checar de novo depois.",
      ],
    }),
  });
  await ask(f, "@dev o ci demora tanto assim?");
  await drainOutbox(f.db, f.handlers);

  expect(f.provider.calls.length).toBe(2);
  const nudge = lastUserText(f.provider.calls[1]?.request as ModelRequest);
  expect(nudge).toContain("You ended with a promise nothing keeps");
  expect(nudge).toContain("Vou checar de novo daqui a pouco e te passo os números.");
  // Asked once: the second promise ends the run.
  expect(followThroughCalls(f).length).toBe(1);
  const steps = await f.db.select().from(schema.agentRunSteps);
  expect(steps.filter((s) => s.data.nudged === "promise").length).toBe(1);
  expect((await agentMessages(f)).map((m) => m.body)).toEqual([
    "O job de testes ainda está rodando. Vou checar de novo daqui a pouco e te passo os números.",
    "Ainda rodando: vou checar de novo depois.",
  ]);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
});

test("waiting on a person for something specific is legitimate: no nudge", async () => {
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "waiting" : undefined),
    reply: () => ({ chunks: ["Assim que você me mandar o token do Sentry, vou configurar o alerta."] }),
  });
  await ask(f, "@dev configura o alerta do Sentry");
  await drainOutbox(f.db, f.handlers);
  expect(followThroughCalls(f).length).toBe(1);
  expect(f.provider.calls.length).toBe(1);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
});

test("a plain answer asks no judge; only a promise at the end of the message counts", async () => {
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "unkept" : undefined),
    reply: () => ({ chunks: ["O CI levou 12 minutos: testes 9, lint 2. Nada fora do normal."] }),
  });
  await ask(f, "@dev o ci demora tanto assim?");
  await drainOutbox(f.db, f.handlers);
  expect(followThroughCalls(f).length).toBe(0);
  expect(f.provider.calls.length).toBe(1);
});

test("promises of later work by the agent, in English, Portuguese and Spanish; other future words aren't", () => {
  expect(promiseIn("When you approve, I'll give you the numbers and say if any job is slower.")).toBe(
    "When you approve, I'll give you the numbers and say if any job is slower.",
  );
  expect(promiseIn("Pronto. Quando terminar eu aviso.")).toBe("Quando terminar eu aviso.");
  for (const said of [
    "Let me check the CI logs.",
    "Let me look into that and get back to you.",
    "One moment, checking now.",
    "The build is still running. I'll keep an eye on it.",
  ])
    expect(promiseIn(said)).not.toBeNull();
  for (const said of ["Deixa eu ver os logs do CI.", "Já volto com os números.", "Vou rodar os testes de novo."])
    expect(promiseIn(said)).not.toBeNull();
  for (const said of ["Déjame revisar el log.", "Voy a revisar el pipeline y te cuento."])
    expect(promiseIn(said)).not.toBeNull();
  // Future words that promise no later work: no judge call.
  for (const said of [
    "Okay. I'll be honest: the CI took 12 minutes, which is normal.",
    "I'll keep it short: tests 9 min, lint 2.",
    "Vou ser direto: o CI levou 12 minutos, normal.",
    "Let me know if you want the per-job times.",
    `I'll explain. ${"Tests took 9 min. ".repeat(60)}All green.`,
  ])
    expect(promiseIn(said)).toBeNull();
});

test("the prompt asks to finish what it starts, and names follow_up only when the run has it", async () => {
  f = await setup({ followUps: true, reply: () => ({ chunks: ["ok"] }) });
  await ask(f, "@dev oi");
  await drainOutbox(f.db, f.handlers);
  const withTool = systemText(f.provider.calls[0]?.request.system ?? []);
  expect(withTool).toContain("Finish what you start.");
  expect(withTool).toContain("set a follow_up to come back to it");
  expect(withTool).toContain("After a person approves or answers what you waited on, go on with the task at once");
  await f.close();

  f = await setup({ react: true, reply: () => ({ chunks: ["ok"] }) });
  await ask(f, "@dev oi");
  await drainOutbox(f.db, f.handlers);
  const without = systemText(f.provider.calls[0]?.request.system ?? []);
  expect(without).toContain("Finish what you start.");
  expect(without).not.toContain("follow_up");
});

test("follow_up: a line now; at its time the agent wakes in the same thread with its note, for the same person", async () => {
  f = await setup({
    followUps: true,
    // A promise kept by the follow-up just set: nothing to nudge.
    judge: (kind) => (kind === "follow_through" ? "unkept" : undefined),
    reply: (_request, call) =>
      call === 1
        ? {
            chunks: ["O CI ainda está rodando."],
            toolUses: [
              {
                name: FOLLOW_UP_TOOL,
                input: { minutes: 30, note: "Check CI run 42 and give the per-job times.", about: "ver o CI" },
              },
            ],
          }
        : call === 2
          ? { chunks: ["Ainda rodando. Volto em 30 minutos para ver o CI."] }
          : { chunks: ["Terminou: testes 9 min, lint 2 min."] },
  });
  const root = await ask(f, "Deploy de hoje");
  await ask(f, "@dev o CI terminou?", root.id);
  await drainOutbox(f.db, f.handlers);

  const [first] = await f.db.select().from(schema.agentRuns);
  const lines = (await f.db.select().from(schema.messages)).filter(
    (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "follow_up",
  );
  expect(lines.length).toBe(1);
  const line = lines[0];
  expect(line?.threadId).toBe(root.id);
  expect(line?.meta.notice).toMatchObject({
    kind: "follow_up",
    text: "Check CI run 42 and give the per-job times.",
    refs: { runId: first?.id, about: "ver o CI", state: "pending" },
  });
  const [job] = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, FOLLOW_UP_JOB));
  expect(job?.status).toBe("pending");
  const ahead = (job?.nextAttemptAt.getTime() ?? 0) - Date.now();
  expect(ahead).toBeGreaterThan(29 * 60_000);
  expect(ahead).toBeLessThanOrEqual(30 * 60_000);
  // The follow-up keeps the promise: no judge call, no nudge.
  expect(followThroughCalls(f).length).toBe(0);
  expect(f.provider.calls.length).toBe(2);

  // Its time comes.
  await f.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date() })
    .where(eq(schema.outbox.id, job?.id ?? ""));
  await drainOutbox(f.db, f.handlers);

  const runs = await f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
  expect(runs.length).toBe(2);
  const woken = runs[1];
  const [trigger] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, woken?.triggerMessageId ?? ""));
  expect(trigger?.threadId).toBe(root.id);
  expect(trigger?.meta.notice).toMatchObject({ kind: "follow_up", refs: { wake: "1", followUpId: line?.id } });
  expect(woken?.status).toBe("done");
  if (!woken) throw new Error("no woken run");
  expect(await runAuthority(f.db, woken)).toEqual({ kind: "person", personId: f.owner.id });
  // It read its note as the current message, with what to do now.
  const read = lastUserText(f.provider.calls[2]?.request as ModelRequest);
  expect(read).toContain("Check CI run 42 and give the per-job times.");
  expect(read).toContain("Do what you came back for now");
  const answer = (await agentMessages(f)).at(-1);
  expect(answer?.body).toBe("Terminou: testes 9 min, lint 2 min.");
  expect(answer?.threadId).toBe(root.id);
  const [settled] = await f.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, line?.id ?? ""));
  expect(settled?.meta.notice).toMatchObject({ refs: { state: "done" } });
  // The lines notify nobody: the reply they bring does.
  const notified = (await f.db.select().from(schema.notifications)).map((n) => n.source.messageId);
  expect(notified).not.toContain(line?.id);
  expect(notified).not.toContain(trigger?.id);
  expect(notified).toContain(answer?.id);
});

test("follow_up bounds: a day ahead at most, two per run, three per conversation, none past the chain's cap", async () => {
  f = await setup({ followUps: true });
  await ask(f, "@dev acompanha o deploy");
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const deps = { db: f.db, pubsub: f.pubsub, tools: f.tools };
  let n = 0;
  const call = (runId: string, input: Record<string, unknown>) =>
    invokeToolForRun(
      deps,
      { orgId: f.org.id, agentId: f.agent.id, runId, machineId: "" },
      {
        id: `fu-${++n}`,
        name: FOLLOW_UP_TOOL,
        input: { note: "Check the deploy.", about: "ver o deploy", ...input },
      },
    );

  expect((await call(run.id, { minutes: 25 * 60 })).result).toMatchObject({ isError: true });
  expect((await call(run.id, { at: new Date(Date.now() + 25 * 3600_000).toISOString() })).result.content).toContain(
    "At most 24 hours ahead",
  );
  expect((await call(run.id, { at: new Date(Date.now() - 60_000).toISOString() })).result.isError).toBe(true);
  expect((await call(run.id, {})).result.isError).toBe(true);
  // A time without its offset would be read in the server's zone, not the person's: refused, a bare date too.
  const local = new Date(Date.now() + 3600_000).toISOString().slice(0, 19);
  expect((await call(run.id, { at: local })).result.content).toContain("offset");
  expect((await call(run.id, { at: local.slice(0, 10) })).result.content).toContain("offset");
  expect((await call(run.id, { minutes: 10 })).result.isError).toBeUndefined();
  expect((await call(run.id, { at: new Date(Date.now() + 3600_000).toISOString() })).result.isError).toBeUndefined();
  expect((await call(run.id, { minutes: 20 })).result.content).toContain("already set 2 follow-ups");

  // Another run of the agent in the same conversation (the channel's timeline): one more fits, then it is full.
  const later = await ask(f, "e o de staging?");
  const [other] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: later.id,
      triggerMessageId: later.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!other) throw new Error("no run");
  expect((await call(other.id, { minutes: 5 })).result.isError).toBeUndefined();
  expect((await call(other.id, { minutes: 6 })).result.content).toContain("3 follow-ups already wait");

  // Each follow-up wakes a run one hop further: at the cap there is no more coming back.
  await f.db.update(schema.agentRuns).set({ hop: NOTICE_WAKE_MAX_HOP }).where(eq(schema.agentRuns.id, other.id));
  expect((await call(other.id, { minutes: 5 })).result.content).toContain("No more follow-ups from here");

  // A routine's background work runs again on its own schedule: no follow-ups there.
  const tool = { name: FOLLOW_UP_TOOL, scope: "" };
  expect(toolPolicy({ kind: "routine", personId: null, brief: null }, tool).action).toBe("refuse");
  expect(toolPolicy({ kind: "person", personId: f.owner.id }, tool).action).toBe("allow");
});

test("canceled by the agent or by a person, a follow-up wakes nobody; a second cancel is refused", async () => {
  f = await setup({ followUps: true });
  await ask(f, "@dev me avisa quando o deploy terminar");
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const deps = { db: f.db, pubsub: f.pubsub, tools: f.tools };
  const id = { orgId: f.org.id, agentId: f.agent.id, runId: run.id, machineId: "" };
  const set = async (minutes: number) => {
    const out = await invokeToolForRun(deps, id, {
      id: `fu-${minutes}`,
      name: FOLLOW_UP_TOOL,
      input: { minutes, note: "Check the deploy.", about: "ver o deploy" },
    });
    return out.result.content.match(/Follow-up (\S+) set/)?.[1] ?? "";
  };
  const byAgent = await set(10);
  const byPerson = await set(20);

  const canceled = await invokeToolForRun(deps, id, { id: "c-1", name: CANCEL_FOLLOW_UP_TOOL, input: { id: byAgent } });
  expect(canceled.result.content).toBe("Canceled 1 follow-up.");
  await cancelFollowUp({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, byPerson);
  await expect(cancelFollowUp({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, byPerson)).rejects.toMatchObject({
    code: "follow_up.not_pending",
  });
  const states = (await f.db.select().from(schema.messages))
    .filter((m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "follow_up")
    .map((m) => (m.meta.notice as { refs: { state: string; canceledBy?: string } }).refs);
  expect(states).toEqual(
    expect.arrayContaining([
      {
        runId: run.id,
        at: expect.any(String),
        about: "ver o deploy",
        state: "canceled",
        personId: f.owner.id,
        canceledBy: `agent:${f.agent.id}`,
      },
      {
        runId: run.id,
        at: expect.any(String),
        about: "ver o deploy",
        state: "canceled",
        personId: f.owner.id,
        canceledBy: f.owner.id,
      },
    ]),
  );

  // Their time comes: nothing is delivered and no run starts.
  await f.db.update(schema.outbox).set({ nextAttemptAt: new Date() }).where(eq(schema.outbox.kind, FOLLOW_UP_JOB));
  await drainOutbox(f.db, f.handlers);
  const wakes = (await f.db.select().from(schema.messages)).filter(
    (m) => (m.meta.notice as { refs?: { wake?: string } } | undefined)?.refs?.wake,
  );
  expect(wakes).toEqual([]);
  const runs = await f.db
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.orgId, f.org.id), eq(schema.agentRuns.agentId, f.agent.id)));
  expect(runs.length).toBe(1);
});

/** Sets a follow-up from a run, as its tool call would. Returns the line's id. */
async function setFollowUp(fx: Fixture, runId: string, minutes: number) {
  const out = await invokeToolForRun(
    { db: fx.db, pubsub: fx.pubsub, tools: fx.tools },
    { orgId: fx.org.id, agentId: fx.agent.id, runId, machineId: "" },
    {
      id: `fu-${runId}-${minutes}`,
      name: FOLLOW_UP_TOOL,
      input: { minutes, note: "Check the deploy.", about: "ver o deploy" },
    },
  );
  return out.result.content.match(/Follow-up (\S+) set/)?.[1] ?? "";
}

const lineState = async (fx: Fixture, id: string) => {
  const [line] = await fx.db.select().from(schema.messages).where(eq(schema.messages.id, id));
  return (line?.meta.notice as { refs?: { state?: string } } | undefined)?.refs?.state;
};

test("at its time, an agent no longer in the conversation, or for a person who left it, wakes nobody", async () => {
  f = await setup({ followUps: true });
  await ask(f, "@dev acompanha o deploy");
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const forPerson = await setFollowUp(f, run.id, 10);
  const forAgent = await setFollowUp(f, run.id, 20);

  // The person who asked left the channel.
  await removeChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: f.owner.id });
  expect(await wakeFollowUp({ db: f.db, pubsub: f.pubsub }, f.org.id, forPerson)).toBeNull();
  expect(await lineState(f, forPerson)).toBe("canceled");

  // Back in it, but the agent was removed.
  await joinChannel(f.db, f.owner.id, f.org.id, f.general.id);
  await removeChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: f.agent.id });
  expect(await wakeFollowUp({ db: f.db, pubsub: f.pubsub }, f.org.id, forAgent)).toBeNull();
  expect(await lineState(f, forAgent)).toBe("canceled");
  expect((await f.db.select().from(schema.agentRuns)).length).toBe(1);
});

test("in a channel's timeline the follow-ups are each person's: cancel_follow_up and the limit count only theirs", async () => {
  f = await setup({ followUps: true });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await joinChannel(f.db, bia.id, f.org.id, f.general.id);
  // One run each (a message while the agent works in the timeline joins its run there).
  await ask(f, "@dev acompanha o deploy");
  await drainOutbox(f.db, f.handlers);
  await ask(f, "@dev e o de staging?");
  await drainOutbox(f.db, f.handlers);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
    body: "@dev me avisa do build",
  });
  await drainOutbox(f.db, f.handlers);
  const [ana1, ana2, biaRun] = await f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
  if (!ana1 || !ana2 || !biaRun) throw new Error("no runs");
  await setFollowUp(f, ana1.id, 10);
  await setFollowUp(f, ana1.id, 11);
  const anaThird = await setFollowUp(f, ana2.id, 12);
  expect(anaThird).not.toBe("");
  // Ana's three fill her conversation with @dev here; Bia's is her own.
  const biaLine = await setFollowUp(f, biaRun.id, 13);
  expect(biaLine).not.toBe("");

  const canceled = await invokeToolForRun(
    { db: f.db, pubsub: f.pubsub, tools: f.tools },
    { orgId: f.org.id, agentId: f.agent.id, runId: biaRun.id, machineId: "" },
    { id: "c-bia", name: CANCEL_FOLLOW_UP_TOOL, input: {} },
  );
  expect(canceled.result.content).toBe("Canceled 1 follow-up.");
  expect(await lineState(f, biaLine)).toBe("canceled");
  expect(await lineState(f, anaThird)).toBe("pending");
});

test("a reminder it set to do the work itself keeps the promise: no judge, no nudge", async () => {
  f = await setup({
    scheduleTools: true,
    judge: (kind) => (kind === "follow_through" ? "unkept" : undefined),
    reply: (request) =>
      JSON.stringify(request.messages.at(-1)?.content).includes("tool_result")
        ? { chunks: ["Agendado: daqui a 2 horas eu confiro o deploy e te passo como ficou."] }
        : {
            chunks: [],
            toolUses: [
              {
                name: "schedule_reminder",
                input: { when: "em 2 horas", message: "verifique o deploy e conte aqui", ask_agent: true },
              },
            ],
          },
  });
  await ask(f, "@dev daqui a 2 horas verifica o deploy");
  await drainOutbox(f.db, f.handlers);
  expect(followThroughCalls(f).length).toBe(0);
  expect(f.provider.calls.length).toBe(2);
});

test("asked to implement an issue: an answer posted before a nudge is a comment there too", async () => {
  const first = "Fixed in PR #7. CI is running: I'll check it once it finishes.";
  const second = "CI passed: PR #7 is ready to merge.";
  f = await setup({
    judge: (kind) => (kind === "follow_through" ? "unkept" : undefined),
    reply: (_request, call) => ({ chunks: [call === 1 ? first : second] }),
  });
  const deps = { db: f.db, pubsub: f.pubsub };
  const person = { type: "person" as const, userId: f.owner.id };
  const issue = await createIssue(deps, person, f.org.id, { title: "Login breaks on Safari" });
  await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id);
  await drainOutbox(f.db, f.handlers);
  const comments = (await listIssueActivity(f.db, person, f.org.id, issue.id)).filter((a) => a.kind === "comment");
  expect(comments.map((a) => a.text)).toEqual([first, second]);
});
