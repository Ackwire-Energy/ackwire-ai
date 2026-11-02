import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  type AgentRun,
  addChannelMember,
  cancelRun,
  checkInWork,
  continueRun,
  createAgent,
  createIssue,
  createJobHandlers,
  drainOutbox,
  endWork,
  invokeToolForRun,
  listIssues,
  loadAgentStatuses,
  moveToBackground,
  openDm,
  POST_UPDATE_TOOL,
  postPersonMessage,
  postWorkUpdate,
  reconcileWorks,
  STEER_WORK_TOOL,
  STOP_WORK_TOOL,
  type ToolSource,
  WORK_CHECK_IN_JOB,
  WORK_IN_BACKGROUND_TOOL,
  WORK_LIMITS,
  workBrief,
  workView,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const ask = (body: string, threadId?: string, userId = f.owner.id, channelId = f.general.id) =>
  postPersonMessage(deps(), userId, f.org.id, channelId, { body, ...(threadId ? { threadId } : {}) });
const runs = () => f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
const works = () => f.db.select().from(schema.agentWorks).orderBy(schema.agentWorks.createdAt);
const messages = () => f.db.select().from(schema.messages).orderBy(schema.messages.createdAt);
const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content ?? "");

/** A run that started on `body` and is working now (its job not run: the test drives it). */
async function working(body: string, threadId?: string, channelId?: string): Promise<AgentRun> {
  const before = new Set((await runs()).map((r) => r.id));
  await ask(body, threadId, f.owner.id, channelId);
  const run = (await runs()).find((r) => !before.has(r.id));
  if (!run) throw new Error("no run started");
  const [moved] = await f.db
    .update(schema.agentRuns)
    .set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() })
    .where(eq(schema.agentRuns.id, run.id))
    .returning();
  return moved as AgentRun;
}

async function moved(run: AgentRun, extra: Partial<Parameters<typeof moveToBackground>[2]> = {}) {
  const out = await moveToBackground(deps(), run.id, {
    how: "agent",
    title: "Migrar a cobrança",
    say: "Vou cuidar disso.",
    ...extra,
  });
  if (!out) throw new Error("not moved");
  return out;
}

test("work_in_background: the anchor in the timeline, updates in its thread, the report home; a card follows it", async () => {
  f = await setup({
    workTools: true,
    reply: (_req, call) =>
      call === 1
        ? {
            chunks: [],
            toolUses: [
              {
                name: WORK_IN_BACKGROUND_TOOL,
                input: {
                  title: "Migrar a cobrança",
                  say: "Vou cuidar disso em segundo plano. Te aviso aqui; o próximo update deve sair em ~10 min.",
                  next_update_minutes: 10,
                  card: true,
                  plan: [{ text: "Ler o esquema" }, { text: "Migrar" }, { text: "Conferir" }],
                },
              },
            ],
          }
        : call === 2
          ? {
              chunks: [],
              toolUses: [
                {
                  name: POST_UPDATE_TOOL,
                  input: {
                    text: "Esquema lido; migrando as tabelas.",
                    plan: [
                      { text: "Ler o esquema", state: "done" },
                      { text: "Migrar", state: "doing" },
                      { text: "Conferir" },
                    ],
                  },
                },
              ],
            }
          : { chunks: ["Pronto: 3 tabelas migradas e conferidas, nada pendente."] },
  });
  const askMsg = await ask("@dev migra a cobrança pro novo esquema");
  await drainOutbox(f.db, f.handlers);

  const [run] = await runs();
  const [work] = await works();
  expect(run?.status).toBe("done");
  expect(work).toMatchObject({ status: "done", how: "agent", ownThread: true, homeThreadId: null, updateSeq: 1 });
  const all = await messages();
  const anchor = all.find((m) => m.id === work?.anchorMessageId);
  expect(anchor?.threadId).toBeNull();
  expect(anchor?.body).toStartWith("Vou cuidar disso em segundo plano.");
  expect(anchor?.meta.longWork).toEqual({ id: work?.id });
  // From the move on, the run answers in the anchor's thread.
  expect(run?.threadRootId).toBe(anchor?.id as string);
  expect(run?.workId).toBe(work?.id as string);
  const update = all.find((m) => m.meta.workUpdate);
  expect(update).toMatchObject({ threadId: anchor?.id, body: "Esquema lido; migrando as tabelas." });
  // The report goes home, where it was asked, as a real reply.
  const report = all.find((m) => m.meta.workEnd);
  expect(report).toMatchObject({ threadId: null, body: "Pronto: 3 tabelas migradas e conferidas, nada pendente." });
  expect(report?.meta.workEnd).toEqual({ id: work?.id, status: "done" });
  expect(work?.resultMessageId).toBe(report?.id as string);
  expect(askMsg.threadId).toBeNull();
  // The card: the agent's, in this channel, done, with the agent's plan and the update in its activity.
  const issues = await listIssues(f.db, { type: "person", userId: f.owner.id }, f.org.id);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({
    title: "Migrar a cobrança",
    status: "done",
    channelId: f.general.id,
    assignee: { type: "agent", id: f.agent.id },
    blocked: null,
  });
  expect(issues[0]?.backgroundWork?.plan.map((p) => p.state)).toEqual(["done", "doing", "todo"]);
  const activity = await f.db.select().from(schema.issueActivity);
  expect(activity.some((a) => a.event === "work_update" && a.text === "Esquema lido; migrando as tabelas.")).toBe(true);
  // The move note told it what to do next, on its next call.
  expect(lastText(f.provider.calls[1]?.request as ModelRequest)).toContain("This is now background work");

  // The report notifies the person behind it as news of its own; the update never does.
  await drainOutbox(f.db, f.handlers);
  const notes = await f.db.select().from(schema.notifications);
  expect(notes.some((n) => n.groupKey === `work_end:${work?.id}`)).toBe(true);
  expect(notes.map((n) => n.source.messageId)).not.toContain(update?.id);
});

