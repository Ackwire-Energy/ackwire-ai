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
    levels: { sentry: "write", github: "read", "cloudflare-observability": "read", linear: "read" },
    channels: ["ops", "incidentes", "incidents", "infra", "alertas", "alerts"],
    model: "sonnet",
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
  // Customers: reads where the customer already is; sending to them asks a person first.
  support: {
    icon: "message",
    look: { color: "teal", eyes: "happy", accessory: "headset" },
    levels: { intercom: "write", notion: "read", linear: "read", stripe: "read" },
    channels: ["suporte", "support", "atendimento", "clientes", "customers", "help"],
    model: "sonnet",
  },
  sales: {
    icon: "coin",
    look: { color: "amber", eyes: "wide", accessory: "hat" },
    levels: { notion: "write", drive: "read", stripe: "read" },
    channels: ["vendas", "sales", "comercial", "leads", "clientes", "customers"],
    model: "sonnet",
  },
  marketing: {
    icon: "globe",
    look: { color: "rose", eyes: "happy", accessory: "party" },
    levels: { webflow: "write", canva: "write", notion: "read" },
    channels: ["marketing", "growth", "campanhas", "campaigns", "lancamentos", "launches"],
    model: "sonnet",
  },
  content: {
    icon: "edit",
    look: { color: "violet", eyes: "round", accessory: "beanie" },
    levels: { notion: "write", drive: "write", webflow: "read", canva: "read" },
    channels: ["conteudo", "content", "blog", "redacao", "writing", "social"],
    model: "sonnet",
  },
  // Operations: numbers are read-only by default; money only moves with approval.
  data: {
    icon: "chart",
    look: { color: "sky", eyes: "dots", accessory: "none" },
    levels: { "supabase-readonly": "read", stripe: "read", drive: "read" },
    channels: ["dados", "data", "metricas", "metrics", "analytics", "relatorios", "reports"],
    model: "sonnet",
  },
  finance: {
    icon: "wallet",
    look: { color: "graphite", eyes: "round", accessory: "hat" },
    levels: { stripe: "read", paypal: "read", square: "read", drive: "read" },
    channels: ["financeiro", "finance", "financas", "pagamentos", "payments", "billing"],
    model: "sonnet",
  },
  people: {
    icon: "members",
    look: { color: "green", eyes: "happy", accessory: "flower" },
    levels: { notion: "write", drive: "read", asana: "read" },
    channels: ["rh", "people", "pessoas", "hr", "contratacao", "hiring", "time", "team"],
    model: "sonnet",
  },
  research: {
    icon: "search",
    look: { color: "indigo", eyes: "wide", accessory: "scarf" },
    levels: { notion: "write", drive: "read" },
    channels: ["pesquisa", "research", "estudos", "insights"],
    model: "sonnet",
  },
  assistant: {
    icon: "calendar",
    look: { color: "rose", eyes: "round", accessory: "bow" },
    levels: { asana: "write", notion: "read", drive: "read" },
    channels: ["geral", "general", "agenda", "secretaria", "admin"],
    model: "haiku",
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
