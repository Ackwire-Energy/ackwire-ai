import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { DatePicker, Field } from "../src";

const body = () => within(document.body);
const click = (el: Element) => act(async () => fireEvent.click(el));

describe("DatePicker", () => {
  test("size sm matches Select sm; with a date, the grid ends with a clear action", async () => {
    const cleared: string[] = [];
    function Harness() {
      const [value, setValue] = useState<string | null>("2026-10-20");
      return (
        <Field label="Prazo" id="due">
          <DatePicker
            size="sm"
            value={value}
            onChange={setValue}
            onClear={() => {
              cleared.push("x");
              setValue(null);
            }}
            placeholder="Sem prazo"
            locale="pt-BR"
            labels={{
              previousMonth: "Mês anterior",
              nextMonth: "Próximo mês",
              choose: "Escolher data",
              clear: "Tirar o prazo",
            }}
          />
        </Field>
      );
    }
    render(<Harness />);
    const trigger = body().getByRole("button", { name: /Prazo/ });
    expect(trigger.className).toContain("ac-date__trigger--sm");
    await click(trigger);
    await click(await body().findByRole("button", { name: "Tirar o prazo" }));
    expect(cleared).toEqual(["x"]);
    expect(trigger.textContent).toContain("Sem prazo");
    // Without a date there's nothing to clear.
    await click(trigger);
    expect(body().queryByRole("button", { name: "Tirar o prazo" })).toBeNull();
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    expect(css).toMatch(
      /\.ac-select--sm \.ac-select__trigger,\s*\.ac-date__trigger--sm \{\s*height: var\(--control-h-sm\);/,
    );
  });
});
