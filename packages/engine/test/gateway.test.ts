import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { costNanoUsd, ProviderError } from "@agenteschat/providers";
import {
  agentSpendThisMonth,
  BudgetExceededError,
  MissingCredentialError,
  revokeCredential,
  updateAgent,
  usageSummary,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const call = (fx: Fixture, deltas: string[] = []) =>
  fx.gateway.stream({
    orgId: fx.org.id,
    agentId: fx.agent.id,
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 100,
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
  f = await setup({ budgetNanoUsd: 1, reply: () => ({ chunks: ["x"], usage: { inputTokens: 10, outputTokens: 10 } }) });
  await call(f); // spends more than 1 nano-USD
  await expect(call(f)).rejects.toBeInstanceOf(BudgetExceededError);
  expect(f.provider.calls).toHaveLength(1);
  expect(await f.db.select().from(schema.usageRecords)).toHaveLength(1);
});

test("budget resets with the calendar month", async () => {
  f = await setup({ budgetNanoUsd: 1 });
  await call(f);
  await f.db.update(schema.usageRecords).set({ createdAt: new Date("2020-01-15T00:00:00Z") });
  await call(f);
  expect(f.provider.calls).toHaveLength(2);
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
