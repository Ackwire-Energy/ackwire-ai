import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

test("the members column: 264px on the sidebar's surface, offline rows quieter, round role marks, a sheet on a phone", async () => {
  const css = await builtCss(
    "src/styles.css",
    "src/components/members/members.css",
    "src/components/channel-header.css",
  );
  const shipped = topLevel(css);
  const phone = atRule(css, "@media (max-width: 760px)");
  const last = (sheet: string, selector: string, property: string) =>
    declarations(sheet, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];

  expect(last(shipped, ".members-side", "width")).toBe("264px");
  expect(last(shipped, ".members-side", "background")).toBe("var(--side)");
  expect(last(shipped, ".members-side__inner[data-presence=offline]", "opacity")).toBe(".45");
  // The open card's row keeps the chosen plate, hover the lighter one.
  expect(last(shipped, ".members-side__row.profile-trigger[data-state=open]", "background")).toBe("var(--side-chosen)");
  expect(last(shipped, ".members-side__row.profile-trigger:hover", "background")).toBe("var(--side-hover)");
  // Every role mark (the group headers' too) is a full circle.
  expect(last(shipped, ".ac-rolemark", "border-radius")).toBe("50%");
  // A phone: no column, the members in a sheet, and the threads button moves into it.
  expect(last(phone, ".members-side", "display")).toBe("none");
  expect(last(shipped, ".members-sheet", "width")).toBe("86%");
  expect(last(phone, ".channel__acts>.channel__threads", "display")).toBe("none");
});

test("the column's add row: a 24px plus tile and 13.5px text, so it fits one line in the 264px column", async () => {
  const shipped = topLevel(await builtCss("src/styles.css", "src/components/members/members.css"));
  const last = (selector: string, property: string) =>
    declarations(shipped, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  expect(last(".members-side__add", "font-size")).toBe("13.5px");
  expect(last(".members-side__add", "gap")).toBe("8px");
  expect(last(".members-side__add .member-row__plus", "width")).toBe("24px");
  expect(last(".members-side__add .member-row__plus", "height")).toBe("24px");
  expect(last(".members-side__add .member-row__plus .ac-icon", "width")).toBe("14px");
  // The dialogs' add rows keep the 32px tile beside their 32px avatars.
  expect(last(".member-row__plus", "width")).toBe("32px");
});