test("a work frees the conversation: a new message starts a new run; a reply in the anchor's thread steers the work", async () => {
  f = await setup();
  const run = await working("@dev roda a migração");
  const { work, anchor } = await moved(run);
  expect(work.ownThread).toBe(true);

  await ask("@dev quanto é 2+2?");
  const after = await runs();
  expect(after).toHaveLength(2);
  const [first] = after;
  expect(first?.pendingMessageIds).toEqual([]);

  const reply = await ask("usa o banco de staging", anchor.id);
  const [steered] = await runs();
  expect(steered?.pendingMessageIds).toEqual([reply.id]);
});

test("in a DM too; asked inside a thread, the work keeps the thread and the agent answers there in a new run", async () => {
  f = await setup();
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  const run = await working("gera o relatório de churn", undefined, dm.id);
  await moved(run);
  await ask("e o resumo de ontem?", undefined, f.owner.id, dm.id);
  expect(await runs()).toHaveLength(2);

  const root = await ask("Deploy de hoje");
  const inThread = await working("@dev investiga os erros", root.id);
  const out = await moved(inThread);
  expect(out.work.ownThread).toBe(false);
  expect(out.anchor.threadId).toBe(root.id);
  await ask("@dev e o log do worker?", root.id);
  const all = await runs();
  expect(all).toHaveLength(4);
  expect(all.find((r) => r.id === inThread.id)?.pendingMessageIds).toEqual([]);
});

test("the conversation's run knows the work, passes a message on with steer_work, and stop_work asks the right person", async () => {
  f = await setup({ workTools: true });
  const run = await working("@dev roda a migração");
  const { work } = await moved(run);
  const other = await working("@dev aliás, usa o banco de staging");
  const brief = await workBrief(f.db, other);
  expect(brief).toContain(`work_id ${work.id}`);
  const id = { orgId: f.org.id, agentId: f.agent.id, runId: other.id, machineId: "" };
  const steer = await invokeToolForRun({ ...deps(), tools: f.tools ?? null }, id, {
    id: "s1",
    name: STEER_WORK_TOOL,
    input: { work_id: work.id },
  });
  expect(steer.result.isError).not.toBe(true);
  const [target] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(target?.pendingMessageIds).toContain(other.triggerMessageId);

  // Someone else's message can't stop the owner's work.
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, other.id));
  const before = new Set((await runs()).map((r) => r.id));
  await ask("@dev para a migração", undefined, bia.id);
  const theirs = (await runs()).find((r) => !before.has(r.id)) as AgentRun;
  await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, theirs.id));
  const refused = await invokeToolForRun(
    { ...deps(), tools: f.tools ?? null },
    { ...id, runId: theirs.id },
    { id: "s2", name: STOP_WORK_TOOL, input: { work_id: work.id } },
  );
  expect(refused.result.isError).toBe(true);
  expect(refused.result.content).toContain("Only who asked");
});

