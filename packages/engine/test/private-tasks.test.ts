import { afterEach, describe, expect, test } from "bun:test";
import { channelTopic, orgTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { and, eq, inArray, schema, sql } from "@agenteschat/db";
import {
  addChannelMember,
  calendarRange,
  commentIssue,
  createAgent,
  createChannel,
  createIssue,
  drainOutbox,
  getIssue,
  getIssueDetail,
  grantScopes,
  issueFromMessage,
  listIssues,
  listNotifications,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  openPersonAgentDm,
  openTaskConversation,
  postPersonMessage,
  searchVisible,
  shareIssueWithEveryone,
  updateIssue,
  userVisibleChannels,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { runContext } from "./mail-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const ISSUES = ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope }));
const deps = () => ({ db: f.db, pubsub: f.pubsub });

/** The fixture's owner and agent in a DM, a second person outside it who is an admin, and the agent's tools there. */
async function inDm() {
  f = await setup({ issueTools: true, reply: () => ({ chunks: ["ok"] }) });
  await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
  const dm = await openPersonAgentDm(f.db, f.org.id, f.owner.id, f.agent.id);
  const admin = await addMember(f.db, f.org.id, "admin", "ada");
  const call = await toolsIn(dm.id);
  return { dm, admin, call };
}

async function toolsIn(channelId: string) {
  const ctx = { ...(await runContext(f)), channelId };
  await f.db.update(schema.agentRuns).set({ channelId }).where(eq(schema.agentRuns.id, ctx.runId));
  return (name: string, input: Record<string, unknown>) =>
    f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
}

const made = async (call: Awaited<ReturnType<typeof toolsIn>>, title: string, more: Record<string, unknown> = {}) => {
  const answer = await call("create_issue", { title, ...more });
  if (answer?.type !== "result") throw new Error("no result");
  const issue = (answer.output.data as { issue?: { id: string; number: number } } | undefined)?.issue;
  if (!issue) throw new Error(`not created: ${answer.output.content}`);
  return issue;
};

describe("a task made in a private conversation stays there", () => {
  test("from a DM: the board, a direct link, the number and search show it only to who is in it, an admin included", async () => {
    const { admin, call, dm } = await inDm();
    const task = await made(call, "Reajuste do salário da Bia", { description: "Conversa reservada" });

    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: task.id })).channelId).toBe(dm.id);
    expect((await listIssues(f.db, person(f.owner.id), f.org.id)).map((i) => i.id)).toEqual([task.id]);

    expect(await listIssues(f.db, person(admin.id), f.org.id)).toEqual([]);
    expect(await listIssues(f.db, person(admin.id), f.org.id, { q: "salário" })).toEqual([]);
    await expect(getIssue(f.db, person(admin.id), f.org.id, { id: task.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getIssueDetail(f.db, person(admin.id), f.org.id, { number: task.number })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      updateIssue(deps(), person(admin.id), f.org.id, task.id, { status: "done" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(commentIssue(deps(), person(admin.id), f.org.id, task.id, "oi")).rejects.toBeInstanceOf(NotFoundError);
    await expect(openTaskConversation(f.db, person(admin.id), f.org.id, task.id)).rejects.toBeInstanceOf(NotFoundError);

    await drainOutbox(f.db, f.handlers);
    const found = (visibleChannelIds: string[]) =>
      searchVisible(f.context, { orgId: f.org.id, text: "salário", visibleChannelIds, kinds: ["issue"] });
    expect(await found(await userVisibleChannels(f.db, f.org.id, admin.id))).toEqual([]);
    const mine = await found(await userVisibleChannels(f.db, f.org.id, f.owner.id));
    expect(mine.map((h) => h.sourceId)).toEqual([task.id]);
  });

  test("from a private channel, the same; a public channel's stays the workspace's", async () => {
    f = await setup({ issueTools: true, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const outside = await addMember(f.db, f.org.id, "member", "bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const hidden = await made(await toolsIn(secret.id), "Fusão");
    const open = await made(await toolsIn(f.general.id), "Onboarding");
    expect((await listIssues(f.db, person(outside.id), f.org.id)).map((i) => i.id)).toEqual([open.id]);
    expect((await listIssues(f.db, person(f.owner.id), f.org.id)).map((i) => i.id).sort()).toEqual(
      [hidden.id, open.id].sort(),
    );
  });

  test("the agent reaches it from that conversation, and not from anywhere else", async () => {
    const { call } = await inDm();
    const task = await made(call, "Fechar a folha");
    expect(await call("list_issues", {})).toMatchObject({ output: { content: expect.stringContaining("Fechar") } });
    expect(await call("comment_issue", { issue: task.id, text: "Comecei." })).toMatchObject({
      output: { content: `Commented on #${task.number}.` },
    });
    const elsewhere = await toolsIn(f.general.id);
    expect(await elsewhere("list_issues", {})).toMatchObject({ output: { content: "No issues." } });
    expect(await elsewhere("list_issues", { issue: task.id })).toMatchObject({ output: { isError: true } });
    expect(await elsewhere("update_issue", { issue: task.id, status: "done" })).toMatchObject({
      output: { isError: true },
    });
  });

  test("realtime goes to the conversation, never to the whole workspace", async () => {
    const { call, dm } = await inDm();
    const toOrg: RealtimeEvent[] = [];
    const toDm: RealtimeEvent[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => toOrg.push(e));
    f.pubsub.subscribe(channelTopic(dm.id), (e) => toDm.push(e));
    const task = await made(call, "Fechar a folha");
    await updateIssue(deps(), person(f.owner.id), f.org.id, task.id, { status: "in_progress" });
    expect(toOrg.filter((e) => e.type.startsWith("issue."))).toEqual([]);
    expect(toDm.map((e) => e.type)).toEqual(expect.arrayContaining(["issue.created", "issue.updated"]));
  });

  test("someone outside can't be assigned, by an agent or a person, so nothing reaches them", async () => {
    const { admin, call } = await inDm();
    const refused = await call("create_issue", { title: "Folha", assignee: "ada" });
    expect(refused).toMatchObject({ output: { isError: true, content: expect.stringContaining("conversation") } });

    const task = await made(call, "Fechar a folha");
    await expect(
      updateIssue(deps(), person(f.owner.id), f.org.id, task.id, { assignee: { type: "person", id: admin.id } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await updateIssue(deps(), person(f.owner.id), f.org.id, task.id, { status: "done" });
    await drainOutbox(f.db, f.handlers);
    expect((await listNotifications({ db: f.db }, admin.id, f.org.id)).items).toEqual([]);
  });

  test("a due date shows on the calendar of who is in it only", async () => {
    const { admin, call } = await inDm();
    await made(call, "Fechar a folha", { due_date: "2026-11-20" });
    const range = (userId: string) =>
      calendarRange({ db: f.db }, userId, f.org.id, "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
    expect((await range(f.owner.id)).deadlines.map((d) => d.title)).toEqual(["Fechar a folha"]);
    expect((await range(admin.id)).deadlines).toEqual([]);
  });

  test("a step of a private task, and a task made in its own conversation, stay with it", async () => {
    const { admin, call, dm } = await inDm();
    const parent = await made(call, "Fechar a folha");
    const step = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "Holerites", parentIssueId: parent.id });
    expect(step.channelId).toBe(dm.id);
    await expect(
      createIssue(deps(), person(admin.id), f.org.id, { title: "Olhar", parentIssueId: parent.id }),
    ).rejects.toBeInstanceOf(ValidationError);

    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, parent.id);
    const inside = await made(await toolsIn(at.channelId), "Passo no tópico");
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: inside.id })).channelId).toBe(dm.id);
    const said = await postPersonMessage(deps(), f.owner.id, f.org.id, at.channelId, {
      body: "Conferir os valores",
      threadId: at.rootId,
    });
    expect((await issueFromMessage(deps(), f.owner.id, f.org.id, said.id)).channelId).toBe(dm.id);
  });

  test("a workspace task's conversation and a room no person reads leave a task the workspace's", async () => {
    const { admin } = await inDm();
    const open = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "Aberta" });
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, open.id);
    const step = await made(await toolsIn(at.channelId), "Passo aberto");
    const seen = (await listIssues(f.db, person(admin.id), f.org.id)).map((i) => i.id);
    expect(seen).toContain(step.id);

    const [room] = await f.db
      .insert(schema.channels)
      .values({ orgId: f.org.id, name: "routine-room", visibility: "private", kind: "dm", dmKey: "routine:x" })
      .returning();
    if (!room) throw new Error("no room");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: room.id, agentId: f.agent.id });
    const fromRoutine = await made(await toolsIn(room.id), "Da rotina");
    expect((await listIssues(f.db, person(admin.id), f.org.id)).map((i) => i.id)).toContain(fromRoutine.id);
  });
});

