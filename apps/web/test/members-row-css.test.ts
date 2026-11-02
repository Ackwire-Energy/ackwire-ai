import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

test("what ships keeps a join request or an invitation on one centred row, and wraps it in two clean lines on a phone", async () => {
  const css = await builtCss("src/styles.css", "src/pages/members.css", "src/components/roles/roles.css");
  const shipped = topLevel(css);
  const phone = atRule(css, "@media (max-width: 640px)");
  const last = (sheet: string, selector: string, property: string) =>
    declarations(sheet, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];

  // The row breaks before it shrinks, so the actions go under the words whole; they still shrink and wrap among
  // themselves when even their own line is too narrow, because the list clips what overflows. The picker is as wide
  // as its words (a form's picker fills its field), on the buttons' 28px.
  expect(last(shipped, ".members-row__acts", "flex")).toBe("0 auto");
  expect(last(shipped, ".members-row__acts", "min-width")).toBe("0");
  expect(last(shipped, ".members-row__acts", "flex-wrap")).toBe("wrap");
  expect(last(shipped, ".members-row__acts.ac-acts", "gap")).toBe("var(--space-2) calc(2 * var(--ghost-plate))");
  expect(last(shipped, ".members-row__acts", "align-items")).toBe("center");
  expect(last(shipped, ".members-row__acts", "gap")).toBe("var(--space-2)");
  expect(last(shipped, ".members-row__acts", "margin-left")).toBe("auto");
  expect(last(shipped, ".members-row__acts .roles-picker.ac-btn", "width")).toBe("auto");
  expect(last(shipped, ".roles-picker.ac-btn", "width")).toBe("100%");

  // The state is an icon line (the icon on its first line's capitals), with no layout of its own to fight it.
  expect(last(shipped, ".ac-iconline", "display")).toBe("flex");
  expect(last(shipped, ".members-row__state", "display")).toBeUndefined();

  // A phone: the person and the state on the first line, the actions under them on the right.
  expect(last(phone, ".members-page .ac-list__row.members-row>.ac-avatar:first-child+.list-col", "flex-basis")).toBe(
    "0",
  );
  expect(last(phone, ".members-row__state", "max-width")).toBe("45%");
  expect(last(phone, ".members-row__acts", "flex-basis")).toBe("100%");
  expect(last(phone, ".members-row__acts", "margin-left")).toBeUndefined();
  expect(last(phone, ".members-row__acts", "justify-content")).toBeUndefined();
  expect(last(shipped, ".members-row__acts", "justify-content")).toBe("flex-end");
  // An unconfirmed address: beside the state on a wide row, on a line of its own under the words on a phone.
  expect(last(shipped, ".members-row__flag", "display")).toBe("contents");
  expect(last(phone, ".members-row__flag", "display")).toBe("block");
  expect(last(phone, ".members-row__flag", "flex-basis")).toBe("100%");
  // No older breakpoint sends the state and the actions under the words on the left.
  expect(declarations(atRule(css, "@media (max-width: 760px)"), ".members-row__state")).toEqual([]);
});
