import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

const sheets = () => builtCss("src/styles.css", "src/components/threads/threads.css");
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("a row's minor action, its time and its stop sit right after its words, never pushed to the far edge", async () => {
  const shipped = topLevel(await sheets());
  // "1 thread arquivada não aparece aqui · Ver", "Thread fechada · … · Abrir · Responder": the words don't grow.
  expect(last(shipped, ".thread-closed__text", "flex")).toBeUndefined();
  expect(last(shipped, ".thread-closed", "justify-content")).toBeUndefined();
  // An error line's × right after its words.
  expect(last(shipped, ".ac-msg__error-row>.ac-msg__error", "flex")).toBeUndefined();
  // The receipt's mark right after the time in the name's line.
  expect(last(shipped, ".ac-msg__aside", "margin-left")).toBeUndefined();
  // "Pensando… · 2 s ■": the step as wide as its words (at most 340px), the clock with no room kept for its seconds.
  expect(last(shipped, ".ac-wait__step", "flex")).not.toContain("340px");
  expect(last(shipped, ".ac-wait__step", "max-width")).toBe("340px");
  expect(last(shipped, ".run-tail__clock", "min-width")).toBeUndefined();
  // The bar's step the same way.
  expect(last(shipped, ".ac-typing__step", "flex")).not.toContain("260px");
  expect(last(shipped, ".ac-typing__step", "max-width")).toBe("260px");
});
