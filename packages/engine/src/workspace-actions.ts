import { holdEvents, type PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, schema, sql } from "@agenteschat/db";
import {
  type ActionRecord,
  type AgentActionTarget,
  actWithUndo,
  publishMessageActions,
  UNDO_WINDOW_MS,
} from "./agent-actions";
import { recordAudit } from "./audit";
import { setChannelOverride } from "./channel-permissions";
import { listChannels, requireChannelAccess } from "./channels";
import { findMember } from "./chat-tools";
import { ownWords } from "./context/learn";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { getMessage, insertMessage, messageView } from "./messages";
import { notify, resolveNotifications } from "./notifications";
import { can, getMembership } from "./organizations";
import {
  CHANNEL_KEYS,
  maySql,
  type Permission,
  ROLE_COLORS,
  ROLE_ICONS,
  ROLE_PERMISSIONS,
  type RolePermission,
} from "./permissions";
import { personBehindCall } from "./requester";
import {
  createRole,
  deleteRole,
  memberRoleIds,
  ROLE_NAME_MAX,
  reorderRoles,
  setMemberRoles,
  updateRole,
} from "./roles";
import { bodyCode } from "./run-tools";
import { replyThreadOf } from "./runs";
import { compactSchema, rankTools } from "./tools/directory";
import { canonicalJson, type JsonSchema, validateJson } from "./tools/json-schema";
import type { ToolContext, ToolDefinition, ToolOutput } from "./tools/types";

const { agentActions, channelPermissionOverrides, messages, organizationMembers, organizationMemberRoles, orgRoles } =
  schema;

/**
 * Anything else a person can change in the app, done by the right hand as them (ADR 0137 amendment of 2026-11-07): a
 * catalog of actions, each the engine call its screen makes with the person as the actor, so it never does more than
 * their click would. `workspace_action` finds one and does it: at once with Undo when the person who asked may decide
 * it in their own words (`ownWords`), else a card whoever may applies, as themselves (`decideWorkspaceAction`).
 */

export const WORKSPACE_ACTION_TOOL = "workspace_action";
/** The receipt of every catalog action (`params.action` says which): Undo runs the entry's own inverse. */
export const WORKSPACE_ACTION_KIND = "workspace.changed";
/** Its card's `bodyCode` (`chat.body.action_workspace`). */
export const WORKSPACE_ACTION_CARD = "action_workspace";
/** At most this many changes at once in one turn: enough for a request, never a flood. */
export const MAX_ACTIONS_PER_RUN = 10;

export interface ActionDeps {
  db: Database;
  pubsub?: PubSub;
}

/** What an action did: its receipt's target and words, and what its Undo puts back. */
export interface ActionDone {
  target: AgentActionTarget;
  /** The words of its receipt (`agentActions.workspace.changed_{action}`) and card (`rightHand.action.{action}`). */
  words: Record<string, string>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Nothing undoes it: its receipt is plain history. */
  final?: boolean;
}

type ActionRow = typeof agentActions.$inferSelect;
type Input = Record<string, unknown>;

