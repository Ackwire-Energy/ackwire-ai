import { expect, test } from "bun:test";
import { join } from "node:path";
import { declarations } from "./built-css";

const css = await Bun.file(join(import.meta.dir, "../src/layout.css")).text();
const value = (selector: string, property: string) =>
  declarations(css, selector).findLast(([p]) => p === property)?.[1];

test("a channel's # is no louder than a category's chevron, in its column, and every name starts in one column", () => {
  const mark = '.sidebar:not([data-rail="true"]) .sidebar__item > .sidebar__channel-icon';
  const chevron = ".sidebar__section-chevron";
  // The chevron's 14px and faint ink, in the 16px icons' place (1px each side).
  expect([value(mark, "width"), value(mark, "height"), value(mark, "color"), value(mark, "margin")]).toEqual([
    "14px",
    "14px",
    "var(--faint)",
    "0 1px",
  ]);
  expect([value(chevron, "color"), value(chevron, "margin")]).toEqual(["var(--faint)", "0 1px"]);
  // A category's header starts and spaces its chevron and name as a row does its icon and name.
  const row = '.sidebar:not([data-rail="true"]) .sidebar__item';
  const header = ".sidebar__section-toggle";
  expect([value(header, "padding"), value(header, "gap")]).toEqual([value(row, "padding"), value(row, "gap")]);
  // No step in under a header: a category's rows line up with the ones outside it.
  expect(value('.sidebar:not([data-rail="true"]) .sidebar__section-body', "padding-left")).toBeUndefined();
});

test("space, not lines, sets the sidebar's parts apart: 14px over each one with the list's gap", () => {
  expect(declarations(css, ".sidebar__divider")).toEqual([]);
  expect(value('.sidebar:not([data-rail="true"]) .sidebar__block + .sidebar__block', "margin-top")).toBe("10px");
  expect(value('.sidebar:not([data-rail="true"]) .sidebar__scroll', "gap")).toBe("4px");
});

test("an agent's role sits under its name, one line, beside a face as tall as both, and gone in the rail", () => {
  const role = ".sidebar__item-role";
  // One line ending in "…", what it is on too: the row stays two lines and everything in it shares its middle.
  expect([
    value(role, "white-space"),
    value(role, "text-overflow"),
    value(".sidebar__item-work", "white-space"),
  ]).toEqual(["nowrap", "ellipsis", undefined]);
  expect([value(role, "font-size"), value(role, "color")]).toEqual(["12px", "var(--ink-muted)"]);
  expect([value(".sidebar__item-text", "flex-direction"), value(".sidebar__item-text", "min-width")]).toEqual([
    "column",
    "0",
  ]);
  // A 32 face, 8 from the plate's edges: a name alone centres on it, a name over a role is a face line (the name's
  // capitals on the face's top, `.ac-captop` on the label) with what ends the row on its middle.
  const face = '.sidebar:not([data-rail="true"]) .sidebar__item > .ac-avatar--sm';
  // The rail's 40px tile keeps its smaller face, with room for the presence badge and the unread count.
  expect(value(".sidebar__item > .ac-avatar--sm", "height")).toBe("28px");
  expect([value(face, "width"), value(face, "height")]).toEqual(["32px", "32px"]);
  expect(value('.sidebar:not([data-rail="true"]) .sidebar__item:has(> .ac-avatar)', "padding-block")).toBe("8px");
  const twoLines =
    '.sidebar:not([data-rail="true"]) .sidebar__item:has(> .ac-avatar + .sidebar__item-text > .sidebar__item-role)';
  expect(declarations(css, twoLines)).toEqual([["align-items", "flex-start"]]);
  expect(value(`${twoLines} > :not(.ac-avatar, .sidebar__item-text)`, "align-self")).toBe("center");
  expect(value(".sidebar__item", "align-items")).toBe("center");
  // The icons' rows: 32, their 16px icons 8 from the plate's edges.
  const item = '.sidebar:not([data-rail="true"]) .sidebar__item';
  expect([value(item, "min-height"), value(item, "padding")]).toEqual(["32px", "0 8px"]);
  expect(value(`${item} > .ac-icon`, "height")).toBe("16px");
  expect(value('.sidebar[data-rail="true"] .sidebar__item-text', "display")).toBe("contents");
  expect(value('.sidebar[data-rail="true"] .sidebar__item-role', "display")).toBe("none");
});

test("a row's hover buttons get their own room instead of covering the name and role, and Tab shows them", () => {
  // Each button is 24px, from 4px before the row's end.
  const open = '.sidebar__row[data-acts]:is(:hover, :focus-within, :has([data-state="open"]))';
  expect(value(`${open} > .sidebar__row-acts`, "opacity")).toBe("1");
  // Not in the rail, which has no such buttons: room kept there would push the mark out of its plate.
  const wide = `.sidebar:not([data-rail="true"]) ${open} > .sidebar__item`;
  expect(value(wide, "padding-right")).toBe("var(--acts-room, 32px)");
  expect(value(`${open} > .sidebar__item`, "padding-right")).toBeUndefined();
  expect(value('.sidebar__row[data-acts="2"]', "--acts-room")).toBe("56px");
  expect(value(".sidebar__row-acts", "opacity")).toBe("0");
  // Centred on the row, as the face is, on a two-line row too.
  expect([value(".sidebar__row-acts", "top"), value(".sidebar__row-acts", "translate")]).toEqual(["50%", "0 -50%"]);
  expect(declarations(css, ".sidebar__row:has(> .sidebar__item .sidebar__item-role) > .sidebar__row-acts")).toEqual([]);
  expect(value('.sidebar[data-rail="true"] .sidebar__row-acts', "display")).toBe("none");
});

