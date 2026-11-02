import { expect, test } from "bun:test";
import { builtCss, declarations } from "./built-css";

const css = await builtCss(
  "src/styles.css",
  "src/components/agent-actions.css",
  "src/components/issue-work.css",
  "src/components/missions/missions.css",
  "src/components/browser/browser.css",
  "src/components/request-card.css",
);
const value = (selector: string, property: string) =>
  declarations(css, selector).findLast(([p]) => p === property)?.[1];

test("a message's words use the whole column; a code block or a table scrolls in its own box", () => {
  for (const selector of [".ac-msg__text", ".shell__main--chat .ac-msg__text"])
    expect(value(selector, "max-width")).toBeUndefined();
  expect(value(".ac-msg__text pre", "overflow")).toBe("auto hidden");
  expect(value(".md__table", "overflow")).toBe("auto");
  // As wide as its columns, up to the column: a small table doesn't stretch across the whole message.
  expect(value(".md__table", "width")).toBe("fit-content");
  expect(value(".md__table", "max-width")).toBe("100%");
  expect(value(".code-card__code", "overflow-x")).toBe("auto");
});

test("the cards in a message share one width: the tools, a lone call's line, every receipt and the other cards", () => {
  expect(value(":root", "--msg-card-w")).toBe("640px");
  for (const selector of [
    ".ac-tools",
    ".ag-rc",
    ".ag-rcg",
    // A request, a memory change, a question to another agent, the older work line.
    ".ac-approval",
    ".ac-consult",
    ".ac-work",
    // Files, a chart, the redo-or-explain ask, an issue's work card.
    ".artifact-cards",
    ".chart-card",
    ".correction-ask",
    ".iw-card",
    // Connect an AI, a proposed agent, a stretch, waiting for its computer.
    ".waitcard",
    // A mission's link and its command to approve, the browser's request and where it browsed.
    ".mi-linkcard",
    ".mi-cmd",
    ".brw-rq",
    // Open or not, the browser card; a request or its decided line; a mission's card.
    ".brw-ac",
    ".rq",
    ".rq-done",
    ".mi-card",
    ".brw-ac.brw-trail.is-open",
    ".brw-ac.brw-trail.brw-mf-end",
  ])
    expect([selector, value(selector, "max-width")]).toEqual([selector, "var(--msg-card-w)"]);
});

test("nothing in a message wears the hover plate's own gray: cards a step up, wells a tint that darkens with it", () => {
  // The row's hover is the soft plate; what sits on it never is.
  expect(value(".ac-msg:hover", "background")).toBe("var(--plate-soft)");
  expect(declarations(css, ".ac-msg>*")).toEqual(
    expect.arrayContaining([
      ["--raised", "var(--raised-2)"],
      ["--surface-raised", "var(--raised-2)"],
      ["--sunken", "var(--msg-well)"],
      ["--surface-sunken", "var(--msg-well)"],
      // The pressed-in well too ("Leu seu recado" under the tools).
      ["--card-well", "var(--msg-well)"],
    ]),
  );
  // Light: a well is the plate's tint over the row (darker hovered or not); dark: its own darker ground.
  expect(declarations(css, '[data-theme="light"]')).toContainEqual(["--msg-well", "var(--plate-soft)"]);
  expect(declarations(css, '[data-theme="dark"]')).toContainEqual(["--msg-well", "var(--sunken)"]);
  // Receipts, and what waits for a click (connect an AI, a stretch, waiting for its computer, "refazer ou
  // explicar?"), are cards like the tools: the card face and its hairline, never the sunken gray.
  for (const selector of [".ag-rc", ".ag-rcg", ".ac-tools", ".waitcard", ".correction-ask"]) {
    expect([selector, value(selector, "background")]).toEqual([selector, "var(--surface-raised)"]);
    expect([selector, value(selector, "box-shadow")]).toEqual([selector, "var(--card-shadow)"]);
  }
  // A request (an agent's proposal with Revisar/Recusar, an approval, a question) is a face with its hairline.
  expect(value(".rq", "background")).toBe("var(--raised)");
  expect(value(".rq", "box-shadow")).toBe("0 0 0 1px var(--line2)");
  // No card in a message sits on the well: the well is the hover plate's tint.
  for (const selector of [".ag-rc", ".ag-rcg", ".ac-tools", ".waitcard", ".correction-ask", ".ac-approval", ".rq"])
    expect(`${selector} ${value(selector, "background")}`).not.toMatch(/sunken|msg-well|plate/);
});

test("a receipt's sentence and a tool's line wrap, whole: no ellipsis", () => {
  for (const selector of [".ag-rc__sentence", ".ac-tools__label", ".ac-tools__label b", ".ac-tools__label small"]) {
    expect(value(selector, "text-overflow")).toBeUndefined();
    expect(value(selector, "white-space")).toBeUndefined();
  }
  expect(value(".ag-rc__sentence", "overflow-wrap")).toBe("anywhere");
  expect(value(".ac-tools__label", "flex-wrap")).toBe("wrap");
});

test("a card's rows start under its title: a row's hover never covers it", () => {
  expect(value(".settings-rows", "margin")).toBe("calc(-1 * var(--card-pad))");
  expect(value(".ac-card__head+.settings-rows", "margin-top")).toBe("0");
  expect(value(".ac-card__head+.settings-rows>.settings-row:first-child", "border-top")).toBe("1px solid var(--line)");
});
