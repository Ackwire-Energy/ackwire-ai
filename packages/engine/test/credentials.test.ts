import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { runMigration } from "@agenteschat/db/testing";
import { customModelId, ProviderError } from "@agenteschat/providers";
import {
  checkCredential,
  createAgent,
  createCredential,
  decryptCredential,
  defaultCredentials,
  deleteCredential,
  ForbiddenError,
  listCredentials,
  NEW_AGENT_DEFAULTS,
  openRouterInUse,
  removeCredentialCopies,
  revokeCredential,
  rotateCredential,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

test("the API key is stored encrypted; only a 4-character hint is readable", async () => {
  const [row] = await f.db
    .select()
    .from(schema.providerCredentials)
    .where(eq(schema.providerCredentials.id, f.credential.id));
  expect(JSON.stringify(row)).not.toContain("sk-ant-test-key");
  expect(row?.keyHint).toBe("1234");
  const listed = await listCredentials(f.db, f.owner.id, f.org.id);
  expect(JSON.stringify(listed)).not.toContain("sk-ant");
  expect(Object.keys(listed[0] ?? {})).not.toContain("secretCiphertext");
});

test("decrypts for its own organization only", async () => {
  expect(await decryptCredential(f.db, [f.keyWrapper], f.org.id, f.credential.id)).toEqual({
    provider: "anthropic",
    apiKey: "sk-ant-test-key-1234",
    options: {},
  });
  const [other] = await f.db.insert(schema.organizations).values({ name: "Other" }).returning();
  expect(await decryptCredential(f.db, [f.keyWrapper], other?.id ?? "", f.credential.id)).toBeNull();
});

test("a ciphertext moved to another organization can't be decrypted", async () => {
  const [other] = await f.db.insert(schema.organizations).values({ name: "Other" }).returning();
  await f.db
    .update(schema.providerCredentials)
    .set({ orgId: other?.id })
    .where(eq(schema.providerCredentials.id, f.credential.id));
  await expect(decryptCredential(f.db, [f.keyWrapper], other?.id ?? "", f.credential.id)).rejects.toThrow();
});

test("revoked credentials can't be used", async () => {
  await revokeCredential(f.db, f.owner.id, f.org.id, f.credential.id);
  expect(await decryptCredential(f.db, [f.keyWrapper], f.org.id, f.credential.id)).toBeNull();
});

test("only admins and owners manage credentials", async () => {
  const member = await addMember(f.db, f.org.id, "member");
  await expect(
    createCredential(f.db, f.keyWrapper, member.id, f.org.id, {
      provider: "anthropic",
      label: "x",
      apiKey: "sk-ant-abcdefgh",
    }),
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(listCredentials(f.db, member.id, f.org.id)).rejects.toBeInstanceOf(ForbiddenError);
  const admin = await addMember(f.db, f.org.id, "admin");
  expect((await listCredentials(f.db, admin.id, f.org.id)).length).toBe(1);
});

test('the label migration calls keys named after the provider "Claude" and leaves names people chose', async () => {
  const add = (provider: "anthropic" | "openai", label: string) =>
    createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider,
      label,
      apiKey: `sk-test-key-${label.length}-5678`,
    });
  const named = await add("anthropic", "Anthropic");
  const chosen = await add("anthropic", "Anthropic da Acme");
  const openai = await add("openai", "Anthropic");
  await runMigration(f.db, "claude_chatgpt_labels");
  await runMigration(f.db, "claude_chatgpt_labels");
  const rows = await f.db
    .select({ id: schema.providerCredentials.id, label: schema.providerCredentials.label })
    .from(schema.providerCredentials);
  expect(Object.fromEntries(rows.map((r) => [r.id, r.label]))).toEqual({
    [f.credential.id]: "main",
    [named.id]: "Claude",
    [chosen.id]: "Anthropic da Acme",
    [openai.id]: "Anthropic",
  });
});

