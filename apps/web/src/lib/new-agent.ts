import type { Level } from "@agenteschat/client/lib/access-levels";
import type { ModelFamily, RoleId } from "@agenteschat/client/lib/new-agent";
import type { AgentAppearance, IconName } from "@agenteschat/ui";

export * from "@agenteschat/client/lib/new-agent";

/**
 * "Criar agente" in steps (docs/design/telas/NovoAgente.html): the role
 * presets with their icon and look (the rest is shared:
 * `@agenteschat/client/lib/new-agent`).
 */

export interface RolePreset {
  icon: IconName;
  look: Required<AgentAppearance>;
  /** Levels by catalog connector id ("github"); connectors not listed start at "Sem acesso". */
  levels: Record<string, Level>;
  /** Channels it joins when the workspace has them (by name; only channels you're in). */
  channels: string[];
  model: ModelFamily;
}

/** Picking a role fills the rest (name and instructions come from i18n: `newAgent.roles.{id}`). */
export const ROLE_PRESETS: Record<RoleId, RolePreset> = {
  dev: {
    icon: "code",
    look: { color: "green", eyes: "wide", accessory: "headphones" },
    levels: { github: "write", sentry: "read", linear: "read" },
    channels: ["eng", "engenharia", "engineering", "dev", "desenvolvimento"],
    model: "sonnet",
  },
  ops: {
    icon: "bolt",
    look: { color: "amber", eyes: "round", accessory: "antenna" },
    levels: { sentry: "write", github: "read", cloudflare: "read", linear: "read" },
    channels: ["ops", "incidentes", "incidents", "infra", "alertas", "alerts"],
    model: "haiku",
  },
  qa: {
    icon: "checks",
    look: { color: "violet", eyes: "round", accessory: "headset" },
    levels: { github: "read", linear: "write", sentry: "read" },
    channels: ["qa", "bugs", "testes", "eng", "engenharia", "engineering"],
    model: "sonnet",
  },
  pm: {
    icon: "issues",
    look: { color: "indigo", eyes: "round", accessory: "cap" },
    levels: { linear: "write", notion: "write", github: "read", drive: "read" },
    channels: ["produto", "product", "pm", "roadmap"],
    model: "sonnet",
  },
  custom: {
    icon: "plus",
    look: { color: "sky", eyes: "round", accessory: "none" },
    levels: {},
    channels: [],
    model: "sonnet",
  },
};

/** The look a draft starts with (before a role is picked). */
export const BLANK_LOOK: Required<AgentAppearance> = { color: "sky", eyes: "round", accessory: "none" };

/** Each connection's level for a role: the preset's level for its catalog connector, else none. */
export function presetLevels(role: RoleId, items: { id: string; def: { id: string } | null }[]) {
  const levels = ROLE_PRESETS[role].levels;
  return Object.fromEntries(items.map((i) => [i.id, (i.def && levels[i.def.id]) || "none"])) as Record<string, Level>;
}

/** The role's channels among the ones given (by name, accents and case ignored). */
export function presetChannels<C extends { id: string; name: string }>(role: RoleId, channels: C[]) {
  const wanted = new Set(ROLE_PRESETS[role].channels);
  return channels.filter((c) => wanted.has(fold(c.name))).map((c) => c.id);
}

const fold = (s: string) => s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
