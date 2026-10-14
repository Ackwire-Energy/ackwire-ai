import type { Role } from "@/api/types";

/**
 * Mirror of the backend role table (packages/engine/src/organizations.ts).
 * The UI only hides what isn't allowed; the server checks every request.
 */
export type Permission =
  | "read"
  | "post"
  | "create_channels"
  | "configure"
  | "manage_agents"
  | "manage_credentials"
  | "view_usage"
  | "manage_members"
  | "manage_owners";

const MEMBER: Permission[] = ["read", "post", "create_channels"];
const ADMIN: Permission[] = [
  ...MEMBER,
  "configure",
  "manage_agents",
  "manage_credentials",
  "view_usage",
  "manage_members",
];
const TABLE: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set([...ADMIN, "manage_owners"]),
  admin: new Set(ADMIN),
  member: new Set(MEMBER),
};

export const can = (role: Role | undefined, permission: Permission) => (role ? TABLE[role].has(permission) : false);