describe("a key's test call", () => {
  const input = { provider: "openai", label: "OpenAI", apiKey: "sk-new-test-key-9876" } as const;
  const save = (verify: Parameters<typeof createCredential>[5]) =>
    createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, input, verify);
  const stored = async () => (await listCredentials(f.db, f.owner.id, f.org.id)).filter((c) => c.provider === "openai");

  test("no credit: nothing is kept, and the provider's name and words come back", async () => {
    const verify = async () => ({ state: "refused" as const, refusal: "no_credit" as const, said: "Add credit." });
    const error = await save({ verify }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({
      code: "provider_key_no_credit",
      params: { provider: "OpenAI", said: "Add credit." },
    });
    expect(await stored()).toEqual([]);
  });

  test("a provider that can't be reached doesn't stop the save, and says it wasn't checked", async () => {
    const saved = await save({ verify: async () => ({ state: "unchecked" }) });
    expect(saved.check).toBe("unchecked");
    expect(await stored()).toHaveLength(1);
  });

  test("a passed call is recorded on the key it tested", async () => {
    const ids: string[] = [];
    const record = async (id: string) => void ids.push(id);
    const saved = await save({ verify: async () => ({ state: "ok", record }) });
    expect(saved.check).toBe("ok");
    expect(ids).toEqual([saved.id]);
  });

  test("the gateway makes the real call, says what it means and keeps no secret in the words", async () => {
    const said =
      "provider rejected the request (400 invalid_request_error): Your credit balance is too low sk-new-test-key-9876";
    const g = await setup({ reply: () => new ProviderError(said, false, 400) });
    const key = { orgId: g.org.id, provider: "anthropic", key: { apiKey: "sk-new-test-key-9876" } };
    const out = await g.gateway.verifyKey(key);
    expect(out).toMatchObject({ state: "refused", refusal: "no_credit" });
    expect(JSON.stringify(out)).not.toContain("sk-new-test-key");
    await g.close();
    const limited = await setup({ reply: () => new ProviderError("rate limited by provider", true, 429) });
    expect(await limited.gateway.verifyKey({ ...key, orgId: limited.org.id })).toEqual({ state: "unchecked" });
    await limited.close();
    const fine = await setup();
    const passed = await fine.gateway.verifyKey({ ...key, orgId: fine.org.id });
    expect(passed.state).toBe("ok");
    await fine.close();
  });

  test("a stored key is tried again before an agent is pointed at it", async () => {
    const g = await setup({ reply: () => new ProviderError("no prepaid credit left at the provider", false, 402) });
    await expect(checkCredential(g.db, g.gateway, g.owner.id, g.org.id, g.credential.id)).rejects.toMatchObject({
      code: "provider_key_no_credit",
    });
    await g.close();
    expect(await checkCredential(f.db, f.gateway, f.owner.id, f.org.id, f.credential.id)).toBe("ok");
  });
});

