import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render, screen } from "@testing-library/react";
import { AffixInput, Field, FormActions, FormStack, Input, Locked } from "../src/components/Field";
import { Segmented } from "../src/components/Segmented";

afterEach(() => cleanup());

const ROOT = new URL("../../../", import.meta.url).pathname;
const kit = readFileSync(join(ROOT, "packages/ui/src/styles/components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const tokens = readFileSync(join(ROOT, "packages/ui/src/styles/tokens.css"), "utf8");

/** The body of the rule for exactly `selector`, wherever it stands in a selector list. */
const rule = (selector: string) =>
  [...kit.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").some((s) => s.trim() === selector))
    .map((m) => m[2])
    .join("\n");

const px = (name: string) => {
  const space = (n: string) => Number(tokens.match(new RegExp(`--space-${n}:\\s*(\\d+)px`))?.[1]);
  return space(tokens.match(new RegExp(`${name}:\\s*var\\(--space-(\\d)\\)`))?.[1] ?? "");
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : [],
  );
}

describe("a form's rhythm", () => {
  test("fields stand clearly further from each other than a label or a help from its control", () => {
    expect(px("--form-gap")).toBeGreaterThanOrEqual(px("--field-gap") * 3);
  });

  test("every stack of fields takes the one gap, and a field its own", () => {
    expect(rule(".ac-form")).toContain("gap: var(--form-gap);");
    expect(rule(".ac-form")).toContain("display: flex;");
    expect(rule(".ac-dialog__body")).toContain("gap: var(--form-gap);");
    expect(rule(".ac-field")).toContain("gap: var(--field-gap);");
    // `Locked` must stay boxless, or what it holds would leave the stack's gap.
    expect(rule(".ac-locked")).toContain("display: contents;");
  });

  test("a Segmented in a field fills it, its options sharing the track", () => {
    expect(rule(".ac-field > .ac-seg")).toContain("display: flex;");
    expect(rule(".ac-field > .ac-seg > .ac-seg__item")).toContain("flex: 1 1 0;");
    expect(rule(".ac-field > .ac-seg > .ac-seg__item")).toContain("min-width: max-content;");
  });

  test('nothing stacks on a class with no rule: `className="stack"` once left a form with no gaps at all', () => {
    const uses = ["apps/web/src", "packages/ui/src"]
      .flatMap((d) => sources(join(ROOT, d)))
      .filter((f) => /className="stack"/.test(readFileSync(f, "utf8")));
    expect(uses).toEqual([]);
  });

  test("a form's actions sit at the end, spaced as a dialog's footer", () => {
    expect(rule(".ac-form__actions")).toContain("justify-content: flex-end;");
    expect(rule(".ac-form__actions")).toContain("gap: var(--space-2);");
  });
});

describe("the pieces", () => {
  test("a group field names its Segmented by the visible label and describes it by the help", () => {
    render(
      <Field label="Formato" help="Como o servidor fala" group>
        <Segmented
          label="Formato do servidor"
          value="a"
          onValueChange={() => {}}
          options={[
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ]}
        />
      </Field>,
    );
    const radios = screen.getByRole("radiogroup", { name: "Formato" });
    expect(radios.hasAttribute("aria-label")).toBe(false);
    expect(document.getElementById(radios.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Como o servidor fala",
    );
    expect(document.querySelector("label")).toBeNull();
  });

  test("a Segmented outside a field keeps its own name", () => {
    render(<Segmented label="Vista" value="a" onValueChange={() => {}} options={[{ value: "a", label: "A" }]} />);
    expect(screen.getByRole("radiogroup", { name: "Vista" }).hasAttribute("aria-labelledby")).toBe(false);
  });

  test("an AffixInput takes an action inside its end, without a prefix too, and shows it's invalid", () => {
    render(
      <Field label="Modelo">
        <AffixInput invalid action={<button type="button">Adicionar</button>} />
      </Field>,
    );
    const input = screen.getByLabelText("Modelo");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.parentElement?.querySelector(".ac-input-affix__prefix")).toBeNull();
    expect(input.nextElementSibling?.className).toBe("ac-input-affix__action");
    expect(rule('.ac-input-affix:has(input[aria-invalid="true"])')).toContain("border-color: var(--danger);");
  });

  test("Locked inside a FormStack leaves its fields the stack's; FormActions' note comes before its buttons", () => {
    render(
      <FormStack>
        <Locked when>
          <Field label="Nome">
            <Input />
          </Field>
        </Locked>
        <FormActions note="Testando">
          <button type="button">Salvar</button>
        </FormActions>
      </FormStack>,
    );
    expect(document.querySelector(".ac-form > .ac-locked > .ac-field")).not.toBeNull();
    expect(document.querySelector(".ac-form__actions")?.firstElementChild?.textContent).toBe("Testando");
  });
});
