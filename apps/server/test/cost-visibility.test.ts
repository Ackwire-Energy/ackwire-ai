import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({
    env: { ALLOW_SIGNUP: "true" },
    reply: () => ({ chunks: ["done"], usage: { inputTokens: 100, outputTokens: 10 } }),
  });
});
afterEach(() => t.close());

/** Owner with @dev (US$ 50) and a member who joined by invitation. */
async function workspace() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const member = browser(t);
  await signUp(member, "ana@example.com");
  const { url } = (await (
    await owner(`/api/app/organizations/${seeded.orgId}/invitations`, {
      json: { email: "ana@example.com", role: "member" },
    })
  ).json()) as { url: string };
  await member(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const api = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return { ...seeded, owner: api(owner), member: api(member) };
}

const money = /usd|cost/i;

test("members never receive money: only percentages and tokens", async () => {
  const w = await workspace();
  await w.owner(`/channels/${w.channelId}/messages`, { json: { body: "@dev status?" } });
  await t.drain();

  for (const path of [
    "/overview",
    "/agents",
    `/agents/${w.agentId}`,
    "/settings",
    `/channels/${w.channelId}/messages`,
    "/routines",
  ]) {
    const res = await w.member(path);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(money);
  }
  const overview = (await (await w.member("/overview")).json()) as { budgetUsedPercent: number };
  expect(typeof overview.budgetUsedPercent).toBe("number");
  const detail = (await (await w.member(`/agents/${w.agentId}`)).json()) as Record<string, unknown>;
  expect(detail.budgetUsedPercent).toBe(0);
  expect(detail).not.toHaveProperty("monthlyBudgetUsd");
  const agents = (await (await w.member("/agents")).json()) as { agents: Record<string, unknown>[] };
  expect(agents.agents[0]).toMatchObject({ handle: "dev", budgetUsedPercent: 0 });

  // The money screens stay closed.
  expect((await w.member("/usage/report")).status).toBe(403);
  expect((await w.member("/usage")).status).toBe(403);
});

test("admins see and set the budgets: the workspace default and each agent's", async () => {
  const w = await workspace();
  const settings = (await (await w.owner("/settings")).json()) as { defaultAgentBudgetUsd: number };
  expect(settings.defaultAgentBudgetUsd).toBe(50);
  const patched = await w.owner("/settings", { method: "PATCH", json: { defaultAgentBudgetUsd: 20 } });
  expect(await patched.json()).toMatchObject({ defaultAgentBudgetUsd: 20 });
  expect((await w.owner("/settings", { method: "PATCH", json: { defaultAgentBudgetUsd: 0 } })).status).toBe(400);
  expect((await w.member("/settings", { method: "PATCH", json: { defaultAgentBudgetUsd: 1 } })).status).toBe(403);

  // An agent created without a budget follows the default; the admin can give it its own.
  const ops = (await (await w.owner("/agents", { json: { name: "Ops", handle: "ops" } })).json()) as {
    id: string;
    monthlyBudgetUsd: number | null;
  };
  expect(ops.monthlyBudgetUsd).toBeNull();
  expect(await (await w.owner(`/agents/${ops.id}`)).json()).toMatchObject({
    monthlyBudgetUsd: null,
    defaultBudgetUsd: 20,
    budgetUsedPercent: 0,
  });
  const own = await w.owner(`/agents/${ops.id}`, { method: "PATCH", json: { monthlyBudgetUsd: 80 } });
  expect(await own.json()).toMatchObject({ monthlyBudgetUsd: 80 });
  const detail = (await (await w.owner(`/agents/${ops.id}`)).json()) as Record<string, unknown>;
  expect(detail.monthlyBudgetUsd).toBe(80);
  expect(detail).not.toHaveProperty("defaultBudgetUsd");
});

test("a forum topic has no spend cap of its own and shows no money", async () => {
  const w = await workspace();
  const res = await w.member("/forum/topics", {
    json: { title: "Pricing", goal: "Pick a plan", agentIds: [w.agentId], budgetUsd: 5 },
  });
  expect(res.status).toBe(201);
  const topic = (await res.json()) as Record<string, unknown>;
  // Each agent runs on its own budget: no cap and no percentage on the topic.
  expect(topic).not.toHaveProperty("budgetUsedPercent");
  expect(JSON.stringify(topic)).not.toMatch(money);
});
