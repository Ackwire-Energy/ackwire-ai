import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { Button, Dialog, DialogFooter, DialogSearchList, Input } from "../src";

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
