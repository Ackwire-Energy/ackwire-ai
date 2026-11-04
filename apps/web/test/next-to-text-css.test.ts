import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

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

test("a thread opens in the members column's place, wider, with no scrim; a phone keeps the whole-screen sheet", async () => {
  const css = await sheets();
  const block = atRule(css, "@media (min-width: 861px)");
  const wide = topLevel(block);
  const phone = atRule(css, "@media (max-width: 860px)");
  expect(last(wide, ".thread-panel--docked", "position")).toBe("relative");
  expect(last(wide, ".thread-panel--docked", "flex")).toBe("none");
  // As wide as the floating panel was (640px), the chat keeping at least 400px.
  expect(last(wide, ".thread-panel--docked", "width")).toBe("clamp(360px,100% - 400px,640px)");
  expect(last(wide, ".thread-panel--docked", "border-radius")).toBe("0");
  // A hairline from the chat, as the members column's, drawn as a border: the thread's own page covers an inset shadow.
  expect(last(wide, ".thread-panel--docked", "border-left")).toBe("1px solid var(--line)");
  expect(last(wide, ".thread-panel--docked", "box-shadow")).toBe("none");
  expect(last(phone, ".thread-panel", "position")).toBe("fixed");
  // A body too narrow for both (a tablet with the sidebar open): the thread takes the conversation's place.
  const narrow = atRule(block, "@container channel-body (max-width: 719px)");
  expect(last(narrow, ".thread-panel--docked", "position")).toBe("absolute");
  expect(last(narrow, ".thread-panel--docked", "inset")).toBe("0");
  expect(last(wide, ".channel__body:has(>.thread-panel--docked)", "position")).toBe("relative");
  // A narrow docked thread drops the channel's name and its "·", never leaving a lone "· 2 respostas".
  const slim = atRule(block, "@container thread-dock (max-width: 479px)");
  expect(last(slim, ".thread-head__meta>.thread-head__where", "display")).toBe("none");
});
