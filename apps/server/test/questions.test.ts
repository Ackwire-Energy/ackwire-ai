import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: [/answered: ([a-z]+)/.exec(last)?.[1] ?? "?"] };
      return {
        chunks: [],
        toolUses: [{ name: "ask_user", input: { question: "Qual ambiente?", choices: ["staging", "production"] } }],
      };
    },
  });
});
afterEach(() => t.close());

test("questions API: the card's answer resumes the agent; a second answer is a conflict", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  await api(`/channels/${channelId}/messages`, { json: { body: "@dev deploy it" } });
  await t.drain();
  // Asked in the channel: the card is in the main timeline.
  const timeline = (await (await api(`/channels/${channelId}/messages`)).json()) as {
    messages: { body: string; meta: { questionId?: string; question?: { status: string } } }[];
  };
  const card = timeline.messages.find((m) => m.meta.questionId);
  expect(card?.meta.question?.status).toBe("open");
  const id = card?.meta.questionId;

  expect(await (await api(`/questions/${id}`)).json()).toMatchObject({ id, status: "open", threadId: null });
  expect((await api(`/questions/${id}/answer`, { json: {} })).status).toBe(400);
  const res = await api(`/questions/${id}/answer`, { json: { choice: "production" } });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({
    id,
    status: "answered",
    answer: "production",
    choices: ["staging", "production"],
  });
  expect((await api(`/questions/${id}/answer`, { json: { text: "staging" } })).status).toBe(409);
  await t.drain();
  const after = (await (await api(`/channels/${channelId}/messages`)).json()) as {
    messages: { body: string }[];
  };
  expect(after.messages.at(-1)?.body).toBe("production");
});
