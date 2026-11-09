import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { render } from "@testing-library/react";
import { FactLine } from "../src";

const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
/** The declarations of the first rule written exactly as `selector {`, at the top level or one block deep. */
const rule = (selector: string) =>
  (css.split(`\n${selector} {`)[1] ?? css.split(`\n  ${selector} {`)[1])?.split("}")[0] ?? "";

describe("FactLine", () => {
  test("each fact an icon and its words, in the order given, its tone on itself", () => {
    const { container } = render(
      <FactLine
        facts={[
          { key: "n", text: "#128" },
          { key: "label", text: "bug", tone: "label" },
          { key: "due", icon: "calendar", text: "amanhã", tone: "warn" },
          { key: "crit", icon: "approve", text: "8/8", tone: "ok", title: "8 de 8 critérios" },
        ]}
      />,
    );
    const facts = [...container.querySelectorAll(".ac-factline > .ac-factline__fact")];
    expect(facts.map((f) => f.textContent)).toEqual(["#128", "bug", "amanhã", "8/8"]);
    expect(facts.map((f) => f.getAttribute("data-tone"))).toEqual([null, "label", "warn", "ok"]);
    expect(facts[2]?.querySelector("svg.ac-icon")).toBeTruthy();
    expect(facts[0]?.querySelector("svg")).toBeNull();
    expect(facts[3]?.getAttribute("title")).toBe("8 de 8 critérios");
  });

  test("no facts, no line", () => {
    const { container } = render(<FactLine facts={[]} />);
    expect(container.querySelector(".ac-factline")).toBeNull();
  });

  test("the line wraps between facts and never inside one; a lone label wider than the line wraps its words", () => {
    expect(rule(".ac-factline")).toContain("flex-wrap: wrap");
    expect(rule(".ac-factline")).toContain("gap: 2px var(--space-3)");
    expect(rule(".ac-factline__fact")).toContain("white-space: nowrap");
    const label = rule('.ac-factline__fact[data-tone="label"]');
    expect(label).toContain("white-space: normal");
    expect(label).toContain("overflow-wrap: anywhere");
    expect(label).toContain("max-width: 100%");
    // Quiet by default; the tones bring the ink, the attention and the green.
    expect(rule(".ac-factline")).toContain("color: var(--muted)");
    expect(rule('.ac-factline__fact[data-tone="warn"]')).toContain("color: var(--ink)");
    expect(rule('.ac-factline__fact:is([data-tone="warn"], [data-tone="warn-icon"]) > svg')).toContain(
      "color: var(--warn)",
    );
    expect(rule('.ac-factline__fact[data-tone="ok"] > svg')).toContain("color: var(--ok)");
  });
});

describe("the props strip", () => {
  test("controls 32 high in the field look, 8 apart, each as wide as its value", () => {
    expect(rule(".ac-props")).toContain("flex-wrap: wrap");
    expect(rule(".ac-props")).toContain("gap: var(--space-2)");
    expect(rule(".ac-props .ac-select__trigger")).toContain("width: auto");
    const value = rule(".ac-props__value,\n.ac-props__switch");
    expect(value).toContain("min-height: var(--control-h-sm)");
    expect(value).toContain("border-radius: var(--control-r-sm)");
    expect(value).toContain("background: var(--field-bg)");
    expect(value).toContain("border: 1px solid var(--field-line)");
  });

  test("on a phone the hairline before the links is a line break", () => {
    const phone = css.split("@media (max-width: 640px) {\n  .ac-props__sep {")[1]?.split("}")[0] ?? "";
    expect(phone).toContain("flex-basis: 100%");
    expect(phone).toContain("height: 0");
  });
});
