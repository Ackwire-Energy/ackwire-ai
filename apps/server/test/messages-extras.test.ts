import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["done"], usage: { inputTokens: 100, outputTokens: 10 } }) });
});
afterEach(() => t.close());

test("agent messages carry model, tokens and cost; include=replies summarizes threads", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const root = (await (await api(`/channels/${channelId}/messages`, { json: { body: "@dev status?" } })).json()) as {
    id: string;
  };
  await t.drain();
  await api(`/channels/${channelId}/messages`, { json: { body: "valeu", threadId: root.id } });
  await api(`/channels/${channelId}/messages`, { json: { body: "sem thread" } });

  type Msg = {
    id: string;
    author: { type: string };
    usage?: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
    replies?: { count: number; lastAt: string | null; latest: { body: string }[] };
  };
  const thread = (await (await api(`/channels/${channelId}/messages?threadId=${root.id}`)).json()) as {
    messages: Msg[];
  };
  const reply = thread.messages.find((m) => m.author.type === "agent");
  expect(reply?.usage).toMatchObject({ model: "claude-sonnet-5-5", inputTokens: 100, outputTokens: 10 });
  expect(reply?.usage?.costUsd).toBeGreaterThan(0);
  expect(thread.messages.find((m) => m.author.type === "person")?.usage).toBeUndefined();

  const plain = (await (await api(`/channels/${channelId}/messages`)).json()) as { messages: Msg[] };
  expect(plain.messages.every((m) => m.replies === undefined)).toBe(true);
  const top = (await (await api(`/channels/${channelId}/messages?include=replies`)).json()) as { messages: Msg[] };
  const summary = top.messages.find((m) => m.id === root.id)?.replies;
  expect(summary?.count).toBe(2);
  expect(summary?.latest.map((m) => m.body)).toEqual(["done", "valeu"]);
  expect(summary?.lastAt).toBeTruthy();
  expect(top.messages.find((m) => m.id !== root.id)?.replies).toEqual({ count: 0, lastAt: null, latest: [] });
});
