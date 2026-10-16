import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  askAgentToImplement,
  commentIssue,
  createChannel,
  createIssue,
  drainOutbox,
  getIssue,
  grantScopes,
  issueFromMessage,
  listIssueActivity,
  listIssues,
  NotFoundError,
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

  test("asking an agent to implement: assigned, a run starts, progress and the reply land on the issue", async () => {
    let step = 0;
    f = await setup({
      issueTools: true,
      reply: (req: ModelRequest) => {
        step++;
        const last = JSON.stringify(req.messages.at(-1)?.content);
        const id = /issue_id ([0-9a-f-]{36})/.exec(last)?.[1];
        if (step === 1 && id) {
          return {
            chunks: [],
            toolUses: [{ name: "comment_issue", input: { issue: id, text: "Comecei: reproduzi o bug." } }],
          };
        }
        return { chunks: ["Corrigido no PR #7."] };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ISSUES);
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Login quebra",
      criteria: ["Funciona no Safari"],
    });
    const asked = await askAgentToImplement(deps, f.owner.id, f.org.id, issue.id, f.agent.id);
    expect(asked.assignee).toEqual({ type: "agent", id: f.agent.id });
    const [message] = (await f.db.select().from(schema.messages)).filter((m) => m.body.includes("#1"));
    expect(message?.body).toContain("@dev implement issue #1: Login quebra");
    expect(message?.body).toContain("- [ ] Funciona no Safari");
    expect(message?.meta).toMatchObject({ issueId: issue.id });

    await drainOutbox(f.db, f.handlers);
    const activity = await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id);
    const comments = activity.filter((a) => a.kind === "comment").map((a) => [a.author.type, a.text]);
    expect(comments).toEqual([
      ["agent", "Comecei: reproduzi o bug."],
      ["agent", "Corrigido no PR #7."],
    ]);
    expect(activity.some((a) => a.event === "agent_asked")).toBe(true);
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
