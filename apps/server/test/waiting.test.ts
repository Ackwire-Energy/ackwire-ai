import { afterEach, expect, test } from "bun:test";
import { type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import { grantScopes, type ToolSource } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

interface Waiting {
  items: {
    id: string;
    kind: string;
    asker: { type: string; id: string } | null;
    source: Record<string, unknown>;
    question: string;
    since: string;
  }[];
  count: number;
}

const github: ToolSource = {
  name: "test-github",
  tools: async () => [
    {
      name: "github_merge_pr",
      description: "Merge a pull request",
      scope: "github:pr.merge",
      inputSchema: { type: "object", properties: { pr: { type: "integer" } }, required: ["pr"] },
      describe: (i) => ({ title: `Merge PR #${i.pr}` }),
      execute: async () => ({ content: "merged" }),
    },
  ],
};

test("GET /waiting lists an approval the person may decide, its conversation's only on request, and the person's topic hears it come and go", async () => {
  t = await createTestServer({
    // The person from another workspace signs up too.
    env: { ALLOW_SIGNUP: "true" },
    toolSources: [github],
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("merged")) return { chunks: ["Merge done."] };
      return {
        chunks: [],
        toolUses: [
          { name: "github_merge_pr", input: { pr: 42, why: "CI passed and the review is done: merging ships it." } },
        ],
      };
    },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const me = (await (await owner("/api/app/me")).json()) as { user: { id: string } };
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const heard: RealtimeEvent[] = [];
  await t.adapters.pubsub.subscribe(userTopic(orgId, me.user.id), (e) => heard.push(e));

  expect(await (await api("/waiting")).json()).toEqual({ items: [], count: 0 });

  await grantScopes(t.db, orgId, agentId, [{ connectionId: null, scope: "github:pr.merge" }]);
  await api(`/channels/${channelId}/messages`, { json: { body: "@dev merge 42" } });
  await t.drain();

  const waiting = (await (await api("/waiting")).json()) as Waiting;
  expect(waiting.count).toBe(1);
  expect(waiting.items[0]).toMatchObject({
    kind: "approval",
    asker: { type: "agent", id: agentId },
    question: "Merge PR #42",
    source: { channelId },
  });
  expect(((await (await api(`/waiting?channelId=${channelId}`)).json()) as Waiting).count).toBe(1);
  expect(((await (await api(`/waiting?channelId=${crypto.randomUUID()}`)).json()) as Waiting).count).toBe(0);
  expect((await api("/waiting?channelId=nope")).status).toBe(400);
  expect(heard.some((e) => e.type === "notification.upserted")).toBe(true);
  expect(heard.some((e) => e.type === "notification.counts" && (e as { waiting?: number }).waiting === 1)).toBe(true);

  const approvalId = waiting.items[0]?.source.approvalId;
  expect((await api(`/approvals/${approvalId}/approve`, { json: {} })).status).toBe(200);
  expect(await (await api("/waiting")).json()).toEqual({ items: [], count: 0 });
  expect(heard.some((e) => e.type === "notification.removed")).toBe(true);

  // Signed out, or another workspace's person: nothing.
  expect((await browser(t)(`/api/app/organizations/${orgId}/waiting`)).status).toBe(401);
  const outsider = browser(t);
  await signUp(outsider, "outsider@example.com");
  expect([403, 404]).toContain((await outsider(`/api/app/organizations/${orgId}/waiting`)).status);
});
