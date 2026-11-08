import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const SRC = join(import.meta.dir, "../src");
const read = (path: string) => Bun.file(join(SRC, path)).text();
const last = (css: string, selector: string, property: string) =>
  declarations(css, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("a DM's name keeps its line on a phone, its pill 8 after it and under it when both don't fit", async () => {
  const phone = atRule(await read("responsive.css"), "@media (max-width: 760px)");
  expect(last(phone, ".dm-who .channel__title", "display")).toBe("flex");
  expect(last(phone, ".dm-who .channel__title", "flex-wrap")).toBe("wrap");
  expect(last(phone, ".dm-who .channel__title", "gap")).toBe("var(--space-1) var(--space-2)");
  expect(last(phone, ".dm-who .channel__title>.channel__name", "text-overflow")).toBe("ellipsis");
  expect(last(phone, ".dm-who .channel__title>.ac-chip", "flex")).toBe("none");
  // On a phone the header's search is its icon, in a DM's header as in a channel's.
  const header = atRule(await read("components/channel-header.css"), "@media (max-width: 760px)");
  expect(last(header, ".channel__header>.channel__search", "display")).toBe("none");
  // A tag on a first line that rises keeps the line where it is, as the kit's pills do.
  expect(last(topLevel(await read("layout.css")), ".ac-captop:has(.agp-tag)", "margin-block-start")).toBe("0");
});
