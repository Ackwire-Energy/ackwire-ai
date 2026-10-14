import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["done"], usage: { inputTokens: 100, outputTokens: 10 } }) });
});
afterEach(() => t.close());

test("management API: settings, overview, people, invitations, credentials, agent detail, runs, usage, channels", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId, credentialId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const patched = await api("/settings", {
    method: "PATCH",
    json: { context: "We ship on Tuesdays.", timezone: "America/Sao_Paulo" },
  });
  expect(await patched.json()).toMatchObject({
    context: "We ship on Tuesdays.",
    timezone: "America/Sao_Paulo",
    routerModel: null,
  });
  expect((await api("/settings", { method: "PATCH", json: { routerModel: "nope" } })).status).toBe(400);

  await api(`/channels/${channelId}/messages`, { json: { body: "@dev status?" } });
  await t.drain();

  const overview = (await (await api("/overview")).json()) as Record<string, number>;
  expect(overview).toMatchObject({ people: 1, agents: 1, approvalsWaitingForMe: 0 });
  expect(overview.myAgentsSpendUsd).toBeCloseTo((100 * 2000 + 10 * 10000) / 1e9);

  const people = (await (await api("/people")).json()) as { people: { email: string; online: boolean }[] };
  expect(people.people).toEqual([expect.objectContaining({ email: "owner@example.com", online: false })]);

  const batch = (await (
    await api("/invitations/batch", { json: { emails: ["a@example.com", "bad", "b@example.com"], role: "member" } })
  ).json()) as { results: { email: string; status: string; url?: string; invitationId?: string }[] };
  expect(batch.results.map((r) => r.status)).toEqual(["invited", "invalid_email", "invited"]);
  expect(batch.results[0]?.url).toContain("/invite/");
  const resent = (await (await api(`/invitations/${batch.results[0]?.invitationId}/resend`, { json: {} })).json()) as {
    url: string;
  };
  expect(resent.url).not.toBe(batch.results[0]?.url);
  const all = (await (await api("/invitations/all")).json()) as { invitations: { status: string }[] };
  expect(all.invitations.map((i) => i.status)).toEqual(["pending", "pending"]);

  const rotated = await api(`/credentials/${credentialId}/rotate`, { json: { apiKey: "sk-ant-new-key-7777" } });
  expect(await rotated.json()).toMatchObject({ id: credentialId, keyHint: "7777" });
  expect(await (await api("/credentials/platform")).json()).toEqual({ available: false });
  expect((await api(`/credentials/${credentialId}?purge=true`, { method: "DELETE" })).status).toBe(409);

  const detail = (await (await api(`/agents/${agentId}`)).json()) as Record<string, unknown>;
  expect(detail).toMatchObject({
    handle: "dev",
    runsThisMonth: 1,
    monthlyBudgetUsd: 50,
    channels: [{ id: channelId, name: "general", autoReply: true }],
  });

  const runs = (await (await api(`/runs?agentId=${agentId}`)).json()) as {
    runs: { id: string; costUsd: number; status: string }[];
  };
  expect(runs.runs).toHaveLength(1);
  expect(runs.runs[0]?.status).toBe("done");
  const run = (await (await api(`/runs/${runs.runs[0]?.id}`)).json()) as { steps: { kind: string }[] };
  expect(run.steps.map((s) => s.kind)).toEqual(["context", "model_call", "message"]);

  const usage = (await (await api("/usage/report")).json()) as {
    byKind: { kind: string; calls: number }[];
    totalUsd: number;
  };
  expect(usage.byKind).toEqual([expect.objectContaining({ kind: "agent", calls: 1 })]);

  const renamed = await api(`/channels/${channelId}`, { method: "PATCH", json: { topic: "All hands" } });
  expect(await renamed.json()).toMatchObject({ topic: "All hands" });
  const roster = (await (await api(`/channels/${channelId}/roster`)).json()) as {
    members: { type: string; name: string; handle: string | null }[];
  };
  expect(roster.members.map((m) => [m.type, m.name, m.handle])).toEqual([
    ["person", "owner", null],
    ["agent", "Dev", "dev"],
  ]);

  const set = await api(`/agents/${agentId}/channels`, {
    method: "PUT",
    json: { channels: [{ channelId, autoReply: false }] },
  });
  expect(await set.json()).toEqual({ channels: [{ id: channelId, name: "general", autoReply: false }] });
});

test("channel members API: add an agent with autoReply off, turn it on, roster shows it", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const room = (await (await api("/channels", { json: { name: "squad", visibility: "private" } })).json()) as {
    id: string;
  };
  expect((await api(`/channels/${room.id}/members`, { json: { agentId, autoReply: false } })).status).toBe(204);
  const roster = async () =>
    ((await (await api(`/channels/${room.id}/roster`)).json()) as { members: { autoReply: boolean | null }[] }).members;
  expect((await roster()).map((m) => m.autoReply)).toContain(false);
  const res = await api(`/channels/${room.id}/members/agents/${agentId}`, {
    method: "PATCH",
    json: { autoReply: true },
  });
  expect(res.status).toBe(204);
  expect((await roster()).map((m) => m.autoReply)).not.toContain(false);
  expect(
    (
      await api(`/channels/${room.id}/members/agents/${crypto.randomUUID()}`, {
        method: "PATCH",
        json: { autoReply: true },
      })
    ).status,
  ).toBe(404);
});
