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
      return { chunks: [], toolUses: [{ name: "github_merge_pr", input: { pr: 42 } }] };
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

  // Asked in the channel: the card is in the main timeline (D67).
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
