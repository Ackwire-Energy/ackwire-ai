import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ModelRequest } from "@agenteschat/providers";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

const PLAN = [
  "## Objective",
  "Captar leads pelo LinkedIn.",
  "## For the requester",
  "Botão ao lado do formulário.",
  "## Steps",
  "1. Registrar o app — owner: @ops — size: ~½ dia",
  "2. Rota de OAuth — owner: @dev — after: 1",
  "## Suggested issues",
  "- Registrar o app — no LinkedIn (step 1, owner: @ops)",
  "- Rota de OAuth — com PKCE (step 2, owner: @dev)",
].join("\n");

/** Forum turns propose; the synthesis writes the plan; "vale um fórum" suggests a topic. */
function reply(req: ModelRequest) {
  const last = JSON.stringify(req.messages.at(-1)?.content);
  if (last.includes("tool_result")) return { chunks: ["Sugeri."] };
  if (last.includes("vale um fórum")) {
    return {
      chunks: [],
      toolUses: [
        { name: "suggest_forum_topic", input: { title: "Link mágico?", goal: "Trocar a senha.", agents: ["dev"] } },
      ],
    };
  }
  if (last.lastIndexOf("now write the") > last.lastIndexOf("your turn in round")) return { chunks: [PLAN] };
  return { chunks: ["Stance: proposes\nPosition: V1 pequena\n\nProponho uma V1 pequena."] };
}

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply });
});
afterEach(() => t.close());

type Topic = {
  id: string;
  status: string;
  phase: string;
  format: string;
  rounds: number;
  waitingUserId: string | null;
  seats: { type: string; id: string }[];
  origin: { kind: string; issueId: string | null; issueNumber: number | null };
  reopened: { byUserId: string } | null;
  track: { rounds: { round: number; entries: { status: string }[] }[] };
  posts: { kind: string; stance: { kind: string } | null; position: string | null }[];
  synthesis: {
    revision: number;
    format: string;
    structured: { format: string; steps?: { title: string }[] } | null;
    suggestedIssues: { title: string; description: string; step?: number }[];
  } | null;
};

