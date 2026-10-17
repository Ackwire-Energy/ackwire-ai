import type { AgentAppearance, AgentColor, AgentEyes } from "@agenteschat/ui";

/**
 * Sample content of the landing page that is not language: names of the
 * example agents and people, model names, the terminal transcript. Every
 * sentence lives in i18n (`landing.*`).
 */

export type AgentKey = "lia" | "teo" | "bia";

export const AGENTS: Record<AgentKey, { name: string; look: AgentAppearance; feminine: boolean }> = {
  lia: { name: "Lia", look: { color: "sky" }, feminine: true },
  teo: { name: "Teo", look: { color: "teal", accessory: "headset" }, feminine: false },
  bia: { name: "Bia", look: { color: "violet", accessory: "bow" }, feminine: true },
};
export const AGENT_KEYS = Object.keys(AGENTS) as AgentKey[];

export const PEOPLE = {
  marina: { name: "Marina Souza", short: "Marina", initials: "MS" },
  rafael: { name: "Rafael Antunes", short: "Rafael", initials: "RA" },
  camila: { name: "Camila Alves", short: "Camila", initials: "CA" },
} as const;
export type PersonKey = keyof typeof PEOPLE;

export const ORG = { name: "Acme", initial: "A" };
export const MODELS = { sonnet: "sonnet 5.5", haiku: "haiku 5.5", router: "router" } as const;

/** The landing page's looks: the user rejected "headphones" and "cap" here. */
export const LP_COLORS: AgentColor[] = ["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"];
export const LP_EYES: AgentEyes[] = ["round", "dots", "wide", "happy", "sleepy"];
export type LpAccessory = "none" | "hat" | "antenna" | "headphones" | "bow" | "crown" | "party";
export const LP_ACCESSORIES: LpAccessory[] = ["none", "hat", "antenna", "headphones", "bow", "crown", "party"];

/** Gradients of each color (same as the design system's). */
export const GRAD: Record<Exclude<AgentColor, "sky">, [string, string]> = {
  indigo: ["#7d8bff", "#3f4fd6"],
  violet: ["#ae8cf7", "#6e45d1"],
  rose: ["#f58aa6", "#c9406a"],
  amber: ["#f3c25c", "#c07d0b"],
  green: ["#5fcf8b", "#1f8a4c"],
  teal: ["#4cd0c0", "#0f8f86"],
  graphite: ["#9a9a95", "#4a4a47"],
};

/** What a click on the giant cycles through. */
export const GIANT_LOOKS: AgentAppearance[] = [
  {},
  { color: "violet", accessory: "antenna" },
  { color: "amber", accessory: "crown" },
  { color: "green", eyes: "wide" },
  { color: "rose", accessory: "party" },
  { color: "teal", accessory: "hat" },
  { color: "indigo", accessory: "bow" },
];

/** The crew at the bottom of the closing sky: look and largest size in px. */
export const CREW: [AgentAppearance, number][] = [
  [{ color: "graphite", accessory: "beanie" }, 64],
  [{ color: "teal", accessory: "headset" }, 88],
  [{ color: "violet", eyes: "dots" }, 112],
  [{ color: "sky" }, 168],
  [{ color: "amber", accessory: "crown" }, 112],
  [{ color: "rose", accessory: "hat" }, 88],
  [{ color: "green", eyes: "wide" }, 64],
];

/** The bento terminal: code, so it stays as is (the last line is translated). */
export const TERM: { parts: [string, string][]; wait: number }[] = [
  {
    parts: [
      ["p", "$"],
      ["", " git clone acme/checkout"],
    ],
    wait: 500,
  },
  {
    parts: [
      ["p", "$"],
      ["", " bun test payments"],
    ],
    wait: 700,
  },
  {
    parts: [
      ["g", "✓"],
      ["", " 12 passed "],
      ["p", "(1.8s)"],
    ],
    wait: 600,
  },
  {
    parts: [
      ["p", "$"],
      ["", " gh pr create --draft"],
    ],
    wait: 600,
  },
];
export const TERM_LAST_WAIT = 2600;

export const WAITLIST_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
