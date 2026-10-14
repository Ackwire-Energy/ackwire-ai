import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import {
  DatePicker,
  Dialog,
  DialogBody,
  Field,
  Menu,
  MenuItem,
  monthGrid,
  normalizeTime,
  Select,
  Sheet,
  TimeSelect,
  Token,
  timeOptions,
} from "../src";

const body = () => within(document.body);
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const css = (file: string) => Bun.file(new URL(`../src/styles/${file}`, import.meta.url).pathname).text();

describe("floating layers", () => {
  test("one layering scale: lists, menus and popovers sit above dialogs and sheets", async () => {
    const layers = await css("layers.css");
    const z = (name: string) => Number(layers.match(new RegExp(`--z-${name}:\\s*(\\d+)`))?.[1]);
    expect(z("floating")).toBeGreaterThan(z("dialog"));
    expect(z("dialog")).toBeGreaterThan(z("scrim"));
    expect(z("toast")).toBeGreaterThan(z("floating"));
    const components = await css("components.css");
    // No raw z-index numbers: everything uses the scale.
    for (const m of components.matchAll(/z-index:\s*([^;]+);/g)) expect(m[1]).toMatch(/^var\(--z-/);
    const rule = (selector: string) => components.split(`${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-menu")).toContain("z-index: var(--z-floating)");
    expect(rule(".ac-dialog")).toContain("z-index: var(--z-dialog)");
    expect(rule(".ac-sheet")).toContain("z-index: var(--z-dialog)");
    expect(await css("index.css")).toContain('@import "./layers.css"');
  });

  test("a Select inside an open Dialog opens and picks an option", async () => {
    function Harness() {
      const [value, setValue] = useState("none");
      return (
        <Dialog open onOpenChange={() => {}} title="Novo evento" closeLabel="Fechar">
          <DialogBody>
            <Field label="Repetir" id="rep">
              <Select
                value={value}
                onValueChange={setValue}
                options={[
                  { value: "none", label: "Não repete" },
                  { value: "weekly", label: "Toda semana" },
                ]}
              />
            </Field>
          </DialogBody>
        </Dialog>
      );
    }
    render(<Harness />);
    const dialog = body().getByRole("dialog", { name: "Novo evento" });
    const trigger = within(dialog).getByRole("combobox", { name: "Repetir" });
    trigger.focus();
    await key(trigger, "Enter");
    const listbox = body().getByRole("listbox");
    // The list portals out of the dialog, onto the floating layer.
    expect(dialog.contains(listbox)).toBe(false);
    await click(within(listbox).getByRole("option", { name: "Toda semana" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(within(dialog).getByRole("combobox", { name: "Repetir" }).textContent).toContain("Toda semana");
  }, 10_000);

  test("a Menu inside an open Sheet opens and runs an item", async () => {
    const picked: string[] = [];
    render(
      <Sheet open onOpenChange={() => {}} title="Relatório" closeLabel="Fechar">
        <Menu trigger={<button type="button">Mais</button>} label="Ações">
          <MenuItem onSelect={() => picked.push("dup")}>Duplicar</MenuItem>
        </Menu>
      </Sheet>,
    );
    const sheet = body().getByRole("dialog", { name: "Relatório" });
    const trigger = within(sheet).getByRole("button", { name: "Mais" });
    trigger.focus();
    await key(trigger, "Enter");
    const menu = body().getByRole("menu", { name: "Ações" });
    expect(sheet.contains(menu)).toBe(false);
    await click(within(menu).getByRole("menuitem", { name: "Duplicar" }));
    expect(picked).toEqual(["dup"]);
  }, 10_000);
});

describe("DatePicker", () => {
  function Harness({ initial = "2026-10-14" }: { initial?: string }) {
    const [value, setValue] = useState<string | null>(initial);
    return (
      <>
        <Field label="Dia" id="day">
          <DatePicker
            value={value}
            onChange={setValue}
            locale="pt-BR"
            labels={{ previousMonth: "Mês anterior", nextMonth: "Próximo mês", choose: "Escolher data" }}
          />
        </Field>
        <output>{value}</output>
      </>
    );
  }
  const full = (y: number, m: number, d: number) =>
    new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" }).format(new Date(y, m - 1, d));

  test("a button with our month grid in a popover, never a native date input", async () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('input[type="date"]')).toBeNull();
    const trigger = body().getByRole("button", { name: "Dia" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    await click(trigger);
    const pop = body().getByRole("dialog", { name: "Escolher data" });
    expect(pop.textContent).toContain("outubro de 2026");
    expect(
      within(pop)
        .getByRole("button", { name: full(2026, 10, 14) })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await click(within(pop).getByRole("button", { name: "Próximo mês" }));
    expect(pop.textContent).toContain("novembro de 2026");
    await click(within(pop).getByRole("button", { name: full(2026, 11, 3) }));
    expect(document.querySelector("output")?.textContent).toBe("2026-11-03");
    expect(body().queryByRole("dialog", { name: "Escolher data" })).toBeNull();
  }, 10_000);

  test("keyboard: arrows move by day and week, PageDown by month, Enter picks", async () => {
    render(<Harness />);
    await click(body().getByRole("button", { name: "Dia" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const focused = () => document.activeElement as HTMLElement;
    expect(focused().getAttribute("data-day")).toBe("2026-10-14");
    await key(focused(), "ArrowRight");
    expect(focused().getAttribute("data-day")).toBe("2026-10-15");
    await key(focused(), "ArrowDown");
    expect(focused().getAttribute("data-day")).toBe("2026-10-22");
    await key(focused(), "PageDown");
    expect(focused().getAttribute("data-day")).toBe("2026-11-22");
    await key(focused(), "Home");
    expect(focused().getAttribute("data-day")).toBe("2026-11-16");
    await key(focused(), "Enter");
    expect(document.querySelector("output")?.textContent).toBe("2026-11-16");
  }, 10_000);

  test("month grid starts on Monday and has 6 weeks", () => {
    const days = monthGrid(new Date(2026, 9, 1));
    expect(days).toHaveLength(42);
    expect(days[0]?.getDay()).toBe(1);
    expect(days[0]?.getDate()).toBe(28); // Mon 28 Sep 2026
  });
});

describe("TimeSelect", () => {
  test("parses what people type", () => {
    expect(normalizeTime("9")).toBe("09:00");
    expect(normalizeTime("930")).toBe("09:30");
    expect(normalizeTime("9h15")).toBe("09:15");
    expect(normalizeTime("14:05")).toBe("14:05");
    expect(normalizeTime("25:00")).toBeNull();
    expect(normalizeTime("abc")).toBeNull();
    expect(timeOptions(15)).toHaveLength(96);
  });

  test("a combobox: type and Enter, or pick a 15-minute step from our list", async () => {
    function Harness() {
      const [value, setValue] = useState("10:00");
      return (
        <>
          <Field label="Início" id="start">
            <TimeSelect value={value} onChange={setValue} />
          </Field>
          <output>{value}</output>
        </>
      );
    }
    const { container } = render(<Harness />);
    expect(container.querySelector('input[type="time"]')).toBeNull();
    const box = body().getByRole("combobox", { name: "Início" });
    await act(async () => fireEvent.change(box, { target: { value: "1415" } }));
    await key(box, "Enter");
    expect(document.querySelector("output")?.textContent).toBe("14:15");
    await click(box);
    const list = body().getByRole("listbox");
    expect(within(list).getAllByRole("option")).toHaveLength(96);
    // Open: the next step after the current value.
    await key(box, "ArrowDown");
    expect(box.getAttribute("aria-activedescendant")).toBeTruthy();
    await key(box, "Enter");
    expect(document.querySelector("output")?.textContent).toBe("14:30");
    await click(box);
    await click(within(body().getByRole("listbox")).getByRole("option", { name: "08:45" }));
    expect(document.querySelector("output")?.textContent).toBe("08:45");
  }, 10_000);
});

describe("Token", () => {
  test("shows the item and a labelled remove button", async () => {
    const removed: string[] = [];
    render(
      <Token removeLabel="Remover Ada" onRemove={() => removed.push("ada")}>
        Ada
      </Token>,
    );
    await click(body().getByRole("button", { name: "Remover Ada" }));
    expect(removed).toEqual(["ada"]);
  });
});