export interface WorkspaceAction {
  id: string;
  /** What it does, for the model (English). */
  does: string;
  /** Its input, with names as the person says them. */
  input: JsonSchema;
  /**
   * `now`: at once with Undo when the person who asked may decide it, a card otherwise. `card`: always a card someone
   * confirms (it can't be undone, or it is a safety switch).
   */
  mode: "now" | "card";
  /** The key its screen asks for, to say who may (the engine call checks again, with all its rules): null, anyone. */
  needs: Permission | null;
  /** Names read as ids for `person`, or why not (English). What a card keeps and its click runs. */
  resolve(
    ctx: ToolContext,
    person: string,
    input: Input,
  ): Promise<{ input: Input; words: Record<string, string> } | string>;
  /** The engine call its screen makes, as `actorId`. */
  run(deps: ActionDeps, actorId: string, orgId: string, input: Input): Promise<ActionDone>;
  /** Undo (back to `before`) or Redo, as `actorId`; throws `changedSince()` when it moved since. The state to keep. */
  revert?(
    deps: ActionDeps,
    actorId: string,
    a: ActionRow,
    direction: "undo" | "redo",
    changedSince: () => Error,
  ): Promise<Record<string, unknown> | undefined>;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const sameSet = (a: readonly string[], b: readonly string[]) => same([...a].sort(), [...b].sort());

// ── Names ────────────────────────────────────────────────────────────────────

const EVERYONE_NAMES = new Set(["everyone", "todos", "@everyone", "@todos"]);

/** A role by name (`everyone` and its words too), or why not. */
async function roleNamed(ctx: Pick<ToolContext, "db" | "orgId">, name: string) {
  const rows = await ctx.db
    .select({ id: orgRoles.id, name: orgRoles.name, kind: orgRoles.kind })
    .from(orgRoles)
    .where(eq(orgRoles.orgId, ctx.orgId));
  const key = name.trim().toLowerCase();
  const hit = EVERYONE_NAMES.has(key)
    ? rows.find((r) => r.kind === "everyone")
    : rows.find((r) => r.kind === "custom" && r.name.toLowerCase() === key);
  return (
    hit ??
    `No role "${name}". Roles here: ${
      rows
        .filter((r) => r.kind === "custom")
        .map((r) => r.name)
        .join(", ") || "none but everyone"
    }.`
  );
}

/** One member by @handle, email or name, or why not. */
async function personNamed(ctx: Pick<ToolContext, "db" | "orgId">, who: string) {
  const found = await findMember(ctx, who);
  if (found.length === 1 && found[0]) return found[0];
  return found.length
    ? `Several people match "${who}": ${found.map((m) => (m.handle ? `${m.name} (@${m.handle})` : m.name)).join(", ")}. Ask which one.`
    : `No one called "${who}" in this workspace.`;
}

/** A channel the person sees, by name. */
async function channelNamed(ctx: Pick<ToolContext, "db" | "orgId">, person: string, name: string) {
  const wanted = name.trim().replace(/^#/, "").toLowerCase();
  const channel = (await listChannels(ctx.db, person, ctx.orgId)).find((c) => c.name === wanted);
  return channel ?? `They see no channel #${wanted}.`;
}

// ── Roles ────────────────────────────────────────────────────────────────────

/** What each key lets a role's people do, for the model choosing them. */
const KEY_WORDS =
  "post: write in channels; create_channels; mention_everyone; manage_channels: rename, archive and arrange channels; talk_to_agents; assign_work: give agents long work; manage_routines: any agent's routines; approve_actions: decide agents' approvals (merges, deploys, emails); create_agents; manage_agents: change any agent; pair_computers; own_browsers, own_computers: their own agents' browser or computer; control_browsers, control_computers: every agent's; manage_connectors: connect apps; manage_credentials: AI keys; use_others_plans; edit_wiki; upload_files; review_memory: agents' memory and instructions; invite_people; view_usage; view_audit; configure: the workspace's settings; manage_members: people's roles and removing people; manage_roles; manage_billing; administrator: all of them.";

const KEYS = { type: "array", items: { enum: [...ROLE_PERMISSIONS] }, maxItems: ROLE_PERMISSIONS.length };

/** The fields a role change can touch, as Undo compares and puts them back. */
const ROLE_FIELDS = ["name", "icon", "color", "permissions", "mentionable", "hoist"] as const;
type RoleRow = typeof orgRoles.$inferSelect;
const roleSnapshot = (r: RoleRow, fields: readonly string[] = ROLE_FIELDS) =>
  Object.fromEntries(
    fields.map((f) => [f, f === "permissions" ? [...r.permissions].sort() : r[f as (typeof ROLE_FIELDS)[number]]]),
  );

async function roleRow(db: Database, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.id, id)));
  return row ?? null;
}

const holders = async (db: Database, orgId: string, roleId: string) =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(organizationMemberRoles)
      .where(and(eq(organizationMemberRoles.orgId, orgId), eq(organizationMemberRoles.roleId, roleId)))
  )[0]?.n ?? 0;

/** The custom roles' ids, top first. */
const roleOrder = async (db: Database, orgId: string) =>
  (
    await db
      .select({ id: orgRoles.id })
      .from(orgRoles)
      .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom")))
      .orderBy(asc(orgRoles.position), asc(orgRoles.name))
  ).map((r) => r.id);

const roleTarget = (r: Pick<RoleRow, "id" | "name">): AgentActionTarget => ({ type: "role", id: r.id, title: r.name });

const createRoleAction: WorkspaceAction = {
  id: "create_role",
  does: "Create a role with what its people may do (permission keys), its color and icon.",
  input: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: ROLE_NAME_MAX },
      permissions: { ...KEYS, description: KEY_WORDS },
      color: { enum: [...ROLE_COLORS] },
      icon: { enum: [...ROLE_ICONS] },
      mentionable: { type: "boolean", description: "Whether @role mentions its people (default true)." },
      hoist: { type: "boolean", description: "Its people listed apart in the members column." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_roles",
  async resolve(_ctx, _person, input) {
    return { input, words: { name: str(input.name) } };
  },
  async run(deps, actorId, orgId, input) {
    const role = await createRole(
      deps.db,
      actorId,
      orgId,
      {
        name: str(input.name),
        permissions: list(input.permissions),
        ...(str(input.color) ? { color: str(input.color) } : {}),
        ...(str(input.icon) ? { icon: str(input.icon) } : {}),
        ...(typeof input.mentionable === "boolean" ? { mentionable: input.mentionable } : {}),
        ...(typeof input.hoist === "boolean" ? { hoist: input.hoist } : {}),
      },
      deps,
    );
    return { target: roleTarget(role), words: { name: role.name }, after: roleSnapshot(role) };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const after = obj(a.after);
    if (direction === "redo") {
      const role = await createRole(deps.db, actorId, a.orgId, after as Parameters<typeof createRole>[3], deps);
      return { roleId: role.id };
    }
    const id = str(obj(a.state).roleId) || a.targetId;
    const role = await roleRow(deps.db, a.orgId, id);
    if (!role) throw new NotFoundError("The role is gone", "action.target_gone");
    // Someone holds it or changed it since: deleting it would take that away.
    if (!same(roleSnapshot(role), after) || (await holders(deps.db, a.orgId, id)) > 0) throw changedSince();
    await deleteRole(deps.db, actorId, a.orgId, id, deps);
    return undefined;
  },
};

