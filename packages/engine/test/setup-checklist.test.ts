import { afterEach, describe, expect, test } from "bun:test";
import { type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import { agentView, confirmSetupStep, createAgent, createOrganization, NotFoundError, newSetup, setupOf } from "../src";
import { addMember, addUser } from "./fixtures";

// A new agent's setup checklist (ADR 0152 §2): every new agent starts with one, whichever way it was made; its owner
// or whoever manages agents confirms its steps; agents made before it keep none.

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const MODEL = { model: "claude-sonnet-5-5" };

async function workspace() {
  const t = await createTestDatabase();
  close = t.close;
  const db: Database = t.db;
  const owner = await addUser(db, "ana");
  const { organization: org } = await createOrganization(db, owner.id, { name: "Acme" });
  const member = await addMember(db, org.id, "member");
  const admin = await addMember(db, org.id, "admin");
  return { db, owner, org, member, admin };
}

async function stored(db: Database, agentId: string) {
  const { agents } = schema;
  const [row] = await db.select({ setup: agents.setup }).from(agents).where(eq(agents.id, agentId));
  return row?.setup ?? null;
}

describe("setup checklist", () => {
  test("a new agent starts with it, with the role it was made from; no role is none", async () => {
    const w = await workspace();
    const nina = await createAgent(
      w.db,
      w.owner.id,
      w.org.id,
      { name: "Nina", handle: "nina", setup: { role: "support" } },
      MODEL,
    );
    expect(agentView(nina).setup).toEqual({ role: "support", done: [] });
    const sol = await createAgent(w.db, w.owner.id, w.org.id, { name: "Sol", handle: "sol" }, MODEL);
    expect(agentView(sol).setup).toEqual({ role: null, done: [] });
    // Something that isn't a role id is no role.
    const odd = await createAgent(
      w.db,
      w.owner.id,
      w.org.id,
      { name: "Odd", handle: "odd", setup: { role: "Atendimento ao cliente" } },
      MODEL,
    );
    expect(agentView(odd).setup).toEqual({ role: null, done: [] });
  });

  test("the right hand has none (it is made apart)", async () => {
    const w = await workspace();
    const [lodi] = await w.db
      .select({ setup: schema.agents.setup })
      .from(schema.agents)
      .where(eq(schema.agents.builtin, "right_hand"));
    expect(lodi?.setup ?? null).toBeNull();
  });

  test("its owner confirms a step once; twice changes nothing; the order is kept", async () => {
    const w = await workspace();
    // A member's own agent (made for them by the workspace's owner: members don't create agents by default).
    const leo = await createAgent(
      w.db,
      w.owner.id,
      w.org.id,
      { name: "Leo", handle: "leo", ownerUserId: w.member.id },
      MODEL,
    );
    await confirmSetupStep(w.db, w.member.id, w.org.id, leo.id, "where");
    await confirmSetupStep(w.db, w.member.id, w.org.id, leo.id, "apps");
    await confirmSetupStep(w.db, w.member.id, w.org.id, leo.id, "where");
    expect(await stored(w.db, leo.id)).toEqual({ role: null, done: ["where", "apps"] });
  });

  test("whoever manages agents confirms any agent's; another member can't", async () => {
    const w = await workspace();
    const leo = await createAgent(w.db, w.owner.id, w.org.id, { name: "Leo", handle: "leo" }, MODEL);
    await confirmSetupStep(w.db, w.admin.id, w.org.id, leo.id, "who");
    expect(await stored(w.db, leo.id)).toEqual({ role: null, done: ["who"] });
    await expect(confirmSetupStep(w.db, w.member.id, w.org.id, leo.id, "how")).rejects.toBeInstanceOf(NotFoundError);
    expect(await stored(w.db, leo.id)).toEqual({ role: null, done: ["who"] });
  });

  test("an agent made before the checklist keeps none", async () => {
    const w = await workspace();
    const old = await createAgent(w.db, w.owner.id, w.org.id, { name: "Old", handle: "old" }, MODEL);
    await w.db.update(schema.agents).set({ setup: null }).where(eq(schema.agents.id, old.id));
    await confirmSetupStep(w.db, w.owner.id, w.org.id, old.id, "ai");
    expect(await stored(w.db, old.id)).toBeNull();
  });

  test("reading it drops what isn't a step or a role", () => {
    expect(setupOf(null)).toBeNull();
    expect(setupOf({ role: "dev", done: ["ai", "nope", "ai", "how"] })).toEqual({ role: "dev", done: ["ai", "how"] });
    expect(setupOf({ role: 7, done: "ai" })).toEqual({ role: null, done: [] });
    expect(newSetup(undefined)).toEqual({ role: null, done: [] });
  });
});