test("forum API: a plan for an issue with a seated person, pass, sub-issues, a new round from a comment", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId, credentialId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const issue = (await (await api("/issues", { json: { title: "Captar lead pelo LinkedIn" } })).json()) as {
    id: string;
    number: number;
    createdBy: { id: string };
  };
  const me = issue.createdBy.id;
  const ops = (await (await api("/agents", { json: { name: "Ops", handle: "ops", credentialId } })).json()) as {
    id: string;
  };

  const created = await api("/forum/topics", {
    json: {
      title: "Como captar lead pelo LinkedIn?",
      goal: "Sair com um plano.",
      agentIds: [agentId, ops.id],
      rounds: 1,
      format: "plan",
      seats: [
        { type: "agent", id: agentId },
        { type: "person", id: me },
        { type: "agent", id: ops.id },
      ],
      originIssueId: issue.id,
    },
  });
  expect(created.status).toBe(201);
  const topic = (await created.json()) as Topic;
  expect(topic).toMatchObject({
    format: "plan",
    status: "open",
    origin: { kind: "issue", issueId: issue.id, issueNumber: issue.number },
  });
  expect(topic.seats.map((s) => s.type)).toEqual(["agent", "person", "agent"]);
  expect(JSON.stringify(topic)).not.toMatch(/budget|usd|cost/i);

  await t.drain();
  const waiting = (await (await api(`/forum/topics/${topic.id}`)).json()) as Topic;
  expect(waiting).toMatchObject({ phase: "waiting_person", waitingUserId: me });
  expect(waiting.posts[0]).toMatchObject({ kind: "turn", stance: { kind: "propose" }, position: "V1 pequena" });

  expect((await api(`/forum/topics/${topic.id}/pass`, { json: {} })).status).toBe(200);
  await t.drain();
  const done = (await (await api(`/forum/topics/${topic.id}`)).json()) as Topic;
  expect(done.status).toBe("done");
  expect(done.track.rounds[0]?.entries.map((e) => e.status)).toEqual(["spoke", "passed", "spoke"]);
  expect(done.synthesis).toMatchObject({ revision: 1, format: "plan", structured: { format: "plan" } });
  expect(done.synthesis?.structured?.steps?.map((s) => s.title)).toEqual(["Registrar o app", "Rota de OAuth"]);
  // Passing again is not your turn any more.
  expect((await api(`/forum/topics/${topic.id}/pass`, { json: {} })).status).toBe(400);

  // Approved issues become sub-issues of the origin issue.
  const made = await api(`/forum/topics/${topic.id}/issues`, { json: { items: done.synthesis?.suggestedIssues } });
  expect(made.status).toBe(200);
  const { issues } = (await made.json()) as { issues: { id: string }[] };
  expect(issues).toHaveLength(2);
  const detail = (await (await api(`/issues/${issue.id}`)).json()) as {
    subIssues: { id: string }[];
    forumTopics: { id: string; status: string }[];
  };
  expect(detail.subIssues.map((s) => s.id)).toEqual(issues.map((i) => i.id));
  expect(detail.forumTopics).toMatchObject([{ id: topic.id, status: "done" }]);
  const child = (await (await api(`/issues/${issues[0]?.id}`)).json()) as { parentIssueId: string };
  expect(child.parentIssueId).toBe(issue.id);

  // A new round from a comment: it reopens, only ops answers, and the synthesis becomes version 2.
  const post = await api(`/forum/topics/${topic.id}/posts`, {
    json: { body: "E o consentimento?", requestRound: { agentIds: [ops.id] } },
  });
  expect(post.status).toBe(201);
  const reopened = (await (await api(`/forum/topics/${topic.id}`)).json()) as Topic;
  expect(reopened).toMatchObject({ status: "open", rounds: 2, reopened: { byUserId: me } });
  await t.drain();
  const v2 = (await (await api(`/forum/topics/${topic.id}`)).json()) as Topic;
  expect(v2).toMatchObject({ status: "done", synthesis: { revision: 2 } });
  expect(v2.track.rounds[1]?.entries.map((e) => e.status)).toEqual(["skipped", "skipped", "spoke"]);
  expect((await api(`/forum/topics/${topic.id}/resume`, { json: {} })).status).toBe(400);
});

test("forum API: an agent's suggestion card is accepted or dismissed by a person", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const cards: string[] = [];
  for (const body of ["@dev vale um fórum?", "@dev vale um fórum de novo?"]) {
    await api(`/channels/${channelId}/messages`, { json: { body } });
    await t.drain();
    // Asked in the channel: the card is in the main timeline, the newest one is this ask's.
    const timeline = (await (await api(`/channels/${channelId}/messages`)).json()) as {
      messages: { id: string; meta?: Record<string, unknown> }[];
    };
    const card = timeline.messages.filter((m) => m.meta?.forumSuggestion).at(-1);
    expect(cards).not.toContain(card?.id ?? "");
    expect(card?.meta?.forumSuggestion).toMatchObject({ title: "Link mágico?", state: "pending" });
    cards.push(card?.id ?? "");
  }
  expect(((await (await api("/forum/topics")).json()) as { topics: unknown[] }).topics).toHaveLength(0);

  const accepted = await api(`/forum/suggestions/${cards[0]}/accept`, { json: { rounds: 1 } });
  expect(accepted.status).toBe(201);
  const result = (await accepted.json()) as { topic: Topic & { rounds: number }; suggestion: { state: string } };
  expect(result.topic).toMatchObject({ rounds: 1, origin: { kind: "suggestion" } });
  expect(result.suggestion.state).toBe("accepted");
  expect((await api(`/forum/suggestions/${cards[0]}/accept`, { json: {} })).status).toBe(409);
  const dismissed = await api(`/forum/suggestions/${cards[1]}/dismiss`, { json: {} });
  expect(await dismissed.json()).toMatchObject({ suggestion: { state: "dismissed" } });
  expect((await api(`/forum/suggestions/${crypto.randomUUID()}/dismiss`, { json: {} })).status).toBe(404);
});
