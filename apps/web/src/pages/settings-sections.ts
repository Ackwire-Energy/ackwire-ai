import type { AuthConfig, Role } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import type { IconName } from "@agenteschat/ui";

// Apart from the settings page so the shell (⌘K, the sidebar) and the settings routes' guards can read
// the sections without loading the page itself.

export type SettingsSection =
  | "general"
  | "members"
  | "access"
  | "connectors"
  | "skills"
  | "keys"
  | "storage"
  | "computers"
  | "usage"
  | "billing"
  | "import";

export type SettingsGroup = "org" | "agents" | "costs";

/** The settings sub-nav, in order and in groups, with who can open each on this server. */
export const SETTINGS_SECTIONS: {
  id: SettingsSection;
  icon: IconName;
  group: SettingsGroup;
  allowed: (role: Role, server: AuthConfig | undefined) => boolean;
}[] = [
  { id: "general", icon: "settings", group: "org", allowed: () => true },
  { id: "members", icon: "members", group: "org", allowed: () => true },
  { id: "access", icon: "agent", group: "agents", allowed: (r) => can(r, "configure") },
  { id: "connectors", icon: "plug", group: "agents", allowed: () => true },
  { id: "skills", icon: "bulb", group: "agents", allowed: (r) => can(r, "configure") },
  // Every member sees the computers and can pair one (ADR 0025); the cloud computer's settings are for admins.
  { id: "computers", icon: "computer", group: "agents", allowed: (r) => can(r, "read") },
  // Everyone (ADR 0063): tokens and percentages; money only for who has `view_usage`.
  { id: "usage", icon: "wallet", group: "costs", allowed: () => true },
  // "Contas de IA": everyone's own plans; the workspace's API keys only for who manages them.
  { id: "keys", icon: "key", group: "costs", allowed: (r) => can(r, "read") },
  { id: "storage", icon: "drive", group: "costs", allowed: (r) => can(r, "configure") },
  // Only where a billing service runs (ADR 0077), for who may open it.
  {
    id: "billing",
    icon: "coin",
    group: "costs",
    allowed: (r, server) => !!server?.billingUrl && can(r, "manage_billing"),
  },
  { id: "import", icon: "archiveBox", group: "costs", allowed: (r) => can(r, "manage_agents") },
];

export const SETTINGS_GROUPS: SettingsGroup[] = ["org", "agents", "costs"];

export const isSettingsSection = (v: unknown): v is SettingsSection => SETTINGS_SECTIONS.some((s) => s.id === v);

/** Old section ids and where they live now ("sandbox" joined Computadores). */
export const MOVED_SETTINGS = new Map<string, SettingsSection>([["sandbox", "computers"]]);

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