describe("removing a key", () => {
  const usingAgent = () =>
    createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Rio", handle: "rio", role: "x", instructions: "x", credentialId: f.credential.id },
      NEW_AGENT_DEFAULTS,
    );

  test("in use: refused with who uses it, and the list says so first", async () => {
    await usingAgent();
    const listed = await listCredentials(f.db, f.owner.id, f.org.id);
    expect(listed.find((c) => c.id === f.credential.id)?.usedBy?.map((a) => a.name)).toContain("Rio");
    await expect(deleteCredential(f.db, f.owner.id, f.org.id, f.credential.id)).rejects.toMatchObject({
      code: "credential.in_use",
    });
  });

  test("an agent with no key of its own counts on the key its calls take, a plan's agent doesn't", async () => {
    const usedByOf = async (id: string) =>
      (await listCredentials(f.db, f.owner.id, f.org.id)).find((c) => c.id === id)?.usedBy?.map((a) => a.name);
    const rio = await usingAgent();
    await f.db.update(schema.agents).set({ credentialId: null }).where(eq(schema.agents.id, rio.id));
    expect(await usedByOf(f.credential.id)).toContain("Rio");
    await f.db.update(schema.agents).set({ brain: "claude_code" }).where(eq(schema.agents.id, rio.id));
    expect(await usedByOf(f.credential.id)).not.toContain("Rio");
  });

  test("with `release` it goes: the agents lose it, its default too, and the row is gone", async () => {
    const agent = await usingAgent();
    const defaults = {
      defaultCredentialId: f.credential.id,
      defaultCredentialIds: { anthropic: f.credential.id, openai: "x" },
    };
    await f.db
      .insert(schema.organizationSettings)
      .values({ orgId: f.org.id, ...defaults })
      .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: defaults });
    await deleteCredential(f.db, f.owner.id, f.org.id, f.credential.id, { release: true });
    expect(await listCredentials(f.db, f.owner.id, f.org.id)).toEqual([]);
    const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, agent.id));
    expect(row?.credentialId).toBeNull();
    expect(await defaultCredentials(f.db, f.org.id)).toEqual({ legacy: null, perProvider: { openai: "x" } });
  });

  test("a default key alone is refused until the person goes on", async () => {
    await f.db
      .insert(schema.organizationSettings)
      .values({ orgId: f.org.id, defaultCredentialId: f.credential.id })
      .onConflictDoUpdate({
        target: schema.organizationSettings.orgId,
        set: { defaultCredentialId: f.credential.id },
      });
    await expect(deleteCredential(f.db, f.owner.id, f.org.id, f.credential.id)).rejects.toMatchObject({
      code: "credential.default",
    });
  });
});

describe("an OpenRouter key", () => {
  /** OpenRouter's `GET /api/v1/key`, answered here. */
  const openRouter = (answer: () => Response) => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return answer();
    }) as unknown as typeof fetch;
    return { fetcher, seen };
  };
  const add = (apiKey: string, fetcher: typeof fetch) =>
    createCredential(
      f.db,
      f.keyWrapper,
      f.owner.id,
      f.org.id,
      { provider: "openrouter", label: "OR", apiKey },
      { fetch: fetcher },
    );
  const stored = async () =>
    (await f.db.select().from(schema.providerCredentials)).filter((r) => r.provider === "openrouter");

  test("is checked with OpenRouter before it is stored: refused or management keys are never kept", async () => {
    const refused = openRouter(() => new Response('{"error":{"code":401}}', { status: 401 }));
    const err = await add("or-test-bad-1234", refused.fetcher).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ code: "provider_key_invalid" });
    expect(refused.seen).toEqual([{ url: "https://openrouter.ai/api/v1/key", auth: "Bearer or-test-bad-1234" }]);
    const manager = openRouter(() => new Response(JSON.stringify({ data: { is_management_key: true } })));
    await expect(add("or-test-mgmt-1234", manager.fetcher)).rejects.toMatchObject({ code: "provider_key_management" });
    expect(await stored()).toEqual([]);
    expect(await openRouterInUse(f.db)).toBe(false);
  });

  test("an accepted key is stored, and one OpenRouter didn't answer for is stored too", async () => {
    const ok = openRouter(() => new Response(JSON.stringify({ data: { is_management_key: false } })));
    await add("or-test-good-1234", ok.fetcher);
    const down = openRouter(() => new Response("bad gateway", { status: 502 }));
    await add("or-test-later-5678", down.fetcher);
    expect((await stored()).map((r) => r.keyHint).sort()).toEqual(["1234", "5678"]);
    expect(await openRouterInUse(f.db)).toBe(true);
  });

  test("a new key for it is checked too; other providers' keys aren't sent anywhere", async () => {
    const ok = openRouter(() => new Response(JSON.stringify({ data: {} })));
    const key = await add("or-test-good-1234", ok.fetcher);
    const refused = openRouter(() => new Response("{}", { status: 401 }));
    await expect(
      rotateCredential(
        f.db,
        f.keyWrapper,
        f.owner.id,
        f.org.id,
        key.id,
        { apiKey: "or-test-bad-9999" },
        { fetch: refused.fetcher },
      ),
    ).rejects.toMatchObject({ code: "provider_key_invalid" });
    expect((await stored())[0]?.keyHint).toBe("1234");
    const untouched = openRouter(() => new Response("{}", { status: 401 }));
    await rotateCredential(
      f.db,
      f.keyWrapper,
      f.owner.id,
      f.org.id,
      f.credential.id,
      { apiKey: "sk-ant-test-key-9999" },
      { fetch: untouched.fetcher },
    );
    expect(untouched.seen).toEqual([]);
  });
});

