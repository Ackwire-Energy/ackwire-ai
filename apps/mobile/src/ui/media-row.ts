/**
 * MediaRow's numbers, the web's `.ac-mediarow` (pure: unit-tested). The face 32 in a card's head and 24 in a list row,
 * 12 and 8 from the name; what goes under the name's line is 8 apart, at the row's full width, never in a column beside
 * the face.
 */
export const MEDIA_ROW = {
  card: { face: 32, gap: 12 },
  row: { face: 24, gap: 8 },
  under: 8,
} as const;

export type MediaRowSize = "card" | "row";
