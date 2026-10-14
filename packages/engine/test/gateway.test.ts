import { afterEach, expect, test } from "bun:test";
import { envPlatformCredentials, noPlatformCredentials } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { costNanoUsd, maxCostNanoUsd, ProviderError, promptChars } from "@agenteschat/providers";
import {
  agentBudgetState,
  agentSpendThisMonth,
  BudgetExceededError,
  createCredential,
  createModelGateway,
  listCredentials,
  MissingCredentialError,
  revokeCredential,
  rotateCredential,
  updateAgent,
  usageSummary,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const call = (fx: Fixture, deltas: string[] = [], maxTokens = 100) =>
  fx.gateway.stream({
    orgId: fx.org.id,
    agentId: fx.agent.id,
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens,
    onDelta: (d) => deltas.push(d),
  });

test("decrypts the org credential, streams, and records tokens and cost with org and agent", async () => {
  f = await setup({
    reply: () => ({ chunks: ["Hi", " there"], usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50 } }),
  });
  const deltas: string[] = [];
  const result = await call(f, deltas);
  expect(deltas).toEqual(["Hi", " there"]);
  expect(f.provider.calls[0]?.apiKey).toBe("sk-ant-test-key-1234");
  expect(f.provider.calls[0]?.request.model).toBe("claude-sonnet-5-5");
  const expected = 1000 * 2000 + 200 * 10000 + 50 * 200;
  expect(result.costNanoUsd).toBe(expected);
  const [record] = await f.db.select().from(schema.usageRecords);
  expect(record).toMatchObject({
    orgId: f.org.id,
    agentId: f.agent.id,
    credentialId: f.credential.id,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 50,
    costNanoUsd: expected,
  });
  expect(await agentSpendThisMonth(f.db, f.org.id, f.agent.id)).toBe(expected);
});

test("budget is checked BEFORE the call: an exhausted agent never reaches the provider", async () => {
  f = await setup({ budgetNanoUsd: 0 });
  await expect(call(f)).rejects.toBeInstanceOf(BudgetExceededError);
  expect(f.provider.calls).toHaveLength(0);
  expect(await f.db.select().from(schema.usageRecords)).toHaveLength(0);
});

test("concurrent calls reserve the worst case atomically and can't overshoot the budget", async () => {
  // Each call may cost at most this (prompt at the cache-write rate, 300 output tokens).
  const prompt = Math.ceil(promptChars({ system: "sys", messages: [{ role: "user", content: "hello" }] }) / 3);
  const worst = maxCostNanoUsd("claude-sonnet-5-5", prompt, 300);
  f = await setup({
    budgetNanoUsd: worst * 2,
    reply: () => ({ chunks: ["x"], usage: { inputTokens: 2, outputTokens: 1 } }),
  });
  // Hold every model call open until all five tried to reserve: reservations overlap for real.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const held = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    platformCredentials: noPlatformCredentials,
    providers: {
      anthropic: {
        id: "anthropic",
        stream: async (req, opts) => {
          await gate;
          return f.provider.stream(req, opts);
        },
      },
    },
  });
  const attempts = [1, 2, 3, 4, 5].map(() =>
    held.stream({
      orgId: f.org.id,
      agentId: f.agent.id,
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 300,
      onDelta: () => {},
    }),
  );
  const settled = Promise.allSettled(attempts);
  await Bun.sleep(100);
  release();
  const calls = await settled;
  expect(calls.filter((c) => c.status === "fulfilled")).toHaveLength(2);
  for (const c of calls.filter((c) => c.status === "rejected")) {
    expect((c as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededError);
  }
  // Settled to the actual cost: the reservation is gone, spend is what the provider reported.
  const state = await agentBudgetState(f.db, f.org.id, f.agent.id);
  const actual = costNanoUsd("claude-sonnet-5-5", {
    inputTokens: 2,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  expect(state).toEqual({ spentNanoUsd: actual * 2, reservedNanoUsd: 0 });
  expect(await f.db.select().from(schema.budgetReservations)).toHaveLength(0);
  // With the reservations released, the next call fits again.
  await call(f, [], 300);
});

test("the output cap shrinks to fit the remaining budget", async () => {
  const prompt = Math.ceil(promptChars({ system: "sys", messages: [{ role: "user", content: "hello" }] }) / 3);
  f = await setup({ budgetNanoUsd: maxCostNanoUsd("claude-sonnet-5-5", prompt, 400) });
  const result = await call(f, [], 10_000);
  expect(result.maxTokens).toBe(400);
  expect(f.provider.calls[0]?.request.maxTokens).toBe(400);
});

test("an abandoned reservation (crashed worker) stops counting once it expires", async () => {
  f = await setup({ budgetNanoUsd: 1_000_000_000 });
  await call(f);
  await f.db.insert(schema.budgetReservations).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    periodStart: `${new Date().toISOString().slice(0, 8)}01`,
    amountNanoUsd: 999_000_000,
    expiresAt: new Date(Date.now() - 1000),
  });
  await f.db.update(schema.agentBudgetPeriods).set({ reservedNanoUsd: 999_000_000 });
  await call(f, [], 100);
  expect(await f.db.select().from(schema.budgetReservations)).toHaveLength(0);
  expect((await agentBudgetState(f.db, f.org.id, f.agent.id)).reservedNanoUsd).toBe(0);
});

