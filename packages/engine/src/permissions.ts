import { type SQL, sql } from "@agenteschat/db";

/**
 * What a role may grant in a workspace (ADR 0084), in five areas. Every member may also `read` (see the workspace,
 * its people, agents and the channels open to them); only an owner may `manage_owners` (give and take ownership,
 * delete the workspace). Agents never hold these: what an agent may do comes from its own scopes (Tool Gateway).
 * The apps draw the roles screen from `PERMISSION_AREAS` (sent by `GET …/roles`) and name each key with i18n.
 */
export const PERMISSION_AREAS = [
  {
    id: "chat",
    use: ["post", "create_channels"],
    keys: ["post", "create_channels", "manage_channels"],
  },
  {
    id: "agents",
    use: ["talk_to_agents", "assign_work", "manage_routines"],
    keys: ["talk_to_agents", "assign_work", "manage_routines", "approve_actions", "create_agents", "manage_agents"],
  },
  {
    id: "tools",
    use: ["pair_computers", "control_computers"],
    keys: ["pair_computers", "control_computers", "manage_connectors", "manage_credentials"],
  },
  {
    id: "knowledge",
    use: ["edit_wiki", "upload_files"],
    keys: ["edit_wiki", "upload_files", "review_memory"],
  },
  {
    id: "org",
    use: ["invite_people"],
    keys: [
      "invite_people",
      "view_usage",
      "view_audit",
      "configure",
      "manage_members",
      "manage_roles",
      "manage_billing",
    ],
  },
] as const;

export type PermissionArea = (typeof PERMISSION_AREAS)[number]["id"];
/** A key a role can hold. `administrator` grants every other one. */
export type RolePermission = "administrator" | (typeof PERMISSION_AREAS)[number]["keys"][number];
/** What the server checks: a role's keys, plus `read` (every member) and `manage_owners` (owners only). */
export type Permission = RolePermission | "read" | "manage_owners";

/** Every key but `administrator`, in the areas' order. */
export const AREA_PERMISSIONS: readonly RolePermission[] = PERMISSION_AREAS.flatMap((a) => a.keys);
export const ROLE_PERMISSIONS: readonly RolePermission[] = ["administrator", ...AREA_PERMISSIONS];

export const isRolePermission = (v: unknown): v is RolePermission =>
  typeof v === "string" && (ROLE_PERMISSIONS as readonly string[]).includes(v);

/**
 * What the `everyone` role ("Todos") holds in a new workspace: what any member could do before roles, now as
 * keys (the same list as migration 0128).
 */
export const EVERYONE_DEFAULTS: readonly RolePermission[] = [
  "post",
  "create_channels",
  "talk_to_agents",
  "assign_work",
  "pair_computers",
  "edit_wiki",
  "upload_files",
];

/** The roles' look: one of the agents' colors but sky (the agents' own) and one of the apps' role icons. */
export const ROLE_COLORS = ["indigo", "violet", "rose", "amber", "green", "teal", "graphite"] as const;
export const ROLE_ICONS = [
  "shield",
  "code",
  "wallet",
  "mail",
  "bolt",
  "flag",
  "book",
  "chart",
  "bulb",
  "globe",
  "pullRequest",
  "calendar",
  "message",
  "eye",
  "plug",
  "person",
] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];
export type RoleIcon = (typeof ROLE_ICONS)[number];

/**
 * Everything a person may do from their roles' keys (theirs and `everyone`'s): an owner everything, a key
 * `administrator` every role key; `read` always.
 */
export function resolvePermissions(owner: boolean, keys: Iterable<string>): ReadonlySet<Permission> {
  if (owner) return new Set<Permission>(["read", "manage_owners", ...ROLE_PERMISSIONS]);
  const out = new Set<Permission>(["read"]);
  for (const k of keys) if (isRolePermission(k)) out.add(k);
  if (out.has("administrator")) for (const k of AREA_PERMISSIONS) out.add(k);
  return out;
}

/** The keys a role holds once `administrator` is spread out (what the role screen shows on). */
export function roleGrants(keys: Iterable<string>): ReadonlySet<RolePermission> {
  const out = new Set<RolePermission>();
  for (const k of keys) if (isRolePermission(k)) out.add(k);
  if (out.has("administrator")) for (const k of AREA_PERMISSIONS) out.add(k);
  return out;
}

/**
 * The keys of every role a member holds, as SQL over `organization_members` aliased `m`: theirs and `everyone`.
 * Used where a membership is read (`getMembership`, `listMemberships`).
 */
export const memberKeysSql = (m: { orgId: unknown; userId: unknown }) => sql<string[]>`coalesce((
  select array_agg(distinct k) from org_roles r, unnest(r.permissions) as k
  where r.org_id = ${m.orgId}
    and (r.kind = 'everyone' or r.id in (
      select mr.role_id from organization_member_roles mr where mr.org_id = ${m.orgId} and mr.user_id = ${m.userId}))
), '{}'::text[])`;

/** The position of a member's highest role (0 the top), null with none but `everyone`. */
export const memberRankSql = (m: { orgId: unknown; userId: unknown }) => sql<number | null>`(
  select min(r.position) from org_roles r join organization_member_roles mr on mr.org_id = r.org_id and mr.role_id = r.id
  where r.org_id = ${m.orgId} and mr.user_id = ${m.userId} and r.kind = 'custom')`;

/**
 * Whether the member `userId` of `orgId` may `permission`, as a SQL condition: an owner, or a role of theirs (or
 * `everyone`) holding the key or `administrator`. For checks inside one statement (the message insert's runs,
 * lists of who may decide).
 */
export function maySql(orgId: unknown, userId: unknown, permission: RolePermission): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from organization_members pm
    where pm.org_id = ${orgId} and pm.user_id = ${userId}
      and (pm.role = 'owner' or exists (
        select 1 from org_roles pr
        where pr.org_id = pm.org_id
          and (pr.kind = 'everyone' or pr.id in (
            select pmr.role_id from organization_member_roles pmr where pmr.org_id = pm.org_id and pmr.user_id = pm.user_id))
          and pr.permissions && array[${permission}, 'administrator']::text[])))`;
}

/** The ids of the members of `orgId` who may `permission` (owners included), as a SQL subquery. */
export function membersWhoMaySql(orgId: unknown, permission: RolePermission): SQL {
  return sql`(select wm.user_id from organization_members wm where wm.org_id = ${orgId}
    and ${maySql(sql`wm.org_id`, sql`wm.user_id`, permission)})`;
}
