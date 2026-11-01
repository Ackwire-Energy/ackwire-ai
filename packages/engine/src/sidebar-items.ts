import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { ValidationError } from "./errors";
import { requirePermission } from "./organizations";

const { organizationMembers } = schema;

/**
 * The tools at the top of a person's sidebar, each where they put it in this workspace
 * (`organization_members.sidebar_items`): `always` in the list, `more` only in the More menu, `auto` in the list
 * while its count is above zero and in More otherwise. An item they never moved keeps the app's default
 * (`SIDEBAR_DEFAULTS`, packages/client/src/lib/sidebar-items.ts, which mirrors these lists).
 */
export const SIDEBAR_ITEMS = [
  "approvals",
  "threads",
  "issues",
  "wiki",
  "drive",
  "routines",
  "calendar",
  "forum",
] as const;
export type SidebarItem = (typeof SIDEBAR_ITEMS)[number];
export const SIDEBAR_PLACES = ["always", "more", "auto"] as const;
export type SidebarPlace = (typeof SIDEBAR_PLACES)[number];
export type SidebarItems = Partial<Record<SidebarItem, SidebarPlace>>;

/** The items that show a count in the sidebar: only these can be `auto`. */
export const SIDEBAR_COUNTED: readonly SidebarItem[] = ["approvals", "threads"];

const isItem = (value: string): value is SidebarItem => (SIDEBAR_ITEMS as readonly string[]).includes(value);
const isPlace = (value: unknown): value is SidebarPlace =>
  typeof value === "string" && (SIDEBAR_PLACES as readonly string[]).includes(value);

/** Whether `item` may sit at `place` (`auto` only for an item with a count). */
export const sidebarPlaceAllowed = (item: SidebarItem, place: SidebarPlace) =>
  place !== "auto" || SIDEBAR_COUNTED.includes(item);

/** Only known items at a place they can take: what a row holds is never trusted as is. */
export function sidebarItemsOf(raw: unknown): SidebarItems {
  if (!raw || typeof raw !== "object") return {};
  const out: SidebarItems = {};
  for (const [key, value] of Object.entries(raw))
    if (isItem(key) && isPlace(value) && sidebarPlaceAllowed(key, value)) out[key] = value;
  return out;
}

const mine = (orgId: string, userId: string) =>
  and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId));

/** Where the person put each item they moved, in this workspace. */
export async function mySidebarItems(db: Database, orgId: string, userId: string): Promise<SidebarItems> {
  await requirePermission(db, userId, orgId, "read");
  const [row] = await db
    .select({ items: organizationMembers.sidebarItems })
    .from(organizationMembers)
    .where(mine(orgId, userId));
  return sidebarItemsOf(row?.items);
}

/**
 * Puts one item where the person wants it in this workspace (`null`: back on its default) and leaves their other
 * choices as the row has them, so one made on another device in the meantime stays.
 */
export async function setMySidebarItem(
  db: Database,
  orgId: string,
  userId: string,
  item: SidebarItem,
  place: SidebarPlace | null,
): Promise<SidebarItems> {
  await requirePermission(db, userId, orgId, "read");
  if (!isItem(item) || (place !== null && !(isPlace(place) && sidebarPlaceAllowed(item, place))))
    throw new ValidationError(`${item} can't go to ${place}`);
  const items = organizationMembers.sidebarItems;
  const [row] = await db
    .update(organizationMembers)
    .set({
      sidebarItems:
        place === null
          ? sql`${items} - ${item}::text`
          : sql`${items} || jsonb_build_object(${item}::text, ${place}::text)`,
    })
    .where(mine(orgId, userId))
    .returning({ items });
  return sidebarItemsOf(row?.items);
}

/** Replaces the person's choices in this workspace (`{}` puts every item back on its default). */
export async function setMySidebarItems(
  db: Database,
  orgId: string,
  userId: string,
  items: SidebarItems,
): Promise<SidebarItems> {
  await requirePermission(db, userId, orgId, "read");
  const clean = sidebarItemsOf(items);
  await db.update(organizationMembers).set({ sidebarItems: clean }).where(mine(orgId, userId));
  return clean;
}
