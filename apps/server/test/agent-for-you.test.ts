import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { consolidateItem, createIssueToolSource, insertMessage, linkRunActions } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

/** A member of the organization (joined through an invite link), with their id. */
async function member(owner: ReturnType<typeof browser>, orgId: string, email: string) {
  const res = await owner(`/api/app/organizations/${orgId}/invite-links`, { json: {} });
  const token = ((await res.json()) as { url: string }).url.split("/invite/")[1] ?? "";
  const b = browser(t);
  await signUp(b, email, { inviteToken: token });
  await b(`/api/app/invitations/${token}/accept`, { json: {} });
  const id = ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
  return { b, id };
}

const meOf = async (b: ReturnType<typeof browser>) =>
  ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;

type ForYou = {
  items: (
    | { type: "action"; at: string; action: { kind: string; target: { number?: number } } }
    | { type: "file"; at: string; file: { title: string } }
    | { type: "approval"; at: string; approval: { title: string; waitingOnYou: boolean; status: string } }
  )[];
  monthCount: number;
};

test("for-you: the viewer's receipts (not memory, not undone), the agent's files where both are, approvals on them", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const ownerId = await meOf(owner);
  const ana = await member(owner, orgId, "ana@example.com");

  // The owner asks; the agent opens two issues (one undone later) and replies.
  const ask = await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "person", userId: ownerId },
    body: "abre as issues",
  });
  const ctx = {
    db: t.db,
    orgId,
    agentId,
    runId: crypto.randomUUID(),
    channelId,
    threadRootId: ask.id,
    triggerMessageId: ask.id,
  };
  const [create] = (await createIssueToolSource({ db: t.db }).tools(ctx)).filter((x) => x.name === "create_issue");
  await create?.execute({ title: "Login no Safari" }, ctx);
  await create?.execute({ title: "Outra" }, ctx);
  // Asked in the channel: the reply is in the main timeline.
  const reply = await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "agent", agentId, runId: ctx.runId, hop: 0 },
    body: "Abri duas.",
  });
  await linkRunActions(t.db, orgId, ctx.runId, reply.id);
  const receipts = await t.db.select().from(schema.agentActions);
  const second = receipts.find((r) => (r.target as { number?: number }).number === 2);
  await owner(`/api/app/organizations/${orgId}/actions/${second?.id}/undo`, { json: {} });
  // A memory receipt stays out (it is in "O que sabe sobre você").
  await t.db.insert(schema.agentActions).values({
    orgId,
    agentId,
    channelId,
    requestedByUserId: ownerId,
    kind: "memory.saved",
    targetType: "memory",
    targetId: crypto.randomUUID(),
    undoableUntil: new Date(Date.now() + 60_000),
  });

  // A file by the agent in #general (both there), and one in a channel the owner is not in.
  const [other] = await t.db
    .insert(schema.channels)
    .values({ orgId, name: "secreto", visibility: "private" })
    .returning();
  const file = (title: string, where: string) => ({
    orgId,
    kind: "document" as const,
    title,
    channelId: where,
    createdByType: "agent",
    createdById: agentId,
    updatedByType: "agent",
    updatedById: agentId,
  });
  await t.db.insert(schema.artifacts).values([file("Erros da semana", channelId), file("Escondido", other?.id ?? "")]);

  // An approval waiting on the owner (they own the agent), one the owner decided, one another person decided.
  const approval = (title: string, extra: Partial<typeof schema.approvals.$inferInsert> = {}) => ({
    orgId,
    agentId,
    channelId,
    threadRootId: ask.id,
    toolUseId: crypto.randomUUID(),
    tool: "github_merge_pr",
    scope: "github:pr.merge",
    params: {},
    actionHash: crypto.randomUUID(),
    title,
    ownerUserId: ownerId,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...extra,
  });
  await t.db
    .insert(schema.approvals)
    .values([
      approval("Merge PR #128"),
      approval("Merge PR #120", { status: "approved", decidedByUserId: ownerId, decidedAt: new Date() }),
      approval("Merge PR #99", { status: "approved", decidedByUserId: ana.id, decidedAt: new Date() }),
    ]);

  const res = await owner(`/api/app/organizations/${orgId}/agents/${agentId}/for-you`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as ForYou;
  const labels = body.items.map((i) =>
    i.type === "action"
      ? `${i.action.kind} #${i.action.target.number}`
      : i.type === "file"
        ? `file ${i.file.title}`
        : `approval ${i.approval.title}${i.approval.waitingOnYou ? " (waiting)" : ""}`,
  );
  expect(labels.sort()).toEqual(
    ["approval Merge PR #120", "approval Merge PR #128 (waiting)", "file Erros da semana", "issue.created #1"].sort(),
  );
  expect(body.monthCount).toBe(4);
  expect([...body.items].map((i) => i.at)).toEqual(
    [...body.items]
      .map((i) => i.at)
      .sort()
      .reverse(),
  );

  // Ana (a member of #general): nothing she asked, she can't decide the pending one; the file and what she decided.
  const hers = (await (await ana.b(`/api/app/organizations/${orgId}/agents/${agentId}/for-you`)).json()) as ForYou;
  expect(hers.items.map((i) => (i.type === "approval" ? i.approval.title : i.type)).sort()).toEqual([
    "Merge PR #99",
    "file",
  ]);

  expect((await owner(`/api/app/organizations/${orgId}/agents/${crypto.randomUUID()}/for-you`)).status).toBe(404);
  const doc = (await (await t.app.request("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
  expect(doc.paths["/app/organizations/{orgId}/agents/{agentId}/for-you"]).toBeDefined();
});

test("memories about=me: only what came from the viewer, with the message it came from", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const ownerId = await meOf(owner);
  const ana = await member(owner, orgId, "ana@example.com");

  const said = await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "person", userId: ownerId },
    body: "publica correções depois das 18h",
  });
  const hers = await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "person", userId: ana.id },
    body: "revisão vai para o Caio",
  });
  const save = (content: string, sourceIds: string[], extra: Partial<Parameters<typeof consolidateItem>[1]> = {}) =>
    consolidateItem(t.db, {
      orgId,
      kind: "preference",
      scopeType: "agent",
      scopeId: agentId,
      agentId,
      content,
      sourceIds,
      channelIds: [channelId],
      ...extra,
    });
  const mine = await save("Prefere publicar correções depois das 18h.", [said.id]);
  await save("Revisão de código vai para o Caio.", [hers.id]);
  await save("O deploy roda às sextas.", [], { kind: "fact" });

  type Mem = { id: string; text: string; from?: { messageId: string; channelId: string; dm: boolean } | null };
  const list = async (b: ReturnType<typeof browser>, q = "") =>
    ((await (await b(`/api/app/organizations/${orgId}/agents/${agentId}/memories${q}`)).json()) as { memories: Mem[] })
      .memories;

  expect((await list(owner)).length).toBe(3);
  expect((await list(owner)).every((m) => m.from === undefined)).toBe(true);
  expect(await list(owner, "?about=me")).toEqual([
    expect.objectContaining({
      id: mine.item.id,
      text: "Prefere publicar correções depois das 18h.",
      from: expect.objectContaining({ messageId: said.id, channelId, dm: false }),
    }),
  ]);
  expect((await list(ana.b, "?about=me")).map((m) => m.text)).toEqual(["Revisão de código vai para o Caio."]);

  // The owner corrects it: the new version keeps where it came from.
  const edit = await owner(`/api/app/organizations/${orgId}/memories/${mine.item.id}`, {
    method: "PATCH",
    json: { text: "Prefere publicar correções depois das 18h, menos às sextas." },
  });
  expect(edit.status).toBe(200);
  expect((await list(owner, "?about=me")).map((m) => [m.text, m.from?.messageId])).toEqual([
    ["Prefere publicar correções depois das 18h, menos às sextas.", said.id],
  ]);
  // A member who doesn't own the agent can't change it.
  const [hersItem] = await list(ana.b, "?about=me");
  const denied = await ana.b(`/api/app/organizations/${orgId}/memories/${hersItem?.id}`, {
    method: "PATCH",
    json: { archived: true },
  });
  expect(denied.status).toBe(403);
});