test("the safety net: a slow tool past the time moves the run by itself, and the brain hears it", async () => {
  const slow: ToolSource = {
    name: "slow",
    tools: async () => [
      {
        name: "build",
        description: "Build",
        scope: "context:read",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          await Bun.sleep(400);
          return { content: "built" };
        },
      },
    ],
  };
  f = await setup({
    workTools: true,
    toolSources: [slow],
    workAuto: { afterMs: 100, tickMs: 20 },
    reply: (_req, call) =>
      call === 1 ? { chunks: [], toolUses: [{ name: "build", input: {} }] } : { chunks: ["Build pronto."] },
  });
  await ask("@dev builda o app");
  await drainOutbox(f.db, f.handlers);
  const [work] = await works();
  expect(work).toMatchObject({ how: "auto", status: "done" });
  const anchor = (await messages()).find((m) => m.id === work?.anchorMessageId);
  expect(anchor?.meta).toMatchObject({ longWork: { id: work?.id, auto: true }, bodyCode: "work_auto_moved" });
  expect(JSON.stringify(f.provider.calls[1]?.request.messages)).toContain("This is now background work");
  const report = (await messages()).find((m) => m.meta.workEnd);
  expect(report?.body).toBe("Build pronto.");
  expect(report?.threadId).toBeNull();
});

test("the safety net counts calls too", async () => {
  const quick: ToolSource = {
    name: "quick",
    tools: async () => [
      {
        name: "look",
        description: "Look",
        scope: "context:read",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          await Bun.sleep(40);
          return { content: "ok" };
        },
      },
    ],
  };
  f = await setup({
    workTools: true,
    toolSources: [quick],
    workAuto: { afterCalls: 2, tickMs: 10 },
    reply: (_req, call) =>
      call <= 4 ? { chunks: [], toolUses: [{ name: "look", input: {} }] } : { chunks: ["Feito."] },
  });
  await ask("@dev confere tudo");
  await drainOutbox(f.db, f.handlers);
  const [work] = await works();
  expect(work?.how).toBe("auto");
});

test("the promise: a nudge when no update came, then exactly one update of the server's; a racing update wins", async () => {
  f = await setup();
  const run = await working("@dev roda a migração");
  const { work } = await moved(run);
  const due = new Date((work.nextUpdateAt as Date).getTime() + 1000);
  // A check before its time does nothing.
  expect(await checkInWork(deps(), f.org.id, { workId: work.id, seq: 0, phase: "nudge" })).toBe("none");
  expect(await checkInWork(deps(), f.org.id, { workId: work.id, seq: 0, phase: "nudge" }, due)).toBe("nudged");
  const nudge = (await messages()).find(
    (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "work_check_in",
  );
  expect(nudge?.body).toContain("You promised an update");
  const [r] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(r?.pendingMessageIds).toContain(nudge?.id as string);
  const fallback = await f.db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.kind, WORK_CHECK_IN_JOB)));
  expect(fallback.some((j) => j.payload.phase === "fallback")).toBe(true);

  const later = new Date(due.getTime() + WORK_LIMITS.graceMs);
  expect(await checkInWork(deps(), f.org.id, { workId: work.id, seq: 0, phase: "fallback" }, later)).toBe("posted");
  // The same job again (a redelivery) posts nothing more.
  expect(await checkInWork(deps(), f.org.id, { workId: work.id, seq: 0, phase: "fallback" }, later)).toBe("none");
  const auto = (await messages()).filter((m) => (m.meta.workUpdate as { auto?: boolean } | undefined)?.auto);
  expect(auto).toHaveLength(1);
  expect(auto[0]?.meta.bodyCode).toBe("work_auto_update");
  const [after] = await f.db.select().from(schema.agentWorks).where(eq(schema.agentWorks.id, work.id));
  expect(after?.updateSeq).toBe(1);
  expect((after?.nextUpdateAt?.getTime() ?? 0) - later.getTime()).toBe(10 * 60_000);

  // The agent's own update racing the server's: one message.
  const seq = after?.updateSeq ?? 1;
  const agentUpdate = await postWorkUpdate(
    deps(),
    run.id,
    { text: "Tabelas migradas.", important: true },
    new Date(later.getTime() + 61_000),
  );
  expect(agentUpdate.ok).toBe(true);
  expect(
    await checkInWork(
      deps(),
      f.org.id,
      { workId: work.id, seq, phase: "fallback" },
      new Date(later.getTime() + 999_000),
    ),
  ).toBe("none");
});