test("budget resets with the calendar month", async () => {
  f = await setup({ budgetNanoUsd: 50_000_000 });
  await call(f);
  await f.db.update(schema.agentBudgetPeriods).set({ spentNanoUsd: 50_000_000 });
  await expect(call(f)).rejects.toBeInstanceOf(BudgetExceededError);
  const nextMonth = new Date();
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 2);
  const later = createModelGateway({
    db: f.db,
    keyWrappers: [f.keyWrapper],
    providers: { anthropic: f.provider },
    platformCredentials: noPlatformCredentials,
    now: () => nextMonth,
  });
  await later.stream({
    orgId: f.org.id,
    agentId: f.agent.id,
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 100,
    onDelta: () => {},
  });
  expect(f.provider.calls).toHaveLength(2);
});

test("a stream that fails midway records partial usage (provider's input count) and releases the reservation", async () => {
  f = await setup({
    budgetNanoUsd: 1_000_000_000,
    reply: () => ({ chunks: ["Half an ans", "wer"], failMidStream: { inputTokens: 500 } }),
  });
  await expect(call(f)).rejects.toBeInstanceOf(ProviderError);
  const [record] = await f.db.select().from(schema.usageRecords);
  expect(record).toMatchObject({
    partial: true,
    inputTokens: 500,
    outputTokens: 4,
    kind: "agent",
    agentId: f.agent.id,
  });
  expect(record?.costNanoUsd).toBe(500 * 2000 + 4 * 10000);
  expect(await agentBudgetState(f.db, f.org.id, f.agent.id)).toEqual({
    spentNanoUsd: record?.costNanoUsd ?? -1,
    reservedNanoUsd: 0,
  });
  expect(f.provider.countCalls).toHaveLength(0);
});

test("partial usage without the provider's input count uses the count-tokens API", async () => {
  f = await setup({ reply: () => ({ chunks: ["abc"], failMidStream: { inputTokens: null } }) });
  await expect(call(f)).rejects.toBeInstanceOf(ProviderError);
  expect(f.provider.countCalls).toHaveLength(1);
  const [record] = await f.db.select().from(schema.usageRecords);
  expect(record?.partial).toBe(true);
  expect(record?.inputTokens).toBeGreaterThan(0);
  expect(record?.outputTokens).toBe(1);
});

test("org calls (router) use the org's credential, have no agent and record their kind", async () => {
  f = await setup({ reply: () => ({ chunks: ['{"ok":true}'], usage: { inputTokens: 40, outputTokens: 5 } }) });
  const result = await f.gateway.complete({
    orgId: f.org.id,
    kind: "router",
    model: "claude-haiku-5-5",
    system: "route",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 100,
    outputSchema: { type: "object" },
  });
  expect(result.text).toBe('{"ok":true}');
  expect(f.provider.calls[0]?.request).toMatchObject({ model: "claude-haiku-5-5", outputSchema: { type: "object" } });
  expect(f.provider.calls[0]?.apiKey).toBe("sk-ant-test-key-1234");
  const [record] = await f.db.select().from(schema.usageRecords);
  expect(record).toMatchObject({ kind: "router", agentId: null, orgId: f.org.id, credentialId: f.credential.id });
  expect(record?.costNanoUsd).toBe(40 * 100 + 5 * 500);
});

