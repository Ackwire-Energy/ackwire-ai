import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryPubSub, orgTopic } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { createTestDatabase } from "@agenteschat/db/testing";
import {
  archiveAgent,
  createAgent,
  createOrganization,
  ForbiddenError,
  getAgent,
  listAgents,
  setCoordinator,
} from "../src";
import { addMember, addUser } from "./fixtures";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A new workspace whose team is made in order (Theo, Ada, Lia, as onboarding does), with a member and an admin. */
async function workspace() {
  const t = await createTestDatabase();
  close = t.close;
  const db: Database = t.db;
  const pubsub = createMemoryPubSub();
  const owner = await addUser(db, "ana");
  const { organization: org } = await createOrganization(db, owner.id, { name: "Acme" });
  const agent = (name: string, ownerUserId?: string) =>
    createAgent(
      db,
      owner.id,
      org.id,
      { name, handle: name.toLowerCase(), ...(ownerUserId ? { ownerUserId } : {}) },
      { model: "claude-sonnet-5-5" },
    );
  const theo = await agent("Theo");
  const ada = await agent("Ada");
  const member = await addMember(db, org.id, "member");
  const lia = await agent("Lia", member.id);
  const admin = await addMember(db, org.id, "admin");
  return { db, pubsub, deps: { db, pubsub }, owner, org, theo, ada, lia, member, admin, agent };
}

const coordinators = async (w: Awaited<ReturnType<typeof workspace>>) =>
  (await listAgents(w.db, w.member.id, w.org.id)).filter((a) => a.coordinator).map((a) => a.name);

describe("the team's coordinator (ADR 0092)", () => {
  test("the first agent of a new workspace coordinates it, the next ones don't", async () => {
    const w = await workspace();
    expect(w.theo.coordinator).toBe(true);
    expect([w.ada.coordinator, w.lia.coordinator]).toEqual([false, false]);
    expect(await coordinators(w)).toEqual(["Theo"]);
    const [created] = await w.db
      .select({ details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.created"));
    expect(created?.details).toMatchObject({ name: "Theo", coordinator: true });
  });

  test("a workspace with agents and nobody coordinating keeps nobody: a new agent doesn't take it", async () => {
    const w = await workspace();
    // A workspace from before coordinators: its agents, none of them coordinating.
    await setCoordinator(w.deps, w.owner.id, w.org.id, w.theo.id, false);
    const atlas = await w.agent("Atlas");
    expect(atlas.coordinator).toBe(false);
    expect(await coordinators(w)).toEqual([]);
  });

  test("an admin moves it in one save, or turns it off; one at a time, audited and announced", async () => {
    const w = await workspace();
    const heard: unknown[] = [];
    w.pubsub.subscribe(orgTopic(w.org.id), (e) => heard.push(e));
    const moved = await setCoordinator(w.deps, w.admin.id, w.org.id, w.ada.id, true);
    expect(moved.coordinator).toBe(true);
    expect(await coordinators(w)).toEqual(["Ada"]);
    // The same again changes nothing and says nothing.
    await setCoordinator(w.deps, w.admin.id, w.org.id, w.ada.id, true);
    await setCoordinator(w.deps, w.admin.id, w.org.id, w.lia.id, false);
    expect(heard).toEqual([{ type: "org.broadcast", orgId: w.org.id, event: { type: "agent.coordinator" } }]);
    // The index holds whatever writes it.
    await expect(
      w.db
        .update(schema.agents)
        .set({ coordinator: true })
        .where(eq(schema.agents.id, w.lia.id))
        .then(() => null),
    ).rejects.toThrow();

    await setCoordinator(w.deps, w.owner.id, w.org.id, w.ada.id, false);
    expect(await coordinators(w)).toEqual([]);
    const audited = await w.db
      .select({ actor: schema.auditLog.actorId, target: schema.auditLog.targetId, details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "agent.coordinator"))
      .orderBy(schema.auditLog.id);
    expect(audited).toEqual([
      { actor: w.admin.id, target: w.ada.id, details: { name: "Ada", on: true, from: w.theo.id } },
      { actor: w.owner.id, target: w.ada.id, details: { name: "Ada", on: false } },
    ]);
  });

  test("only who edits any agent picks it: a member can't, not even for the agent they own", async () => {
    const w = await workspace();
    await expect(setCoordinator(w.deps, w.member.id, w.org.id, w.lia.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setCoordinator(w.deps, w.member.id, w.org.id, w.theo.id, false)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await coordinators(w)).toEqual(["Theo"]);
  });

  test("an archived coordinator leaves the team with none, and a new pick works", async () => {
    const w = await workspace();
    await archiveAgent(w.db, w.owner.id, w.org.id, w.theo.id);
    expect((await getAgent(w.db, w.org.id, w.theo.id))?.coordinator).toBe(false);
    expect(await coordinators(w)).toEqual([]);
    await expect(setCoordinator(w.deps, w.owner.id, w.org.id, w.theo.id, true)).rejects.toThrow("Agent not found");
    await setCoordinator(w.deps, w.owner.id, w.org.id, w.lia.id, true);
    expect(await coordinators(w)).toEqual(["Lia"]);
  });
});
