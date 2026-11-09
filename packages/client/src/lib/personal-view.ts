import type { OrgRole, OrgSummary, WorkspaceMode } from "../api/types";
import { isPersonal } from "./workspace-mode";

/**
 * What a personal workspace shows its person (ADR 0158): a simpler view of the same workspace. Nothing here changes
 * what exists or who may do what; it only picks which sections come first, their words, and what a switch of mode or
 * an invitation says. Pure, for the web and the phone app.
 */

type Org = Pick<OrgSummary, "mode"> | null | undefined;

/**
 * Settings in a personal workspace (ADR 0158 §3), in this order: Your account, About you, AI and apps, Plan and usage,
 * Vault, Computers. Every other section the person may open is under Advanced. Ids are the settings sections'
 * (`/settings/{id}` on the web).
 */
export const PERSONAL_SETTINGS = ["account", "general", "keys", "usage", "vault", "computers"] as const;

/**
 * Sections a personal workspace shows on another one's page: AI and apps holds connectors and skills, Plan and usage
 * holds billing. Their own address still opens them alone.
 */
export const PERSONAL_SETTINGS_PARTS: Readonly<Record<string, (typeof PERSONAL_SETTINGS)[number]>> = {
  connectors: "keys",
  skills: "keys",
  billing: "usage",
};

/** The section whose page also shows `id` in a personal workspace, when the person may open it; null otherwise. */
export function personalSettingsHost(id: string, open: ReadonlySet<string>): string | null {
  const host = PERSONAL_SETTINGS_PARTS[id];
  return host && open.has(host) ? host : null;
}

/**
 * A personal workspace's settings list from the sections the person may open (`open`, in their usual order): the
 * short list, then Advanced with every other one (a section already on another's page isn't listed again).
 */
export function personalSettingsNav<T extends { id: string }>(open: readonly T[]): { main: T[]; advanced: T[] } {
  const ids = new Set(open.map((s) => s.id));
  const short = PERSONAL_SETTINGS as readonly string[];
  return {
    main: PERSONAL_SETTINGS.flatMap((id) => open.filter((s) => s.id === id)),
    advanced: open.filter((s) => !short.includes(s.id) && personalSettingsHost(s.id, ids) === null),
  };
}

/** The sections a personal workspace names in its own words: About you, AI and apps, Plan and usage. */
const RENAMED = ["general", "keys", "usage"] as const;
type Renamed = (typeof RENAMED)[number];
/** The sections whose line under the title has a personal variant. */
const RETOLD = ["general", "keys", "usage", "connectors"] as const;
type Retold = (typeof RETOLD)[number];

type NameKey<S extends string> = `settings.section.${S}` | `settings.section.${S & Renamed}Personal`;
type TextKey<S extends string> = `settings.sectionText.${S}` | `settings.sectionText.${S & Retold}Personal`;

/**
 * The i18n key of a settings section's name: `settings.section.<id>`, or in a personal workspace its own
 * (`settings.section.<id>Personal`) for the sections it renames.
 */
export function settingsSectionNameKey<S extends string>(org: Org, id: S): NameKey<S> {
  const own = isPersonal(org) && (RENAMED as readonly string[]).includes(id);
  return (own ? `settings.section.${id}Personal` : `settings.section.${id}`) as NameKey<S>;
}

/** The i18n key of a settings section's line under its title, with the personal variant where there is one. */
export function settingsSectionTextKey<S extends string>(org: Org, id: S): TextKey<S> {
  const own = isPersonal(org) && (RETOLD as readonly string[]).includes(id);
  return (own ? `settings.sectionText.${id}Personal` : `settings.sectionText.${id}`) as TextKey<S>;
}

/** A line of what switching the mode changes: its icon (the web's icon names) and its i18n key. */
export interface ModeSwitchLine {
  icon: "channel" | "personAdd" | "shield" | "sidebar" | "message" | "settings" | "members";
  key:
    | "personalMode.toTeam.channels"
    | "personalMode.toTeam.roles"
    | "personalMode.toTeam.admin"
    | "personalMode.toPersonal.sidebar"
    | "personalMode.toPersonal.channels"
    | "personalMode.toPersonal.settings"
    | "personalMode.toPersonal.bubbles"
    | "personalMode.toPersonal.others";
  /** For `others`: how many other people are members. */
  count?: number;
}

/**
 * What switching a workspace `to` a mode says (ADR 0158 §4): what comes into sight going to a team's; what changes
 * going to personal, and with `others` other members, that they see it too. What stays is its own line
 * (`personalMode.<to>.stays`).
 */
export function modeSwitchLines(to: WorkspaceMode, others: number): ModeSwitchLine[] {
  if (to === "team")
    return [
      { icon: "channel", key: "personalMode.toTeam.channels" },
      { icon: "personAdd", key: "personalMode.toTeam.roles" },
      { icon: "shield", key: "personalMode.toTeam.admin" },
    ];
  const lines: ModeSwitchLine[] = [
    { icon: "sidebar", key: "personalMode.toPersonal.sidebar" },
    { icon: "channel", key: "personalMode.toPersonal.channels" },
    { icon: "settings", key: "personalMode.toPersonal.settings" },
    { icon: "message", key: "personalMode.toPersonal.bubbles" },
  ];
  if (others > 0) lines.push({ icon: "members", key: "personalMode.toPersonal.others", count: others });
  return lines;
}

/**
 * Inviting in a personal workspace asks one plain question (ADR 0158 §4): the person uses the agents (a member, no
 * role) or helps run the workspace, which is the highest role the inviter may give that holds `administrator` (a new
 * workspace's Admin). Null when there is none to give: only the first choice is offered. The roles stay what they are.
 */
export function personalHelperRole(roles: readonly OrgRole[]): OrgRole | null {
  return (
    [...roles]
      .filter((r) => r.kind === "custom" && r.givable && r.permissions.includes("administrator"))
      .sort((a, b) => a.position - b.position)[0] ?? null
  );
}
