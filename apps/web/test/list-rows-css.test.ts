import { expect, test } from "bun:test";
import path from "node:path";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

const SRC = path.join(import.meta.dir, "../src");
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("a settings row's title line is one text line, and one gap token sits under it and between the row's parts", async () => {
  const css = await builtCss("src/styles.css", "src/components/ai-apps.css");
  const top = topLevel(css);
  expect(last(top, ":root", "--list-part-gap")).toBe("10px");
  // The pill is as tall as the line it sits on, so the title line keeps the text's height.
  expect(last(top, "body", "line-height")).toBe("22px");
  expect(last(top, ".ac-chip", "height")).toBe("22px");
  expect(last(top, ".list-title", "align-items")).toBe("center");
  expect(last(top, ".list-title:not(:last-child)", "margin-block-end")).toBe("var(--list-part-gap)");
  expect(last(top, ".connected-row", "row-gap")).toBe("var(--list-part-gap)");
  // The leading icon or logo keeps its top on the name's capitals (the name rises: `.ac-captop`), however far the
  // details wrap.
  expect(last(top, ".connected-row", "align-items")).toBe("start");
  expect(last(top, ".app-row", "align-items")).toBe("flex-start");
  // Nothing else adds to the gap under the title: the details' column and the other lists' columns have none.
  for (const col of [".list-col", ".connected-row__text", ".machine-row__main", ".app-row__main"]) {
    expect(last(top, col, "gap")).toBeUndefined();
  }
  // The details wrap whole: no "…" that hides what they say.
  expect(last(top, ".connected-row__text>.small", "text-overflow")).toBeUndefined();
  expect(last(top, ".connected-row__text", "overflow-wrap")).toBe("anywhere");
  // Rows with actions stack them under the text at every width; only a row without them puts who uses it beside.
  expect(last(top, ".connected-row__actions", "grid-column")).toBe("2");
  const wide = atRule(css, "@container (width > 720px)");
  expect(last(wide, ".connected-row:not(:has(>.connected-row__actions))", "grid-template-columns")).toBe(
    "auto minmax(0,1fr) 10.5rem",
  );
});

test("every settings list with a name and pills uses the shared title line", async () => {
  for (const file of [
    "components/Connectors.tsx",
    "components/MailConnect.tsx",
    "components/DatabaseConnect.tsx",
    "components/GitHubAppPanel.tsx",
    "components/Machines.tsx",
    "components/AiApps.tsx",
    "components/vault/VaultConnections.tsx",
  ]) {
    const source = await Bun.file(path.join(SRC, file)).text();
    expect(source).toContain('className="list-title');
    expect(source).not.toContain("connected-row__name");
    expect(source).not.toContain("app-row__title");
  }
});

test("Calendar's and Routines' lists show their words whole: they wrap, never end in a \"…\" that hides them", async () => {
  const top = topLevel(await builtCss("src/pages/routines.css", "src/pages/calendar.css"));
  for (const selector of [
    ".routine-row__title",
    ".routine-row__sub",
    ".routine-row__to>span",
    ".routine-row__when-text b",
    ".routine-row__when-text small",
    ".routine-row__runs small",
    ".routine-sel__text b",
    ".routines-horizon__label b",
    ".cal-band__label b",
  ]) {
    expect([selector, last(top, selector, "text-overflow")]).toEqual([selector, undefined]);
    expect([selector, last(top, selector, "white-space")]).toEqual([selector, undefined]);
  }
  // Who and where it delivers keeps the row's width: its chips and its fix go under the words when there's no room.
  expect(last(top, ".routine-row__sub", "flex-wrap")).toBe("wrap");
  // A lane grows with its name, the routine's line on its middle.
  expect(last(top, ".routines-horizon__label", "height")).toBeUndefined();
  expect(last(top, ".routines-horizon__track", "align-self")).toBe("center");
  expect(last(top, ".cal-band__label", "height")).toBeUndefined();
  // An event's title wraps in a list (Agenda, a day's "+N"); a day's cell and the time grid keep the event's box.
  const listed = ":is(.cal-agenda__list,.cal-more__list) .cal-chip--line .cal-chip__title";
  expect(last(top, listed, "white-space")).toBe("normal");
  expect(last(top, listed, "overflow-wrap")).toBe("anywhere");
});
