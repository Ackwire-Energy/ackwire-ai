import type { AgentAppearance, AgentColor } from "@agenteschat/ui";

/**
 * The landing page's sample workspace (docs/design/telas/LandingNova.html):
 * the agents, their people and the two sample companies. Names stay as they
 * are in every language; every sentence lives in i18n (`landing.*`).
 */

export type CastKey = "dev" | "atlas" | "nina" | "theo" | "ada" | "sol" | "cora";
export type RoleKey = "dev" | "infra" | "data" | "marketing" | "product" | "support" | "finance";
export type PersonKey = "marina" | "rafael" | "camila";

export interface CastAgent {
  name: string;
  color: AgentColor;
  look: AgentAppearance;
  role: RoleKey;
  /** The person who answers for it. */
  owner: PersonKey;
  /** Grammatical gender in Portuguese ("a Nina", "o Dev"). */
  feminine: boolean;
}

export const CAST: Record<CastKey, CastAgent> = {
  dev: {
    name: "Dev",
    color: "sky",
    look: { color: "sky", accessory: "headset" },
    role: "dev",
    owner: "rafael",
    feminine: false,
  },
  atlas: {
    name: "Atlas",
    color: "violet",
    look: { color: "violet", accessory: "antenna" },
    role: "infra",
    owner: "rafael",
    feminine: false,
  },
  nina: {
    name: "Nina",
    color: "teal",
    look: { color: "teal", accessory: "bow" },
    role: "data",
    owner: "camila",
    feminine: true,
  },
  theo: {
    name: "Theo",
    color: "amber",
    look: { color: "amber", accessory: "hat" },
    role: "marketing",
    owner: "marina",
    feminine: false,
  },
  ada: {
    name: "Ada",
    color: "indigo",
    look: { color: "indigo", accessory: "crown" },
    role: "product",
    owner: "marina",
    feminine: true,
  },
  sol: {
    name: "Sol",
    color: "green",
    look: { color: "green", eyes: "dots", accessory: "flower" },
    role: "support",
    owner: "camila",
    feminine: false,
  },
  cora: {
    name: "Cora",
    color: "graphite",
    look: { color: "graphite", eyes: "dots", accessory: "scarf" },
    role: "finance",
    owner: "camila",
    feminine: true,
  },
};
export const CAST_KEYS = Object.keys(CAST) as CastKey[];

export const PEOPLE: Record<PersonKey, { name: string; short: string; initials: string }> = {
  marina: { name: "Marina Souza", short: "Marina", initials: "M" },
  rafael: { name: "Rafael Antunes", short: "Rafael", initials: "R" },
  camila: { name: "Camila Alves", short: "Camila", initials: "C" },
};

/**
 * The two sample companies: the coffee shop used across the page and the
 * startup that compresses files in the hero and the demo. Neither is real.
 */
export type OrgKey = "shop" | "startup";
export const ORGS: Record<OrgKey, { name: string; slug: string; people: number; agents: number }> = {
  shop: { name: "Grão Norte", slug: "graonorte", people: 6, agents: 5 },
  startup: { name: "Pixelpress", slug: "pixelpress", people: 8, agents: 5 },
};

/** The channels of the sample workspaces (names are translated: `landing.channel.*`). */
export type ChannelKey = "engineering" | "metrics" | "launch" | "data" | "marketing" | "product";

/** The startup's workspace (hero and demo): its channels and its five agents. */
export const STARTUP_CHANNELS: ChannelKey[] = ["engineering", "metrics", "launch"];
export const STARTUP_AGENTS: CastKey[] = ["dev", "atlas", "nina", "theo", "ada"];
/** The coffee shop's workspace (the web screen of "Em todo lugar"). */
export const SHOP_CHANNELS: ChannelKey[] = ["engineering", "data", "marketing", "product"];
