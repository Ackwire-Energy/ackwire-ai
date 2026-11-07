import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MEDIA_ROW } from "../../src/ui/media-row";

const src = (path: string) => readFileSync(join(import.meta.dir, "../../src", path), "utf8");

describe("MediaRow", () => {
  test("the web's numbers: a face of 32 in a card and 24 in a list, 12 and 8 from the name, 8 between what's under", () => {
    expect(MEDIA_ROW).toEqual({ card: { face: 32, gap: 12 }, row: { face: 24, gap: 8 }, under: 8 });
  });

  test("the name and what it is share one line beside the face; the rest goes under at the row's full width", () => {
    const row = src("ui/MediaRow.tsx");
    // One Text holds the name and the meta, so they wrap as words, never as two columns.
    expect(row).toMatch(
      /<Text variant="subhead" style=\{styles\.words\}>\s*<Text variant="subhead" style=\{styles\.name\}>/,
    );
    // The children come after the head's View, not inside it: under the face, not beside it.
    const head = row.indexOf("<View style={[styles.head, { gap }]}>");
    const close = row.indexOf("</View>", row.indexOf("{end}"));
    expect(head).toBeGreaterThan(0);
    expect(row.indexOf("{children}")).toBeGreaterThan(close);
    expect(row).toContain("row: { gap: MEDIA_ROW.under }");
  });

  test("screens import it from the design system", () => {
    expect(src("ui/index.ts")).toContain('export { MediaRow, type MediaRowProps } from "./MediaRow";');
  });
});
