import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { proposeChange } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

test("knowledge API: search, context items (add, pin, edit), reactions, correction → lesson, proposals", async () => {
  t = await createTestServer({ embeddings: true, reply: () => ({ chunks: ["Builds run on Jenkins."] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  await api(`/channels/${channelId}/messages`, { json: { body: "@dev where do builds run?" } });
  await t.drain();
  const search = (await (await api("/search?q=builds%20run")).json()) as {
    hits: { kind: string; snippet: string; messageId: string | null; threadId: string | null; author: unknown }[];
  };
  expect(search.hits.map((h) => h.snippet)).toContain("Builds run on Jenkins.");
  // Message hits say where they are and who wrote them.
  const replyHit = search.hits.find((h) => h.snippet === "Builds run on Jenkins.");
  expect(replyHit).toMatchObject({ kind: "message", author: { type: "agent", id: agentId, name: "Dev" } });
  expect(replyHit?.messageId).toBeTruthy();
  // Asked in the channel: the reply is in the main timeline.
  expect(replyHit?.threadId).toBeNull();

  const created = await api("/context-items", { json: { kind: "fact", content: "Our CI is Buildkite", pinned: true } });
  expect(created.status).toBe(201);
  const item = (await created.json()) as { id: string; verified: boolean; evidence: { type: string }[] };
  expect(item.evidence.map((e) => e.type)).toEqual(["human"]);
  expect(
    (await api("/context-items", { json: { kind: "fact", content: "token: ghp_abcdefghijklmnopqrstuvwxyz12" } }))
      .status,
  ).toBe(400);
  const edited = (await (
    await api(`/context-items/${item.id}`, { method: "PATCH", json: { content: "Our CI is Buildkite (since May)" } })
  ).json()) as { version: number; id: string };
  expect(edited.version).toBe(2);
  const list = (await (await api("/context-items?kinds=fact")).json()) as { items: { content: string }[] };
  expect(list.items.map((i) => i.content)).toEqual(["Our CI is Buildkite (since May)"]);

  const [reply] = (await t.db.select().from(schema.messages)).filter((m) => m.authorType === "agent");
  const reacted = (await (await api(`/messages/${reply?.id}/reactions`, { json: { reaction: "-1" } })).json()) as {
    reactions: { reaction: string; count: number }[];
  };
  expect(reacted.reactions).toEqual([expect.objectContaining({ reaction: "-1", count: 1 })]);
  const lesson = await api(`/messages/${reply?.id}/correction`, { json: { body: "We use Buildkite, not Jenkins." } });
  expect(lesson.status).toBe(201);
  const memory = (await (await api(`/context-items?agentId=${agentId}`)).json()) as {
    items: { kind: string; verified: boolean }[];
  };
  expect(memory.items).toEqual([expect.objectContaining({ kind: "lesson", verified: true })]);

  const memories = (await (await api(`/agents/${agentId}/memories`)).json()) as {
    memories: { id: string; kind: string; text: string; source: string; lowTrust: boolean; archived: boolean }[];
  };
  expect(memories.memories).toEqual([
    expect.objectContaining({
      kind: "lesson",
      text: expect.stringContaining("We use Buildkite"),
      lowTrust: false,
      archived: false,
    }),
  ]);
  expect(memories.memories[0]?.source).toContain("Written by owner in #general");
  const pinned = (await (
    await api(`/memories/${memories.memories[0]?.id}`, {
      method: "PATCH",
      json: { pinned: true, text: "Builds: Buildkite." },
    })
  ).json()) as { pinned: boolean; text: string; supersedes: string | null };
  expect(pinned).toMatchObject({ pinned: true, text: "Builds: Buildkite." });
  expect(pinned.supersedes).toContain("We use Buildkite");

  // A recurring verified lesson → proposal (the web app's shape) → accept with adjusted text.
  await t.db
    .update(schema.contextItems)
    .set({ recurrence: 2, proposedAt: null })
    .where(eq(schema.contextItems.kind, "lesson"));
  await t.engine.handlers["context.consolidate"]?.({ orgId } as never, { finalAttempt: false });
  const proposals = (await (await api("/proposals?status=pending")).json()) as {
    proposals: {
      id: string;
      title: string;
      before: string;
      after: string;
      decider: { type: string };
      canDecide: boolean;
    }[];
  };
  expect(proposals.proposals).toHaveLength(1);
  expect(proposals.proposals[0]).toMatchObject({
    title: "Update Dev's instructions",
    proposedByAgentId: agentId,
    access: null,
    before: "",
    decider: { type: "user" },
    canDecide: true,
  });
  expect(proposals.proposals[0]?.after).toContain("Builds: Buildkite.");
  const accepted = (await (
    await api(`/proposals/${proposals.proposals[0]?.id}/accept`, { json: { text: "Our CI is Buildkite." } })
  ).json()) as { status: string; after: string };
  expect(accepted).toMatchObject({ status: "accepted", after: "Our CI is Buildkite." });
  const agent = (await (await api(`/agents/${agentId}`)).json()) as { instructions: string };
  expect(agent.instructions).toBe("Our CI is Buildkite.");
  expect((await api("/search/reindex", { json: {} })).status).toBe(202);
});

test("proposals an agent made for a teammate name it and say what they change: instructions, role, apps", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const ada = (await (
    await api("/agents", {
      json: { name: "Ada", handle: "ada", role: "Dev", instructions: "Seja breve.", model: "claude-sonnet-5-5" },
    })
  ).json()) as { id: string };
  const [me] = await t.db.select().from(schema.users).where(eq(schema.users.email, "owner@example.com"));
  await proposeChange(
    { db: t.db },
    {
      orgId,
      agentId,
      target: "agent_instructions",
      agentIds: [ada.id],
      change: "Responder em português.",
      roles: [{ agentId: ada.id, role: "Revisora" }],
      access: [{ agentId: ada.id, lines: [{ id: "issues:write", label: "Issues", on: true }] }],
      rationale: "",
      requesterId: me?.id ?? "",
    },
  );
  type View = { id: string; target: { type: string }; [key: string]: unknown };
  const { proposals } = (await (await api("/proposals?status=pending")).json()) as { proposals: View[] };
  const of = (type: string) => proposals.find((p) => p.target.type === type) as View;
  expect(of("agent_instructions")).toMatchObject({
    agentId: ada.id,
    proposedByAgentId: agentId,
    target: { agentId: ada.id },
    access: null,
    decider: { type: "user" },
  });
  expect(of("agent_role")).toMatchObject({
    title: "Change Ada's role",
    proposedByAgentId: agentId,
    before: "Dev",
    after: "Revisora",
    decider: { type: "admins" },
    canDecide: true,
  });
  expect(of("agent_access")).toMatchObject({
    title: "Change Ada's access",
    access: [{ id: "issues:write", label: "Issues", on: true }],
    before: "",
    decider: { type: "admins" },
  });
  // A role is taken as proposed or refused: only instructions and the org context are edited first.
  expect((await api(`/proposals/${of("agent_role").id}/accept`, { json: { text: "Outra" } })).status).toBe(400);
  const role = await api(`/proposals/${of("agent_role").id}/accept`, { json: {} });
  expect(await role.json()).toMatchObject({ status: "accepted", after: "Revisora" });
  expect(((await (await api(`/agents/${ada.id}`)).json()) as { role: string }).role).toBe("Revisora");
});

test("a card's rows are read by id, and deciding one answers with it however many came after", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const [me] = await t.db.select().from(schema.users).where(eq(schema.users.email, "owner@example.com"));
  const {
    proposals: [mine],
  } = await proposeChange(
    { db: t.db },
    {
      orgId,
      agentId,
      target: "agent_instructions",
      change: "Responder em português.",
      rationale: "",
      requesterId: me?.id ?? "",
    },
  );
  const id = mine?.id ?? "";
  // 200 newer ones, still waiting: the whole of the list.
  await t.db.insert(schema.contextProposals).values(
    Array.from({ length: 200 }, (_, i) => ({
      orgId,
      target: "org_context" as const,
      baseHash: "x",
      proposedText: `v${i}`,
      diff: "",
      rationale: "",
      createdAt: new Date(Date.now() + 1000 + i),
    })),
  );
  const card = (await (await api(`/proposals?ids=${id},not-an-id`)).json()) as { proposals: { id: string }[] };
  expect(card.proposals.map((p) => p.id)).toEqual([id]);
  const accepted = await api(`/proposals/${id}/accept`, { json: {} });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ id, status: "accepted" });
});
