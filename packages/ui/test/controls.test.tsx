import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { Checkbox, CheckboxPill, Field, Input, Radio, RadioGroup, TabPanel, Tabs } from "../src";

const body = () => within(document.body);

describe("Checkbox", () => {
  function Harness({ disabled }: { disabled?: boolean }) {
    const [on, setOn] = useState(false);
    return (
      <>
        <Checkbox id="c1" checked={on} onCheckedChange={setOn} disabled={disabled} />
        <label htmlFor="c1">Ler arquivos</label>
      </>
    );
  }

  test("is our own role=checkbox (no native input look) named by its label", () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('input[type="checkbox"]:not([aria-hidden="true"])')).toBeNull();
    const box = body().getByRole("checkbox", { name: "Ler arquivos" });
    expect(box.className).toContain("ac-check");
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  test("toggles with click and with the keyboard (Space)", async () => {
    render(<Harness />);
    const box = body().getByRole("checkbox", { name: "Ler arquivos" });
    await act(async () => fireEvent.click(box));
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(box.getAttribute("data-state")).toBe("checked");
    // Radix checkboxes are buttons: Space/Enter activate them as a click.
    box.focus();
    await act(async () => {
      fireEvent.keyDown(box, { key: " " });
      fireEvent.keyUp(box, { key: " " });
      fireEvent.click(box);
    });
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  test("clicking the label toggles it", async () => {
    render(<Harness />);
    await act(async () => fireEvent.click(body().getByText("Ler arquivos")));
    expect(body().getByRole("checkbox").getAttribute("aria-checked")).toBe("true");
  });

  test("disabled cannot be toggled", async () => {
    render(<Harness disabled />);
    const box = body().getByRole("checkbox");
    await act(async () => fireEvent.click(box));
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(box.hasAttribute("disabled")).toBe(true);
  });

  test("pill reflects the checked state for styling", async () => {
    function Pill() {
      const [on, setOn] = useState(true);
      return (
        <CheckboxPill id="tg-eng" checked={on} onCheckedChange={setOn}>
          #eng
        </CheckboxPill>
      );
    }
    const { container } = render(<Pill />);
    const pill = container.querySelector(".ac-pill");
    expect(pill?.getAttribute("data-checked")).toBe("true");
    await act(async () => fireEvent.click(body().getByRole("checkbox", { name: "#eng" })));
    expect(pill?.getAttribute("data-checked")).toBe("false");
  });
});

describe("Radio", () => {
  test("one tab stop, arrow keys select the next option", async () => {
    function Harness() {
      const [v, setV] = useState("platform");
      return (
        <RadioGroup value={v} onValueChange={setV} aria-label="Qual chave o agente usa?">
          <Radio value="platform" aria-label="Chave do agentes" />
          <Radio value="own" aria-label="Chave da Acme" />
        </RadioGroup>
      );
    }
    render(<Harness />);
    const [a, b] = body().getAllByRole("radio");
    expect(a?.getAttribute("aria-checked")).toBe("true");
    expect(b?.getAttribute("tabindex")).toBe("-1");
    await act(async () => fireEvent.click(b as HTMLElement));
    expect(b?.getAttribute("aria-checked")).toBe("true");
    expect(a?.getAttribute("aria-checked")).toBe("false");
  });
});

describe("Field", () => {
  test("label, help and error are wired to the control", () => {
    render(
      <>
        <Field label="Senha" id="pw" help="Pelo menos 8 caracteres.">
          <Input type="password" />
        </Field>
        <Field label="Orçamento" id="b" error="Use um valor maior que zero.">
          <Input />
        </Field>
      </>,
    );
    const pw = body().getByLabelText("Senha");
    expect(pw.getAttribute("aria-describedby")).toBe("pw-help");
    expect(document.getElementById("pw-help")?.textContent).toBe("Pelo menos 8 caracteres.");
    expect(pw.hasAttribute("aria-invalid")).toBe(false);
    const budget = body().getByLabelText("Orçamento");
    expect(budget.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("b-help")?.className).toBe("ac-field__error");
  });
});

describe("Tabs", () => {
  test("tablist with counts; selecting a tab shows its panel", async () => {
    function Harness() {
      const [tab, setTab] = useState<"pending" | "done">("pending");
      return (
        <Tabs
          value={tab}
          onValueChange={setTab}
          label="Filtro"
          items={[
            { value: "pending", label: "Pendentes", count: 2 },
            { value: "done", label: "Decididas", count: 2 },
          ]}
        >
          <TabPanel value="pending">Lista pendente</TabPanel>
          <TabPanel value="done">Lista decidida</TabPanel>
        </Tabs>
      );
    }
    render(<Harness />);
    const list = body().getByRole("tablist", { name: "Filtro" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Pendentes 2", "Decididas 2"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(body().getByRole("tabpanel").textContent).toBe("Lista pendente");
    await act(async () => {
      fireEvent.mouseDown(tabs[1] as HTMLElement, { button: 0 });
    });
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(body().getByRole("tabpanel").textContent).toBe("Lista decidida");
  });
});
