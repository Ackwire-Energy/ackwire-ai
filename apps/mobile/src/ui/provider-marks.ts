import { markOf, PROVIDER_MARKS } from "@agenteschat/ui/brand/marks";
import type { Scheme } from "./palette";

/** Box and drawing per size, in points: the web's sizes. */
export const LOGO_SIZES = { xs: [14, 14], chip: [20, 12], sm: [30, 16], tile: [48, 26] } as const;
export type LogoSize = keyof typeof LOGO_SIZES;

/** The id of the gradient a mark's main shape is filled with, inside its own drawing. */
export const MARK_GRADIENT = "mark";

/**
 * A maker's mark as drawn on the phone (pure, so it is unit-tested): its shapes in order, each in the maker's
 * colors for this scheme. The main shape takes the brand's color, its gradient, or `ink` for a one-color mark;
 * the parts (Kimi's dot, OpenCode's block) keep their own colors. Null for an id with no mark.
 */
export function markShapes(id: string, scheme: Scheme, ink: string) {
  const key = markOf(id);
  if (!key) return null;
  const mark = PROVIDER_MARKS[key];
  return {
    key,
    gradient: mark.gradient ?? null,
    shapes: [
      { d: mark.path, fill: mark.gradient ? `url(#${MARK_GRADIENT})` : (mark.color ?? ink) },
      ...(mark.parts ?? []).map((part) => ({
        d: part.path,
        fill: scheme === "dark" ? (part.dark ?? part.color) : part.color,
      })),
    ],
  };
}

/** A stack's chips, left to right as given, each after the first drawn 6 pt over the one before. */
export const stackChips = (ids: readonly string[]) => ids.map((id, i) => ({ id, marginLeft: i === 0 ? 0 : -6 }));
