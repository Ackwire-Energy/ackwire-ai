import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

test("issues API: create, by number, patch, criteria, comments, activity, ask agent, from a message", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const created = await api("/issues", { json: { title: "Login quebra", criteria: ["Funciona no Safari"] } });
  expect(created.status).toBe(201);
  const issue = (await created.json()) as { id: string; number: number; criteria: { id: string }[] };
  expect(issue.number).toBe(1);
  expect(await (await api("/issues/by-number/1")).json()).toMatchObject({ id: issue.id, title: "Login quebra" });
  expect(
    await (await api(`/issues/${issue.id}`, { method: "PATCH", json: { status: "in_progress" } })).json(),
  ).toMatchObject({
    status: "in_progress",
  });
  const criterion = await api(`/issues/${issue.id}/criteria/${issue.criteria[0]?.id}`, {
    method: "PUT",
    json: { done: true },
  });
  expect(((await criterion.json()) as { criteria: { done: boolean }[] }).criteria[0]?.done).toBe(true);
  expect((await api(`/issues/${issue.id}/comments`, { json: { text: "Olhando" } })).status).toBe(201);

  const asked = await api(`/issues/${issue.id}/ask-agent`, { json: { agentId } });
  expect(await asked.json()).toMatchObject({ assignee: { type: "agent", id: agentId } });
  await t.drain();
  const activity = (await (await api(`/issues/${issue.id}/activity`)).json()) as {
    activity: { kind: string; event?: string; author: { type: string }; text: string }[];
  };
  expect(activity.activity.map((a) => a.event ?? a.kind)).toEqual([
    "created",
    "status_changed",
    "criterion_checked",
    "comment",
    "assigned",
    "agent_asked",
    "comment",
  ]);
  expect(activity.activity.at(-1)).toMatchObject({ author: { type: "agent" }, text: "Feito." });

  const message = (await (
    await api(`/channels/${channelId}/messages`, { json: { body: "Bug no checkout" } })
  ).json()) as {
    id: string;
  };
  const fromMessage = await api(`/messages/${message.id}/issue`, { json: {} });
  expect(await fromMessage.json()).toMatchObject({ number: 2, title: "Bug no checkout", source: { type: "message" } });
  const list = (await (await api("/issues")).json()) as { issues: { number: number }[] };
  expect(list.issues.map((i) => i.number).sort()).toEqual([1, 2]);
});
