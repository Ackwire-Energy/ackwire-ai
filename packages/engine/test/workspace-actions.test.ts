import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  actionsFor,
  addChannelMember,
  askWorkspaceAction,
  createChannel,
  createInvitation,
  createRole,
  createRoutine,
  createScheduleToolSource,
  createSetupToolSource,
  createToolGateway,
  createWikiToolSource,
  decideWorkspaceAction,
  getOrgSettings,
  getWorkspaceActionCard,
  insertMessage,
  linkRunActions,
  memberRoleIds,
  noticePrefsView,
  openPersonAgentDm,
  postPersonMessage,
  RIGHT_HAND,
  setMemberRoles,
  suggestPerson,
  type ToolContext,
  undoAgentAction,
  undoMessageActions,
  updateRole,
  WORKSPACE_ACTION_TOOL,
  type WorkspaceActionCard,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const lodiOf = async (fx: Fixture) => {
  const [lodi] = await fx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  return lodi;
};

/** A run of Lodi on what `userId` wrote in their DM with it; `outside`: their message relays outside content. */
async function lodiRun(fx: Fixture, userId: string, body: string, outside = false): Promise<ToolContext> {
  const lodi = await lodiOf(fx);
  const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, lodi.id);
  const trigger = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, { body });
  if (outside)
    await fx.db
      .update(schema.messages)
      .set({ meta: { readOutside: true } })
      .where(eq(schema.messages.id, trigger.id));
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: lodi.id,
    runId: run.id,
    channelId: dm.id,
    threadRootId: run.threadRootId,
    triggerMessageId: trigger.id,
  };
}

const SERVER = { publicUrl: "https://agentes.test" };
const gatewayOf = (fx: Fixture) =>
  createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub, server: SERVER })] });
async function act(fx: Fixture, ctx: ToolContext, input: Record<string, unknown>) {
  const res = await gatewayOf(fx).invoke(ctx, {
    toolUseId: `tu_${crypto.randomUUID()}`,
    name: WORKSPACE_ACTION_TOOL,
    input,
  });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

/** Lodi's reply to the run, carrying its receipts. */
async function reply(fx: Fixture, ctx: ToolContext) {
  const message = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: ctx.channelId,
    author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: 0 },
    body: "Pronto.",
  });
  await linkRunActions(fx.db, fx.org.id, ctx.runId, message.id);
  return message.id;
}

async function lastCard(fx: Fixture) {
  const rows = await fx.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.orgId, fx.org.id))
    .orderBy(schema.messages.createdAt);
  const m = rows
    .filter((r) => (r.meta.actionCard as { kind?: string } | undefined)?.kind === "workspace_action")
    .at(-1);
  return m ? { id: m.id, card: m.meta.actionCard as WorkspaceActionCard } : null;
}

const roleNamed = async (fx: Fixture, name: string) =>
  (
    await fx.db
      .select()
      .from(schema.orgRoles)
      .where(and(eq(schema.orgRoles.orgId, fx.org.id), eq(schema.orgRoles.name, name)))
  )[0] ?? null;

/** What "no merge or deploy" means: everything a marketing person needs, but not deciding agents' approvals. */
const MARKETING = {
  name: "Marketing",
  color: "rose",
  permissions: ["talk_to_agents", "assign_work", "manage_routines", "edit_wiki", "upload_files"],
};

