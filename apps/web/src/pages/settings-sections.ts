import type { AuthConfig, OrgSummary } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import type { IconName } from "@agenteschat/ui";

// Apart from the settings page so the shell (⌘K, the sidebar) and the settings routes' guards can read
// the sections without loading the page itself.

export type SettingsSection =
  | "account"
  | "notifications"
  | "apps"
  | "general"
  | "right_hand"
  | "members"
  | "roles"
  | "vault"
  | "audit"
  | "access"
  | "connectors"
  | "skills"
  | "keys"
  | "storage"
  | "computers"
  | "usage"
  | "billing"
  | "import"
  | "media"
  | "voice";

export type SettingsGroup = "you" | "org" | "agents" | "costs";

/** The settings sub-nav, in order and in groups, with who can open each on this server. */
export const SETTINGS_SECTIONS: {
  id: SettingsSection;
  icon: IconName;
  group: SettingsGroup;
  allowed: (org: OrgSummary, server: AuthConfig | undefined) => boolean;
}[] = [
  // Mine, not the workspace's: my profile here and what this device keeps (the nav shows my face for it).
  { id: "account", icon: "person", group: "you", allowed: () => true },
  // What reaches my devices as a notification here (ADR 0071 §8).
  { id: "notifications", icon: "bell", group: "you", allowed: () => true },
  // AI apps (ADR 0119): each person connects their own, in this workspace.
  { id: "apps", icon: "link", group: "you", allowed: () => true },
  // The workspace's sections are for who runs it: a member keeps only their own (above) and what they use themselves
  // (the people, where a member who may not invite suggests someone (ADR 0090), connectors, computers, AI accounts).
  { id: "general", icon: "settings", group: "org", allowed: (o) => can(o, "configure") },
  // The team's right hand (ADR 0137): its name, AI, budget and audience, for who manages agents.
  { id: "right_hand", icon: "agent", group: "org", allowed: (o) => can(o, "manage_agents") },
  { id: "members", icon: "members", group: "org", allowed: () => true },
  { id: "roles", icon: "audiencePeople", group: "org", allowed: (o) => can(o, "manage_roles") },
  // Every member keeps their own logins, keys and contacts there; team items show to who they're shared with (ADR 0142).
  { id: "vault", icon: "lock", group: "org", allowed: () => true },
  // What agents did and people changed: only for who may see it (it shows everyone's work).
  { id: "audit", icon: "shield", group: "org", allowed: (o) => can(o, "view_audit") },
  // GIFs and stickers in chat (ADR 0091): who configures the workspace.
  { id: "media", icon: "sticker", group: "org", allowed: (o) => can(o, "configure") },
  // Voice messages (ADR 0100): who configures the workspace.
  { id: "voice", icon: "mic", group: "org", allowed: (o) => can(o, "configure") },
  { id: "access", icon: "agent", group: "agents", allowed: (o) => can(o, "manage_agents") },
  { id: "connectors", icon: "plug", group: "agents", allowed: () => true },
  { id: "skills", icon: "bulb", group: "agents", allowed: (o) => can(o, "manage_agents") },
  // Every member sees the computers and can pair one (ADR 0025).
  { id: "computers", icon: "computer", group: "agents", allowed: (o) => can(o, "read") },
  // Everyone (ADR 0063): their plans' meters and the agents whose details they see, in tokens and percentages;
  // money and the workspace's report only for who has `view_usage`.
  { id: "usage", icon: "wallet", group: "costs", allowed: () => true },
  // "Contas de IA": everyone's own plans; the workspace's API keys only for who manages them.
  { id: "keys", icon: "key", group: "costs", allowed: (o) => can(o, "read") },
  { id: "storage", icon: "drive", group: "costs", allowed: (o) => can(o, "configure") },
  // Only where a billing service runs (ADR 0079), for who may open it.
  {
    id: "billing",
    icon: "coin",
    group: "costs",
    allowed: (o, server) => !!server?.billingUrl && can(o, "manage_billing"),
  },
  { id: "import", icon: "archiveBox", group: "costs", allowed: (o) => can(o, "create_agents") },
];

export const SETTINGS_GROUPS: SettingsGroup[] = ["you", "org", "agents", "costs"];

export const isSettingsSection = (v: unknown): v is SettingsSection => SETTINGS_SECTIONS.some((s) => s.id === v);

/**
 * `?connected=github` (back from OAuth), `?review=1` (a custom MCP server to
 * classify), `?mail=connected|failed&account={id}` (back from Gmail/Outlook),
 * `?request={id}&do=approve|deny` (a request to join, from the admins' email),
 * `?delete=1` (Geral's dialog that deletes the workspace), `?install={link}` (Skills, back from connecting GitHub
 * in Instalar skill: the link to read again) and `?agent={id}` (Auditoria filtered to that agent).
 */
export const settingsSearch = (
  search: Record<string, unknown>,
): {
  connected?: string;
  outcome?: string;
  review?: string;
  mail?: string;
  account?: string;
  request?: string;
  do?: "approve" | "deny";
  delete?: 1;
  install?: string;
  skill?: string;
  agent?: string;
} => ({
  connected: typeof search.connected === "string" ? search.connected : undefined,
  outcome: typeof search.outcome === "string" ? search.outcome : undefined,
  review: search.review === undefined ? undefined : String(search.review),
  mail: typeof search.mail === "string" ? search.mail : undefined,
  account: typeof search.account === "string" ? search.account : undefined,
  request: typeof search.request === "string" ? search.request : undefined,
  do: search.do === "approve" || search.do === "deny" ? search.do : undefined,
  delete: search.delete === undefined ? undefined : 1,
  install: typeof search.install === "string" ? search.install : undefined,
  skill: typeof search.skill === "string" ? search.skill : undefined,
  agent: typeof search.agent === "string" ? search.agent : undefined,
});
