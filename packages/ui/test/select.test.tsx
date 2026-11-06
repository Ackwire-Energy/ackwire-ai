import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { Field, Select } from "../src";

const roles = [
  { value: "member", label: "Membro", description: "Conversa, cria issues" },
  { value: "admin", label: "Admin", description: "Também gerencia membros" },
  { value: "owner", label: "Dono" },
];

function Harness({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState("member");
  return (
    <Field label="Papel" id="role">
      <Select
        value={value}
        onValueChange={(v) => {
          setValue(v);
          onChange?.(v);
        }}
        options={roles}
      />
    </Field>
  );
}

const body = () => within(document.body);
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  // Radix moves focus between options (and back to the trigger) on the next tick.
  await act(() => new Promise((r) => setTimeout(r, 0)));
};

describe("Select", () => {
  test("is a labelled button with the current value, never a native select", () => {
    const { container } = render(<Harness />);
    expect(container.querySelector("select")).toBeNull();
    const trigger = body().getByRole("combobox", { name: "Papel" });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.textContent).toContain("Membro");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("keyboard: opens with Enter, moves with arrows, picks with Enter, focus returns", async () => {
    const changes: string[] = [];
    render(<Harness onChange={(v) => changes.push(v)} />);
    const trigger = body().getByRole("combobox", { name: "Papel" });
    trigger.focus();
    await key(trigger, "Enter");
    const listbox = body().getByRole("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const options = within(listbox).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "MembroConversa, cria issues",
      "AdminTambém gerencia membros",
      "Dono",
    ]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    // The selected option has focus; move down once and pick it.
    await key(document.activeElement ?? listbox, "ArrowDown");
    expect(document.activeElement?.textContent).toContain("Admin");
    await key(document.activeElement ?? listbox, "Enter");
    expect(changes).toEqual(["admin"]);
    expect(body().queryByRole("listbox")).toBeNull();
    expect(trigger.textContent).toContain("Admin");
    expect(document.activeElement === trigger).toBe(true);
  });

  test("Escape closes without changing the value", async () => {
    const changes: string[] = [];
    render(<Harness onChange={(v) => changes.push(v)} />);
    const trigger = body().getByRole("combobox", { name: "Papel" });
    trigger.focus();
    await key(trigger, "ArrowDown");
    expect(body().getByRole("listbox")).toBeTruthy();
    await key(document.activeElement ?? document.body, "Escape");
    expect(body().queryByRole("listbox")).toBeNull();
    expect(changes).toEqual([]);
    expect(trigger.textContent).toContain("Membro");
  });

  test("the list opens on the trigger's start edge, or on its end edge for a select that ends its row", async () => {
    for (const align of [undefined, "end"] as const) {
      const { unmount } = render(
        <Select aria-label="Papel" value="member" onValueChange={() => {}} options={roles} align={align} />,
      );
      const trigger = body().getByRole("combobox", { name: "Papel" });
      trigger.focus();
      await key(trigger, "Enter");
      expect(body().getByRole("listbox").getAttribute("data-align")).toBe(align ?? "start");
      unmount();
    }
  });

  test("people and agents: 32px faces centred on their two lines, every row of that list with more air", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-menu--select .ac-menu__leading > .ac-avatar")).toContain("width: 32px;");
    const rows = rule(".ac-menu--select:has(.ac-menu__leading > .ac-avatar) .ac-menu__item");
    expect(rows).toContain("padding-block: var(--space-2);");
    expect(rows).toContain("gap: var(--space-3);");
    // Not on the first line's capitals, as a small mark is: in the middle of the name and its line.
    expect(
      rule(
        ".ac-menu--select .ac-menu__item:has(> .ac-menu__label > .ac-menu__desc) > .ac-menu__leading:has(> .ac-avatar)",
      ),
    ).toContain("translate: none;");
  });

  test("an action row is set apart by a line, rows keep a gap, two-line rows the sides' room", async () => {
    const options = [...roles, { value: "new", label: "Nova categoria…", action: true }];
    render(<Select aria-label="Categoria" value="member" onValueChange={() => {}} options={options} />);
    const trigger = body().getByRole("combobox", { name: "Categoria" });
    trigger.focus();
    await key(trigger, "Enter");
    const listbox = body().getByRole("listbox");
    const separators = listbox.querySelectorAll(".ac-menu__separator");
    expect(separators.length).toBe(1);
    expect(separators[0]?.nextElementSibling?.textContent).toContain("Nova categoria");
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-menu--select [data-radix-select-viewport]")).toContain("gap: 2px;");
    expect(rule(".ac-menu__item:has(> .ac-menu__label > .ac-menu__desc)")).toContain(
      "padding-block: var(--menu-item-px);",
    );
  });
});

test("a list mixing two-line options and one-line actions gives every row the same room above and below", async () => {
  const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url)).text();
  expect(css).toContain(".ac-menu:has(.ac-menu__desc) .ac-menu__item {\n  padding-block: var(--menu-item-px);\n}");
});

test("a browser translating the trigger's text doesn't break it: the words sit in an element of ours", () => {
  const { container, rerender, unmount } = render(<Select value="member" onValueChange={() => {}} options={roles} />);
  const value = container.querySelector(".ac-select__text") as HTMLElement;
  expect(value.textContent).toBe("Membro");
  // What Google Translate does: the text node goes, a <font> holding the new words takes its place.
  const font = document.createElement("font");
  font.textContent = "Member";
  value.replaceChild(font, value.firstChild as Text);
  rerender(<Select value="admin" onValueChange={() => {}} options={roles} />);
  expect(container.querySelector(".ac-select__value")?.textContent).toBe("Admin");
  expect(() => unmount()).not.toThrow();
});