describe("roles through the right hand", () => {
  test("the owner's marketing role, made and given at once; Desfazer tudo takes both back", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const ctx = await lodiRun(f, f.owner.id, "cria um cargo de marketing pra Bia, sem merge nem deploy");
    const found = await act(f, ctx, { find: "create a role with permissions" });
    expect(found.content).toContain("create_role");
    expect(found.content).toContain("They may: it applies at once with Undo.");
    const made = await act(f, ctx, { action: "create_role", input: MARKETING, why: "Cargo da Bia" });
    expect(made.content).toContain("Done at once");
    const given = await act(f, ctx, {
      action: "set_member_roles",
      input: { person: "Bia Teste", add_roles: ["marketing"] },
    });
    expect(given.content).toContain("Done at once");
    const role = await roleNamed(f, "Marketing");
    expect(role).toMatchObject({ color: "rose", kind: "custom" });
    expect([...(role?.permissions ?? [])].sort()).toEqual([...MARKETING.permissions].sort());
    expect(role?.permissions).not.toContain("approve_actions");
    expect(await memberRoleIds(f.db, f.org.id, bia.id)).toEqual([role?.id ?? ""]);
    // No card: both were the owner's to decide, in their own words.
    expect(await lastCard(f)).toBeNull();

    const messageId = await reply(f, ctx);
    const receipts = (await actionsFor(f.db, f.org.id, [messageId])).get(messageId) ?? [];
    expect(receipts.map((r) => [r.kind, r.params.action, r.requestedByUserId])).toEqual([
      ["workspace.changed", "create_role", f.owner.id],
      ["workspace.changed", "set_member_roles", f.owner.id],
    ]);
    expect(receipts[1]?.params).toMatchObject({ name: "Bia Teste", change: "+ Marketing" });
    const undone = await undoMessageActions({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, messageId);
    expect(undone.failed).toEqual([]);
    expect(await memberRoleIds(f.db, f.org.id, bia.id)).toEqual([]);
    expect(await roleNamed(f, "Marketing")).toBeNull();
  });

  test("a member who can't manage roles gets a card for an admin, never the role; sent, an admin applies it", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const admin = await addMember(f.db, f.org.id, "admin", "Caio Admin");
    const ctx = await lodiRun(f, bia.id, "cria um cargo de marketing pra mim");
    const out = await act(f, ctx, { action: "create_role", input: MARKETING, why: "Cargo de marketing" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("They can't make this change");
    expect(await roleNamed(f, "Marketing")).toBeNull();
    const posted = await lastCard(f);
    expect(posted?.card).toMatchObject({
      kind: "workspace_action",
      forUserId: bia.id,
      state: "pending",
      params: { action: "create_role", needs: "manage_roles", words: { name: "Marketing" } },
    });
    if (!posted) throw new Error("no card");
    const deps = { db: f.db, pubsub: f.pubsub };
    // Her own click is refused by the role screen's own check.
    await expect(decideWorkspaceAction(deps, bia.id, f.org.id, posted.id, "apply")).rejects.toThrow();
    expect(await roleNamed(f, "Marketing")).toBeNull();
    // The admin can't open her DM until she sends it.
    await expect(getWorkspaceActionCard(f.db, admin.id, f.org.id, posted.id)).rejects.toThrow();
    await askWorkspaceAction(deps, bia.id, f.org.id, posted.id);
    const inbox = await f.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, "change_request")));
    expect(inbox.map((n) => n.userId).sort()).toEqual([admin.id, f.owner.id].sort());
    expect(inbox[0]?.source).toMatchObject({ messageId: posted.id, action: "create_role" });
    const card = await decideWorkspaceAction(deps, admin.id, f.org.id, posted.id, "apply");
    expect(card).toMatchObject({ state: "applied", decidedByUserId: admin.id });
    expect(await roleNamed(f, "Marketing")).not.toBeNull();
    await expect(decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply")).rejects.toThrow(
      "already decided",
    );
    // Its receipt is on the card, for the admin to undo.
    const [receipt] = (await actionsFor(f.db, f.org.id, [posted.id])).get(posted.id) ?? [];
    expect(receipt).toMatchObject({ kind: "workspace.changed", requestedByUserId: admin.id });
    await undoAgentAction(deps, admin.id, f.org.id, receipt?.id ?? "");
    expect(await roleNamed(f, "Marketing")).toBeNull();
    const open = await f.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.orgId, f.org.id), eq(schema.notifications.kind, "change_request")));
    expect(open.every((n) => n.doneAt)).toBe(true);
  });

  test("a key they don't hold is refused by the roles screen's rule: a card, nothing made", async () => {
    f = await setup({ rightHand: true });
    const lead = await addMember(f.db, f.org.id, "member", "Lia Lead");
    const managers = await createRole(f.db, f.owner.id, f.org.id, {
      name: "Gestores",
      permissions: ["manage_roles", "manage_members"],
    });
    await setMemberRoles(f.db, f.owner.id, f.org.id, lead.id, [managers.id]);
    const ctx = await lodiRun(f, lead.id, "cria um cargo que aprova merges");
    const out = await act(f, ctx, {
      action: "create_role",
      input: { name: "Revisores", permissions: ["approve_actions"] },
    });
    expect(out.content).toContain("They can't make this change");
    // In the roles screen's own words.
    expect(out.content).toContain("You can only give what you can do yourself");
    expect(await roleNamed(f, "Revisores")).toBeNull();
    const posted = await lastCard(f);
    expect(posted?.card.params).toMatchObject({ action: "create_role", refused: true });
    // They hold the roles screen's key, but its rule refused them: they send it on.
    await askWorkspaceAction({ db: f.db, pubsub: f.pubsub }, lead.id, f.org.id, posted?.id ?? "");
    // One they hold applies at once.
    expect((await act(f, ctx, { action: "create_role", input: { name: "Apoio" } })).content).toContain("Done at once");
  });

  test("after outside content, even the owner's change waits on its card", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "cria o cargo Marketing", true);
    const out = await act(f, ctx, { action: "create_role", input: MARKETING });
    expect(out.content).toContain("They apply it there");
    expect(await roleNamed(f, "Marketing")).toBeNull();
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    await decideWorkspaceAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, posted.id, "apply");
    expect(await roleNamed(f, "Marketing")).not.toBeNull();
  });

  test("change, move and delete a role, and a channel's exception: the screen's result, its refusal, its Undo", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const sales = await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas", permissions: ["post"] });
    const ops = await createRole(f.db, f.owner.id, f.org.id, { name: "Operações" });
    const ctx = await lodiRun(f, f.owner.id, "ajusta os cargos");
    const changed = await act(f, ctx, {
      action: "update_role",
      input: { role: "vendas", name: "Comercial", add_permissions: ["edit_wiki"], color: "amber" },
    });
    expect(changed.content).toContain("Done at once");
    expect(await roleNamed(f, "Comercial")).toMatchObject({ color: "amber", permissions: ["post", "edit_wiki"] });
    const moved = await act(f, ctx, { action: "move_role", input: { role: "Operações", above: "Comercial" } });
    expect(moved.content).toContain("Done at once");
    const exception = await act(f, ctx, {
      action: "set_channel_permissions",
      input: { channel: "#general", role: "Operações", deny: ["post"] },
    });
    expect(exception.content).toContain("Done at once");
    const [override] = await f.db
      .select()
      .from(schema.channelPermissionOverrides)
      .where(eq(schema.channelPermissionOverrides.roleId, ops.id));
    expect(override).toMatchObject({ allow: [], deny: ["post"] });
    const order = async () =>
      (
        await f.db
          .select({ id: schema.orgRoles.id, position: schema.orgRoles.position })
          .from(schema.orgRoles)
          .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "custom")))
      )
        .sort((a, b) => a.position - b.position)
        .map((r) => r.id);
    expect((await order()).indexOf(ops.id)).toBeLessThan((await order()).indexOf(sales.id));
    const messageId = await reply(f, ctx);
    const undone = await undoMessageActions(deps, f.owner.id, f.org.id, messageId);
    expect(undone.failed).toEqual([]);
    expect(await roleNamed(f, "Vendas")).toMatchObject({ color: "graphite", permissions: ["post"] });
    expect((await order()).indexOf(ops.id)).toBeGreaterThan((await order()).indexOf(sales.id));
    expect(
      await f.db
        .select()
        .from(schema.channelPermissionOverrides)
        .where(eq(schema.channelPermissionOverrides.roleId, ops.id)),
    ).toEqual([]);

    // Deleting can't be undone: always a card, even for the owner, and its receipt has no Undo.
    const del = await act(f, ctx, { action: "delete_role", input: { role: "Vendas" } });
    expect(del.content).toContain("Posted a card");
    expect(await roleNamed(f, "Vendas")).not.toBeNull();
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply");
    expect(await roleNamed(f, "Vendas")).toBeNull();
    const [receipt] = (await actionsFor(f.db, f.org.id, [posted.id])).get(posted.id) ?? [];
    expect(Date.parse(receipt?.undoableUntil ?? "")).toBeLessThanOrEqual(Date.now());

    // A member without the permission: each a card, nothing changes.
    const nina = await addMember(f.db, f.org.id, "member", "Nina Teste");
    const hers = await lodiRun(f, nina.id, "renomeia operações");
    const refused = await act(f, hers, { action: "update_role", input: { role: "Operações", name: "Ops" } });
    expect(refused.content).toContain("They can't make this change");
    expect(await roleNamed(f, "Operações")).not.toBeNull();
  });

  test("wrong or unknown input says why and changes nothing", async () => {
    f = await setup({ rightHand: true });
    const ctx = await lodiRun(f, f.owner.id, "faz algo");
    const unknown = await act(f, ctx, { action: "make_coffee", input: {} });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain('No action "make_coffee"');
    const bad = await act(f, ctx, { action: "create_role", input: { name: "X", permissions: ["fly"] } });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.content).toContain("Wrong input");
    const nobody = await act(f, ctx, { action: "set_member_roles", input: { person: "Zé", add_roles: ["x"] } });
    expect(nobody.content).toBe('No one called "Zé" in this workspace.');
    expect(await lastCard(f)).toBeNull();
  });
});

