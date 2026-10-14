import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  addChannelMember,
  ConflictError,
  createChannel,
  ForbiddenError,
  joinChannel,
  listChannels,
  NotFoundError,
  requireChannelAccess,
  ValidationError,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

test("channel access requires org membership, the right org, and channel membership", async () => {
  const stranger = await addUser(f.db, "eve");
  await expect(requireChannelAccess(f.db, stranger.id, f.org.id, f.general.id)).rejects.toBeInstanceOf(ForbiddenError);

  const member = await addMember(f.db, f.org.id, "member");
  await expect(requireChannelAccess(f.db, member.id, f.org.id, f.general.id)).rejects.toThrow(/Join this channel/);
  await joinChannel(f.db, member.id, f.org.id, f.general.id);
  expect((await requireChannelAccess(f.db, member.id, f.org.id, f.general.id)).channel.id).toBe(f.general.id);

  // Same user is owner of another org: the first org's channel id doesn't work through it.
  const [other] = await f.db.insert(schema.organizations).values({ name: "Other" }).returning();
  await f.db.insert(schema.organizationMembers).values({ orgId: other?.id ?? "", userId: member.id, role: "owner" });
  await expect(requireChannelAccess(f.db, member.id, other?.id ?? "", f.general.id)).rejects.toBeInstanceOf(
    NotFoundError,
  );
});

test("private channels can't be joined, only added to by a member", async () => {
  const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "Leadership", visibility: "private" });
  expect(secret.name).toBe("leadership");
  const member = await addMember(f.db, f.org.id, "member");
  await expect(joinChannel(f.db, member.id, f.org.id, secret.id)).rejects.toBeInstanceOf(ForbiddenError);
  expect((await listChannels(f.db, member.id, f.org.id)).map((c) => c.name)).toEqual(["general"]);
  await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: member.id });
  expect((await listChannels(f.db, member.id, f.org.id)).map((c) => [c.name, c.isMember])).toEqual([
    ["general", false],
    ["leadership", true],
  ]);
});

test("names are validated and unique per org", async () => {
  await expect(createChannel(f.db, f.owner.id, f.org.id, { name: "General" })).rejects.toBeInstanceOf(ConflictError);
  await expect(createChannel(f.db, f.owner.id, f.org.id, { name: "has space" })).rejects.toBeInstanceOf(
    ValidationError,
  );
});

test("agents and people from other orgs can't be added", async () => {
  const [other] = await f.db.insert(schema.organizations).values({ name: "Other" }).returning();
  const [foreign] = await f.db
    .insert(schema.agents)
    .values({ orgId: other?.id ?? "", name: "Spy", handle: "spy", model: "claude-sonnet-5-5" })
    .returning();
  await expect(
    addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: foreign?.id ?? "" }),
  ).rejects.toBeInstanceOf(ValidationError);
  const outsider = await addUser(f.db, "zed");
  await expect(
    addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: outsider.id }),
  ).rejects.toBeInstanceOf(ValidationError);
});
