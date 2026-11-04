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
  ]) {
    const source = await Bun.file(path.join(SRC, file)).text();
    expect(source).toContain('className="list-title');
    expect(source).not.toContain("connected-row__name");
    expect(source).not.toContain("app-row__title");
  }
});
