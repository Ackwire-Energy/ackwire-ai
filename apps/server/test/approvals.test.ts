import { afterEach, beforeEach, expect, test } from "bun:test";
import { grantScopes, type ToolSource } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

const merged: Record<string, unknown>[] = [];
const github: ToolSource = {
  name: "test-github",
  tools: async () => [
    {
      name: "github_merge_pr",
      description: "Merge a pull request",
      scope: "github:pr.merge",
      inputSchema: { type: "object", properties: { pr: { type: "integer" } }, required: ["pr"] },
      describe: (i) => ({ title: `Merge PR #${i.pr}` }),
      execute: async (input) => {
        merged.push(input);
        return { content: "merged" };
      },
    },
  ],
};

let t: TestServer;
beforeEach(async () => {
  merged.length = 0;
  t = await createTestServer({
    toolSources: [github],
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("merged")) return { chunks: ["Merge done."] };
      if (last.includes("refused")) return { chunks: ["OK, leaving it."] };
      return {
        chunks: [],
        toolUses: [
          {
            name: "github_merge_pr",
            input: { pr: 42, why: "CI passed and the review is done: merging ships the fix today." },
          },
        ],
      };
    },
  });
});
afterEach(() => t.close());

test("approvals API: list, approve (resumes the run), and decisions are final", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  await grantScopes(t.db, orgId, agentId, [{ connectionId: null, scope: "github:pr.merge" }]);
  await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "@dev merge 42" } });
  await t.drain();

  const list = (await (await owner(`/api/app/organizations/${orgId}/approvals?status=pending`)).json()) as {
    approvals: { id: string; title: string; canDecide: boolean; params: unknown; messageId: string }[];
  };
  expect(list.approvals).toHaveLength(1);
  expect(list.approvals[0]).toMatchObject({ title: "Merge PR #42", canDecide: true, params: { pr: 42 } });
  const id = list.approvals[0]?.id;

  // Asked in the channel: the card is in the main timeline.
  const messages = (await (await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`)).json()) as {
    messages: { body: string; meta: Record<string, unknown> }[];
  };
  expect(messages.messages.at(-1)).toMatchObject({ body: "Approval request: Merge PR #42", meta: { approvalId: id } });

  const approved = await owner(`/api/app/organizations/${orgId}/approvals/${id}/approve`, { json: {} });
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({ status: "approved", canDecide: false });
  await t.drain();
  expect(merged).toEqual([{ pr: 42 }]);
  expect((await owner(`/api/app/organizations/${orgId}/approvals/${id}/refuse`, { json: {} })).status).toBe(409);
  const one = (await (await owner(`/api/app/organizations/${orgId}/approvals/${id}`)).json()) as { status: string };
  expect(one.status).toBe("approved");
});

test("approvals API: 'Aprovar tudo' decides exactly the ids sent and resumes the run once", async () => {
  await t.close();
  t = await createTestServer({
    toolSources: [github],
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("merged")) return { chunks: ["Both merged."] };
      const why = "CI passed and the review is done: merging ships the fix today.";
      return {
        chunks: [],
        toolUses: [
          { name: "github_merge_pr", input: { pr: 42, why } },
          { name: "github_merge_pr", input: { pr: 43, why } },
        ],
      };
    },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  await grantScopes(t.db, orgId, agentId, [{ connectionId: null, scope: "github:pr.merge" }]);
  await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "@dev merge both" } });
  await t.drain();
  const list = (await (await owner(`/api/app/organizations/${orgId}/approvals?status=pending`)).json()) as {
    approvals: { id: string; messageId: string }[];
  };
  expect(list.approvals).toHaveLength(2);
  // One card for both.
  expect(new Set(list.approvals.map((a) => a.messageId)).size).toBe(1);
  // The card's requests by the card, wherever the org's list stops.
  const cardId = list.approvals[0]?.messageId ?? "";
  const onCard = (await (await owner(`/api/app/organizations/${orgId}/approvals?messageId=${cardId}`)).json()) as {
    approvals: unknown[];
  };
  expect(onCard.approvals).toHaveLength(2);
  const elsewhere = (await (
    await owner(`/api/app/organizations/${orgId}/approvals?messageId=${crypto.randomUUID()}`)
  ).json()) as { approvals: unknown[] };
  expect(elsewhere.approvals).toHaveLength(0);
  const ids = list.approvals.map((a) => a.id);
  const res = await owner(`/api/app/organizations/${orgId}/approvals/decide`, {
    json: { ids, decision: "approve" },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { approvals: { status: string }[]; skipped: string[] };
  expect(body.approvals.map((a) => a.status)).toEqual(["approved", "approved"]);
  expect(body.skipped).toEqual([]);
  await t.drain();
  expect(merged.map((m) => m.pr).sort()).toEqual([42, 43]);
  expect(
    (await owner(`/api/app/organizations/${orgId}/approvals/decide`, { json: { ids: [], decision: "approve" } }))
      .status,
  ).toBe(400);
});