describe("the same key saved again", () => {
  const save = (input: Partial<Parameters<typeof createCredential>[4]> = {}) =>
    createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "openai",
      label: "OpenAI",
      apiKey: "sk-proj-same-key-5555",
      ...input,
    });
  const rows = () =>
    f.db.select().from(schema.providerCredentials).where(eq(schema.providerCredentials.provider, "openai"));

  test("updates the saved key and says so: one row, its id, a name chosen kept from a plain save", async () => {
    const first = await save({ label: "Time de vendas" });
    expect(first.reused).toBeUndefined();
    const again = await save();
    expect(again).toMatchObject({ id: first.id, reused: true, label: "Time de vendas" });
    const renamed = await save({ label: "Vendas" });
    expect(renamed).toMatchObject({ id: first.id, reused: true, label: "Vendas" });
    expect(await rows()).toHaveLength(1);
  });

  test("saved again with make default, it becomes the default; saved again without, it stays the default", async () => {
    const first = await save();
    expect(first.isDefault).toBe(false);
    expect(await save({ makeDefault: true })).toMatchObject({ id: first.id, reused: true, isDefault: true });
    expect((await defaultCredentials(f.db, f.org.id)).perProvider.openai).toBe(first.id);
    expect(await save()).toMatchObject({ id: first.id, reused: true, isDefault: true });
    expect((await defaultCredentials(f.db, f.org.id)).perProvider.openai).toBe(first.id);
  });

  test("another OpenAI project, another workspace scope or another secret is another key", async () => {
    await save();
    await save({ project: "proj_other" });
    await save({ apiKey: "sk-proj-else-key-5555" });
    await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "anthropic",
      label: "Claude",
      apiKey: "sk-ant-test-key-1234",
      workspaceId: "wrkspc_01abc",
    });
    expect(await rows()).toHaveLength(3);
    expect(await listCredentials(f.db, f.owner.id, f.org.id)).toHaveLength(5);
  });
});

