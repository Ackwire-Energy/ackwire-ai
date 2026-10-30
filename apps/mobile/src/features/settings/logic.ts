import type {
  Agent,
  AgentAccess,
  Machine,
  MachineAccessReduce,
  MachineOs,
  MachinePause,
  MachineToolName,
  OrgSummary,
  S3Input,
  Skill,
  StorageConfig,
  StoragePlatform,
} from "@agenteschat/client";
import { type AccessResource, resourcesOf } from "@agenteschat/client/lib/access-levels";
import { type NoComputer, noComputerChoice, type SetupView, setupPending } from "@agenteschat/client/lib/computer";
import { clockAt, formatPercent, relativeTime } from "@agenteschat/client/lib/format";
import { folderName, hostDescKey, isPaused } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { zoneDisplayName } from "@agenteschat/client/lib/routines";
import type { TFunction } from "i18next";
import type { IconName } from "@/ui";

/*
 * The workspace's settings on the phone, as the web's (`apps/web/src/pages/SettingsPage.tsx`): which sections each
 * person opens (from their permissions, ADR 0081), the line the workspace's page shows under each area, and what the
 * screens decide before they draw. Pure, so it is unit-tested; the screens turn it into views.
 */

// ── Sections ────────────────────────────────────────────────────────────────

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

export interface SettingsEntry {
  id: SettingsSection;
  group: SettingsGroup;
  icon: IconName;
  /** The phone's screen for it. */
  href: string;
  /** Who opens it: the web's rule (`apps/web/src/pages/settings-sections.ts`), but for Membros (see there). */
  allowed: (org: OrgSummary | null | undefined) => boolean;
}

/** The web's settings, in its order and groups (`settings.group.*`, `settings.section.*`), with the phone's screens. */
export const SETTINGS_SECTIONS: readonly SettingsEntry[] = [
  { id: "general", group: "org", icon: "home", href: "/settings/general", allowed: () => true },
  // Everyone on the web (a read-only list for members); the phone's Membros holds the requests to join and the
  // invitation link, so it opens for who invites people or manages members, as Você already does.
  {
    id: "members",
    group: "org",
    icon: "members",
    href: "/me/members",
    allowed: (o) => can(o, "invite_people") || can(o, "manage_members"),
  },
  // What agents did and people changed: who may see the audit (it shows everyone's work).
  { id: "audit", group: "org", icon: "shield", href: "/settings/audit", allowed: (o) => can(o, "view_audit") },
  { id: "access", group: "agents", icon: "agent", href: "/settings/access", allowed: (o) => can(o, "manage_agents") },
  { id: "connectors", group: "agents", icon: "bolt", href: "/connectors", allowed: () => true },
  { id: "skills", group: "agents", icon: "sparkle", href: "/settings/skills", allowed: (o) => can(o, "manage_agents") },
  // Every member sees the computers and connects one (ADR 0025).
  { id: "computers", group: "agents", icon: "laptop", href: "/settings/computers", allowed: (o) => can(o, "read") },
  // Everyone (ADR 0063): tokens and percentages; money only for who has `view_usage`.
  { id: "usage", group: "costs", icon: "chart", href: "/usage", allowed: () => true },
  // "Contas de IA": everyone's own plans; the workspace's API keys only for who manages them.
  { id: "keys", group: "costs", icon: "brain", href: "/ai-accounts", allowed: (o) => can(o, "read") },
  { id: "storage", group: "costs", icon: "drive", href: "/settings/storage", allowed: (o) => can(o, "configure") },
  { id: "import", group: "costs", icon: "archive", href: "/settings/import", allowed: (o) => can(o, "create_agents") },
];

export const SETTINGS_GROUPS: readonly SettingsGroup[] = ["org", "agents", "costs"];

/** The sections this membership opens, in order. */
export const visibleSections = (org: OrgSummary | null | undefined) => SETTINGS_SECTIONS.filter((s) => s.allowed(org));

// ── The workspace's page and Editar workspace ──────────────────────────────

/** What the workspace's page knows of each area (absent while it loads: its line stays empty). */
export interface TileFacts {
  overview?: { people: number; agents: number; budgetUsedPercent: number } | undefined;
  /** Invitations waiting (managers only). */
  invitations?: number | undefined;
  /** The live connections' names. */
  connectors?: string[] | undefined;
  skills?: number | undefined;
  computers?: { count: number; online: number } | undefined;
  /** Who manages keys sees the workspace's; anyone else, their own plans. */
  keys?: { manages: true; live: number; platform: boolean } | { manages: false; plans: number } | undefined;
  storage?: { kind: "agentes" | "s3"; edition: "cloud" | "selfhost" } | undefined;
}

