import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  connectVaultSource,
  createVaultItem,
  importVaultKeys,
  listVault,
  moveVaultItem,
  type VaultKeysImportInput,
} from "../src";
import { cleanAccess } from "../src/vault/access";
import { openItemValue } from "../src/vault/seal";
import { everythingStored, SOURCE_TOKEN, type VaultFixture, vaultSetup } from "./vault-fixtures";

/**
 * Several keys in one save and an item moved between Personal and Team (ADR 0144 §11): the same permissions as one
 * key, all or none, a saved name left unless replaced, and never a value in what is stored beside the seal.
 */

let v: VaultFixture;
afterEach(async () => {
  const current = v;
  v = undefined as unknown as VaultFixture;
  await current?.f.close();
});

const ONE = "fake-value-one-not-real";
const TWO = "fake-value-two-not-real";
const THREE = "fake-value-three-not-real";

const rowOf = async (id: string) => {
  const [row] = await v.f.db.select().from(schema.vaultItems).where(eq(schema.vaultItems.id, id));
  if (!row) throw new Error("no row");
  return row;
};
const keyRows = async () => {
  const rows = await v.f.db.select().from(schema.vaultItems).where(eq(schema.vaultItems.kind, "key"));
  return new Map(rows.map((row) => [`${row.ownerUserId ? "personal" : "team"}:${row.keyName}`, row]));
};
const keys = (...names: [string, string, boolean?][]): VaultKeysImportInput["keys"] =>
  names.map(([keyName, secret, replace]) => ({ keyName, secret, replace: replace === true }));
const audits = (action: string) => v.f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

describe("several keys in one save", () => {
  test("personal keys for a member: sealed, named after their variable, with the access chosen once", async () => {
    v = await vaultSetup();
    const result = await importVaultKeys(v.deps, v.bruno.id, v.f.org.id, {
      scope: "personal",
      access: { everyone: false, roleIds: [], userIds: [], allAgents: false, agentIds: [v.dev.id] },
      keys: keys(["DATABASE_URL", ONE], ["API_TOKEN", `  ${TWO}  `]),
    });
    expect(result).toEqual({ added: 2, replaced: 0, skipped: 0 });
    const rows = await keyRows();
    const db = rows.get("personal:DATABASE_URL");
    const token = rows.get("personal:API_TOKEN");
    expect(db).toMatchObject({
      ownerUserId: v.bruno.id,
      title: "DATABASE_URL",
      allAgents: false,
      agentIds: [v.dev.id],
    });
    expect(await openItemValue(v.deps, db as NonNullable<typeof db>)).toBe(ONE);
    // A key's value is trimmed, as a single key's is.
    expect(await openItemValue(v.deps, token as NonNullable<typeof token>)).toBe(TWO);
    const [audit] = await audits("vault.keys_imported");
    expect(audit?.details).toEqual({ scope: "personal", added: 2, replaced: 0, skipped: 0 });
    const stored = await everythingStored(v);
    for (const secret of [ONE, TWO, "value-one", "value-two"]) expect(stored).not.toContain(secret);
    expect(JSON.stringify(await listVault(v.deps, v.bruno.id, v.f.org.id))).not.toContain("value-one");
    // Carla manages credentials and still sees no one else's personal keys.
    expect((await listVault(v.deps, v.carla.id, v.f.org.id)).items).toEqual([]);
  });

  test("a saved name is left unless replaced, and a replaced one keeps its access and its note", async () => {
    v = await vaultSetup();
    const saved = await createVaultItem(v.deps, v.carla.id, v.f.org.id, {
      kind: "key",
      scope: "team",
      title: "Payments",
      description: "Test mode",
      keyName: "PAY_KEY",
      secret: ONE,
      access: { everyone: false, roleIds: [v.supportRoleId], userIds: [], allAgents: false, agentIds: [v.infra.id] },
    });
    const left = await importVaultKeys(v.deps, v.carla.id, v.f.org.id, {
      scope: "team",
      keys: keys(["PAY_KEY", TWO], ["NEW_KEY", THREE]),
    });
    expect(left).toEqual({ added: 1, replaced: 0, skipped: 1 });
    expect(await openItemValue(v.deps, await rowOf(saved.id))).toBe(ONE);
    // The same name in the other scope is another key.
    expect(
      await importVaultKeys(v.deps, v.carla.id, v.f.org.id, { scope: "personal", keys: keys(["PAY_KEY", THREE]) }),
    ).toEqual({ added: 1, replaced: 0, skipped: 0 });

    const replaced = await importVaultKeys(v.deps, v.carla.id, v.f.org.id, {
      scope: "team",
      access: { everyone: true, roleIds: [], userIds: [], allAgents: true, agentIds: [] },
      keys: keys(["PAY_KEY", TWO, true]),
    });
    expect(replaced).toEqual({ added: 0, replaced: 1, skipped: 0 });
    const row = await rowOf(saved.id);
    expect(await openItemValue(v.deps, row)).toBe(TWO);
    expect(row).toMatchObject({
      title: "Payments",
      description: "Test mode",
      secretVersion: 2,
      audienceEveryone: false,
      audienceRoleIds: [v.supportRoleId],
      allAgents: false,
      agentIds: [v.infra.id],
    });
    // A new team key with no access given starts as any team item does.
    expect((await keyRows()).get("team:NEW_KEY")).toMatchObject(
      await cleanAccess(v.f.db, v.f.org.id, "team", undefined),
    );
  });

  test("refusals write nothing: the team's without the permission, a bad or reserved name, no value, too many", async () => {
    v = await vaultSetup();
    const org = v.f.org.id;
    await expect(
      importVaultKeys(v.deps, v.bruno.id, org, { scope: "team", keys: keys(["API_TOKEN", ONE]) }),
    ).rejects.toMatchObject({ code: "vault.team_needs_permission" });
    const refused: [VaultKeysImportInput["keys"], string][] = [
      [keys(["GOOD_KEY", ONE], ["lower_case", TWO]), "vault.key_name_invalid"],
      [keys(["GOOD_KEY", ONE], ["OPENAI_API_KEY", TWO]), "vault.key_name_reserved"],
      [keys(["GOOD_KEY", ONE], ["EMPTY_KEY", "   "]), "vault.no_value"],
      [[], "vault.no_value"],
      [keys(...Array.from({ length: 201 }, (_, i): [string, string] => [`KEY_${i}`, ONE])), "vault.too_many_keys"],
    ];
    for (const [list, code] of refused) {
      const error = await importVaultKeys(v.deps, v.bruno.id, org, { scope: "personal", keys: list }).catch((e) => e);
      expect(error).toMatchObject({ code });
      expect(String(error.message)).not.toContain("fake-value");
    }
    expect(await v.f.db.select().from(schema.vaultItems)).toEqual([]);
    expect(await audits("vault.keys_imported")).toEqual([]);
    // A name sent twice keeps its last value.
    await importVaultKeys(v.deps, v.bruno.id, org, { scope: "personal", keys: keys(["TWICE", ONE], ["TWICE", TWO]) });
    const twice = (await keyRows()).get("personal:TWICE");
    expect(await openItemValue(v.deps, twice as NonNullable<typeof twice>)).toBe(TWO);
  });
});

