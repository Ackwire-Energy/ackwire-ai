import type { AgentAppearance, AgentColor } from "@agenteschat/ui";

/**
 * Landing page constants that are not language: the giant's looks, the sky's
 * gradients and the waiting list's email check. The sample workspace (agents,
 * people, companies) lives in cast.ts; every sentence lives in i18n
 * (`landing.*`).
 */

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

export const WAITLIST_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
