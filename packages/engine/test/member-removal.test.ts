import { afterEach, beforeEach, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL, orgTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  ConflictError,
  changeMemberRole,
  createRole,
  ForbiddenError,
  removalPreview,
  removeMember,
  setMemberRoles,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

const MAC = {
  name: "mac",
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.9.0",
  workspace: "/Users/a/agentes",
  protocol: ACCOUNTS_PROTOCOL,
  exec: true,
};

const ACCOUNT_ID = "0193eeee-0000-4000-8000-000000000001";

const agentRow = async () => {
  const [row] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  if (!row) throw new Error("no agent");
  return row;
};

test("removing someone: their agents pass to the remover, their plan leaves the agents, back to the API", async () => {
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "mac",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.9.0",
    workspace: "/Users/a/agentes",
    protocol: ACCOUNTS_PROTOCOL,
    exec: true,
  });
  await f.db.update(schema.machines).set({ pairedByUserId: null }).where(eq(schema.machines.id, machineId));
  await f.db.insert(schema.machineAccounts).values({
    id: ACCOUNT_ID,
    orgId: f.org.id,
    machineId,
    kind: "claude_code",
    label: "Trabalho",
    email: "caio@example.com",
    status: "active",
    createdBy: caio.id,
  });
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: caio.id, machineId, brain: "claude_code", brainAccountId: ACCOUNT_ID })
    .where(eq(schema.agents.id, f.agent.id));

  const preview = await removalPreview(f.db, f.owner.id, f.org.id, caio.id);
  expect(preview).toEqual({
    heir: { userId: f.owner.id, name: f.owner.name },
    agents: [{ id: f.agent.id, name: f.agent.name }],
    losePlan: [{ id: f.agent.id, name: f.agent.name }],
    computers: [],
    routines: 0,
  });

  await removeMember(f.db, f.owner.id, f.org.id, caio.id, { pubsub: f.pubsub });
  const after = await agentRow();
  expect(after.ownerUserId).toBe(f.owner.id);
  expect(after.brain).toBe("model");
  expect(after.brainAccountId).toBeNull();
});

test("leaving: the agents pass to the longest-standing other owner; the last owner can't leave", async () => {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const cy = await addMember(f.db, f.org.id, "member", "cy");
  await changeMemberRole(f.db, f.owner.id, f.org.id, bia.id, "owner");
  await f.db.update(schema.agents).set({ ownerUserId: cy.id }).where(eq(schema.agents.id, f.agent.id));

  expect((await removalPreview(f.db, cy.id, f.org.id, cy.id))?.heir?.userId).toBe(f.owner.id);
  await removeMember(f.db, cy.id, f.org.id, cy.id);
  expect((await agentRow()).ownerUserId).toBe(f.owner.id);

  // Two owners: one leaves, the other is then the last and can't.
  await removeMember(f.db, f.owner.id, f.org.id, f.owner.id);
  expect((await agentRow()).ownerUserId).toBe(bia.id);
  await expect(removeMember(f.db, bia.id, f.org.id, bia.id)).rejects.toBeInstanceOf(ConflictError);
});

test("only someone above removes a member, and the preview refuses the same", async () => {
  const admin = await addMember(f.db, f.org.id, "admin", "adm");
  const other = await addMember(f.db, f.org.id, "admin", "adm2");
  const dev = await addMember(f.db, f.org.id, "member", "dev");
  const devs = await createRole(f.db, f.owner.id, f.org.id, { name: "Devs" });
  await setMemberRoles(f.db, f.owner.id, f.org.id, dev.id, [devs.id]);

  for (const [actor, target] of [
    [dev.id, admin.id],
    [admin.id, other.id],
    [admin.id, f.owner.id],
  ] as const) {
    await expect(removalPreview(f.db, actor, f.org.id, target)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeMember(f.db, actor, f.org.id, target)).rejects.toBeInstanceOf(ForbiddenError);
  }
  expect(await removalPreview(f.db, admin.id, f.org.id, dev.id)).not.toBeNull();
  await removeMember(f.db, admin.id, f.org.id, dev.id);
  expect(await removalPreview(f.db, admin.id, f.org.id, dev.id)).toBeNull();
});

test("an agent thinking with the removed person's own computer goes back to the API, and open apps hear it", async () => {
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, caio.id, f.org.id, MAC);
  await f.db
    .update(schema.agents)
    .set({ ownerUserId: caio.id, machineId, brain: "claude_code", brainAccountId: null })
    .where(eq(schema.agents.id, f.agent.id));
  expect((await removalPreview(f.db, f.owner.id, f.org.id, caio.id))?.losePlan).toEqual([
    { id: f.agent.id, name: f.agent.name },
  ]);
  const told: RealtimeEvent[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => told.push(e));

  await removeMember(f.db, f.owner.id, f.org.id, caio.id, { pubsub: f.pubsub });
  const after = await agentRow();
  expect(after).toMatchObject({ ownerUserId: f.owner.id, machineId: null, brain: "model", brainAccountId: null });
  expect(told).toContainEqual({
    type: "org.broadcast",
    orgId: f.org.id,
    event: { type: "org.members", agents: [f.agent.id] },
  });
  // Taken out by someone else: not quiet.
  expect(told.find((e) => e.type === "membership.revoked")).toEqual({
    type: "membership.revoked",
    orgId: f.org.id,
    userId: caio.id,
  });
});

test("leaving on one's own is quiet, and the agents skip a blocked owner", async () => {
  const blocked = await addMember(f.db, f.org.id, "member", "old");
  await changeMemberRole(f.db, f.owner.id, f.org.id, blocked.id, "owner");
  // The longest-standing other owner, but blocked: can't sign in.
  await f.db
    .update(schema.organizationMembers)
    .set({ createdAt: new Date(0) })
    .where(eq(schema.organizationMembers.userId, blocked.id));
  await f.db.update(schema.users).set({ blockedAt: new Date() }).where(eq(schema.users.id, blocked.id));
  const cy = await addMember(f.db, f.org.id, "member", "cy");
  await f.db.update(schema.agents).set({ ownerUserId: cy.id }).where(eq(schema.agents.id, f.agent.id));
  const told: RealtimeEvent[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => told.push(e));

  await removeMember(f.db, cy.id, f.org.id, cy.id, { pubsub: f.pubsub });
  expect((await agentRow()).ownerUserId).toBe(f.owner.id);
  expect(told).toContainEqual({ type: "membership.revoked", orgId: f.org.id, userId: cy.id, quiet: true });
});