/** Each area's line under its name on the workspace's page, as the web's tiles (`settings.tileState.*`). */
export function tileStates(t: TFunction, locale: string, f: TileFacts): Partial<Record<SettingsSection, string>> {
  const out: Partial<Record<SettingsSection, string>> = {};
  const pending = f.invitations ?? 0;
  if (f.overview) {
    out.members = [
      t("settings.tileState.members", { count: f.overview.people }),
      pending > 0 ? t("settings.tileState.invitations", { count: pending }) : null,
    ]
      .filter(Boolean)
      .join(" · ");
    out.access = t("settings.tileState.agents", { count: f.overview.agents });
    out.usage = t("settings.tileState.usage", { percent: formatPercent(locale, f.overview.budgetUsedPercent) });
  }
  if (f.connectors) {
    const names = f.connectors.slice(0, 3).join(", ");
    out.connectors =
      f.connectors.length === 0
        ? t("settings.tileState.noConnectors")
        : `${t("settings.tileState.connectors", { count: f.connectors.length })} · ${names}`;
  }
  if (f.skills !== undefined) out.skills = t("settings.tileState.skills", { count: f.skills });
  if (f.computers)
    out.computers =
      f.computers.count === 0
        ? t("settings.tileState.noComputers")
        : t("settings.tileState.computers", { count: f.computers.count, online: f.computers.online });
  if (f.keys)
    out.keys = f.keys.manages
      ? f.keys.live > 0
        ? t("settings.tileState.keys", { count: f.keys.live })
        : f.keys.platform
          ? t("settings.tileState.platformKey")
          : t("settings.tileState.noKeys")
      : f.keys.plans > 0
        ? t("settings.tileState.plans", { count: f.keys.plans })
        : t("settings.tileState.noPlans");
  if (f.storage) out.storage = t(storageKey(f.storage.kind, f.storage.edition));
  return out;
}

/** The ideas the organization's context still misses ("Falta dizer: Para quem…"), by their label. */
export const missingIdeas = (context: string, labels: readonly string[]) =>
  labels.filter((label) => !context.toLowerCase().includes(label.toLowerCase()));

/** The context with an idea started on a paragraph of its own ("…\n\nPara quem: "). */
export const withIdea = (context: string, label: string) =>
  `${context.replace(/\s*$/, "")}${context.trim() ? "\n\n" : ""}${label}: `;

/**
 * Leaving the name field: save the trimmed name when it changed, put the saved one back when it was emptied (a
 * workspace always has a name), else nothing.
 */
export function nameOnLeave(draft: string, saved: string | undefined): { save: string } | { reset: string } | null {
  const next = draft.trim();
  if (!next) return { reset: saved ?? "" };
  return next !== saved ? { save: next } : null;
}

/** A zone as lists say it: "Horário de Brasília" (a friendly name) or the city. */
export const zoneLabel = (zone: string, locale: string) =>
  zoneDisplayName(zone, locale) ?? (zone.split("/").pop() ?? zone).replace(/_/g, " ");

// ── Acesso ──────────────────────────────────────────────────────────────────

export type AccessKind = "connector" | "builtin";

/** The columns of the web's matrix: the resources of that kind, from the first agent's tree (all agents share them). */
export const accessColumns = (first: AgentAccess | undefined, kind: AccessKind): AccessResource[] =>
  first ? resourcesOf(first).filter((r) => r.kind === kind) : [];

/** A built-in area's icon (the web's `AREA_ICON`, in the phone's set). */
export const AREA_ICON: Record<string, IconName> = {
  context: "search",
  drive: "drive",
  issues: "issue",
  calendar: "clock",
  wiki: "doc",
  skills: "bolt",
  schedule: "clock",
  forum: "chat",
  sandbox: "code",
  browser: "globe",
  setup: "pen",
  desktop: "laptop",
};

// ── Skills ──────────────────────────────────────────────────────────────────

/** Above this many skills the list gets its search (the web lists 6 and searches the rest). */
export const SKILLS_INLINE = 6;

/** "GitHub" for github.com links, "Link" for other addresses, "Enviada", "Criada aqui" (`skills.source.*`). */
export const skillSourceKey = (s: Pick<Skill, "source" | "sourceUrl">) =>
  s.source === "url" ? (/github\.com/i.test(s.sourceUrl ?? "") ? "github" : "url") : s.source;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** The skills whose name or description has the query, accents aside. */
export function searchSkills<S extends Pick<Skill, "name" | "description">>(skills: S[], query: string): S[] {
  const q = fold(query.trim());
  return q ? skills.filter((s) => fold(`${s.name} ${s.description}`).includes(q)) : skills;
}