describe("copies saved before", () => {
  // A copy as one was made before a save looked for it: another key, then given the same secret.
  const copyOf = async (label: string) => {
    const other = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "anthropic",
      label,
      apiKey: `sk-ant-other-${label}-0000`,
    });
    await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, other.id, { apiKey: "sk-ant-test-key-1234" });
    return other.id;
  };

  test("the list shows one row with the count; the default stays the row shown", async () => {
    const a = await copyOf("a");
    const b = await copyOf("b");
    await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
      provider: "anthropic",
      label: "x",
      apiKey: "sk-ant-different-1234",
    });
    await f.db
      .insert(schema.organizationSettings)
      .values({ orgId: f.org.id, defaultCredentialId: b })
      .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { defaultCredentialId: b } });
    const listed = await listCredentials(f.db, f.owner.id, f.org.id, [f.keyWrapper]);
    const byId = new Map(listed.map((k) => [k.id, k]));
    expect(byId.get(b)).toMatchObject({ copies: 2 });
    expect(byId.get(b)?.copyOf).toBeUndefined();
    expect([byId.get(a)?.copyOf, byId.get(f.credential.id)?.copyOf]).toEqual([b, b]);
    expect(listed.filter((k) => k.copies !== undefined || k.copyOf !== undefined)).toHaveLength(3);
    // Without the wrappers no key is opened, and none is told apart.
    expect((await listCredentials(f.db, f.owner.id, f.org.id)).some((k) => k.copies !== undefined)).toBe(false);
  });

  test("Remover cópias moves agents, an endpoint agent's model, the defaults and past spend, then deletes", async () => {
    const copy = await copyOf("copy");
    const rio = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Rio", handle: "rio", role: "x", instructions: "x", credentialId: copy },
      NEW_AGENT_DEFAULTS,
    );
    const defaults = { defaultCredentialId: copy, defaultCredentialIds: { anthropic: copy, openai: "x" } };
    await f.db
      .insert(schema.organizationSettings)
      .values({ orgId: f.org.id, ...defaults })
      .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: defaults });
    await f.db.insert(schema.usageRecords).values({
      orgId: f.org.id,
      agentId: rio.id,
      credentialId: copy,
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      requestedModel: "claude-sonnet-5-5",
      inputTokens: 10,
      outputTokens: 0,
      costNanoUsd: 5,
    });

    expect(await removeCredentialCopies(f.db, [f.keyWrapper], f.owner.id, f.org.id, f.credential.id)).toEqual({
      removed: 1,
    });
    const keys = await f.db.select().from(schema.providerCredentials);
    expect(keys.map((k) => k.id)).toEqual([f.credential.id]);
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, rio.id));
    expect(agent?.credentialId).toBe(f.credential.id);
    expect(await defaultCredentials(f.db, f.org.id)).toEqual({
      legacy: f.credential.id,
      perProvider: { anthropic: f.credential.id, openai: "x" },
    });
    const [spent] = await f.db.select().from(schema.usageRecords);
    expect(spent?.credentialId).toBe(f.credential.id);
    expect(await removeCredentialCopies(f.db, [f.keyWrapper], f.owner.id, f.org.id, f.credential.id)).toEqual({
      removed: 0,
    });
  });

  test("an endpoint's copy: an agent's model on it moves to the kept key, which keeps offering that model", async () => {
    const net = { allowPrivate: false, resolveHost: async () => ["93.184.216.34"] };
    const endpoint = (label: string, apiKey: string, model: string) =>
      createCredential(
        f.db,
        f.keyWrapper,
        f.owner.id,
        f.org.id,
        {
          provider: "custom",
          label,
          apiKey,
          endpoint: { style: "openai", baseURL: "https://gw.example.com/v1", models: [{ id: model }] },
        },
        { net },
      );
    const kept = await endpoint("Gateway", "gw-key-1234567", "m-1");
    const copy = await endpoint("Gateway", "gw-key-7654321", "m-2");
    await rotateCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, copy.id, { apiKey: "gw-key-1234567" });
    const [rio] = await f.db
      .insert(schema.agents)
      .values({
        orgId: f.org.id,
        name: "Rio",
        handle: "rio",
        role: "x",
        instructions: "x",
        model: customModelId(copy.id, "m-2"),
        credentialId: copy.id,
      })
      .returning();
    const agentSetup = { brain: "model" as const, model: customModelId(copy.id, "m-2"), key: copy.id };
    await f.db
      .insert(schema.organizationSettings)
      .values({ orgId: f.org.id, agentSetup })
      .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { agentSetup } });
    expect(await removeCredentialCopies(f.db, [f.keyWrapper], f.owner.id, f.org.id, kept.id)).toEqual({ removed: 1 });
    const [settings] = await f.db.select().from(schema.organizationSettings);
    expect(settings?.agentSetup).toMatchObject({ model: customModelId(kept.id, "m-2"), key: kept.id });
    const [agent] = await f.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, rio?.id ?? ""));
    expect(agent).toMatchObject({ credentialId: kept.id, model: customModelId(kept.id, "m-2") });
    const [row] = await f.db
      .select()
      .from(schema.providerCredentials)
      .where(eq(schema.providerCredentials.id, kept.id));
    expect(row?.options.endpoint?.models.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });

  test("an admin's step only", async () => {
    await copyOf("copy");
    const member = await addMember(f.db, f.org.id, "member");
    await expect(
      removeCredentialCopies(f.db, [f.keyWrapper], member.id, f.org.id, f.credential.id),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