test("updates: 5 minutes apart unless important (then a minute), the promise clamped to 5–20", async () => {
  f = await setup();
  const run = await working("@dev roda a migração");
  await moved(run);
  const t0 = new Date();
  const first = await postWorkUpdate(deps(), run.id, { text: "Começando.", nextUpdateMin: 60 }, t0);
  expect(first.ok && first.work.nextUpdateAt?.getTime()).toBe(t0.getTime() + 20 * 60_000);
  const soon = await postWorkUpdate(deps(), run.id, { text: "Mais um." }, new Date(t0.getTime() + 2 * 60_000));
  expect(soon.ok).toBe(false);
  expect(!soon.ok && soon.reason).toStartWith("Too soon; your last update was 2 min ago.");
  const important = await postWorkUpdate(
    deps(),
    run.id,
    { text: "Bloqueado: falta a chave.", important: true, nextUpdateMin: 1 },
    new Date(t0.getTime() + 2 * 60_000),
  );
  expect(important.ok && important.work.nextUpdateAt?.getTime()).toBe(t0.getTime() + 7 * 60_000);
  const tooFast = await postWorkUpdate(
    deps(),
    run.id,
    { text: "De novo.", important: true },
    new Date(t0.getTime() + 2.5 * 60_000),
  );
  expect(tooFast.ok).toBe(false);
});

test("waiting: no timer while it waits, the line says on what, and it starts over on resume", async () => {
  f = await setup();
  const run = await working("@dev roda a migração");
  const { work } = await moved(run);
  await f.db.update(schema.agentRuns).set({ status: "waiting_approval" }).where(eq(schema.agentRuns.id, run.id));
  const { pauseWorkTimer, resumeWorkTimer } = await import("../src/works");
  await pauseWorkTimer(deps(), { ...run, workId: work.id });
  let view = await workView(f.db, f.org.id, work.id);
  expect(view).toMatchObject({ state: "waiting_approval", nextUpdateAt: null });
  expect(
    await checkInWork(deps(), f.org.id, { workId: work.id, seq: 0, phase: "nudge" }, new Date(Date.now() + 3600_000)),
  ).toBe("none");
  await f.db
    .update(schema.agentRuns)
    .set({
      status: "waiting_input",
      transcript: { waitingForBrain: { code: "usage_pause", until: "2026-11-02T14:00:00.000Z" } },
    })
    .where(eq(schema.agentRuns.id, run.id));
  view = await workView(f.db, f.org.id, work.id);
  expect(view).toMatchObject({ state: "paused", pausedUntil: "2026-11-02T14:00:00.000Z" });
  await f.db.update(schema.agentRuns).set({ status: "running" }).where(eq(schema.agentRuns.id, run.id));
  const now = new Date();
  await resumeWorkTimer(deps(), { ...run, workId: work.id }, now);
  view = await workView(f.db, f.org.id, work.id);
  expect(view?.state).toBe("working");
  expect(Date.parse(view?.nextUpdateAt ?? "")).toBe(now.getTime() + 10 * 60_000);
});