/** A link to a skill's folder on GitHub (the only link the import reads). */
export const isGithubSkillLink = (url: string) => /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+/.test(url.trim());

/** "GitHub · Em agentes novos · v3 · 2 agentes usam": a skill's facts in the list. */
export function skillLine(
  t: TFunction,
  s: Pick<Skill, "source" | "sourceUrl" | "version" | "defaultForNewAgents">,
  users: number | null,
): string {
  return [
    t(`skills.source.${skillSourceKey(s)}`),
    s.defaultForNewAgents ? t("skills.defaultChip") : null,
    t("skills.version", { version: s.version }),
    users !== null ? t("skills.usedBy", { count: users }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** How often a long action's line moves on ("Baixando a skill…" → "Lendo os arquivos…"). */
export const STEP_EVERY_MS = 2500;

/** Which step of a long action to show, by the time since it started (the last one stays). */
export const stepAt = (sinceMs: number, nowMs: number, steps: number, everyMs = STEP_EVERY_MS) =>
  Math.min(steps - 1, Math.max(0, Math.floor((nowMs - sinceMs) / everyMs)));

// ── Computadores ────────────────────────────────────────────────────────────

const OSES: MachineOs[] = ["linux", "darwin", "windows", "other"];
export const osOf = (os: string): MachineOs => (OSES.includes(os as MachineOs) ? (os as MachineOs) : "other");

/** "conectado agora", "visto há 2 h", "ainda não conectou". */
export function seenText(t: TFunction, locale: string, m: Pick<Machine, "online" | "lastSeenAt">, now = new Date()) {
  return m.online
    ? t("machines.seenNow")
    : m.lastSeenAt
      ? t("machines.seen", { when: relativeTime(t, locale, m.lastSeenAt, now) })
      : t("machines.neverSeen");
}

/** "Pausado até 16:24" (another day: with the date), "Pausado"; null when not paused now. */
export function pauseText(t: TFunction, locale: string, paused: MachinePause | null | undefined, now = new Date()) {
  if (!isPaused({ paused }, now.getTime())) return null;
  const until = paused?.until;
  if (!until) return t("machines.paused");
  return t("machines.pausedUntil", { time: clockAt(locale, until, now) });
}

/** A computer's line in the lists: the server's own says what it is; others their system, version, seen and by whom. */
export function machineFacts(t: TFunction, locale: string, m: Machine, now = new Date()): string {
  if (m.kind === "host") return t(`machines.host.${hostDescKey(m.os)}`);
  return [
    t(`machines.os.${osOf(m.os)}`),
    m.runnerVersion ? t("machines.versionShort", { version: m.runnerVersion }) : null,
    seenText(t, locale, m, now),
    m.pairedBy ? t("machines.pairedBy", { name: m.pairedBy.name }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The computers people connected with a code ("Outros computadores"): the server's and the workspace's own apart. */
export const peoplesMachines = (list: readonly Machine[]) =>
  list.filter((m) => m.kind !== "managed" && m.kind !== "host");

/** The pickers' value for "no computer" (`machineId` null), as on the web. */
export const NO_COMPUTER = "none";

export interface AgentComputerPick {
  /** The computer the agent uses, or `NO_COMPUTER`. */
  value: string;
  /** What "no computer" stands for here; null: not offered. */
  noComputer: NoComputer | null;
  /** The computers this person may pick for it. */
  choices: Machine[];
  canPick: boolean;
}

/**
 * "Qual computador cada agente usa", for one agent: admins pick any computer; its owner, the ones they connected (the
 * server checks again). While the workspace's own computer is on its way, "no computer" stands for it.
 */
export function agentComputerPick(input: {
  agent: Pick<Agent, "id" | "ownerUserId">;
  meId: string | null;
  admin: boolean;
  machines: readonly Machine[];
  setup: SetupView | null;
}): AgentComputerPick {
  const machines = setupPending(input.setup) ? input.machines.filter((m) => m.kind !== "managed") : [...input.machines];
  const current = machines.find((m) => m.agents.some((a) => a.id === input.agent.id));
  const value = current?.id ?? NO_COMPUTER;
  const mine = (id: string | null | undefined) => input.meId !== null && id === input.meId;
  const choices = machines.filter((m) => input.admin || mine(m.pairedBy?.id) || m.id === value);
  return {
    value,
    noComputer: noComputerChoice(input.setup, value === NO_COMPUTER),
    choices,
    canPick: (input.admin || mine(input.agent.ownerUserId)) && choices.length > 0,
  };
}

/**
 * The "no computer" choice's name: the workspace's own computer on its way (`computerSetup.title`, with `org`), else
 * no computer at all.
 */
export const noComputerKey = (choice: NoComputer) =>
  choice === "workspace" ? "computerSetup.title" : "computer.target.none";

/** Taking something away on a computer (granting happens only on the computer itself). */
export type Reduce =
  | { kind: "folder"; path: string; agent?: { id: string; name: string } }
  | { kind: "tool"; tool: MachineToolName | "browser" };

/** The confirmation's words, its button, the toast after it and the request, as the web's. */
export function reduceTexts(
  t: TFunction,
  reduce: Reduce,
): { title: string; text: string; action: string; done: string; input: MachineAccessReduce } {
  if (reduce.kind === "tool") {
    const tool = t(`machines.access.tool.${reduce.tool}`);
    return {
      title: t("machines.access.disableTitle", { tool }),
      text: t("machines.access.disableText", { tool }),
      action: t("machines.access.disable"),
      done: t("machines.access.disabled", { tool }),
      input: { disableTool: reduce.tool },
    };
  }
  const folder = folderName(reduce.path);
  if (reduce.agent) {
    const values = { folder, name: reduce.agent.name };
    return {
      title: t("machines.access.removeAgentTitle", values),
      text: t("machines.access.removeAgentText", values),
      action: t("machines.access.remove"),
      done: t("machines.access.removedAgent", values),
      input: { removeFolder: { path: reduce.path, agentId: reduce.agent.id } },
    };
  }
  return {
    title: t("machines.access.removeTitle", { folder }),
    text: t("machines.access.removeText"),
    action: t("machines.access.remove"),
    done: t("machines.access.removed", { folder }),
    input: { removeFolder: { path: reduce.path } },
  };
}

/** "Para liberar mais": the command that allows a folder, as the administrator in system mode (ADR 0057). */
export const grantCommand = (m: Pick<Machine, "mode">, path: string, agent: string) =>
  `${m.mode === "system" ? "sudo " : ""}agentes-runner folders allow ${path} --agent ${agent}`;

/** Both switches apps on the agents' screens need, turned on at the computer (ADR 0062). */
export const DESKTOP_TURN_ON = "agentes-runner tools enable desktop && agentes-runner tools enable commands";

// ── Armazenamento ───────────────────────────────────────────────────────────

/** The option's name: the workspace's own bucket, our storage on the Cloud, or this server where people run it. */
export const storageKey = (kind: "agentes" | "s3", edition: "cloud" | "selfhost") =>
  kind === "s3" ? "storage.s3" : edition === "cloud" ? "storage.agentes" : "storage.server";

/** Where this server keeps files, in words: the folder by its path when the server says it. */
export function platformText(t: TFunction, platform: StoragePlatform): string {
  if (platform.kind !== "disk" || !platform.folder) return t(`storage.serverText.${platform.kind}`);
  return t("storage.serverText.folder").replace("<folder/>", platform.folder);
}

export interface S3Form {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export const EMPTY_S3_FORM: S3Form = {
  endpoint: "",
  region: "",
  bucket: "",
  prefix: "",
  pathStyle: false,
  accessKeyId: "",
  secretAccessKey: "",
};

/** The bucket form from what is saved (the keys never come back: blank keeps them). */
export const s3FormOf = (c: StorageConfig | undefined): S3Form =>
  c?.s3
    ? {
        ...EMPTY_S3_FORM,
        endpoint: c.s3.endpoint,
        region: c.s3.region,
        bucket: c.s3.bucket,
        prefix: c.s3.prefix ?? "",
        pathStyle: c.s3.pathStyle,
      }
    : EMPTY_S3_FORM;

/** What the server gets; blank keys mean "keep the saved ones". */
export function toS3Input(f: S3Form): S3Input {
  const input: S3Input = {
    endpoint: f.endpoint.trim(),
    region: f.region.trim(),
    bucket: f.bucket.trim(),
    prefix: f.prefix.trim() || null,
    pathStyle: f.pathStyle,
  };
  if (f.accessKeyId.trim()) input.accessKeyId = f.accessKeyId.trim();
  if (f.secretAccessKey.trim()) input.secretAccessKey = f.secretAccessKey.trim();
  return input;
}

/** What the form lacks before a test: the required fields, and the keys when none are saved yet. */
export function s3Missing(f: S3Form, keysSaved: boolean) {
  const input = toS3Input(f);
  const keys = !keysSaved && (!input.accessKeyId || !input.secretAccessKey);
  const fields = !input.endpoint || !input.region || !input.bucket;
  return { fields, keys, complete: !fields && !keys };
}

// ── Importar e exportar ─────────────────────────────────────────────────────

/** The export's file name, as the web saves it: `agentes-chat-2026-10-28.json`. */
export const exportFileName = (now: Date) => `agentes-chat-${now.toISOString().slice(0, 10)}.json`;
