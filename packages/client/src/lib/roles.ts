import type { TFunction } from "i18next";
import type { OrgRole, PermissionArea, Person } from "../api/types";
import { joinNames } from "./format";
import { can, type RolePermission } from "./permissions";

/**
 * A workspace's roles on screen (ADR 0085): each area of permissions at a level, the line that sums a role up, and
 * the order. Pure, for the web and the phone app.
 */

/** The permission areas (`PERMISSION_AREAS` on the server). */
export type PermissionAreaId = "chat" | "agents" | "tools" | "knowledge" | "org";

/** An area's level: nothing past `everyone` ("Como Todos"), its "use" keys, all of them, or a mix. */
export type AreaLevel = "none" | "use" | "manage" | "custom";

/** Every key with `administrator` spread out. */
export function grants(keys: readonly string[]): Set<string> {
  const out = new Set(keys);
  if (out.has("administrator")) for (const k of ALL_KEYS) out.add(k);
  return out;
}

/** The keys the summary names first: what tells roles apart. */
export const SUMMARY_ORDER: readonly RolePermission[] = [
  "administrator",
  "approve_actions",
  "manage_agents",
  "control_computers",
  "manage_connectors",
  "manage_credentials",
  "manage_members",
  "manage_roles",
  "view_usage",
  "configure",
  "view_audit",
  "manage_billing",
  "create_agents",
  "manage_channels",
  "manage_routines",
  "review_memory",
  "invite_people",
  "pair_computers",
  "talk_to_agents",
  "assign_work",
  "post",
  "create_channels",
  "edit_wiki",
  "upload_files",
];
const ALL_KEYS = SUMMARY_ORDER.filter((k) => k !== "administrator");

export const isEveryone = (r: Pick<OrgRole, "kind">) => r.kind === "everyone";
export const everyoneOf = (roles: readonly OrgRole[]) => roles.find(isEveryone);

/** Top first, `everyone` last. */
export const sortRoles = (roles: readonly OrgRole[]) =>
  [...roles].sort(
    (a, b) =>
      (isEveryone(a) ? 1 : 0) - (isEveryone(b) ? 1 : 0) || a.position - b.position || a.name.localeCompare(b.name),
  );

/** What `everyone` already gives (for a role that isn't it). */
const baseOf = (role: OrgRole, everyone: OrgRole | undefined) =>
  isEveryone(role) || !everyone ? new Set<string>() : grants(everyone.permissions);

/** The area's keys this role reaches, `everyone`'s included. */
export function areaReach(role: OrgRole, area: PermissionArea, everyone: OrgRole | undefined) {
  const own = grants(role.permissions);
  const base = baseOf(role, everyone);
  return area.keys.filter((k) => own.has(k) || base.has(k));
}

const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export function levelOf(role: OrgRole, area: PermissionArea, everyone: OrgRole | undefined): AreaLevel {
  const base = new Set(area.keys.filter((k) => baseOf(role, everyone).has(k)));
  const reach = new Set(areaReach(role, area, everyone));
  if (same(reach, base)) return "none";
  if (same(reach, new Set([...base, ...area.use]))) return "use";
  if (same(reach, new Set(area.keys))) return "manage";
  return "custom";
}

/** The levels to offer: "use" only when it gives more than `everyone` already does. */
export function levelOptions(role: OrgRole, area: PermissionArea, everyone: OrgRole | undefined): AreaLevel[] {
  const base = baseOf(role, everyone);
  return area.use.some((k) => !base.has(k)) ? ["none", "use", "manage"] : ["none", "manage"];
}

/** The role's keys with the area set to `level` (the rest untouched). */
export function withLevel(role: OrgRole, area: PermissionArea, level: AreaLevel): string[] {
  if (level === "custom") return role.permissions;
  const keep = role.permissions.filter((k) => !area.keys.includes(k));
  const add = level === "use" ? area.use : level === "manage" ? area.keys : [];
  return [...keep, ...add];
}

/** The role's keys with one key on or off. */
export const withKey = (role: OrgRole, key: string, on: boolean) =>
  on ? [...new Set([...role.permissions, key])] : role.permissions.filter((k) => k !== key);

