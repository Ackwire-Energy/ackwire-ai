import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  actionsFor,
  askWorkspaceAction,
  createRole,
  createSetupToolSource,
  createToolGateway,
  decideWorkspaceAction,
  getWorkspaceActionCard,
  insertMessage,
  linkRunActions,
  memberRoleIds,
  openPersonAgentDm,
  postPersonMessage,
  RIGHT_HAND,
  setMemberRoles,
  type ToolContext,
  undoAgentAction,
  undoMessageActions,
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

const gatewayOf = (fx: Fixture) => createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub })] });
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
    expect(await roleNamed(f, "Revisores")).toBeNull();
    expect((await lastCard(f))?.card.params.action).toBe("create_role");
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