test("org calls prefer the org's default credential", async () => {
  f = await setup();
  const second = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "anthropic",
    label: "router",
    apiKey: "sk-ant-router-key-5555",
  });
  const org = {
    orgId: f.org.id,
    kind: "router" as const,
    model: "claude-haiku-5-5",
    system: "s",
    messages: [{ role: "user" as const, content: "x" }],
    maxTokens: 10,
  };
  await f.gateway.complete(org);
  expect(f.provider.calls[0]?.apiKey).toBe("sk-ant-router-key-5555"); // newest
  await f.db.insert(schema.organizationSettings).values({ orgId: f.org.id, defaultCredentialId: f.credential.id });
  await f.gateway.complete(org);
  expect(f.provider.calls[1]?.apiKey).toBe("sk-ant-test-key-1234");
  expect(second.id).not.toBe(f.credential.id);
});

test("prices by the model that answered after a server-side fallback", async () => {
  f = await setup({
    reply: () => ({ chunks: ["x"], model: "claude-opus-5-5", usage: { inputTokens: 100, outputTokens: 10 } }),
  });
  const result = await call(f);
  expect(result.costNanoUsd).toBe(
    costNanoUsd("claude-opus-5-5", { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  );
  const [record] = await f.db.select().from(schema.usageRecords);
  expect([record?.model, record?.requestedModel]).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
});

test("no credential: core has no platform key; a module can provide one", async () => {
  f = await setup();
  await revokeCredential(f.db, f.owner.id, f.org.id, f.credential.id);
  await expect(call(f)).rejects.toBeInstanceOf(MissingCredentialError);
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: null });
  await expect(call(f)).rejects.toBeInstanceOf(MissingCredentialError);
  await f.close();

  f = await setup({ platform: { resolve: async () => ({ apiKey: "platform-key" }) } });
  await f.db.update(schema.agents).set({ credentialId: null }).where(eq(schema.agents.id, f.agent.id));
  await call(f);
  expect(f.provider.calls[0]?.apiKey).toBe("platform-key");
  expect((await f.db.select().from(schema.usageRecords))[0]?.credentialId).toBeNull();
});

test("provider errors propagate and record no usage", async () => {
  f = await setup({ reply: () => new ProviderError("overloaded", true, 529) });
  await expect(call(f)).rejects.toBeInstanceOf(ProviderError);
  expect(await f.db.select().from(schema.usageRecords)).toHaveLength(0);
});

test("usage summary needs view_usage", async () => {
  f = await setup();
  await call(f);
  const member = await addMember(f.db, f.org.id, "member");
  await expect(usageSummary(f.db, member.id, f.org.id)).rejects.toThrow();
  const [row] = await usageSummary(f.db, f.owner.id, f.org.id);
  expect(row?.handle).toBe("dev");
  expect(row?.calls).toBe(1);
});

test("workspace-scoped keys: the credential's workspace id (and the platform's) reaches the provider", async () => {
  f = await setup({
    platform: envPlatformCredentials({ anthropic: { apiKey: "sk-platform-key", workspaceId: "wrkspc_platform" } }),
  });
  await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, f.credential.id, {
    apiKey: "sk-ant-test-key-1234",
    workspaceId: "wrkspc_01abc",
  });
  await call(f);
  expect(f.provider.calls[0]).toMatchObject({ apiKey: "sk-ant-test-key-1234", workspaceId: "wrkspc_01abc" });
  const [listed] = await listCredentials(f.db, f.owner.id, f.org.id);
  expect(listed?.workspaceIdHint).toBe("_01abc");
  expect(JSON.stringify(listed)).not.toContain("sk-ant");
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { credentialId: null });
  await call(f);
  expect(f.provider.calls[1]).toMatchObject({ apiKey: "sk-platform-key", workspaceId: "wrkspc_platform" });
  expect((await f.db.select().from(schema.usageRecords)).map((u) => u.orgId)).toEqual([f.org.id, f.org.id]);
  await expect(
    rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, f.credential.id, {
      apiKey: "sk-ant-x-12345678",
      workspaceId: "bad id!",
    }),
  ).rejects.toThrow("workspaceId");
});