/** Ends a test run so the person's next message starts another (a DM holds one run at a time). */
const finish = (fx: Fixture, ctx: ToolContext) =>
  fx.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ctx.runId));

const statusOf = async (fx: Fixture, userId: string) =>
  (
    await fx.db
      .select({ availability: schema.organizationMembers.availability, text: schema.organizationMembers.statusText })
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, fx.org.id), eq(schema.organizationMembers.userId, userId)))
  )[0];

describe("the rest of the app through the right hand", () => {
  test("their own status: anyone sets theirs at once, and Desfazer puts it back", async () => {
    f = await setup({ rightHand: true });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const ctx = await lodiRun(f, bia.id, "estou em reunião até as 15h");
    const out = await act(f, ctx, { action: "set_my_status", input: { availability: "busy", text: "Em reunião" } });
    expect(out.content).toContain("Done at once");
    expect(await statusOf(f, bia.id)).toEqual({ availability: "busy", text: "Em reunião" });
    const messageId = await reply(f, ctx);
    const [receipt] = (await actionsFor(f.db, f.org.id, [messageId])).get(messageId) ?? [];
    expect(receipt?.params).toMatchObject({ action: "set_my_status", what: "Em reunião", availability: "busy" });
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, receipt?.id ?? "");
    expect(await statusOf(f, bia.id)).toEqual({ availability: "auto", text: null });
  });

  test("their notifications and time zone, and an invitation's roles: at once, each undone", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const ctx = await lodiRun(f, bia.id, "não quero mais notificação de reação, e estou em Lisboa");
    const reactions = async () =>
      (await noticePrefsView(f.db, f.org.id, bia.id)).categories.find((c) => c.id === "reactions")?.on;
    const start = await reactions();
    for (const [action, input] of [
      ["set_notifications", { category: "reactions", on: !start }],
      ["set_my_timezone", { timezone: "Europe/Lisbon" }],
    ] as const)
      expect((await act(f, ctx, { action, input })).content).toContain("Done at once");
    const zone = async () =>
      (
        await f.db
          .select({ timezone: schema.organizationMembers.timezone })
          .from(schema.organizationMembers)
          .where(and(eq(schema.organizationMembers.orgId, f.org.id), eq(schema.organizationMembers.userId, bia.id)))
      )[0]?.timezone;
    expect(await reactions()).toBe(!start);
    expect(await zone()).toBe("Europe/Lisbon");
    const messageId = await reply(f, ctx);
    expect((await undoMessageActions(deps, bia.id, f.org.id, messageId)).failed).toEqual([]);
    expect(await reactions()).toBe(start);
    expect(await zone()).toBeNull();

    await createRole(f.db, f.owner.id, f.org.id, { name: "Vendas" });
    await createInvitation(f.db, f.owner.id, f.org.id, { email: "convidada@example.com" });
    const roles = async () =>
      (
        await f.db
          .select({ roleIds: schema.organizationInvitations.roleIds })
          .from(schema.organizationInvitations)
          .where(eq(schema.organizationInvitations.orgId, f.org.id))
      )[0]?.roleIds;
    const mine = await lodiRun(f, f.owner.id, "o convite dela entra em Vendas");
    const out = await act(f, mine, {
      action: "set_invitation_roles",
      input: { email: "convidada@example.com", add_roles: ["vendas"] },
    });
    expect(out.content).toContain("Done at once");
    expect(await roles()).toHaveLength(1);
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, mine.runId));
    await undoAgentAction(deps, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await roles()).toEqual([]);
  });

  test("a channel renamed, its people changed and archived at once, all undone; its deletion is a card", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const launch = await createChannel(f.db, f.owner.id, f.org.id, { name: "lancamento", topic: "" });
    const ctx = await lodiRun(f, f.owner.id, "arruma o canal de lançamento");
    for (const [action, input] of [
      ["update_channel", { channel: "#lancamento", name: "lancamento-q4", topic: "Campanha do Q4" }],
      ["channel_people", { channel: "lancamento-q4", add: ["Bia Teste"] }],
      ["archive_channel", { channel: "lancamento-q4" }],
    ] as const)
      expect((await act(f, ctx, { action, input })).content).toContain("Done at once");
    const row = async () => (await f.db.select().from(schema.channels).where(eq(schema.channels.id, launch.id)))[0];
    expect(await row()).toMatchObject({ name: "lancamento-q4", topic: "Campanha do Q4" });
    expect((await row())?.archivedAt).not.toBeNull();
    const seated = async () =>
      (await f.db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, launch.id))).map(
        (m) => m.userId,
      );
    expect(await seated()).toContain(bia.id);
    const messageId = await reply(f, ctx);
    expect((await undoMessageActions(deps, f.owner.id, f.org.id, messageId)).failed).toEqual([]);
    expect(await row()).toMatchObject({ name: "lancamento", topic: "", archivedAt: null });
    expect(await seated()).not.toContain(bia.id);
    await finish(f, ctx);

    // Bia doesn't manage it: a card, nothing changes.
    const hers = await lodiRun(f, bia.id, "renomeia o canal");
    await addChannelMember(f.db, f.owner.id, f.org.id, launch.id, { userId: bia.id });
    const refused = await act(f, hers, { action: "update_channel", input: { channel: "lancamento", name: "meu" } });
    expect(refused.content).toContain("They can't make this change");
    expect((await row())?.name).toBe("lancamento");

    const del = await act(f, await lodiRun(f, f.owner.id, "apaga o canal"), {
      action: "delete_channel",
      input: { channel: "lancamento" },
    });
    expect(del.content).toContain("Posted a card");
    expect((await row())?.deletedAt).toBeNull();
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply");
    expect((await row())?.deletedAt).not.toBeNull();
  });

  test("an invitation canceled at once by who may invite; a member gets a card", async () => {
    f = await setup({ rightHand: true });
    await createInvitation(f.db, f.owner.id, f.org.id, { email: "convidada@example.com" });
    const pending = async () =>
      (
        await f.db
          .select()
          .from(schema.organizationInvitations)
          .where(eq(schema.organizationInvitations.orgId, f.org.id))
      ).length;
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const hers = await act(f, await lodiRun(f, bia.id, "cancela o convite"), {
      action: "revoke_invitation",
      input: { email: "convidada@example.com" },
    });
    expect(hers.content).toContain("They can't make this change");
    expect(await pending()).toBe(1);
    const out = await act(f, await lodiRun(f, f.owner.id, "cancela o convite"), {
      action: "revoke_invitation",
      input: { email: "Convidada@example.com" },
    });
    expect(out.content).toContain("Done at once");
    expect(await pending()).toBe(0);
  });

  test("an invitation sent again at once; a request to join decided on a card, let in or turned down", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub, server: SERVER };
    const invited = await createInvitation(f.db, f.owner.id, f.org.id, { email: "convidada@example.com" });
    await f.db
      .update(schema.organizationInvitations)
      .set({ expiresAt: new Date(Date.now() + 3_600_000) })
      .where(eq(schema.organizationInvitations.email, "convidada@example.com"));
    const ctx = await lodiRun(f, f.owner.id, "reenvia o convite");
    const again = await act(f, ctx, { action: "resend_invitation", input: { email: "convidada@example.com" } });
    expect(again.content).toContain("Done at once");
    const [row] = await f.db
      .select()
      .from(schema.organizationInvitations)
      .where(eq(schema.organizationInvitations.email, "convidada@example.com"));
    expect((row?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    expect(invited).toBeTruthy();
    await finish(f, ctx);

    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    await suggestPerson(deps, bia.id, f.org.id, { email: "nova@example.com" });
    await suggestPerson(deps, bia.id, f.org.id, { email: "outra@example.com" });
    const hers = await act(f, await lodiRun(f, bia.id, "deixa a nova entrar"), {
      action: "decide_join_request",
      input: { email: "nova@example.com", approve: true },
    });
    expect(hers.content).toContain("They can't make this change");
    const status = async (email: string) =>
      (
        await f.db
          .select({ status: schema.organizationJoinRequests.status })
          .from(schema.organizationJoinRequests)
          .where(eq(schema.organizationJoinRequests.email, email))
      )[0]?.status;
    const mine = await lodiRun(f, f.owner.id, "deixa a nova entrar e recusa a outra");
    for (const [email, approve] of [
      ["nova@example.com", true],
      ["outra@example.com", false],
    ] as const) {
      const out = await act(f, mine, { action: "decide_join_request", input: { email, approve, reason: "Não agora" } });
      expect(out.content).toContain("Posted a card");
      expect(await status(email)).toBe("pending");
      const posted = await lastCard(f);
      if (!posted) throw new Error("no card");
      await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply");
    }
    expect(await status("nova@example.com")).toBe("approved");
    expect(await status("outra@example.com")).toBe("denied");
  });

  test("stopping an agent's work as the person who may; the right hand never stops itself", async () => {
    f = await setup({ rightHand: true });
    const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev faz o relatório",
    });
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, asked.id));
    if (!run) throw new Error("no run");
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const hers = await act(f, await lodiRun(f, bia.id, "para o dev"), {
      action: "stop_work",
      input: { agent: "@dev" },
    });
    expect(hers.content).toContain("They can't make this change");
    const status = async () => (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id)))[0];
    expect((await status())?.status).toBe("queued");
    const ctx = await lodiRun(f, f.owner.id, "para o dev");
    expect((await act(f, ctx, { action: "stop_work", input: { agent: "@dev", reason: "Já fiz" } })).content).toContain(
      "Done at once",
    );
    expect((await status())?.status).toBe("canceled");
    const self = await act(f, ctx, { action: "stop_work", input: { agent: "@lodi" } });
    expect(self).toMatchObject({ isError: true, content: "That is you: say so, and stop nothing." });
    const none = await act(f, ctx, { action: "continue_work", input: { agent: "@dev" } });
    expect(none.isError).toBe(true);
  });

  test("the workspace's name and time zone at once, undone; the action check always on a card", async () => {
    f = await setup({ rightHand: true });
    const deps = { db: f.db, pubsub: f.pubsub };
    const before = await getOrgSettings(f.db, f.owner.id, f.org.id);
    const ctx = await lodiRun(f, f.owner.id, "muda o nome do workspace");
    const out = await act(f, ctx, {
      action: "update_workspace",
      input: { name: "Acme Teste", timezone: "America/Sao_Paulo" },
    });
    expect(out.content).toContain("Done at once");
    expect(await getOrgSettings(f.db, f.owner.id, f.org.id)).toMatchObject({
      name: "Acme Teste",
      timezone: "America/Sao_Paulo",
    });
    const check = await act(f, ctx, { action: "set_action_check", input: { on: false } });
    expect(check.content).toContain("Posted a card");
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).actionCheck).toBe(true);
    const posted = await lastCard(f);
    if (!posted) throw new Error("no card");
    await decideWorkspaceAction(deps, f.owner.id, f.org.id, posted.id, "apply");
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).actionCheck).toBe(false);
    const messageId = await reply(f, ctx);
    expect((await undoMessageActions(deps, f.owner.id, f.org.id, messageId)).failed).toEqual([]);
    expect(await getOrgSettings(f.db, f.owner.id, f.org.id)).toMatchObject({
      name: before.name,
      timezone: before.timezone,
    });
    const [receipt] = (await actionsFor(f.db, f.org.id, [posted.id])).get(posted.id) ?? [];
    await undoAgentAction(deps, f.owner.id, f.org.id, receipt?.id ?? "");
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).actionCheck).toBe(true);
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    const hers = await act(f, await lodiRun(f, bia.id, "muda o fuso"), {
      action: "update_workspace",
      input: { timezone: "Europe/Lisbon" },
    });
    expect(hers.content).toContain("They can't make this change");
  });

  test("another agent's routine: deleted for who may manage it, with Undo", async () => {
    f = await setup({ rightHand: true });
    const routine = await createRoutine({ db: f.db, pubsub: f.pubsub, context: f.context }, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Resuma o dia.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "schedule", phrase: "dias úteis às 9h" },
    });
    const ctx = await lodiRun(f, f.owner.id, "apaga a rotina do dev");
    const gateway = createToolGateway({
      sources: [createScheduleToolSource({ pubsub: f.pubsub, context: f.context })],
    });
    const res = await gateway.invoke(ctx, {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: "delete_routine",
      input: { id: routine.id },
    });
    if (res.type !== "result") throw new Error(res.type);
    expect(res.output.isError).toBeFalsy();
    const deletedAt = async () =>
      (await f.db.select().from(schema.routines).where(eq(schema.routines.id, routine.id)))[0]?.deletedAt;
    expect(await deletedAt()).not.toBeNull();
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, ctx.runId));
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect(await deletedAt()).toBeNull();
  });

  test("a wiki page written as itself at the person's request, with Undo; never for who can't edit the wiki", async () => {
    f = await setup({ rightHand: true });
    const wiki = createToolGateway({ sources: [createWikiToolSource({ pubsub: f.pubsub, search: f.context })] });
    const write = async (ctx: ToolContext) => {
      const res = await wiki.invoke(ctx, {
        toolUseId: `tu_${crypto.randomUUID()}`,
        name: "create_wiki_page",
        input: { title: "Onboarding de marketing", body: "Primeiros passos." },
      });
      if (res.type !== "result") throw new Error(res.type);
      return res.output;
    };
    const pages = async () => await f.db.select().from(schema.wikiPages).where(eq(schema.wikiPages.orgId, f.org.id));
    const ctx = await lodiRun(f, f.owner.id, "documenta o onboarding de marketing na wiki");
    expect((await write(ctx)).isError).toBeFalsy();
    expect((await pages()).filter((p) => !p.deletedAt)).toHaveLength(1);
    const [receipt] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, ctx.runId));
    expect(receipt?.kind).toBe("wiki.page_created");
    await undoAgentAction({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, receipt?.id ?? "");
    expect((await pages()).filter((p) => !p.deletedAt)).toHaveLength(0);

    const [everyone] = await f.db
      .select()
      .from(schema.orgRoles)
      .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
    await updateRole(f.db, f.owner.id, f.org.id, everyone?.id ?? "", {
      permissions: (everyone?.permissions ?? []).filter((k) => k !== "edit_wiki"),
    });
    const bia = await addMember(f.db, f.org.id, "member", "Bia Teste");
    expect((await write(await lodiRun(f, bia.id, "documenta isso na wiki"))).isError).toBe(true);
    expect((await pages()).filter((p) => !p.deletedAt)).toHaveLength(0);
  });
});