describe("Mostrar para todos", () => {
  test("someone in the conversation shows an agent's task to everyone; it reaches the board and search; nobody outside can", async () => {
    const { admin, call } = await inDm();
    const task = await made(call, "Fechar a folha");
    await expect(shareIssueWithEveryone(deps(), person(admin.id), f.org.id, task.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await shareIssueWithEveryone(deps(), person(f.owner.id), f.org.id, task.id);
    expect((await listIssues(f.db, person(admin.id), f.org.id)).map((i) => i.id)).toEqual([task.id]);
    await drainOutbox(f.db, f.handlers);
    const hits = await searchVisible(f.context, { orgId: f.org.id, text: "folha", visibleChannelIds: [], kinds: ["issue"] });
    expect(hits.map((h) => h.sourceId)).toEqual([task.id]);
  });

  test("a task a person made from a private message keeps its channel", async () => {
    f = await setup();
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const said = await postPersonMessage(deps(), f.owner.id, f.org.id, secret.id, { body: "Bug" });
    const task = await issueFromMessage(deps(), f.owner.id, f.org.id, said.id);
    await expect(shareIssueWithEveryone(deps(), person(f.owner.id), f.org.id, task.id)).rejects.toThrow();
  });
});

describe("the data migrations", () => {
  const run = async (name: string) =>
    f.db.execute(sql.raw(await Bun.file(new URL(`../../db/migrations/${name}.sql`, import.meta.url)).text()));
  const write = (agentId: string) =>
    f.db
      .select({ scope: schema.agentScopes.scope })
      .from(schema.agentScopes)
      .where(and(eq(schema.agentScopes.agentId, agentId), eq(schema.agentScopes.scope, "issues:write")));
  const agent = (handle: string) =>
    createAgent(f.db, f.owner.id, f.org.id, { name: handle, handle }, NEW_AGENT_DEFAULTS);
  const drop = (ids: string[]) =>
    f.db
      .delete(schema.agentScopes)
      .where(and(inArray(schema.agentScopes.agentId, ids), eq(schema.agentScopes.scope, "issues:write")));

  test("every agent gets task writing: archived too; not one a person took it from or refused it to, nor the right hand", async () => {
    f = await setup();
    const plain = await agent("plain");
    const archived = await agent("arquivado");
    const turnedOff = await agent("desligado");
    const cardRefused = await agent("recusado");
    const cardRemoved = await agent("devolvido");
    const saved = await agent("salvo");
    const gone = await agent("apagado");
    const all = [plain, archived, turnedOff, cardRefused, cardRemoved, saved, gone].map((a) => a.id);
    await drop(all);
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, archived.id));
    await f.db.update(schema.agents).set({ deletedAt: new Date() }).where(eq(schema.agents.id, gone.id));
    const audited = (agentId: string, scopes: string[]) =>
      f.db.insert(schema.auditLog).values({
        orgId: f.org.id,
        actorType: "person",
        actorId: f.owner.id,
        action: "agent.access_changed",
        targetType: "agent",
        targetId: agentId,
        details: { scopes },
      });
    // Held it, then a later save left it out.
    await audited(turnedOff.id, ["issues:read", "issues:write"]);
    await audited(turnedOff.id, ["issues:read"]);
    // Saved with it off all along: never held it, so that says nothing.
    await audited(saved.id, ["issues:read"]);
    const card = (agentId: string, status: "approved" | "refused") =>
      f.db.insert(schema.approvals).values({
        orgId: f.org.id,
        agentId,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        toolUseId: crypto.randomUUID(),
        tool: "request_permission",
        scope: "",
        params: { permission: "issues:write" },
        actionHash: crypto.randomUUID(),
        title: "Turn on: Issues",
        status,
        expiresAt: new Date(Date.now() + 60_000),
      });
    await card(cardRefused.id, "refused");
    await card(cardRemoved.id, "approved");
    const [rightHand] = await f.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, f.org.id), eq(schema.agents.builtin, "right_hand")));

    await run("0224_agents_write_tasks");
    await run("0224_agents_write_tasks");

    for (const yes of [plain, archived, saved]) expect(await write(yes.id)).toHaveLength(1);
    for (const no of [turnedOff, cardRefused, cardRemoved, gone]) expect(await write(no.id)).toEqual([]);
    if (rightHand) expect(await write(rightHand.id)).toEqual([]);
  });

  test("an agent's task from a private conversation goes back to it, search included; one someone outside works on stays", async () => {
    const { admin, call, dm } = await inDm();
    const tied = await made(call, "Fechar a folha");
    const assigned = await made(call, "Com alguém de fora");
    const commented = await made(call, "Comentada de fora");
    const noReceipt = await made(call, "Sem recibo");
    const fromPublic = await made(await toolsIn(f.general.id), "Do canal aberto");
    const ids = [tied, assigned, commented, noReceipt].map((t) => t.id);
    await drainOutbox(f.db, f.handlers);
    // As they were before: made for the whole workspace.
    await f.db.update(schema.issues).set({ channelId: null }).where(inArray(schema.issues.id, ids));
    await f.db
      .update(schema.searchDocuments)
      .set({ channelIds: [] })
      .where(inArray(schema.searchDocuments.sourceId, ids));
    await f.db
      .update(schema.issues)
      .set({ assigneeType: "person", assigneeId: admin.id })
      .where(eq(schema.issues.id, assigned.id));
    await commentIssue(deps(), person(admin.id), f.org.id, commented.id, "Vi aqui");
    await drainOutbox(f.db, f.handlers);
    await f.db.delete(schema.agentActions).where(eq(schema.agentActions.targetId, noReceipt.id));

    await run("0225_private_tasks");

    const channelOf = async (id: string) =>
      (await f.db.select().from(schema.issues).where(eq(schema.issues.id, id)))[0]?.channelId;
    expect(await channelOf(tied.id)).toBe(dm.id);
    expect(await channelOf(assigned.id)).toBeNull();
    expect(await channelOf(commented.id)).toBeNull();
    expect(await channelOf(noReceipt.id)).toBeNull();
    expect(await channelOf(fromPublic.id)).toBeNull();
    const [doc] = await f.db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.sourceId, tied.id));
    expect(doc?.channelIds).toEqual([dm.id]);
  });
});
