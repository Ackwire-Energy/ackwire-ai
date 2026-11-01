import type { CSSProperties } from "react";
import { AGENT_GRADIENTS } from "../agent/engine.js";

/** The agent symbol's colors (sky is the default identity). */
export const AGENT_COLORS = ["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

export const AGENT_EYES = ["round", "dots", "wide", "happy", "sleepy"] as const;
export type AgentEyes = (typeof AGENT_EYES)[number];

/** Pixel accessories drawn by the agent engine (ACCESSORIES in ../agent/engine.js; same list, "none" first). */
export const AGENT_ACCESSORIES = [
  "none",
  "hat",
  "cap",
  "headphones",
  "bow",
  "crown",
  "antenna",
  "headset",
  "beanie",
  "party",
  "flower",
  "scarf",
] as const;
export type AgentAccessory = (typeof AGENT_ACCESSORIES)[number];

export interface AgentAppearance {
  color?: AgentColor;
  eyes?: AgentEyes;
  accessory?: AgentAccessory;
}

const pick = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;

/** Only known values (the backend's allow-list); anything else falls back to the default look. */
export function normalizeAppearance(raw: unknown): AgentAppearance {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    color: pick(AGENT_COLORS, o.color),
    eyes: pick(AGENT_EYES, o.eyes),
    accessory: pick(AGENT_ACCESSORIES, o.accessory),
  };
}

/** A random look ("Aleatório"), different from `current` when possible. */
export function randomAppearance(current: AgentAppearance = {}, rand: () => number = Math.random): AgentAppearance {
  const one = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)] as T;
  for (let i = 0; i < 5; i++) {
    const next = { color: one(AGENT_COLORS), eyes: one(AGENT_EYES), accessory: one(AGENT_ACCESSORIES) };
    if (next.color !== current.color || next.eyes !== current.eyes || next.accessory !== current.accessory) return next;
  }
  return { color: one(AGENT_COLORS), eyes: one(AGENT_EYES), accessory: one(AGENT_ACCESSORIES) };
}

/** Top and bottom of an agent color as fixed hex (sky as on the landing: the same in both themes). For drawing, e.g. the pixel sky. */
export function agentGradient(color: AgentColor = "sky"): [string, string] {
  return AGENT_GRADIENTS[color];
}

/** CSS variables for the symbol's color (none for sky: the tokens). */
export function appearanceStyle(a: AgentAppearance | undefined): CSSProperties | undefined {
  if (!a?.color || a.color === "sky") return undefined;
  const [top, bottom] = AGENT_GRADIENTS[a.color];
  return { "--av-top": top, "--av-bottom": bottom } as CSSProperties;
}