test("cards: none for a quick run nor a short auto work; card: true makes one; a named issue is reused untouched", async () => {
  f = await setup();
  const quick = await working("@dev oi");
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, quick.id));
  const short = await working("@dev confere o build");
  const auto = await moveToBackground(deps(), short.id, { how: "auto", title: "" });
  expect(auto?.work.title).toBe("@dev confere o build");
  expect(await listIssues(f.db, { type: "person", userId: f.owner.id }, f.org.id)).toHaveLength(0);

  const existing = await createIssue(deps(), { type: "person", userId: f.owner.id }, f.org.id, {
    title: "Cobrança nova",
    criteria: ["Sem perda de dados"],
    assignee: { type: "agent", id: f.agent.id },
    channelId: f.general.id,
  });
  const reuse = await working("@dev pega a #1");
  const named = await moved(reuse, { card: existing.number });
  const [linked] = await f.db.select().from(schema.agentWorks).where(eq(schema.agentWorks.id, named.work.id));
  expect(linked?.issueId).toBe(existing.id);
  const [issue] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, existing.id));
  expect(issue?.criteria.map((c) => c.text)).toEqual(["Sem perda de dados"]);
  expect(issue?.status).toBe("in_progress");

  const fresh = await working("@dev monta o relatório");
  const made = await moved(fresh, { card: true, title: "Relatório de churn" });
  const [w] = await f.db.select().from(schema.agentWorks).where(eq(schema.agentWorks.id, made.work.id));
  const [card] = await f.db
    .select()
    .from(schema.issues)
    .where(eq(schema.issues.id, w?.issueId ?? ""));
  expect(card).toMatchObject({ title: "Relatório de churn", status: "in_progress", channelId: f.general.id });

  // Failed: the blocked badge, in its stage. Stopped: back to A fazer.
  await f.db
    .update(schema.agentRuns)
    .set({ status: "failed", error: "budget_exceeded" })
    .where(eq(schema.agentRuns.id, fresh.id));
  await endWork(deps(), { ...fresh, workId: made.work.id, error: "budget_exceeded" }, "failed");
  const [failed] = await f.db
    .select()
    .from(schema.issues)
    .where(eq(schema.issues.id, card?.id ?? ""));
  expect(failed?.blocked).toMatchObject({ reason: "failed", text: "run.budget_exceeded" });
  expect(failed?.status).toBe("in_progress");
  await cancelRun(deps(), f.owner.id, f.org.id, reuse.id);
  const [stopped] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, existing.id));
  expect(stopped?.status).toBe("todo");
  const end = (await messages()).find((m) => (m.meta.workEnd as { id?: string } | undefined)?.id === named.work.id);
  expect(end?.meta.workEnd).toMatchObject({ status: "canceled", byUserId: f.owner.id });
});

test("a work 15 minutes old gets its card at its check-in", async () => {
  f = await setup();
  const run = await working("@dev roda a migração");
  const { work } = await moved(run);
  const at = new Date(Date.now() + WORK_LIMITS.cardAfterMs + 60_000);
  await checkInWork(deps(), f.org.id, { workId: work.id, seq: 0, phase: "nudge" }, at);
  const [w] = await f.db.select().from(schema.agentWorks).where(eq(schema.agentWorks.id, work.id));
  expect(w?.issueId).not.toBeNull();
});

test("caps: an agent's 4th work waits in line, with its place, and starts when one ends", async () => {
  f = await setup();
  const out = [];
  for (const n of [1, 2, 3, 4]) out.push(await moved(await working(`@dev tarefa ${n}`), { title: `Tarefa ${n}` }));
  expect(out.map((o) => o.queued)).toEqual([false, false, false, true]);
  const fourth = out[3] as (typeof out)[number];
  expect(await workView(f.db, f.org.id, fourth.work.id)).toMatchObject({
    state: "queued",
    queuePosition: 1,
    nextUpdateAt: null,
  });
  const first = out[0] as (typeof out)[number];
  const [firstRun] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.workId, first.work.id));
  await f.db
    .update(schema.agentRuns)
    .set({ status: "done" })
    .where(eq(schema.agentRuns.id, firstRun?.id ?? ""));
  await endWork(deps(), firstRun as AgentRun, "done");
  expect((await workView(f.db, f.org.id, fourth.work.id))?.status).toBe("live");
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  expect(jobs.some((j) => String(j.payload.wait ?? "").startsWith("work_queue:"))).toBe(true);
});

