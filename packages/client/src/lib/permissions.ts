/**
 * The keys of a workspace's permissions (ADR 0085, packages/engine/src/permissions.ts). The server sends each
 * person's resolved `permissions` with their membership (`OrgSummary`); the UI only hides what isn't allowed, the
 * server checks every request.
 */
export type RolePermission =
  | "administrator"
  | "post"
  | "create_channels"
  | "manage_channels"
  | "talk_to_agents"
  | "assign_work"
  | "manage_routines"
  | "approve_actions"
  | "create_agents"
  | "manage_agents"
  | "pair_computers"
  | "control_computers"
  | "manage_connectors"
  | "manage_credentials"
  | "edit_wiki"
  | "upload_files"
  | "review_memory"
  | "invite_people"
  | "view_usage"
  | "view_audit"
  | "configure"
  | "manage_members"
  | "manage_roles"
  | "manage_billing";

/** `read`: any member; `manage_owners`: owners only. */
export type Permission = RolePermission | "read" | "manage_owners";

/** Whether this membership (an `OrgSummary`) may `permission`. */
export const can = (org: { permissions?: readonly string[] } | null | undefined, permission: Permission) =>
  org?.permissions?.includes(permission) === true;
