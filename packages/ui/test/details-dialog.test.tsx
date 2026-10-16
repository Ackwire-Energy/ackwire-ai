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
    // One section pattern: an eyebrow title with its count, a region.
    const people = within(dialog).getByRole("region", { name: "Pessoas" });
    expect(people.className).toBe("ac-details__section");
    expect(people.querySelector(".ac-countchip")?.textContent).toBe("2");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" })));
    expect(body().queryByRole("dialog")).toBeNull();
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

  test("the CSS: 720 reading width, its own scroll, a full-screen sheet on a phone", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ac-details")).toContain("width: min(720px, calc(100% - 48px))");
    expect(rule(".ac-details__body")).toContain("overflow-y: auto");
    expect(css).toMatch(/@media \(max-width: 640px\) \{\s*\.ac-details,\s*\.ac-details--lg \{[^}]*inset: 0/);
    // The old side sheet is gone.
    expect(css).not.toContain(".ac-sheet");
  });
});
