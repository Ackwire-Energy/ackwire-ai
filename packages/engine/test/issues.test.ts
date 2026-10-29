import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  askAgentToImplement,
  commentIssue,
  createChannel,
  createIssue,
  createIssueToolSource,
  drainOutbox,
  ForbiddenError,
  getIssue,
  grantScopes,
  issueFromMessage,
  listIssueActivity,
  listIssues,
  NotFoundError,
  openDm,
  postPersonMessage,
  searchVisible,
  setCriterion,
  updateIssue,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  // Some tests don't set up a database: close each one once.
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const ISSUES = ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope }));

describe("issues", () => {
  test("numbers per org, criteria, activity for every change, comments, search", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    const first = await createIssue(deps, ana, f.org.id, {
      title: "Login quebra no Safari",
      description: "Ao clicar em entrar, nada acontece.",
      criteria: ["Funciona no Safari 17", "Teste automatizado"],
      priority: "high",
      dueDate: "2026-10-20",
      labels: ["Bug", "bug", " web "],
    });
    const second = await createIssue(deps, ana, f.org.id, { title: "Outra" });
    expect([first.number, second.number]).toEqual([1, 2]);
    expect(first).toMatchObject({ status: "todo", priority: "high", labels: ["bug", "web"], dueDate: "2026-10-20" });
    expect(first.criteria.map((c) => [c.text, c.done])).toEqual([
      ["Funciona no Safari 17", false],
      ["Teste automatizado", false],
    ]);
    await expect(createIssue(deps, ana, f.org.id, { title: "x", dueDate: "20/10/2026" })).rejects.toBeInstanceOf(
      ValidationError,
    );

    await updateIssue(deps, ana, f.org.id, first.id, {
      status: "in_review",
      assignee: { type: "agent", id: f.agent.id },
    });
    const checked = await setCriterion(deps, ana, f.org.id, first.id, first.criteria[0]?.id ?? "", true);
    expect(checked.criteria[0]?.done).toBe(true);
    await commentIssue(deps, ana, f.org.id, first.id, "Reproduzi no iPhone também.");
    const activity = await listIssueActivity(f.db, ana, f.org.id, first.id);
    expect(activity.map((a) => a.event ?? a.kind)).toEqual([
      "created",
      "status_changed",
      "assigned",
      "criterion_checked",
      "comment",
    ]);
    expect(activity[1]?.text).toBe("changed the status to In review");
    expect(activity[1]).toMatchObject({ textCode: "status_changed", textParams: { status: "in_review" } });

    expect((await listIssues(f.db, ana, f.org.id, { q: "safari" })).map((i) => i.number)).toEqual([1]);
    expect((await listIssues(f.db, ana, f.org.id, { q: "#2" })).map((i) => i.number)).toEqual([2]);
    expect((await getIssue(f.db, ana, f.org.id, { number: 1 })).assignee).toEqual({ type: "agent", id: f.agent.id });

    await drainOutbox(f.db, f.handlers);
    const hits = await searchVisible(f.context, {
      orgId: f.org.id,
      text: "Safari",
      visibleChannelIds: [f.general.id],
      kinds: ["issue"],
    });
    expect(hits.map((h) => h.sourceId)).toContain(first.id);
  });

  test('"Transformar em issue" keeps the visibility of a private channel', async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const message = await postPersonMessage(deps, f.owner.id, f.org.id, secret.id, {
      body: "Bug no pagamento\nDetalhes",
    });
    const issue = await issueFromMessage(deps, f.owner.id, f.org.id, message.id);
    expect(issue).toMatchObject({ title: "Bug no pagamento", channelId: secret.id });
    expect(issue.source).toEqual({ type: "message", channelId: secret.id, messageId: message.id });
    await expect(getIssue(f.db, person(bia.id), f.org.id, { id: issue.id })).rejects.toBeInstanceOf(NotFoundError);
    expect(await listIssues(f.db, person(bia.id), f.org.id)).toEqual([]);

    const open = await postPersonMessage(deps, f.owner.id, f.org.id, f.general.id, { body: "Melhorar o onboarding" });
    const fromGeneral = await issueFromMessage(deps, f.owner.id, f.org.id, open.id, { title: "Onboarding" });
    expect(fromGeneral.channelId).toBeNull(); // public origin: the whole org sees it
    expect((await listIssues(f.db, person(bia.id), f.org.id)).map((i) => i.id)).toEqual([fromGeneral.id]);
  });

  test("asking an agent to implement: work in the requester's DM thread, instructions only in the run's context", async () => {
    let step = 0;
    let system = "";
    f = await setup({
      issueTools: true,
      reply: (req: ModelRequest) => {
        step++;
        system = JSON.stringify(req.system);
        if (step === 1 && system.includes("# Your task: issue #1")) {
          return {
            chunks: [],
            toolUses: [{ name: "comment_issue", input: { issue: "#1", text: "Comecei: reproduzi o bug." } }],
          };
        }
        return { chunks: ["Corrigido no PR #7."] };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Login quebra",
      description: "Safari não entra.",
      criteria: ["Funciona no Safari"],
    });
    const asked = await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id);
    expect(asked.assignee).toEqual({ type: "agent", id: f.agent.id });

    // The DM with the agent: a root card and the start inside its thread; nothing in #general.
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const all = await f.db.select().from(schema.messages);
    expect(all.filter((m) => m.channelId === f.general.id)).toEqual([]);
    const root = all.find((m) => m.channelId === dm.id && !m.threadId);
    expect(root?.meta).toMatchObject({ issueWork: { issueId: issue.id, number: 1, title: "Login quebra" } });
    const start = all.find((m) => m.threadId === root?.id && m.authorType === "person");
    expect(start?.meta).toMatchObject({ issueId: issue.id, bodyCode: "issue_work_start" });
    for (const m of [root, start]) {
      expect(m?.body).not.toContain(issue.id);
      expect(m?.body).not.toContain("comment_issue");
      expect(m?.body).not.toContain("Safari não entra");
    }
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({ channelId: dm.id, threadRootId: root?.id, triggerMessageId: start?.id });

    await drainOutbox(f.db, f.handlers);
    // The run read its task from the issue (description, criteria, how to report).
    expect(system).toContain("Safari não entra.");
    expect(system).toContain("1. [ ] Funciona no Safari");
    expect(system).toContain("comment_issue");
    expect(system).toContain("private between you and the person who asked");
    // Its reply stays in the DM thread; progress and the reply land on the issue.
    const replies = (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "agent");
    expect(replies.map((m) => [m.channelId, m.threadId])).toEqual([[dm.id, root?.id ?? ""]]);
    const activity = await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id);
    const comments = activity.filter((a) => a.kind === "comment").map((a) => [a.author.type, a.text]);
    expect(comments).toEqual([
      ["agent", "Comecei: reproduzi o bug."],
      ["agent", "Corrigido no PR #7."],
    ]);
    const askedEvent = activity.find((a) => a.event === "agent_asked");
    expect(askedEvent?.textParams).toMatchObject({ threadId: root?.id });
  });

  test("asking to implement an issue from a channel message: one line there, a private issue still works", async () => {
    let system = "";
    let step = 0;
    f = await setup({
      issueTools: true,
      reply: (req: ModelRequest) => {
        step++;
        system = JSON.stringify(req.system);
        if (step === 1)
          return { chunks: [], toolUses: [{ name: "comment_issue", input: { issue: "#1", text: "Vou olhar." } }] };
        return { chunks: ["Feito."] };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const deps = { db: f.db, pubsub: f.pubsub };
    // A private channel the agent is not in: the issue keeps its visibility.
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    const said = await postPersonMessage(deps, f.owner.id, f.org.id, secret.id, { body: "Checkout quebra" });
    const issue = await issueFromMessage(deps, f.owner.id, f.org.id, said.id);
    expect(issue.channelId).toBe(secret.id);
    await drainOutbox(f.db, f.handlers);
    const before = (await f.db.select().from(schema.messages)).length;
    await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id);
    const added = (await f.db.select().from(schema.messages)).slice(before);
    const line = added.filter((m) => m.channelId === secret.id);
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ authorType: "agent", authorAgentId: f.agent.id, threadId: null });
    expect(line[0]?.meta).toMatchObject({ issueTaken: { issueId: issue.id, number: 1 }, bodyCode: "issue_taken" });
    expect(added.filter((m) => m.channelId === f.general.id)).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    // Nobody answered the line; the agent (not in #secreto) still read and commented the issue from the DM.
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs).toHaveLength(1);
    expect(system).toContain("# Your task: issue #1");
    const comments = (await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id))
      .filter((a) => a.kind === "comment")
      .map((a) => a.text);
    expect(comments).toEqual(["Vou olhar.", "Feito."]);
  });

  test("asking to implement a manual issue posts nothing in channels; an agent the person can't talk to refuses", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Sem origem" });
    await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id);
    const channelsWithMessages = new Set((await f.db.select().from(schema.messages)).map((m) => m.channelId));
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    expect([...channelsWithMessages]).toEqual([dm.id]);
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await f.db
      .update(schema.agents)
      .set({ audienceMode: "owner", ownerUserId: f.owner.id })
      .where(eq(schema.agents.id, f.agent.id));
    await expect(askAgentToImplement(deps, bia.id, f.org.id, issue.id, f.agent.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("the issue follows the agent's work: in progress when it starts, working while the run lives, stalled after, review with a PR", async () => {
    let step = 0;
    f = await setup({
      issueTools: true,
      reply: (req: ModelRequest) => {
        step++;
        if (step === 1 && JSON.stringify(req.system).includes("# Your task: issue #1"))
          return { chunks: [], toolUses: [{ name: "update_issue", input: { issue: "#1", done_criteria: [1] } }] };
        return { chunks: ["Plano escrito; falta o teste."] };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Frete lento",
      criteria: ["Responde em 2 s", "Tem teste"],
    });
    expect(issue.work).toBeNull();

    // Asked: the run is queued, so the agent is working and the status moved by itself.
    const asked = await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id);
    expect(asked.status).toBe("in_progress");
    expect(asked.work).toMatchObject({ agentId: f.agent.id, state: "running" });
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.map((r) => r.issueId)).toEqual([issue.id]);

    // The run ends without a PR: still in progress with the agent, nothing alive → stalled.
    await drainOutbox(f.db, f.handlers);
    const after = await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id });
    expect(after.status).toBe("in_progress");
    expect(after.work?.state).toBe("stalled");
    expect(after.work?.steps.map((s) => s.tool)).toEqual(["update_issue"]);
    // The agent checked the first criterion; it remembers who.
    expect(after.criteria.map((c) => [c.done, c.doneBy?.type ?? null])).toEqual([
      [true, "agent"],
      [false, null],
    ]);
    const moved = (await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id)).filter(
      (a) => a.event === "status_changed",
    );
    expect(moved.map((a) => [a.textParams?.status, a.auto ?? false])).toEqual([["in_progress", true]]);

    // A linked PR moves it to review on its own; in review, an ended run is not "stalled".
    const reviewed = await updateIssue(deps, person(f.owner.id), f.org.id, issue.id, {
      addPullRequest: { number: 7, url: "https://github.com/acme/app/pull/7" },
    });
    expect(reviewed.status).toBe("in_review");
    expect(reviewed.work).toBeNull();
    const last = (await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id)).at(-1);
    expect(last).toMatchObject({ event: "status_changed", auto: true, textParams: { status: "in_review" } });
  });

  test("a comment can carry the author's Drive files; they link to the issue; someone else's can't be attached", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Tela quebra no Safari" });
    const file = async (by: string, title: string) => {
      const [row] = await f.db
        .insert(schema.artifacts)
        .values({
          orgId: f.org.id,
          kind: "file",
          title,
          createdByType: "person",
          createdById: by,
          updatedByType: "person",
          updatedById: by,
        })
        .returning();
      return row?.id ?? "";
    };
    const mine = await file(f.owner.id, "print.png");
    const comment = await commentIssue(deps, person(f.owner.id), f.org.id, issue.id, "", { attachmentIds: [mine] });
    expect(comment.attachments).toEqual([{ id: mine, title: "print.png" }]);
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).artifacts.map((a) => a.id)).toEqual([
      mine,
    ]);
    const other = await addMember(f.db, f.org.id, "member", "Ana");
    const theirs = await file(other.id, "deles.pdf");
    await expect(
      commentIssue(deps, person(f.owner.id), f.org.id, issue.id, "olha", { attachmentIds: [theirs] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("update_issue and create_issue set the assignee: me, a handle, none; an unknown name fails", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const tools = await createIssueToolSource(deps).tools(ctx);
    const run = (name: string, input: Record<string, unknown>) => {
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`no ${name}`);
      return tool.execute(input, ctx);
    };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "N+1 no offline-map",
      assignee: { type: "person", id: f.owner.id },
    });
    const mine = await run("update_issue", { issue: `#${issue.number}`, assignee: "me" });
    expect(mine.isError).toBeUndefined();
    // The agent reads who it is, not an id.
    expect(mine.content).toContain("(assignee: @dev (you))");
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).assignee).toEqual({
      type: "agent",
      id: f.agent.id,
    });
    await run("update_issue", { issue: issue.id, assignee: "none" });
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).assignee).toBeNull();
    const failed = await run("update_issue", { issue: issue.id, assignee: "@nobody" });
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("Nobody called");

    const created = await run("create_issue", { title: "Contar o rate limit uma vez", assignee: "@dev" });
    const [row] = (await listIssues(f.db, person(f.owner.id), f.org.id, { q: "rate limit" })).filter(
      (i) => i.title === "Contar o rate limit uma vez",
    );
    expect(created.isError).toBeUndefined();
    expect(row?.assignee).toEqual({ type: "agent", id: f.agent.id });
  });

  test("update_issue links only an https pull request; any other address is refused", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    const tools = await createIssueToolSource(deps).tools(ctx);
    const update = tools.find((t) => t.name === "update_issue");
    if (!update) throw new Error("no update_issue");
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Corrigir o login" });
    for (const url of ["javascript:alert(1)//pull/3", "data:text/html,x/pull/3", "http://example.com/pull/3"]) {
      const refused = await update.execute({ issue: issue.id, pull_request_url: url, pull_request_number: 3 }, ctx);
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain("https://");
    }
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).pullRequests).toEqual([]);
    const pr = "https://github.com/acme/app/pull/3";
    const linked = await update.execute({ issue: issue.id, pull_request_url: pr }, ctx);
    expect(linked.isError).toBeUndefined();
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).pullRequests).toMatchObject([
      { number: 3, url: pr },
    ]);
    await expect(
      updateIssue(deps, person(f.owner.id), f.org.id, issue.id, {
        addPullRequest: { number: 4, url: "javascript:alert(1)" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("an agent without issues:write can't create issues; one in another channel can't see private ones", async () => {
    f = await setup({
      issueTools: true,
      reply: (req: ModelRequest) =>
        JSON.stringify(req.messages.at(-1)?.content).includes("tool_result")
          ? { chunks: ["ok"] }
          : { chunks: [], toolUses: [{ name: "create_issue", input: { title: "Nova" } }] },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev abre" });
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.issues)).toEqual([]);

    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const deps = { db: f.db, pubsub: f.pubsub };
    const hidden = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Segredo", channelId: secret.id });
    const inGeneral = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    const inSecret = { type: "agent" as const, agentId: f.agent.id, channelId: secret.id };
    await expect(getIssue(f.db, inGeneral, f.org.id, { id: hidden.id })).rejects.toBeInstanceOf(NotFoundError);
    expect((await getIssue(f.db, inSecret, f.org.id, { id: hidden.id })).title).toBe("Segredo");
  });
});