describe("moving between Personal and Team", () => {
  test("to the team: sealed again for the team, seen by everyone, its agents kept", async () => {
    v = await vaultSetup();
    const item = await createVaultItem(v.deps, v.carla.id, v.f.org.id, {
      kind: "key",
      scope: "personal",
      title: "Deploys",
      keyName: "DEPLOY_TOKEN",
      secret: ONE,
      access: { everyone: false, roleIds: [], userIds: [], allAgents: false, agentIds: [v.dev.id] },
    });
    expect((await listVault(v.deps, v.dora.id, v.f.org.id)).items).toEqual([]);
    const moved = await moveVaultItem(v.deps, v.carla.id, v.f.org.id, item.id, "team");
    expect(moved).toMatchObject({
      id: item.id,
      scope: "team",
      ownerUserId: null,
      access: { everyone: true, roleIds: [], userIds: [], allAgents: false, agentIds: [v.dev.id] },
    });
    const row = await rowOf(item.id);
    expect(row.secretVersion).toBe(2);
    expect(await openItemValue(v.deps, row)).toBe(ONE);
    // The old seal named its owner: it no longer opens as the row now stands.
    await expect(openItemValue(v.deps, { ...row, ownerUserId: v.carla.id })).rejects.toThrow();
    expect((await listVault(v.deps, v.dora.id, v.f.org.id)).items.map((i) => i.id)).toEqual([item.id]);
    const [audit] = await audits("vault.item_moved");
    expect(audit).toMatchObject({ targetId: item.id, actorId: v.carla.id });
    expect(audit?.details).toEqual({ kind: "key", title: "Deploys", scope: "team", from: "personal" });
    expect(await everythingStored(v)).not.toContain(ONE);
    // Already there: nothing changes.
    await moveVaultItem(v.deps, v.carla.id, v.f.org.id, item.id, "team");
    expect((await rowOf(item.id)).secretVersion).toBe(2);
    expect(await audits("vault.item_moved")).toHaveLength(1);
  });

  test("to Personal: the mover's own, with no audience, and nobody else sees it", async () => {
    v = await vaultSetup();
    const item = await createVaultItem(v.deps, v.ana.id, v.f.org.id, {
      kind: "login",
      scope: "team",
      title: "Portal",
      website: "portal.example.com",
      username: "ops",
      secret: ONE,
      access: { everyone: false, roleIds: [v.supportRoleId], userIds: [v.dora.id], allAgents: true, agentIds: [] },
    });
    const moved = await moveVaultItem(v.deps, v.carla.id, v.f.org.id, item.id, "personal");
    expect(moved).toMatchObject({
      scope: "personal",
      ownerUserId: v.carla.id,
      access: { everyone: false, roleIds: [], userIds: [], allAgents: true, agentIds: [] },
      can: { edit: true, delete: true },
    });
    const row = await rowOf(item.id);
    expect(row).toMatchObject({ audienceEveryone: false, audienceRoleIds: [], audienceUserIds: [] });
    expect(await openItemValue(v.deps, row)).toBe(ONE);
    for (const other of [v.ana, v.bruno, v.dora])
      expect((await listVault(v.deps, other.id, v.f.org.id)).items).toEqual([]);
  });

  test("a contact moves with its fields", async () => {
    v = await vaultSetup();
    const item = await createVaultItem(v.deps, v.carla.id, v.f.org.id, {
      kind: "contact",
      scope: "personal",
      title: "Billing",
      contact: { fullName: "Lia Example", email: "lia@example.com" },
    });
    await moveVaultItem(v.deps, v.carla.id, v.f.org.id, item.id, "team");
    expect(JSON.parse((await openItemValue(v.deps, await rowOf(item.id))) ?? "{}")).toEqual({
      fullName: "Lia Example",
      email: "lia@example.com",
    });
  });

  test("refusals: without the team's permission, someone else's, a taken name, a password manager's", async () => {
    v = await vaultSetup();
    const org = v.f.org.id;
    const mine = await createVaultItem(v.deps, v.bruno.id, org, {
      kind: "key",
      scope: "personal",
      title: "",
      keyName: "SHARED_NAME",
      secret: ONE,
    });
    const teams = await createVaultItem(v.deps, v.carla.id, org, {
      kind: "key",
      scope: "team",
      title: "",
      keyName: "SHARED_NAME",
      secret: TWO,
    });
    // A member may not write to the team, nor take from it, nor touch what they can't see.
    await expect(moveVaultItem(v.deps, v.bruno.id, org, mine.id, "team")).rejects.toMatchObject({
      code: "vault.team_needs_permission",
    });
    await expect(moveVaultItem(v.deps, v.bruno.id, org, teams.id, "personal")).rejects.toMatchObject({
      name: "ForbiddenError",
    });
    await expect(moveVaultItem(v.deps, v.carla.id, org, mine.id, "team")).rejects.toMatchObject({
      name: "NotFoundError",
    });
    // Carla's own key of that name can't join the team's one.
    const carlas = await createVaultItem(v.deps, v.carla.id, org, {
      kind: "key",
      scope: "personal",
      title: "",
      keyName: "SHARED_NAME",
      secret: THREE,
    });
    await expect(moveVaultItem(v.deps, v.carla.id, org, carlas.id, "team")).rejects.toMatchObject({
      code: "vault.key_name_taken",
    });
    await expect(moveVaultItem(v.deps, v.carla.id, org, teams.id, "personal")).rejects.toMatchObject({
      code: "vault.key_name_taken",
    });
    await expect(moveVaultItem(v.deps, v.carla.id, org, teams.id, "elsewhere" as "team")).rejects.toMatchObject({
      code: "vault.invalid",
    });

    v.source.items = [
      { ref: "item-1", kind: "login", title: "Wiki", websites: [{ url: "https://wiki.example.com", match: "exact" }] },
    ];
    await connectVaultSource(v.deps, v.carla.id, org, {
      kind: "fakepass",
      scope: "team",
      input: { token: SOURCE_TOKEN },
    });
    const external = (await listVault(v.deps, v.carla.id, org)).items.find((i) => i.connectionId !== null);
    await expect(moveVaultItem(v.deps, v.carla.id, org, external?.id ?? "", "personal")).rejects.toMatchObject({
      code: "vault.external_read_only",
    });
    expect(await audits("vault.item_moved")).toEqual([]);
    expect((await rowOf(teams.id)).ownerUserId).toBeNull();
  });
});
