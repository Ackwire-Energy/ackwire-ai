import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { DetailsDialog, DetailsSection } from "../src";

afterEach(cleanup);

const body = () => within(document.body);

function Harness({ onPage }: { onPage?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir detalhes
      </button>
      <DetailsDialog
        open={open}
        onOpenChange={setOpen}
        closeLabel="Fechar"
        eyebrow="#6"
        title="Exportar agenda"
        subtitle="Criada por Walter"
        page={
          onPage
            ? { label: "Abrir em página própria", onOpen: onPage }
            : {
                label: "Abrir em página própria",
                render: (props) => <a href="/issues/6" {...props} />,
              }
        }
      >
        <DetailsSection title="Pessoas" count={2}>
          <p>Ana e Theo</p>
        </DetailsSection>
      </DetailsDialog>
    </>
  );
}

describe("DetailsDialog", () => {
  test("a centered modal named by its title, with the eyebrow, the page link and close", async () => {
    render(<Harness />);
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Abrir detalhes" })));
    const dialog = body().getByRole("dialog", { name: "Exportar agenda" });
    expect(dialog.className).toContain("ac-details");
    expect(dialog.getAttribute("aria-modal") ?? "true").toBe("true");
    expect(dialog.textContent).toContain("#6");
    expect(dialog.textContent).toContain("Criada por Walter");
    const link = within(dialog).getByRole("link", { name: "Abrir em página própria" });
    expect(link.getAttribute("href")).toBe("/issues/6");
    expect(link.className).toContain("ac-btn");
    // Its buttons are one row of actions, close last: its icon on the head's padding line.
    const acts = dialog.querySelector(".ac-details__actions") as HTMLElement;
    expect(acts.classList.contains("ac-acts")).toBe(true);
    expect(acts.lastElementChild?.getAttribute("aria-label")).toBe("Fechar");
    // One section pattern: an eyebrow title with its count, a region.
    const people = within(dialog).getByRole("region", { name: "Pessoas" });
    expect(people.className).toBe("ac-details__section");
    expect(people.querySelector(".ac-countchip")?.textContent).toBe("2");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" })));
    expect(body().queryByRole("dialog")).toBeNull();
  });

  test("with no eyebrow, the heading sits on the bar beside the buttons, not on an empty row above it", () => {
    render(
      <DetailsDialog open onOpenChange={() => {}} closeLabel="Fechar" title="tela.png" subtitle="Arquivo · 245 kB">
        <p>Prévia</p>
      </DetailsDialog>,
    );
    const dialog = body().getByRole("dialog", { name: "tela.png" });
    const bar = dialog.querySelector(".ac-details__bar") as HTMLElement;
    expect(bar.classList.contains("ac-details__bar--titled")).toBe(true);
    expect(bar.firstElementChild?.className).toBe("ac-details__heading");
    expect(bar.lastElementChild?.className).toContain("ac-details__actions");
    expect(dialog.querySelector(".ac-details__eyebrow")).toBeNull();
    expect(dialog.querySelectorAll(".ac-details__heading")).toHaveLength(1);
  });

  test("Esc closes it and the page is left without a scroll or pointer lock", async () => {
    render(<Harness />);
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Abrir detalhes" })));
    expect(body().getByRole("dialog")).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(body().queryByRole("dialog")).toBeNull();
    expect(document.body.hasAttribute("data-scroll-locked")).toBe(false);
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  test("without a link renderer the page action is a button", async () => {
    let opened = 0;
    render(<Harness onPage={() => opened++} />);
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Abrir detalhes" })));
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Abrir em página própria" })));
    expect(opened).toBe(1);
  });

  test("opened by a double click's first press: its second presses nothing, and the double click opens the item", async () => {
    let opened = 0;
    render(<Harness onPage={() => opened++} />);
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Abrir detalhes" }), { detail: 1 }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    // The second press on the scrim keeps the details; on a button inside, the button isn't pressed.
    const scrim = document.querySelector(".ac-dialog__scrim") as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(scrim);
      fireEvent.click(scrim, { detail: 2 });
    });
    expect(body().getByRole("dialog", { name: "Exportar agenda" })).toBeTruthy();
    const page = body().getByRole("button", { name: "Abrir em página própria" });
    await act(async () => fireEvent.click(page, { detail: 2 }));
    expect(opened).toBe(0);
    await act(async () => fireEvent.doubleClick(scrim));
    expect(opened).toBe(1);
    // A press of its own, later on, works as ever.
    await act(async () => fireEvent.click(page, { detail: 1 }));
    expect(opened).toBe(2);
  });

  test("an item laid out as its own page: the title only names it, and the height stays full", async () => {
    render(
      <DetailsDialog
        open
        onOpenChange={() => {}}
        closeLabel="Fechar"
        eyebrow="#6"
        title="Exportar agenda"
        fill
        titleHidden
      >
        <h1>Exportar agenda</h1>
      </DetailsDialog>,
    );
    const dialog = body().getByRole("dialog", { name: "Exportar agenda" });
    expect(dialog.className).toContain("ac-details--fill");
    expect(dialog.querySelector(".ac-details__heading")).toBeNull();
    expect(within(dialog).getAllByText("Exportar agenda")).toHaveLength(2);
    expect(within(dialog).getByRole("heading", { level: 1, name: "Exportar agenda" })).toBeTruthy();
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    expect(css.split("\n.ac-details--fill {")[1]?.split("}")[0]).toContain("height: calc(100dvh - 48px)");
  });

  test("the CSS: 720 reading width, its own scroll, a full-screen sheet on a phone", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-details")).toContain("width: min(720px, calc(100% - 48px))");
    expect(rule(".ac-details__body")).toContain("overflow-y: auto");
    expect(css).toMatch(
      /@media \(max-width: 640px\) \{\s*\.ac-details,\s*\.ac-details--lg,\s*\.ac-details--xl \{[^}]*inset: 0/,
    );
    expect(rule(".ac-details--xl")).toContain("width: min(1440px, calc(100% - 96px))");
    // The old side sheet is gone.
    expect(css).not.toContain(".ac-sheet");
  });
});
