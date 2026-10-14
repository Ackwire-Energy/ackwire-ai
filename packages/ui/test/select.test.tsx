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
    expect(document.activeElement).toBe(trigger);
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
});
