import type { Database, Executor, SQL } from "@agenteschat/db";
import type { Membership } from "../organizations";
import type { DashboardRow, WidgetRow } from "./types";

/**
 * Who sees, edits and manages a board (ADR 0134 §8). Placeholder signatures: the dashboards service stage writes
 * the bodies (see the contract); every caller compiles against these names now.
 *
 * - **Sees:** a board that isn't deleted and is the viewer's own (`owner_user_id`), or `workspace` (every member), or
 *   `roles` when the viewer holds one of `audience_role_ids` at the time (`organization_member_roles`, as
 *   `channelAudienceSql`) or is an admin. A `private` board and a `home` board are their owner's alone, admins
 *   included. A `roles` board with no role left is its owner's (and admins') alone.
 * - **Edits** (title, about, widgets, layout, refresh, change requests): who sees it, when `edit_policy` is
 *   `viewers`; else its owner and admins. A home board: its owner only.
 * - **Manages** (share, delete, pin): its owner and admins; never for a home board but by its owner (no share or
 *   delete at all for a home board).
 * - **Admin**: `can(membership, "administrator")` (owners hold it too).
 * - **Shows to others** (`audience` other than `private` on create or share): needs `post`.
 */

export interface DashboardViewer {
  userId: string;
  /** The viewer's roles (`Membership.roleIds`), not `everyone`. */
  roleIds: readonly string[];
  admin: boolean;
  /** May show a board to others (`post`). */
  mayPublish: boolean;
}

export type DashboardNeed = "see" | "edit" | "manage";

export interface DashboardRights {
  see: boolean;
  edit: boolean;
  manage: boolean;
}

/** The viewer of a membership. */
export function viewerOf(_membership: Membership): DashboardViewer {
  throw new Error("not implemented");
}

/** What `viewer` may do with `board` (`dashboards` row), from the row alone. */
export function dashboardRights(
  _board: Pick<DashboardRow, "kind" | "audience" | "audienceRoleIds" | "editPolicy" | "ownerUserId" | "deletedAt">,
  _viewer: DashboardViewer,
): DashboardRights {
  throw new Error("not implemented");
}

/**
 * The "sees it" rule as SQL over `dashboards` aliased `alias`, for lists in one statement: `userId` the viewer, `admin`
 * whether they are an admin. Excludes deleted boards.
 */
export function dashboardSeerSql(_alias: string, _userId: SQL | string, _admin: boolean): SQL {
  throw new Error("not implemented");
}

/**
 * The board and the viewer, or `dashboard.not_found` (404) when it doesn't exist or they can't see it, and
 * `dashboard.forbidden` (403) when they see it but `need` is more. Also refuses a closed workspace
 * (`requireActiveMembership`).
 */
export async function requireDashboard(
  _db: Database,
  _actorId: string,
  _orgId: string,
  _dashboardId: string,
  _need: DashboardNeed,
): Promise<{ board: DashboardRow; viewer: DashboardViewer; membership: Membership }> {
  throw new Error("not implemented");
}

/** A widget and its board, with the same rule on the board (`widget.not_found` when the board is hidden). */
export async function requireWidget(
  _db: Database,
  _actorId: string,
  _orgId: string,
  _widgetId: string,
  _need: DashboardNeed,
): Promise<{ widget: WidgetRow; board: DashboardRow; viewer: DashboardViewer; membership: Membership }> {
  throw new Error("not implemented");
}

/** How many members see `board` now (the list's count and the Share dialog). */
export async function dashboardViewerCount(
  _db: Executor,
  _board: Pick<DashboardRow, "orgId" | "kind" | "audience" | "audienceRoleIds" | "ownerUserId">,
): Promise<number> {
  throw new Error("not implemented");
}
