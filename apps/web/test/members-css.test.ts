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
  // Inside the chat's main, beside the conversation's column and under the header (whose line spans both).
  expect(last(shipped, ".members-side", "height")).toBeUndefined();
  expect(last(shipped, ".channel__body", "display")).toBe("flex");
  expect(last(shipped, ".channel__body", "min-height")).toBe("0");
  expect(last(shipped, ".channel__col", "flex-direction")).toBe("column");
  expect(last(shipped, ".channel__col", "min-width")).toBe("0");
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

test("the column's add row: a 24px plus tile and 13px text, so it fits one line in the 264px column", async () => {
  const shipped = topLevel(await builtCss("src/styles.css", "src/components/members/members.css"));
  const last = (selector: string, property: string) =>
    declarations(shipped, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  expect(last(".members-side__add", "font-size")).toBe("13px");
  expect(last(".members-side__add", "padding")).toBe("5px 4px 5px 8px");
  expect(last(".members-side__add", "gap")).toBe("8px");
  expect(last(".members-side__add .member-row__plus", "width")).toBe("24px");
  expect(last(".members-side__add .member-row__plus", "height")).toBe("24px");
  expect(last(".members-side__add .member-row__plus .ac-icon", "width")).toBe("14px");
  // The dialogs' add rows keep the 32px tile beside their 32px avatars.
  expect(last(".member-row__plus", "width")).toBe("32px");
});

test("a DM's sidebar: a settings row's words keep the column, and its buttons wrap under them", async () => {
  const css = await Bun.file(new URL("../src/components/agents/agent-sidebar.css", import.meta.url).pathname).text();
  const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split("}")[0];
  expect(rule(".dm-side__sec .settings-row")).toContain("flex-wrap: wrap");
  expect(rule(".dm-side__sec .settings-row > .settings-row__text")).toContain("flex: 1 1 0");
  const buttons = rule(".dm-side .dm-side__sec .settings-row.settings-row--lead > .settings-row__end");
  expect(buttons).toContain("flex-basis: 100%");
  // The name's 22px box belongs beside the words, never around buttons under them.
  expect(buttons).toContain("height: auto");
  expect(rule(".dm-side__sec .rh-set__acts")).toContain("flex-wrap: wrap");
  // Only there: Settings' rows keep their layout.
  expect(css.match(/^[^\n]*settings-row[^\n]*\{$/gm)?.every((line) => /^(\.dm-side )?\.dm-side__sec/.test(line))).toBe(
    true,
  );
});

test("a DM's floating sidebar: 360px over the chat, and where panels take the whole screen it does too", async () => {
  const css = await builtCss("src/components/agents/agent-sidebar.css");
  const width = (sheet: string) =>
    declarations(sheet, ".thread-panel.dm-side--float").find(([p]) => p === "width")?.[1];
  expect(width(topLevel(css))).toBeUndefined();
  expect(width(atRule(css, "@media (min-width: 861px)"))).toContain("360px");
});
