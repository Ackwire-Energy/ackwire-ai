import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  ConflictError,
  createAgent,
  createCredential,
  drainOutbox,
  listCredentials,
  makeDefaultCredential,
  postPersonMessage,
  resolveRouterModel,
  resolveSummaryModel,
  revokeCredential,
  updateOrgSettings,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const openaiKey = (fx: Fixture, extra: Partial<Parameters<typeof createCredential>[4]> = {}) =>
  createCredential(fx.db, fx.keyWrapper, fx.owner.id, fx.org.id, {
    provider: "openai",
    label: "openai",
    apiKey: "sk-proj-openai-9999",
    organization: "org-abc",
    project: "proj_123",
    ...extra,
  });

describe("credentials per provider", () => {
  test("an OpenAI agent uses the org's OpenAI key (with org/project) and is priced by its model", async () => {
    f = await setup({ reply: () => ({ chunks: ["oi"], usage: { inputTokens: 1000, outputTokens: 100 } }) });
    await openaiKey(f, { makeDefault: true });
    const gpt = await createAgent(f.db, f.owner.id, f.org.id, { name: "Gpt", handle: "gpt" }, { model: "gpt-6-sol" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: gpt.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@gpt hi" });
    await drainOutbox(f.db, f.handlers);
    expect(f.openaiProvider.calls[0]).toMatchObject({ apiKey: "sk-proj-openai-9999" });
    expect(f.provider.calls).toHaveLength(0);
    const [usage] = await f.db.select().from(schema.usageRecords);
    expect(usage).toMatchObject({ provider: "openai", model: "gpt-6-sol", costNanoUsd: 1000 * 2000 + 100 * 10000 });
  });

  test("no key for the model's provider: the run fails with a clear message", async () => {
    f = await setup();
    const gpt = await createAgent(f.db, f.owner.id, f.org.id, { name: "Gpt", handle: "gpt" }, { model: "gpt-6-luna" });
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: gpt.id });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@gpt hi" });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({
      status: "failed",
      error: "Add an API key for OpenAI in the workspace settings",
    });
  });

  test("an agent's key must match its model's provider", async () => {
    f = await setup();
    const key = await openaiKey(f);
    await expect(
      createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name: "X", handle: "x", model: "claude-sonnet-5-5", credentialId: key.id },
        { model: "x" },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("defaults per provider: make default in one call, 'Tornar padrão', can't remove a default", async () => {
    f = await setup();
    const a = await openaiKey(f, { makeDefault: true });
    const b = await openaiKey(f, { label: "second" });
    let list = await listCredentials(f.db, f.owner.id, f.org.id);
    expect(list.filter((c) => c.isDefault).map((c) => c.id)).toEqual([a.id]);
    await expect(revokeCredential(f.db, f.owner.id, f.org.id, a.id)).rejects.toBeInstanceOf(ConflictError);
    await makeDefaultCredential(f.db, f.owner.id, f.org.id, b.id);
    list = await listCredentials(f.db, f.owner.id, f.org.id);
    expect(list.filter((c) => c.isDefault && c.provider === "openai").map((c) => c.id)).toEqual([b.id]);
    await revokeCredential(f.db, f.owner.id, f.org.id, a.id);
    const [settings] = await f.db
      .select()
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.orgId, f.org.id));
    expect(settings?.defaultCredentialIds).toEqual({ openai: b.id });
    await expect(
      updateOrgSettings(f.db, f.owner.id, f.org.id, { defaultCredentialIds: { anthropic: b.id } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("router fallback and summaries use the cheap model of the org's default key's provider", async () => {
    f = await setup();
    expect(await resolveRouterModel(f.db, f.org.id, "claude-haiku-5-5", { openai: "gpt-6-luna" })).toBe(
      "claude-haiku-5-5",
    );
    await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
    await openaiKey(f, { makeDefault: true });
    expect(await resolveRouterModel(f.db, f.org.id, "claude-haiku-5-5", { openai: "gpt-6-luna" })).toBe("gpt-6-luna");
    expect(await resolveSummaryModel({ ...f.context, cheapModels: { openai: "gpt-6-luna" } }, f.org.id)).toBe(
      "gpt-6-luna",
    );
  });
});
