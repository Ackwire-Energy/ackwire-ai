import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { runMigration } from "@agenteschat/db/testing";
import { createCredential, decryptCredential, ForbiddenError, listCredentials, revokeCredential } from "../src";
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
