import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  acceptInvitation,
  ConflictError,
  can,
  changeMemberRole,
  createInvitation,
  ForbiddenError,
  isSignupAllowed,
  listMemberships,
  type Permission,
  previewInvitation,
  removeMember,
  requirePermission,
  sha256,
  updateOrganization,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

describe("permissions", () => {
  test("role matrix", () => {
    const all: Permission[] = [
      "read",
      "post",
      "create_channels",
      "configure",
      "manage_agents",
      "manage_credentials",
      "view_usage",
      "manage_members",
      "manage_owners",
    ];
    const allowed = (role: "owner" | "admin" | "member") => all.filter((p) => can(role, p));
    expect(allowed("owner")).toEqual(all);
    expect(allowed("admin")).toEqual(all.filter((p) => p !== "manage_owners"));
    expect(allowed("member")).toEqual(["read", "post", "create_channels"]);
  });

  test("requirePermission rejects non-members and missing permissions", async () => {
    const stranger = await addUser(f.db, "eve");
    await expect(requirePermission(f.db, stranger.id, f.org.id, "read")).rejects.toThrow(/not a member/);
    const member = await addMember(f.db, f.org.id, "member");
    await expect(updateOrganization(f.db, member.id, f.org.id, { context: "x" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await requirePermission(f.db, member.id, f.org.id, "post")).role).toBe("member");
  });

  test("the creator is owner and lands in #general", async () => {
    expect(await listMemberships(f.db, f.owner.id)).toEqual([
      { orgId: f.org.id, orgName: "Acme", role: "owner", orgLogo: null },
    ]);
    const members = await f.db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, f.general.id));
    expect(members.map((m) => m.userId)).toContain(f.owner.id);
  });
});

describe("ownership", () => {
  test("the last owner can't be demoted or leave", async () => {
    await expect(changeMemberRole(f.db, f.owner.id, f.org.id, f.owner.id, "admin")).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(removeMember(f.db, f.owner.id, f.org.id, f.owner.id)).rejects.toBeInstanceOf(ConflictError);
  });

  test("admins can't grant ownership or remove owners", async () => {
    const admin = await addMember(f.db, f.org.id, "admin");
    const member = await addMember(f.db, f.org.id, "member");
    await expect(changeMemberRole(f.db, admin.id, f.org.id, member.id, "owner")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(removeMember(f.db, admin.id, f.org.id, f.owner.id)).rejects.toBeInstanceOf(ForbiddenError);
    await changeMemberRole(f.db, admin.id, f.org.id, member.id, "admin");
  });
});

describe("invitations", () => {
  test("only the token hash is stored; accepting needs the invited email and joins #general", async () => {
    const { token, invitation } = await createInvitation(f.db, f.owner.id, f.org.id, {
      email: "Bia@Example.com",
      role: "member",
    });
    const [row] = await f.db
      .select()
      .from(schema.organizationInvitations)
      .where(eq(schema.organizationInvitations.id, invitation.id));
    expect(row?.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const preview = await previewInvitation(f.db, token);
    expect(preview).toMatchObject({ orgName: "Acme", email: "bia@example.com", role: "member", kind: "email" });
    // Who invited and a few of the org's agents (name and look), for the phone's invitation screen.
    expect(typeof preview?.invitedBy).toBe("string");
    expect(preview?.agents.length).toBeLessThanOrEqual(3);
    for (const a of preview?.agents ?? []) expect(Object.keys(a).sort()).toEqual(["appearance", "id", "name"]);

    const wrong = await addUser(f.db, "carl");
    await expect(acceptInvitation(f.db, wrong, token)).rejects.toBeInstanceOf(ForbiddenError);
    const bia = { id: (await addUser(f.db, "bia")).id, email: "bia@example.com" };
    expect(await acceptInvitation(f.db, bia, token)).toEqual({ orgId: f.org.id });
    await expect(acceptInvitation(f.db, bia, token)).rejects.toBeInstanceOf(ConflictError);
    const general = await f.db.select().from(schema.channelMembers).where(eq(schema.channelMembers.userId, bia.id));
    expect(general.map((g) => g.channelId)).toEqual([f.general.id]);
  });

  test("expired invitations don't work", async () => {
    const past = new Date(Date.now() - 30 * 86_400_000);
    const { token } = await createInvitation(
      f.db,
      f.owner.id,
      f.org.id,
      { email: "old@example.com", role: "member" },
      past,
    );
    expect(await previewInvitation(f.db, token)).toBeNull();
  });

  test("members can't invite; admins can't invite owners", async () => {
    const member = await addMember(f.db, f.org.id, "member");
    await expect(
      createInvitation(f.db, member.id, f.org.id, { email: "x@example.com", role: "member" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await addMember(f.db, f.org.id, "admin");
    await expect(
      createInvitation(f.db, admin.id, f.org.id, { email: "x@example.com", role: "owner" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("self-host sign-up policy", () => {
  test("closed after the first account unless ALLOW_SIGNUP or a pending invitation", async () => {
    expect(await isSignupAllowed(f.db, "new@example.com", false)).toBe(false);
    expect(await isSignupAllowed(f.db, "new@example.com", true)).toBe(true);
    await createInvitation(f.db, f.owner.id, f.org.id, { email: "new@example.com", role: "member" });
    expect(await isSignupAllowed(f.db, "NEW@example.com", false)).toBe(true);
  });

  test("the very first account may always sign up", async () => {
    await f.db.delete(schema.users);
    expect(await isSignupAllowed(f.db, "first@example.com", false)).toBe(true);
  });
});
