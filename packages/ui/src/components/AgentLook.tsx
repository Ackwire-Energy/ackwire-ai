import type { CSSProperties, ReactNode } from "react";

/** The agent symbol's colors (sky is the default identity). */
export const AGENT_COLORS = ["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

export const AGENT_EYES = ["round", "dots", "wide", "happy", "sleepy"] as const;
export type AgentEyes = (typeof AGENT_EYES)[number];

export const AGENT_ACCESSORIES = ["none", "hat", "cap", "glasses", "sunglasses", "headphones", "bow", "crown"] as const;
export type AgentAccessory = (typeof AGENT_ACCESSORIES)[number];

export interface AgentAppearance {
  color?: AgentColor;
  eyes?: AgentEyes;
  accessory?: AgentAccessory;
}

/** Top and bottom of the symbol's gradient (sky follows the theme tokens). */
const GRADIENT: Record<Exclude<AgentColor, "sky">, [string, string]> = {
  indigo: ["#7d8bff", "#3f4fd6"],
  violet: ["#ae8cf7", "#6e45d1"],
  rose: ["#f58aa6", "#c9406a"],
  amber: ["#f3c25c", "#c07d0b"],
  green: ["#5fcf8b", "#1f8a4c"],
  teal: ["#4cd0c0", "#0f8f86"],
  graphite: ["#9a9a95", "#4a4a47"],
};

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
  const one = <T,>(list: readonly T[]) => list[Math.floor(rand() * list.length)] as T;
  for (let i = 0; i < 5; i++) {
    const next = { color: one(AGENT_COLORS), eyes: one(AGENT_EYES), accessory: one(AGENT_ACCESSORIES) };
    if (next.color !== current.color || next.eyes !== current.eyes || next.accessory !== current.accessory) return next;
  }
  return { color: one(AGENT_COLORS), eyes: one(AGENT_EYES), accessory: one(AGENT_ACCESSORIES) };
}

/** CSS variables for the symbol's color (none for sky: the tokens). */
export function appearanceStyle(a: AgentAppearance | undefined): CSSProperties | undefined {
  if (!a?.color || a.color === "sky") return undefined;
  const [top, bottom] = GRADIENT[a.color];
  return { "--av-top": top, "--av-bottom": bottom } as CSSProperties;
}

const INK = "#1d1d1b";
const SHAPES: Record<Exclude<AgentAccessory, "none">, ReactNode> = {
  hat: (
    <>
      <rect x="31" y="-26" width="38" height="30" rx="3" fill={INK} />
      <rect x="31" y="-4" width="38" height="5" fill="#e5484d" />
      <rect x="16" y="1" width="68" height="7" rx="3.5" fill={INK} />
    </>
  ),
  cap: (
    <>
      <path d="M17 20 C 20 -6, 80 -6, 83 20 Z" fill="#2a2a28" />
      <path d="M60 18 C 78 14, 96 16, 104 22 L 60 24 Z" fill="#2a2a28" />
      <circle cx="50" cy="1" r="3" fill="#5a5a56" />
    </>
  ),
  glasses: (
    <g fill="none" stroke={INK} strokeWidth="3.2">
      <circle cx="34.5" cy="50" r="11.5" />
      <circle cx="65.5" cy="50" r="11.5" />
      <path d="M46 50 h8 M23 48 L10 44 M77 48 L90 44" strokeLinecap="round" />
    </g>
  ),
  sunglasses: (
    <g>
      <rect x="20" y="40" width="27" height="17" rx="6" fill={INK} />
      <rect x="53" y="40" width="27" height="17" rx="6" fill={INK} />
      <path d="M47 46 h6 M20 45 L9 41 M80 45 L91 41" stroke={INK} strokeWidth="3.2" strokeLinecap="round" />
      <path d="M25 44 l6 -2" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="2.4" strokeLinecap="round" />
    </g>
  ),
  headphones: (
    <g>
      <path d="M8 52 C 8 4, 92 4, 92 52" fill="none" stroke={INK} strokeWidth="6" strokeLinecap="round" />
      <rect x="-2" y="42" width="15" height="26" rx="6" fill={INK} />
      <rect x="87" y="42" width="15" height="26" rx="6" fill={INK} />
    </g>
  ),
  bow: (
    <g transform="translate(76 2) rotate(18)">
      <path d="M0 0 L-18 -11 L-18 11 Z" fill="#f2668b" />
      <path d="M0 0 L18 -11 L18 11 Z" fill="#f2668b" />
      <circle cx="0" cy="0" r="5" fill="#d9466e" />
    </g>
  ),
  crown: (
    <g>
      <path
        d="M24 10 L30 -16 L41 -2 L50 -20 L59 -2 L70 -16 L76 10 Z"
        fill="#f5c542"
        stroke="#c99a1c"
        strokeWidth="1.6"
      />
      <circle cx="50" cy="-20" r="3.4" fill="#f2668b" />
    </g>
  ),
};

/** The accessory drawn over the symbol (inline SVG, 100×100 space, may go past the edges). */
export function AgentAccessoryLayer({ accessory }: { accessory?: AgentAccessory }) {
  if (!accessory || accessory === "none") return null;
  return (
    <svg className="ac-avatar__accessory" viewBox="0 0 100 100" aria-hidden="true" data-accessory={accessory}>
      {SHAPES[accessory]}
    </svg>
  );
}
