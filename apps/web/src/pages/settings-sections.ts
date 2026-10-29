import type { Role } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import type { IconName } from "@agenteschat/ui";

// Apart from the settings page so the shell (⌘K, the sidebar) and the settings routes' guards can read
// the sections without loading the page itself.

export type SettingsSection =
  | "general"
  | "members"
  | "audit"
  | "access"
  | "connectors"
  | "skills"
  | "keys"
  | "storage"
  | "computers"
  | "usage"
  | "import";

export type SettingsGroup = "org" | "agents" | "costs";

/** The settings sub-nav, in order and in groups, with who can open each. */
export const SETTINGS_SECTIONS: {
  id: SettingsSection;
  icon: IconName;
  group: SettingsGroup;
  allowed: (role: Role) => boolean;
}[] = [
  { id: "general", icon: "settings", group: "org", allowed: () => true },
  { id: "members", icon: "members", group: "org", allowed: () => true },
  // What agents did and people changed: admins only (it shows everyone's work).
  { id: "audit", icon: "shield", group: "org", allowed: (r) => can(r, "configure") },
  { id: "access", icon: "agent", group: "agents", allowed: (r) => can(r, "configure") },
  { id: "connectors", icon: "plug", group: "agents", allowed: () => true },
  { id: "skills", icon: "bulb", group: "agents", allowed: (r) => can(r, "configure") },
  // Every member sees the computers and can pair one (ADR 0025).
  { id: "computers", icon: "computer", group: "agents", allowed: (r) => can(r, "read") },
  // Everyone (ADR 0063): tokens and percentages; money only for who has `view_usage`.
  { id: "usage", icon: "wallet", group: "costs", allowed: () => true },
  // "Contas de IA": everyone's own plans; the workspace's API keys only for who manages them.
  { id: "keys", icon: "key", group: "costs", allowed: (r) => can(r, "read") },
  { id: "storage", icon: "drive", group: "costs", allowed: (r) => can(r, "configure") },
  { id: "import", icon: "archiveBox", group: "costs", allowed: (r) => can(r, "manage_agents") },
];

export const SETTINGS_GROUPS: SettingsGroup[] = ["org", "agents", "costs"];

export const isSettingsSection = (v: unknown): v is SettingsSection => SETTINGS_SECTIONS.some((s) => s.id === v);

/**
 * `?connected=github` (back from OAuth), `?review=1` (a custom MCP server to
 * classify), `?mail=connected|failed` (back from Gmail/Outlook) and
 * `?request={id}&do=approve|deny` (a request to join, from the admins' email).
 */
export const settingsSearch = (
  search: Record<string, unknown>,
): { connected?: string; review?: string; mail?: string; request?: string; do?: "approve" | "deny" } => ({
  connected: typeof search.connected === "string" ? search.connected : undefined,
  review: search.review === undefined ? undefined : String(search.review),
  mail: typeof search.mail === "string" ? search.mail : undefined,
  request: typeof search.request === "string" ? search.request : undefined,
  do: search.do === "approve" || search.do === "deny" ? search.do : undefined,
});