test("a closed group of agents keeps in sight who works, waits or wrote; pinned rows end with a thin line", () => {
  expect(
    value('.sidebar__section--group[data-open="false"] .sidebar__section-body > [data-live="true"]', "display"),
  ).toBe("flex");
  expect(value(".sidebar__pins-end", "border-top")).toBe("1px solid var(--line)");
  expect(
    value('.sidebar:not([data-rail="true"]) .sidebar__section--part[data-open="false"] ~ .sidebar__see-all', "display"),
  ).toBe("none");
});

test("the right hand stays in sight in a closed AGENTES, on a soft tint of the agent blue the open row's plate replaces", () => {
  expect(value('.sidebar__section[data-open="false"] .sidebar__section-body > [data-right-hand]', "display")).toBe(
    "flex",
  );
  expect(value('.sidebar__item[data-right-hand]:not([data-status="active"])', "background")).toContain(
    "var(--agent-soft)",
  );
});

test("a row's hidden hover buttons don't catch the pointer, so a drag over a row's end lands before or after it", () => {
  const shown = '.sidebar__row[data-acts]:is(:hover, :focus-within, :has([data-state="open"])) > .sidebar__row-acts';
  expect([value(".sidebar__row-acts", "pointer-events"), value(shown, "pointer-events")]).toEqual(["none", "auto"]);
});

test("over a row's hover button the row keeps its plate, and the button lights its ink only, no square of its own", () => {
  const row = '.sidebar__row:hover > .sidebar__item:not([data-status="active"], .sidebar__item--unshown)';
  expect(value(row, "background")).toBe(value(".sidebar__item:hover", "background"));
  expect(value(".sidebar__row-acts .ac-btn--ghost", "color")).toBe("var(--ink-muted)");
  const lit = '.sidebar__row-acts .ac-btn--ghost:is(:hover, [data-state="open"])';
  expect([value(lit, "background"), value(lit, "color")]).toEqual(["transparent", "var(--ink)"]);
});

test("the open row is one solid plate (no sky, no glow), hover its lighter step, both from the sidebar's tokens", () => {
  const active = '.sidebar__item[data-status="active"]';
  expect(value(active, "background")).toBe("var(--side-chosen)");
  const all = declarations(css, active).concat(declarations(css, `${active}::before`));
  expect(
    all.some(([p, v]) => p.startsWith("background-image") || v.includes("--sel-sky") || v.includes("--sel-glow")),
  ).toBe(false);
  expect(value(".sidebar__item:hover", "background")).toBe("var(--side-hover)");
  // The open channel's own buttons stay in sight on it.
  expect(value('.sidebar__row:has(> [data-status="active"]) > .sidebar__row-acts', "opacity")).toBe("1");
});

test("a channel: gray when read, full ink and bold with the edge pill when unread, the red count only for mentions", () => {
  const channel = '.sidebar__item[data-kind="channel"]';
  expect(value(`${channel} .sidebar__item-label`, "color")).toBe("var(--faint)");
  const unread = `${channel}[data-unread="true"]`;
  expect([
    value(`${unread} .sidebar__item-label`, "color"),
    value(`${unread} .sidebar__item-label`, "font-weight"),
  ]).toEqual(["var(--ink)", "650"]);
  const pill = `${unread}::before`;
  expect([value(pill, "left"), value(pill, "width"), value(pill, "height"), value(pill, "background")]).toEqual([
    "-12px",
    "4px",
    "8px",
    "var(--ink)",
  ]);
  expect([value(".sidebar__unread", "background"), value(".sidebar__unread", "color")]).toEqual([
    "var(--danger)",
    "var(--raised)",
  ]);
  // A category's name is small and gray, quieter than any unread channel.
  const label = ".sidebar__section--category .sidebar__section-head .sidebar__label";
  expect([value(label, "font-size"), value(label, "color")]).toEqual(["12.5px", "var(--faint)"]);
});

test("every role mark is a full circle", async () => {
  const ui = await Bun.file(join(import.meta.dir, "../../../packages/ui/src/styles/components.css")).text();
  expect(declarations(ui, ".ac-rolemark").findLast(([p]) => p === "border-radius")?.[1]).toBe("50%");
});

test("Personalizar: the five parts of a tool's line have five columns, and on a phone the arrows stay on its first line", () => {
  expect(value(".sidebar-setup", "grid-template-columns")).toBe("auto 1fr auto auto");
  const first = declarations(css, ".sidebar-setup").find(([p]) => p === "grid-template-columns")?.[1];
  expect(first?.split(/ (?![^(]*\))/)).toHaveLength(5);
  expect(value(".sidebar-setup__row > .ac-seg", "grid-column")).toBe("2 / -1");
});
