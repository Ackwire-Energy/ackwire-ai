import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { Button, Dialog, DialogBody, DialogFooter, DialogSearchList, InfoHint, Input } from "../src";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Ajustar orçamento</Button>
      <Dialog open={open} onOpenChange={setOpen} title="Orçamento mensal" closeLabel="Fechar" width={440}>
        <Input aria-label="Limite mensal (US$)" defaultValue="40" />
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Cancelar</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

const body = () => within(document.body);

describe("Dialog", () => {
  test("opens as a labelled modal and moves focus inside", async () => {
    render(<Harness />);
    const trigger = body().getByRole("button", { name: "Ajustar orçamento" });
    trigger.focus();
    await act(async () => fireEvent.click(trigger));
    const dialog = body().getByRole("dialog", { name: "Orçamento mensal" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Fechar" })).toBeTruthy();
  });

  test("Escape closes it and focus returns to the trigger", async () => {
    render(<Harness />);
    const trigger = body().getByRole("button", { name: "Ajustar orçamento" });
    trigger.focus();
    await act(async () => fireEvent.click(trigger));
    const dialog = body().getByRole("dialog");
    await act(async () => fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" }));
    // Radix restores focus on the next tick after unmounting the focus scope.
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(body().queryByRole("dialog")).toBeNull();
    expect(document.activeElement === trigger).toBe(true);
  });

  test("the close button closes it", async () => {
    render(<Harness />);
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Ajustar orçamento" })));
    await act(async () => fireEvent.click(body().getByRole("button", { name: "Fechar" })));
    expect(body().queryByRole("dialog")).toBeNull();
  });

  test("an ⓘ at the end of the description's line stays out of it: the dialog is described by the sentence alone", () => {
    render(
      <Dialog
        open
        onOpenChange={() => {}}
        title="Entre no Claude pelo navegador"
        description="Entre com a conta que quer adicionar."
        descriptionAside={<InfoHint name="Sobre a conta errada">Saia do Claude lá e tente de novo.</InfoHint>}
        closeLabel="Fechar"
      >
        <DialogBody>Esperando você entrar…</DialogBody>
      </Dialog>,
    );
    const dialog = body().getByRole("dialog", { description: "Entre com a conta que quer adicionar." });
    const info = within(dialog).getByRole("button", { name: "Sobre a conta errada" });
    // Outside the description element, since a browser reads a button's name inside it as part of the description
    // (the test library's own description leaves it out, so it can't tell), but on the sentence's line, after it.
    const description = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe("Entre com a conta que quer adicionar.");
    expect(description?.contains(info)).toBe(false);
    expect(info.closest(".ac-dialog__desc")?.textContent).toStartWith("Entre com a conta que quer adicionar.");
  });

  test("a toast over it takes its own clicks, even one that removes it; a press on the scrim still closes it", async () => {
    let closes = 0;
    render(
      <>
        <div className="ac-toasts">
          <div className="ac-toast">
            Salvo <button type="button">Dispensar</button>
          </div>
        </div>
        <Dialog open onOpenChange={() => closes++} title="Orçamento mensal" closeLabel="Fechar">
          <Input aria-label="Limite mensal (US$)" defaultValue="40" />
        </Dialog>
      </>,
    );
    // Radix listens for presses outside a tick after it opens.
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const toast = document.querySelector(".ac-toast") as HTMLElement;
    const dismiss = toast.querySelector("button") as HTMLButtonElement;
    // As in a browser once the toast's own click handler ran: the toast is gone before the click reaches the page.
    toast.parentElement?.addEventListener("click", () => toast.remove());
    await act(async () => {
      fireEvent.pointerDown(dismiss);
      fireEvent.click(dismiss);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(toast.isConnected).toBe(false);
    expect(closes).toBe(0);
    const scrim = document.querySelector(".ac-dialog__scrim") as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(scrim);
      fireEvent.click(scrim);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(closes).toBe(1);
    // A modal dialog turns the page's pointer events off; a toast turns its own back on.
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    expect(css.split("\n.ac-toast {")[1]?.split("}")[0]).toContain("pointer-events: auto");
  });

  test("searchable list variant filters and shows the empty message", async () => {
    const items = ["Ler código e issues", "Abrir e comentar PRs", "Fazer merge"];
    function Search() {
      const [q, setQ] = useState("");
      const shown = items.filter((i) => i.toLowerCase().includes(q.toLowerCase()));
      return (
        <Dialog open onOpenChange={() => {}} title="Permissões da Ada" closeLabel="Fechar">
          <DialogSearchList
            query={q}
            onQueryChange={setQ}
            searchLabel="Buscar permissões"
            emptyText={`Nada encontrado com “${q}”.`}
            isEmpty={shown.length === 0}
          >
            <ul>
              {shown.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </DialogSearchList>
        </Dialog>
      );
    }
    render(<Search />);
    const search = body().getByRole("searchbox", { name: "Buscar permissões" });
    expect(body().getAllByRole("listitem")).toHaveLength(3);
    await act(async () => fireEvent.change(search, { target: { value: "merge" } }));
    expect(
      body()
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Fazer merge"]);
    await act(async () => fireEvent.change(search, { target: { value: "deploy" } }));
    expect(body().queryAllByRole("listitem")).toHaveLength(0);
    expect(body().getByText("Nada encontrado com “deploy”.")).toBeTruthy();
  });
});

describe("Dialog without a footer", () => {
  test("its body is the last thing in it, and then keeps the dialog's own edge under its last item", async () => {
    render(
      <Dialog open onOpenChange={() => {}} title="Conectar uma IA" closeLabel="Fechar" width={480}>
        <DialogBody>
          <Button>Chave de API</Button>
        </DialogBody>
      </Dialog>,
    );
    const dialog = body().getByRole("dialog", { name: "Conectar uma IA" });
    expect(dialog.lastElementChild?.classList.contains("ac-dialog__body")).toBe(true);
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
    expect(css).toMatch(/\n\.ac-dialog__body:last-child \{\s*padding-bottom: 20px;/);
    // On a phone, the sheet's own 16 px.
    expect(css).toMatch(/@media \(max-width: 640px\) \{[^@]*\.ac-dialog__body:last-child \{\s*padding-bottom: 16px;/);
  });
});
