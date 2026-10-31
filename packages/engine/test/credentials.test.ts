import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { runMigration } from "@agenteschat/db/testing";
import {
  createCredential,
  decryptCredential,
  ForbiddenError,
  listCredentials,
  openRouterInUse,
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
    createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, { provider, label, apiKey: "sk-test-key-5678" });
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