test("the workspace's cap is the configured one", async () => {
  f = await setup();
  const { setWorkOrgCap } = await import("../src/works");
  setWorkOrgCap(1);
  try {
    const second = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Ops", instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: second.id });
    expect((await moved(await working("@dev um"))).queued).toBe(false);
    expect((await moved(await working("@ops dois"))).queued).toBe(true);
  } finally {
    setWorkOrgCap(10);
  }
});

test("restarts: a terminal run with a live work is closed once by the sweep, even run twice", async () => {
  f = await setup();
  const run = await working("@dev roda a migração");
  const { work } = await moved(run);
  await f.db
    .update(schema.agentRuns)
    .set({ status: "failed", error: "Interrupted by a server restart" })
    .where(eq(schema.agentRuns.id, run.id));
  const [a, b] = await Promise.all([reconcileWorks(deps()), reconcileWorks(deps())]);
  expect(a + b).toBe(1);
  expect(await reconcileWorks(deps())).toBe(0);
  const ends = (await messages()).filter((m) => (m.meta.workEnd as { id?: string } | undefined)?.id === work.id);
  expect(ends).toHaveLength(1);
  expect(ends[0]?.meta.workEnd).toMatchObject({ status: "failed", errorCode: "run.interrupted" });
});

test("the agent's status: one work, two, three, and one that waits", async () => {
  f = await setup();
  const status = async () => (await loadAgentStatuses(f.db, f.org.id)).find((s) => s.agentId === f.agent.id);
  const one = await moved(await working("@dev um"), { title: "Migrar a cobrança" });
  let s = await status();
  expect(s?.presence).toBe("busy");
  expect(s?.status).toMatchObject({ kind: "work", subject: "Migrar a cobrança", count: 1 });
  await moved(await working("@dev dois"), { title: "Relatório de churn" });
  s = await status();
  expect(s?.status).toMatchObject({
    kind: "work",
    count: 2,
    subject: "Relatório de churn",
    second: "Migrar a cobrança",
  });
  await moved(await working("@dev três"), { title: "Backup" });
  expect((await status())?.status?.count).toBe(3);
  // A work in a DM shows no title (the whole workspace reads the line).
  await f.db.delete(schema.agentWorks).where(eq(schema.agentWorks.title, "Backup"));
  await f.db.delete(schema.agentWorks).where(eq(schema.agentWorks.title, "Relatório de churn"));
  const [r] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.workId, one.work.id));
  await f.db
    .update(schema.agentRuns)
    .set({ status: "waiting_approval" })
    .where(eq(schema.agentRuns.id, r?.id ?? ""));
  expect((await status())?.status).toMatchObject({ kind: "work", wait: "approval", subject: "Migrar a cobrança" });
});

test("Continuar on a work stopped at its step limit carries the same work", async () => {
  f = await setup({
    workTools: true,
    reply: (_req, call) =>
      call === 1
        ? {
            chunks: [],
            toolUses: [{ name: WORK_IN_BACKGROUND_TOOL, input: { title: "Migrar", say: "Vou cuidar disso." } }],
          }
        : {
            chunks: ["ainda"],
            toolUses: [{ name: POST_UPDATE_TOOL, input: { text: `passo ${call}`, important: true } }],
          },
  });
  await ask("@dev migra");
  await drainOutbox(f.db, createJobHandlers({ ...f.jobDeps, maxToolTurns: 4 }));
  const [stopped] = await runs();
  const [work] = await works();
  expect(stopped?.workId).toBe(work?.id as string);
  expect(work?.status).toBe("done");
  const { runId } = await continueRun(deps(), f.owner.id, f.org.id, stopped?.id ?? "");
  const [next] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  expect(next?.workId).toBe(work?.id as string);
  expect(next?.threadRootId).toBe(work?.anchorMessageId as string);
  expect((await workView(f.db, f.org.id, work?.id ?? ""))?.status).toBe("live");
});
