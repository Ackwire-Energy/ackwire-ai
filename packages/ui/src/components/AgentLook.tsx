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

/** How an accessory is drawn at a given avatar size (px). */
interface Draw {
  /** ≤ 24px: no highlights, glints or gems. */
  simple: boolean;
  /** Stroke props: `units` in the 100×100 box, never thinner than 1.5px on screen. */
  stroke: (units: number) => { strokeWidth: number; vectorEffect?: "non-scaling-stroke" };
}

export function accessoryDraw(px: number): Draw {
  const scale = px / 100;
  return {
    simple: px <= 24,
    stroke: (units) =>
      units * scale < 1.5 ? { strokeWidth: 1.5, vectorEffect: "non-scaling-stroke" } : { strokeWidth: units },
  };
}

/** Temples of glasses and sunglasses. */
const temples = (d: Draw) => (
  <path d="M22.5 48 L10 45 M77.5 48 L90 45" stroke={INK} {...d.stroke(3)} strokeLinecap="round" />
);

/** On the head: still while the eyes look around. */
const HEAD: Record<"hat" | "cap" | "headphones" | "bow" | "crown", (d: Draw) => ReactNode> = {
  hat: (d) => (
    <g transform="rotate(-4 50 2)">
      <rect x="30" y="-30" width="40" height="32" rx="3" fill={INK} />
      {!d.simple && <rect x="33" y="-27" width="6" height="26" rx="2" fill="#fff" opacity=".12" />}
      <rect x="30" y="-6" width="40" height="7" fill="#c8453b" />
      <ellipse cx="50" cy="2" rx="31" ry="5.5" fill={INK} />
    </g>
  ),
  cap: (d) => (
    <g>
      <path d="M22 6 C22 -14 78 -14 78 6 Z" fill="#2b2f36" />
      {!d.simple && <path d="M50 -9 V6" stroke="#fff" strokeOpacity=".18" strokeWidth="2" />}
      {!d.simple && <circle cx="50" cy="-9" r="2.5" fill="#3a404a" />}
      <path d="M60 4 C80 2 96 6 98 11 C86 12 70 10 58 9 Z" fill="#232730" />
    </g>
  ),
  headphones: (d) => (
    <g>
      <path d="M10 44 C10 -8 90 -8 90 44" stroke="#2b2f36" {...d.stroke(7)} fill="none" strokeLinecap="round" />
      <rect x="-2" y="36" width="16" height="28" rx="7" fill="#2b2f36" />
      <rect x="86" y="36" width="16" height="28" rx="7" fill="#2b2f36" />
      {!d.simple && <rect x="9" y="39" width="5" height="22" rx="2.5" fill="#4a5160" />}
      {!d.simple && <rect x="86" y="39" width="5" height="22" rx="2.5" fill="#4a5160" />}
    </g>
  ),
  bow: (d) => (
    <g transform="rotate(18 76 4)">
      <path d="M76 4 L60 -6 L60 14 Z" fill="#ec6f9a" />
      <path d="M76 4 L92 -6 L92 14 Z" fill="#ec6f9a" />
      {!d.simple && <path d="M76 4 L64 0 L64 8 Z" fill="#c9507b" />}
      {!d.simple && <path d="M76 4 L88 0 L88 8 Z" fill="#c9507b" />}
      <circle cx="76" cy="4" r="4.5" fill="#d65a87" />
    </g>
  ),
  crown: (d) => (
    <g>
      <path
        d="M27 6 L27 -14 L38.5 -3 L50 -20 L61.5 -3 L73 -14 L73 6 Z"
        fill="#f2c14e"
        stroke="#c99a2e"
        {...d.stroke(2)}
        strokeLinejoin="round"
      />
      <rect x="27" y="1" width="46" height="6" rx="1.5" fill="#e0ab3a" />
      {!d.simple && (
        <>
          <circle cx="50" cy="-1" r="3" fill="#d6455a" />
          <circle cx="38" cy="2" r="2" fill="#3b82c4" />
          <circle cx="62" cy="2" r="2" fill="#3b82c4" />
        </>
      )}
    </g>
  ),
};

/** On the eyes: they move with the eyes' look-around (same group). */
const FACE: Record<"glasses" | "sunglasses", (d: Draw) => ReactNode> = {
  glasses: (d) => (
    <g>
      <circle cx="34.5" cy="50" r="12" fill="#fff" fillOpacity=".14" stroke={INK} {...d.stroke(3.5)} />
      <circle cx="65.5" cy="50" r="12" fill="#fff" fillOpacity=".14" stroke={INK} {...d.stroke(3.5)} />
      <path d="M46.5 48 Q50 45 53.5 48" stroke={INK} {...d.stroke(3)} fill="none" />
      {temples(d)}
    </g>
  ),
  sunglasses: (d) => (
    <g>
      <rect x="21" y="41" width="27" height="17" rx="7" fill="#111" />
      <rect x="52" y="41" width="27" height="17" rx="7" fill="#111" />
      {!d.simple && (
        <path d="M25 45 L31 45 M56 45 L62 45" stroke="#fff" strokeOpacity=".5" strokeWidth="2" strokeLinecap="round" />
      )}
      <rect x="47" y="45" width="6" height="3" rx="1.5" fill="#111" />
      {temples(d)}
    </g>
  ),
};

export const isFaceAccessory = (a: AgentAccessory | undefined): a is "glasses" | "sunglasses" =>
  a === "glasses" || a === "sunglasses";

/**
 * An accessory over the symbol: one `0 0 100 100` box like the symbol (eyes
 * at 34.5/65.5, 50), free to go past the edges. `layer` picks the head items
 * (hat, cap, headphones, bow, crown) or the face items (glasses), which the
 * avatar puts inside the eyes' group so they look around together.
 */
export function AgentAccessoryLayer({
  accessory,
  px = 36,
  layer = "head",
}: {
  accessory?: AgentAccessory;
  /** Rendered size of the avatar (simplifies and thickens below 24–36px). */
  px?: number;
  layer?: "head" | "face";
}) {
  if (!accessory || accessory === "none") return null;
  const face = isFaceAccessory(accessory);
  if ((layer === "face") !== face) return null;
  const draw = accessoryDraw(px);
  return (
    <svg
      className="ac-avatar__accessory"
      viewBox="0 0 100 100"
      aria-hidden="true"
      data-accessory={accessory}
      data-simple={draw.simple ? "" : undefined}
    >
      {face ? FACE[accessory](draw) : HEAD[accessory as keyof typeof HEAD](draw)}
    </svg>
  );
}