/**
 * What sums a role up, most telling first: its own keys past what `everyone` gives (every key of `everyone` for
 * itself). `administrator` stands alone.
 */
export function summaryKeys(role: OrgRole, everyone: OrgRole | undefined): RolePermission[] {
  if (role.permissions.includes("administrator")) return ["administrator"];
  const base = baseOf(role, everyone);
  const own = new Set(role.permissions);
  return SUMMARY_ORDER.filter((k) => own.has(k) && !base.has(k));
}

/** "a, b e c" in the person's language; the phone's JavaScript engine has no `Intl.ListFormat`. */
const wordList = (t: TFunction, locale: string, items: string[]) =>
  typeof Intl.ListFormat === "function"
    ? new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items)
    : joinNames(items, t);

/** The sentence that sums a role up: its own keys past what `everyone` gives, the first three, "and N more". */
export function roleSummary(t: TFunction, locale: string, role: OrgRole, everyone: OrgRole | undefined) {
  const keys = summaryKeys(role, everyone);
  if (keys[0] === "administrator") return t("rolesPage.summary.admin");
  const words = keys.slice(0, 3).map((k) => t(`permissions.${k}.say`));
  if (keys.length > 3) words.push(t("rolesPage.summary.more", { count: keys.length - 3 }));
  if (isEveryone(role))
    return keys.length
      ? t("rolesPage.summary.everyone", { list: wordList(t, locale, words) })
      : t("rolesPage.summary.everyoneNone");
  return keys.length ? t("rolesPage.summary.extra", { list: wordList(t, locale, words) }) : t("rolesPage.summary.none");
}

/** A person's rank: their highest role's position (an owner above all, `Infinity` with none). */
export function rankOf(person: Pick<Person, "role" | "roleIds">, roles: readonly OrgRole[]) {
  if (person.role === "owner") return -1;
  const mine = roles.filter((r) => !isEveryone(r) && (person.roleIds ?? []).includes(r.id));
  return mine.length ? Math.min(...mine.map((r) => r.position)) : Number.POSITIVE_INFINITY;
}

/** Whether the viewer may touch this person's roles (the server checks it again): someone below them, or themselves. */
export const isBelow = (
  viewer: { role: string; rank?: number | null; userId: string },
  person: Pick<Person, "userId" | "role" | "roleIds">,
  roles: readonly OrgRole[],
) =>
  viewer.role === "owner" ||
  (person.role !== "owner" &&
    (person.userId === viewer.userId || rankOf(person, roles) > (viewer.rank ?? Number.POSITIVE_INFINITY)));

/**
 * Whether the viewer may remove this person from the workspace (the server checks it again, `removeMember`): who may
 * manage members, above them (an owner above all). Their own row leaves instead (`leaves`).
 */
export const removes = (
  viewer: { role: string; rank?: number | null; userId: string; permissions?: readonly string[] },
  person: Pick<Person, "userId" | "role" | "roleIds">,
  roles: readonly OrgRole[],
) => person.userId !== viewer.userId && can(viewer, "manage_members") && isBelow(viewer, person, roles);

/** Whether the viewer may leave the workspace: anyone but its last owner. */
export const leaves = (viewer: { role: string }, people: readonly Pick<Person, "role">[]) =>
  viewer.role !== "owner" || people.filter((p) => p.role === "owner").length > 1;

/** Whether the viewer holds every key of a role (an owner all): only then may they copy it or give it. */
export function holdsAll(viewer: { role: string; permissions?: readonly string[] }, keys: readonly string[]) {
  if (viewer.role === "owner") return true;
  const mine = grants(viewer.permissions ?? []);
  return keys.every((k) => mine.has(k));
}

/** A person's roles, top first. */
export const rolesOf = (person: Pick<Person, "roleIds">, roles: readonly OrgRole[]) =>
  sortRoles(roles.filter((r) => !isEveryone(r) && (person.roleIds ?? []).includes(r.id)));

/** Who holds a role (`everyone`: everybody). */
export const peopleWith = <P extends Pick<Person, "roleIds">>(role: OrgRole, people: readonly P[]) =>
  isEveryone(role) ? [...people] : people.filter((p) => (p.roleIds ?? []).includes(role.id));