const updateRoleAction: WorkspaceAction = {
  id: "update_role",
  does: "Change a role: its name, color or icon, the permission keys it gives or takes, its switches.",
  input: {
    type: "object",
    properties: {
      role: { type: "string", minLength: 1, maxLength: 80, description: "Its name (everyone: the base role)." },
      name: { type: "string", minLength: 1, maxLength: ROLE_NAME_MAX },
      color: { enum: [...ROLE_COLORS] },
      icon: { enum: [...ROLE_ICONS] },
      add_permissions: { ...KEYS, description: KEY_WORDS },
      remove_permissions: KEYS,
      mentionable: { type: "boolean" },
      hoist: { type: "boolean" },
    },
    required: ["role"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_roles",
  async resolve(ctx, _person, input) {
    const role = await roleNamed(ctx, str(input.role));
    if (typeof role === "string") return role;
    const { role: _, ...rest } = input;
    return { input: { ...rest, roleId: role.id }, words: { name: role.name } };
  },
  async run(deps, actorId, orgId, input) {
    const role = await roleRow(deps.db, orgId, str(input.roleId));
    if (!role) throw new NotFoundError("Role not found");
    const add = list(input.add_permissions);
    const take = list(input.remove_permissions);
    const patch: Record<string, unknown> = {};
    for (const f of ["name", "color", "icon"] as const) if (str(input[f])) patch[f] = str(input[f]);
    for (const f of ["mentionable", "hoist"] as const) if (typeof input[f] === "boolean") patch[f] = input[f];
    if (add.length || take.length)
      patch.permissions = [...new Set([...role.permissions, ...add])].filter((k) => !take.includes(k));
    const fields = Object.keys(patch);
    if (fields.length === 0) throw new ValidationError("Say what changes on the role");
    const updated = await updateRole(deps.db, actorId, orgId, role.id, patch, deps);
    const before = roleSnapshot(role, fields);
    const after = roleSnapshot(updated, fields);
    if (same(before, after)) throw new ValidationError(`${role.name} already is like that`);
    return { target: roleTarget(updated), words: { name: updated.name }, before, after };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    const role = await roleRow(deps.db, a.orgId, a.targetId);
    if (!role) throw new NotFoundError("The role is gone", "action.target_gone");
    if (!same(roleSnapshot(role, Object.keys(from)), from)) throw changedSince();
    await updateRole(deps.db, actorId, a.orgId, role.id, to, deps);
    return undefined;
  },
};

const deleteRoleAction: WorkspaceAction = {
  id: "delete_role",
  does: "Delete a role for good: whoever held it keeps their other roles.",
  input: {
    type: "object",
    properties: { role: { type: "string", minLength: 1, maxLength: 80 } },
    required: ["role"],
    additionalProperties: false,
  },
  mode: "card",
  needs: "manage_roles",
  async resolve(ctx, _person, input) {
    const role = await roleNamed(ctx, str(input.role));
    if (typeof role === "string") return role;
    if (role.kind === "everyone") return "The base role (everyone) can't be deleted.";
    return { input: { roleId: role.id }, words: { name: role.name } };
  },
  async run(deps, actorId, orgId, input) {
    const role = await roleRow(deps.db, orgId, str(input.roleId));
    if (!role) throw new NotFoundError("Role not found");
    await deleteRole(deps.db, actorId, orgId, role.id, deps);
    return { target: roleTarget(role), words: { name: role.name }, final: true };
  },
};

const moveRoleAction: WorkspaceAction = {
  id: "move_role",
  does: "Move a role above or below another (order is rank: people only manage roles below their own).",
  input: {
    type: "object",
    properties: {
      role: { type: "string", minLength: 1, maxLength: 80 },
      above: { type: "string", minLength: 1, maxLength: 80, description: "Right above this role." },
      below: { type: "string", minLength: 1, maxLength: 80, description: "Right below this role." },
    },
    required: ["role"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_roles",
  async resolve(ctx, _person, input) {
    const role = await roleNamed(ctx, str(input.role));
    if (typeof role === "string") return role;
    const anchorName = str(input.above) || str(input.below);
    if (!anchorName) return "Say which role it goes above or below.";
    const anchor = await roleNamed(ctx, anchorName);
    if (typeof anchor === "string") return anchor;
    if (role.kind === "everyone" || anchor.kind === "everyone") return "The base role (everyone) is always last.";
    if (anchor.id === role.id) return "A role can't move next to itself.";
    return {
      input: { roleId: role.id, anchorId: anchor.id, above: Boolean(str(input.above)) },
      words: { name: role.name, other: anchor.name },
    };
  },
  async run(deps, actorId, orgId, input) {
    const role = await roleRow(deps.db, orgId, str(input.roleId));
    if (!role) throw new NotFoundError("Role not found");
    const before = await roleOrder(deps.db, orgId);
    const rest = before.filter((id) => id !== role.id);
    const at = rest.indexOf(str(input.anchorId));
    if (at < 0) throw new NotFoundError("Role not found");
    const after = [...rest.slice(0, input.above ? at : at + 1), role.id, ...rest.slice(input.above ? at : at + 1)];
    if (same(before, after)) throw new ValidationError(`${role.name} is already there`);
    await reorderRoles(deps.db, actorId, orgId, after, deps);
    return { target: roleTarget(role), words: { name: role.name }, before: { order: before }, after: { order: after } };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    if (!same(await roleOrder(deps.db, a.orgId), from.order)) throw changedSince();
    await reorderRoles(deps.db, actorId, a.orgId, to.order as string[], deps);
    return undefined;
  },
};

const setMemberRolesAction: WorkspaceAction = {
  id: "set_member_roles",
  does: "Give a person roles or take roles from them.",
  input: {
    type: "object",
    properties: {
      person: { type: "string", minLength: 1, maxLength: 200, description: "@handle, email or name." },
      add_roles: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 20 },
      remove_roles: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 20 },
    },
    required: ["person"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_members",
  async resolve(ctx, _person, input) {
    const who = await personNamed(ctx, str(input.person));
    if (typeof who === "string") return who;
    const pick = async (names: string[]) => {
      const out: { id: string; name: string }[] = [];
      for (const n of names) {
        const role = await roleNamed(ctx, n);
        if (typeof role === "string") return role;
        if (role.kind === "everyone") return "Everyone holds the base role (everyone): it isn't given or taken.";
        out.push(role);
      }
      return out;
    };
    const add = await pick(list(input.add_roles));
    if (typeof add === "string") return add;
    const take = await pick(list(input.remove_roles));
    if (typeof take === "string") return take;
    if (add.length + take.length === 0) return "Say which roles they get or lose.";
    return {
      input: { userId: who.userId, name: who.name, add: add.map((r) => r.id), remove: take.map((r) => r.id) },
      words: { name: who.name, change: roleChange(add, take) },
    };
  },
  async run(deps, actorId, orgId, input) {
    const userId = str(input.userId);
    const add = list(input.add);
    const take = list(input.remove);
    const before = await memberRoleIds(deps.db, orgId, userId);
    const next = [...new Set([...before, ...add])].filter((id) => !take.includes(id));
    if (sameSet(before, next)) throw new ValidationError(`${str(input.name)} already has those roles`);
    await setMemberRoles(deps.db, actorId, orgId, userId, next, deps);
    const names = await roleNames(deps.db, orgId, [...add, ...take]);
    const pick = (ids: string[]) => ids.map((id) => ({ name: names.get(id) ?? "" }));
    return {
      target: { type: "person", id: userId, title: str(input.name) },
      words: { name: str(input.name), change: roleChange(pick(add), pick(take)) },
      before: { roleIds: before },
      after: { roleIds: next },
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    if (!sameSet(await memberRoleIds(deps.db, a.orgId, a.targetId), list(from.roleIds))) throw changedSince();
    await setMemberRoles(deps.db, actorId, a.orgId, a.targetId, list(to.roleIds), deps);
    return undefined;
  },
};

/** "+ Marketing, − Vendas": the same in every language. */
const roleChange = (add: { name: string }[], take: { name: string }[]) =>
  [...add.map((r) => `+ ${r.name}`), ...take.map((r) => `− ${r.name}`)].join(", ");

async function roleNames(db: Database, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: orgRoles.id, name: orgRoles.name })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), inArray(orgRoles.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const CHANNEL_KEY_LIST = { type: "array", items: { enum: [...CHANNEL_KEYS] }, maxItems: CHANNEL_KEYS.length };

/** A channel exception's keys now (null: none). */
async function overrideNow(db: Database, channelId: string, target: { type: "role" | "person"; id: string }) {
  const [row] = await db
    .select({ allow: channelPermissionOverrides.allow, deny: channelPermissionOverrides.deny })
    .from(channelPermissionOverrides)
    .where(
      and(
        eq(channelPermissionOverrides.channelId, channelId),
        target.type === "role"
          ? eq(channelPermissionOverrides.roleId, target.id)
          : eq(channelPermissionOverrides.userId, target.id),
      ),
    );
  return row ? { allow: [...row.allow].sort(), deny: [...row.deny].sort() } : { allow: [], deny: [] };
}

const channelPermissionsAction: WorkspaceAction = {
  id: "set_channel_permissions",
  does: "In one channel, allow or deny a role or a person to post, to talk to agents or to manage the channel, against what their roles say; clear: back to their roles.",
  input: {
    type: "object",
    properties: {
      channel: { type: "string", minLength: 1, maxLength: 81 },
      role: { type: "string", minLength: 1, maxLength: 80, description: "A role, or everyone." },
      person: { type: "string", minLength: 1, maxLength: 200 },
      allow: CHANNEL_KEY_LIST,
      deny: CHANNEL_KEY_LIST,
      clear: { type: "boolean", description: "True: remove this role's or person's exception." },
    },
    required: ["channel"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_channels",
  async resolve(ctx, person, input) {
    const channel = await channelNamed(ctx, person, str(input.channel));
    if (typeof channel === "string") return channel;
    let target: { type: "role" | "person"; id: string; name: string };
    if (str(input.role)) {
      const role = await roleNamed(ctx, str(input.role));
      if (typeof role === "string") return role;
      target = { type: "role", id: role.id, name: role.name };
    } else if (str(input.person)) {
      const who = await personNamed(ctx, str(input.person));
      if (typeof who === "string") return who;
      target = { type: "person", id: who.userId, name: who.name };
    } else return "Say for which role or person.";
    const allow = input.clear === true ? [] : list(input.allow);
    const deny = input.clear === true ? [] : list(input.deny);
    if (input.clear !== true && allow.length + deny.length === 0) return "Say what to allow or deny, or clear.";
    return {
      input: { channelId: channel.id, channel: channel.name, target, allow, deny },
      words: { channel: channel.name, who: target.name },
    };
  },
  async run(deps, actorId, orgId, input) {
    const channelId = str(input.channelId);
    const target = obj(input.target) as { type: "role" | "person"; id: string; name: string };
    const before = await overrideNow(deps.db, channelId, target);
    const after = { allow: list(input.allow).sort(), deny: list(input.deny).sort() };
    if (same(before, after)) throw new ValidationError("That channel already has that exception");
    await setChannelOverride(deps.db, actorId, orgId, channelId, { target, ...after }, deps);
    return {
      target: { type: "channel", id: channelId, title: str(input.channel) },
      words: { channel: str(input.channel), who: target.name },
      before: { target, ...before },
      after: { target, ...after },
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    const target = obj(from.target) as { type: "role" | "person"; id: string };
    if (!same(await overrideNow(deps.db, a.targetId, target), { allow: from.allow, deny: from.deny }))
      throw changedSince();
    await setChannelOverride(
      deps.db,
      actorId,
      a.orgId,
      a.targetId,
      { target, allow: list(to.allow), deny: list(to.deny) },
      deps,
    );
    return undefined;
  },
};

// ── The catalog ──────────────────────────────────────────────────────────────

export const WORKSPACE_ACTIONS: readonly WorkspaceAction[] = [
  createRoleAction,
  updateRoleAction,
  deleteRoleAction,
  moveRoleAction,
  setMemberRolesAction,
  channelPermissionsAction,
];

export const workspaceAction = (id: unknown) => WORKSPACE_ACTIONS.find((a) => a.id === id) ?? null;

/** The catalog as tools, for the search the directory runs. */
const asTools = () =>
  WORKSPACE_ACTIONS.map((a) => ({ name: a.id, description: a.does, inputSchema: a.input }) as ToolDefinition);

/** Whether this member may, as far as its screen's key goes (the engine call checks the rest). */
const mayDo = (membership: Awaited<ReturnType<typeof getMembership>>, a: WorkspaceAction) =>
  Boolean(membership) && (a.needs === null || can(membership, a.needs));

/** `find`: the best actions for what the person wants, with their input and whether they may. */
export async function findWorkspaceActions(ctx: ToolContext, person: string | null, query: string) {
  const membership = person ? await getMembership(ctx.db, person, ctx.orgId) : null;
  const best = rankTools(asTools(), "", query)
    .slice(0, 5)
    .map((t) => workspaceAction(t.name) as WorkspaceAction);
  if (best.length === 0)
    return `No action matches. The actions: ${WORKSPACE_ACTIONS.map((a) => a.id).join(", ")}. Billing, deleting the workspace or an account, passwords and keys: offer_open_page.`;
  return best
    .map(
      (a) =>
        `- ${a.id}: ${a.does} ${
          mayDo(membership, a)
            ? a.mode === "now"
              ? "They may: it applies at once with Undo."
              : "They may: a card they confirm."
            : "They can't: a card for someone who may."
        } Input: ${compactSchema(a.input)}`,
    )
    .join("\n");
}

// ── Doing it ─────────────────────────────────────────────────────────────────

/** The receipt of a done action: its kind, with what Undo needs. */
const recordOf = (a: WorkspaceAction, done: ActionDone): ActionRecord => ({
  kind: WORKSPACE_ACTION_KIND,
  target: done.target,
  params: { action: a.id, ...done.words },
  before: done.before ?? null,
  after: done.after ?? null,
  ...(done.final ? { final: true } : {}),
});

/** `meta.actionCard` of a catalog action waiting for someone who may (and how it ended). */
export interface WorkspaceActionCard {
  kind: "workspace_action";
  forUserId: string;
  params: {
    action: string;
    input: Input;
    words: Record<string, string>;
    needs: Permission | null;
    why: string;
  };
  state: "pending" | "applied" | "dismissed";
  decidedByUserId: string | null;
  decidedAt: string | null;
  /** "Pedir a quem pode": sent to whoever may (their inbox opens the card). */
  askedAt?: string | null;
}

const changesThisRun = async (ctx: ToolContext) =>
  (
    await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentActions)
      .where(
        and(
          eq(agentActions.orgId, ctx.orgId),
          eq(agentActions.runId, ctx.runId),
          eq(agentActions.kind, WORKSPACE_ACTION_KIND),
        ),
      )
  )[0]?.n ?? 0;

/** Runs `a` now for the person behind the call, its receipt in the same transaction (null: they may not). */
export async function actNow(
  deps: { pubsub?: PubSub },
  ctx: ToolContext,
  person: string,
  a: WorkspaceAction,
  input: Input,
): Promise<ActionDone | null> {
  const events = holdEvents(deps.pubsub);
  try {
    const done = await actWithUndo(
      ctx,
      (db) => a.run({ db, pubsub: events.pubsub }, person, ctx.orgId, input),
      (d) => recordOf(a, d),
    );
    await events.flush();
    return done;
  } catch (error) {
    if (error instanceof ForbiddenError) return null;
    throw error;
  }
}

/** The tool's card tools (`cardsLeft`, `hopOf`), passed in as `teamTools` takes them. */
export interface CardTools {
  cardsLeft: (ctx: ToolContext, asks?: boolean) => Promise<ToolOutput | null>;
  hopOf: (ctx: ToolContext) => Promise<number>;
}

/**
 * `workspace_action` (the right hand only): finds an action of the catalog and does it as the person behind the run,
 * with their permissions. One tool for all of them, so its prompt stays the size of one.
 */
export function workspaceActionTool(deps: { pubsub?: PubSub } & CardTools): ToolDefinition {
  return {
    name: WORKSPACE_ACTION_TOOL,
    description:
      "Do anything else the app lets this person do, as them and never more: roles and what each may do, people's roles, a channel's permissions and settings. First call it with `find` (what they want, in a few words), then with `action`, its `input` and `why`. A change they may make, asked in their own words, applies at once with Undo; anything else becomes a card for whoever may. The result says which: never say it is done before it does.",
    scope: "setup:write",
    inputSchema: {
      type: "object",
      properties: {
        find: { type: "string", minLength: 1, maxLength: 200, description: "What they want done, in a few words." },
        action: { type: "string", minLength: 1, maxLength: 64, description: "An action from find." },
        input: { type: "object", description: "The action's input, as find showed it." },
        why: { type: "string", maxLength: 300, description: "One short line for its card, in their language." },
      },
      additionalProperties: false,
    },
    async execute(raw, ctx) {
      try {
        const person = await personBehindCall(ctx);
        if (str(raw.find) && !str(raw.action))
          return { content: await findWorkspaceActions(ctx, person, str(raw.find)) };
        if (!person) return { content: "Only a person's request changes the workspace.", isError: true };
        const a = workspaceAction(str(raw.action));
        if (!a)
          return {
            content: `No action "${str(raw.action)}". Closest:\n${await findWorkspaceActions(ctx, person, str(raw.action).replace(/_/g, " "))}`,
            isError: true,
          };
        const given = obj(raw.input);
        const errors = validateJson(a.input, given);
        if (errors.length > 0)
          return { content: `Wrong input: ${errors.join("; ")}. Input: ${compactSchema(a.input)}`, isError: true };
        const resolved = await a.resolve(ctx, person, given);
        if (typeof resolved === "string") return { content: resolved, isError: true };
        const membership = await getMembership(ctx.db, person, ctx.orgId);
        let may = mayDo(membership, a);
        if (a.mode === "now" && may && (await ownWords(ctx)) === person) {
          if ((await changesThisRun(ctx)) >= MAX_ACTIONS_PER_RUN)
            return { content: `You already made ${MAX_ACTIONS_PER_RUN} changes in this turn.`, isError: true };
          const done = await actNow(deps, ctx, person, a, resolved.input);
          if (done)
            return {
              content: `Done at once, with Undo under your reply: ${a.id} (${describe(done.words)}). Say it is done.`,
            };
          // Refused by the engine's own rules (a role above theirs, a key they don't hold): someone who may decides.
          may = false;
        }
        const full = await deps.cardsLeft(ctx);
        if (full) return full;
        const card: WorkspaceActionCard = {
          kind: "workspace_action",
          forUserId: person,
          params: { action: a.id, input: resolved.input, words: resolved.words, needs: a.needs, why: str(raw.why) },
          state: "pending",
          decidedByUserId: null,
          decidedAt: null,
        };
        const message = await postActionCard(deps, ctx, card);
        return {
          content: `Posted a card to ${a.id} (${describe(resolved.words)}). ${
            may
              ? "They apply it there."
              : "They can't make this change: the card lets them send it to whoever may. Say so."
          } Nothing has changed yet.`,
          data: { actionCard: { messageId: message } },
        };
      } catch (error) {
        return { content: `Failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  };
}

const describe = (words: Record<string, string>) =>
  Object.entries(words)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

async function postActionCard(deps: { pubsub?: PubSub } & CardTools, ctx: ToolContext, card: WorkspaceActionCard) {
  const message = await insertMessage(ctx.db, {
    orgId: ctx.orgId,
    channelId: ctx.channelId,
    threadId: replyThreadOf(ctx),
    author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await deps.hopOf(ctx) },
    body: `Proposed ${card.params.action} (${describe(card.params.words)})${card.params.why ? `: ${card.params.why}` : ""}`,
    meta: { ...bodyCode(WORKSPACE_ACTION_CARD), actionCard: card },
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return message.id;
}

// ── The card ─────────────────────────────────────────────────────────────────

const cardOf = (meta: Record<string, unknown> | null | undefined) => {
  const c = meta?.actionCard as WorkspaceActionCard | undefined;
  return c?.kind === "workspace_action" && c.params && typeof c.params.action === "string" ? c : null;
};

const ASK_GROUP = "change_request:action:";

/** The card behind `messageId` for someone who reads its conversation, or whom it was sent to (and may). */
async function cardMessage(db: Database, userId: string, orgId: string, messageId: string) {
  const message = await getMessage(db, orgId, messageId);
  const card = message && !message.deletedAt && message.authorType === "agent" ? cardOf(message.meta) : null;
  if (!message || !card) throw new NotFoundError("Card not found", "action_card.not_found");
  const membership = await getMembership(db, userId, orgId);
  const asked = card.askedAt && membership && (card.params.needs === null || can(membership, card.params.needs));
  if (!asked) await requireChannelAccess(db, userId, orgId, message.channelId);
  if (!membership) throw new NotFoundError("Card not found", "action_card.not_found");
  return { message, card, membership };
}

/** The card as it is now (`GET`), for its conversation or the inbox of whom it was sent to. */
export async function getWorkspaceActionCard(db: Database, userId: string, orgId: string, messageId: string) {
  const { message, card } = await cardMessage(db, userId, orgId, messageId);
  return { messageId: message.id, channelId: message.channelId, threadId: message.threadId, card };
}

async function announceCard(
  deps: ActionDeps,
  message: { channelId: string; threadId: string | null; id: string },
  card: WorkspaceActionCard,
) {
  await publishChannelEvent(deps.pubsub, {
    type: "action_card.updated",
    channelId: message.channelId,
    threadId: message.threadId,
    messageId: message.id,
    card: card as unknown as Record<string, unknown>,
  });
}

/**
 * Aplicar or Descartar on the card, as whoever clicks: Aplicar runs the action with their permissions (the engine call
 * refuses what they can't do) and puts its receipt, with Undo, on the card; Descartar is for the person it was for or
 * anyone who may. Once: a card already decided is refused.
 */
export async function decideWorkspaceAction(
  deps: ActionDeps,
  userId: string,
  orgId: string,
  messageId: string,
  decision: "apply" | "dismiss",
) {
  const found = await cardMessage(deps.db, userId, orgId, messageId);
  const a = workspaceAction(found.card.params.action);
  if (!a) throw new ValidationError("This build doesn't know that action", "action_card.unknown");
  const decided = () => new ConflictError("This card was already decided", "action_card.decided");
  if (found.card.state !== "pending") throw decided();
  if (decision === "dismiss" && found.card.forUserId !== userId && !mayDo(found.membership, a))
    throw new ForbiddenError("Only the person it was for, or someone who may, dismisses it", "action_card.not_allowed");
  const events = holdEvents(deps.pubsub);
  const next = await deps.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    // Locked: two clicks at once never apply it twice.
    const [row] = await db
      .select({ meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)))
      .for("update");
    if (cardOf(row?.meta)?.state !== "pending") throw decided();
    const card: WorkspaceActionCard = {
      ...found.card,
      state: decision === "apply" ? "applied" : "dismissed",
      decidedByUserId: userId,
      decidedAt: new Date().toISOString(),
    };
    if (decision === "apply") {
      const done = await a.run({ db, pubsub: events.pubsub }, userId, orgId, found.card.params.input);
      const record = recordOf(a, done);
      const now = new Date();
      await db.insert(agentActions).values({
        orgId,
        runId: found.message.agentRunId,
        agentId: found.message.authorAgentId as string,
        channelId: found.message.channelId,
        messageId,
        // Whoever applied it may undo it, as may admins and its agent's owner.
        requestedByUserId: userId,
        kind: record.kind,
        targetType: record.target.type,
        targetId: record.target.id,
        target: (({ type: _t, id: _i, ...label }) => label)(record.target),
        params: record.params ?? {},
        before: record.before ?? null,
        after: record.after ?? null,
        createdAt: now,
        undoableUntil: new Date(now.getTime() + (record.final ? 0 : UNDO_WINDOW_MS)),
      });
      card.params = { ...card.params, words: { ...card.params.words, ...done.words } };
    }
    await db
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(card)}::jsonb)` })
      .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: userId },
      action: decision === "apply" ? "action_card.applied" : "action_card.dismissed",
      target: { type: "message", id: messageId },
      details: { action: a.id, via: found.message.authorAgentId },
    });
    return card;
  });
  await events.flush();
  await resolveNotifications(deps, orgId, { groupKey: `${ASK_GROUP}${messageId}` }).catch(() => 0);
  await announceCard(deps, { ...found.message }, next);
  if (decision === "apply") await publishMessageActions(deps, orgId, messageId);
  return next;
}

/**
 * "Pedir a quem pode": the person it was for can't make the change, so it goes to whoever may, as an inbox entry
 * (waiting) that opens the card; their click applies it as them. Once per card.
 */
export async function askWorkspaceAction(deps: ActionDeps, userId: string, orgId: string, messageId: string) {
  const found = await cardMessage(deps.db, userId, orgId, messageId);
  const { message, card } = found;
  const a = workspaceAction(card.params.action);
  if (!a) throw new ValidationError("This build doesn't know that action", "action_card.unknown");
  if (card.forUserId !== userId)
    throw new ForbiddenError("Only the person it was for can send it", "action_card.not_requester");
  if (card.state !== "pending") throw new ConflictError("This card was already decided", "action_card.decided");
  if (card.askedAt) throw new ConflictError("It was already sent", "action_card.asked");
  if (mayDo(found.membership, a)) throw new ConflictError("You can apply it yourself", "action_card.yours");
  const next: WorkspaceActionCard = { ...card, askedAt: new Date().toISOString() };
  const [row] = await deps.db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(next)}::jsonb)` })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.orgId, orgId),
        sql`${messages.meta}->'actionCard'->>'state' = 'pending'`,
        sql`not (${messages.meta}->'actionCard' ? 'askedAt')`,
      ),
    )
    .returning({ id: messages.id });
  if (!row) throw new ConflictError("It was already sent", "action_card.asked");
  const deciders = await deps.db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        a.needs && a.needs !== "read" && a.needs !== "manage_owners"
          ? maySql(orgId, organizationMembers.userId, a.needs as RolePermission)
          : eq(organizationMembers.role, "owner"),
      ),
    );
  await notify(deps, {
    orgId,
    userIds: deciders.map((d) => d.userId).filter((id) => id !== userId),
    kind: "change_request",
    groupKey: `${ASK_GROUP}${message.id}`,
    waiting: true,
    actor: { type: "user", id: userId },
    source: {
      messageId: message.id,
      action: a.id,
      ...(message.authorAgentId ? { agentId: message.authorAgentId } : {}),
      label: Object.values(card.params.words)[0] ?? a.id,
    },
    latest: { text: card.params.why || describe(card.params.words) },
  }).catch(() => {});
  await announceCard(deps, message, next);
  return next;
}

/** Undo or Redo of a catalog action's receipt, as `userId` (`agent-undo.ts`). */
export async function revertWorkspaceAction(
  deps: ActionDeps,
  a: ActionRow,
  userId: string,
  direction: "undo" | "redo",
  changedSince: () => Error,
) {
  const entry = workspaceAction(obj(a.params).action);
  if (!entry?.revert) throw new ConflictError("This can't be undone", "action.not_undoable");
  const events = holdEvents(deps.pubsub);
  const state = await entry.revert({ db: deps.db, pubsub: events.pubsub }, userId, a, direction, changedSince);
  await events.flush();
  return state;
}
