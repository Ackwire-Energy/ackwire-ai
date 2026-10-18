import { bodyPath, EYE_STYLES, EYE_X } from "@agenteschat/ui/agent/engine";
import { ICONS } from "./icons.data";

/**
 * The tab bar's own glyphs (Início, Conversas, Agentes, Atividade) as SVG documents, in two states:
 * outline (unselected) and filled (selected). They are template images: one opaque color, and the
 * native tab bar tints them by state. 24×24 viewBox, stroke 1.7 with round caps, the line icons'
 * geometry; Agentes is our agent (the engine's body with the cut bottom-left corner and two pill eyes).
 * Pure: `tabIcons.ts` rasterizes them with Skia.
 */

export const TAB_GLYPHS = ["home", "chats", "agents", "activity"] as const;
export type TabGlyph = (typeof TAB_GLYPHS)[number];

/** A glyph and its state, as one name (the icon "family" of the tab bar takes a single name). */
export type TabGlyphKey = TabGlyph | `${TabGlyph}.selected`;

export function tabGlyphKey(glyph: TabGlyph, selected: boolean): TabGlyphKey {
  return selected ? `${glyph}.selected` : glyph;
}

export function parseTabGlyphKey(key: string): { glyph: TabGlyph; selected: boolean } | null {
  const selected = key.endsWith(".selected");
  const glyph = (selected ? key.slice(0, -".selected".length) : key) as TabGlyph;
  return TAB_GLYPHS.includes(glyph) ? { glyph, selected } : null;
}

const STROKE = 1.7;
const f = (n: number) => Number(n.toFixed(3));

function pathD(name: "home" | "chat" | "bell", index = 0): string {
  const shape = ICONS[name][index];
  if (shape?.t !== "path") throw new Error(`icon ${name} has no path ${index}`);
  return shape.d;
}

const line = (d: string, color: string) =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`;
/** Filled and stroked with the same color: the solid shape keeps the outline's outer edge. */
const solid = (d: string, color: string) =>
  `<path d="${d}" fill="${color}" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`;

/** A vertical pill (an eye) as a closed path. */
function pill(cx: number, cy: number, w: number, h: number): string {
  const r = w / 2;
  const x = cx - r;
  const top = cy - h / 2;
  const bottom = cy + h / 2;
  return [
    `M${f(x)} ${f(top + r)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(top + r)}`,
    `V${f(bottom - r)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(bottom - r)}`,
    "Z",
  ].join("");
}

/** Body side and origin of the agent glyph in the 24 grid (the stroke's center line). */
const AGENT_SIDE = 15.4;
const AGENT_AT = (24 - AGENT_SIDE) / 2;

/** The agent's two eyes for a body at `at` with side `side`; never thinner than `minW` (legible at 24pt). */
function agentEyes(at: number, side: number, minW: number): string {
  const eye = EYE_STYLES.round;
  const w = Math.max(eye.w * side, minW);
  const h = eye.h * side;
  const cy = at + eye.cy * side;
  return EYE_X.map((x) => pill(at + x * side, cy, w, h)).join("");
}

function agentGlyph(selected: boolean, color: string): string {
  if (!selected) {
    // The outline body, the eyes filled.
    return `${line(bodyPath(AGENT_AT, AGENT_AT, AGENT_SIDE), color)}<path d="${agentEyes(AGENT_AT, AGENT_SIDE, 1.8)}" fill="${color}"/>`;
  }
  // The solid body out to the outline's outer edge, the eyes cut out (even-odd), so the bar's tint
  // shows a filled agent with see-through eyes.
  const at = AGENT_AT - STROKE / 2;
  const side = AGENT_SIDE + STROKE;
  return `<path d="${bodyPath(at, at, side)}${agentEyes(at, side, 2.1)}" fill="${color}" fill-rule="evenodd"/>`;
}

/** The SVG document of a tab glyph in a state, drawn in `color` (any opaque color: it is a template). */
export function tabGlyphSvg(glyph: TabGlyph, selected: boolean, color = "#000000"): string {
  let body: string;
  switch (glyph) {
    case "home":
      // The house path traces the door as a notch, so the solid house keeps an open door.
      body = selected ? solid(pathD("home"), color) : line(pathD("home"), color);
      break;
    case "chats":
      body = selected ? solid(pathD("chat"), color) : line(pathD("chat"), color);
      break;
    case "activity":
      body = `${selected ? solid(pathD("bell"), color) : line(pathD("bell"), color)}${line(pathD("bell", 1), color)}`;
      break;
    case "agents":
      body = agentGlyph(selected, color);
      break;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;
}
