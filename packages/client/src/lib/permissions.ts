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

type Membership = Parameters<typeof can>[0];

/** Who manages a channel (its name, members and category): its creator, or who may manage every channel. */
export const managesChannel = (
  channel: { createdByUserId?: string | null } | null | undefined,
  meId: string | null | undefined,
  org: Membership,
) => can(org, "manage_channels") || (!!meId && channel?.createdByUserId === meId);

/**
 * Who picks how an agent replies in a channel: who manages the channel, or the agent's owner. Mirrors the server's
 * `setChannelAgentAutoReply` (packages/engine/src/channels.ts).
 */
export const setsAutoReply = (
  channel: { createdByUserId?: string | null } | null | undefined,
  agent: { ownerUserId?: string | null } | null | undefined,
  meId: string | null | undefined,
  org: Membership,
) => managesChannel(channel, meId, org) || (!!meId && agent?.ownerUserId === meId);

/**
 * Whether this person may put an agent in a channel or take it out of it: a channel they're in and may post in, or
 * one they manage. Mirrors the server's `placesAgentsIn` (packages/engine/src/channels.ts), which also needs the
 * agent to be theirs or `manage_agents`.
 */
export const addsAgentsTo = (
  channel: { isMember?: boolean; createdByUserId?: string | null } | null | undefined,
  meId: string | null | undefined,
  org: Membership,
) => (channel?.isMember === true && can(org, "post")) || managesChannel(channel, meId, org);
