import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ISSUES_VIEW_DEFAULT } from "@agenteschat/client/lib/issues-view";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};
const go = async (state = seedState(), api = createFakeApi(state)) => {
  await renderApp(`/org/${ORG_ID}/issues`, { api });
  await settle(8);
  return { state, api };
};
const menuOf = async (name: string) => {
  const trigger = screen().getByRole("button", { name });
  trigger.focus();
  await key(trigger, "Enter");
  return screen().getByRole("menu");
};
const closeOverlay = async () => {
  await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
  await settle(3);
};
const display = async () => {
  await click(screen().getByRole("button", { name: /^Exibição: / }));
  return screen().getByRole("dialog", { name: "Exibição" });
};
const columnNames = () =>
  screen()
    .getAllByRole("region")
    .filter((r) => r.matches(".issues-col"))
    .map((r) => r.getAttribute("aria-label"));
const rowNumbers = () =>
  screen()
    .getAllByRole("link", { name: /^#\d+/ })
    .map((l) => l.getAttribute("data-card"));

describe("Tarefas: what the view shows and hides", () => {
  test("a column folds to a strip with its count from its menu, stays folded for me, and opens again", async () => {
    const { state } = await go();
    await click(within(await menuOf("Opções da coluna Feito")).getByRole("menuitem", { name: "Recolher coluna" }));
    const strip = screen().getByRole("button", { name: "Abrir Feito" });
    expect(strip.getAttribute("aria-expanded")).toBe("false");
    expect(strip.textContent).toContain("Feito");
    const done = screen().getByRole("region", { name: "Feito" });
    expect(done.matches(".is-folded")).toBe(true);
    expect(done.querySelector(".issue-card")).toBeNull();
    // Still a place to drop a card.
    expect(done.querySelector("[data-drop]")).toBeTruthy();
    expect(state.issuesView?.collapsed).toHaveLength(1);
    await click(strip);
    expect(screen().getByRole("region", { name: "Feito" }).querySelector(".issue-card")).toBeTruthy();
    expect(state.issuesView?.collapsed).toEqual([]);
  });

  test("Exibição: finished tasks all, recent or none; empty columns leave; by last change", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    // One of the finished tasks was last touched a month ago.
    const old = (await api.issues.list(ORG_ID)).find((i) => i.status === "done");
    const list = api.issues.list;
    api.issues.list = async (...args) =>
      (await list(...args)).map((i) =>
        i.id === old?.id ? { ...i, updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() } : i,
      );
    await go(state, api);
    const before = rowNumbers().length;
    let dialog = await display();
    const done = within(dialog).getByRole("radiogroup", { name: "Concluídas" });
    expect(
      within(done)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Todas", "Últimos 7 dias", "Nenhuma"]);
    await click(within(done).getByRole("radio", { name: "Últimos 7 dias" }));
    await closeOverlay();
    // The one finished a month ago is gone; its column stays, to drop a card in.
    expect(rowNumbers()).toHaveLength(before - 1);
    expect(rowNumbers()).not.toContain(String(old?.number));
    expect(columnNames()).toContain("Feito");
    dialog = await display();
    await click(
      within(within(dialog).getByRole("radiogroup", { name: "Concluídas" })).getByRole("radio", { name: "Nenhuma" }),
    );
    await click(within(dialog).getByRole("switch", { name: "Ocultar grupos vazios" }));
    await click(
      within(within(dialog).getByRole("radiogroup", { name: "Ordenar por" })).getByRole("radio", { name: "Recentes" }),
    );
    await closeOverlay();
    expect(columnNames()).not.toContain("Feito");
    expect(state.issuesView).toMatchObject({ done: "hidden", hideEmpty: true, sort: "updated" });
    // Not the default any more: "Voltar ao padrão" brings every part back.
    dialog = await display();
    await click(within(dialog).getByRole("button", { name: "Voltar ao padrão" }));
    expect(state.issuesView).toEqual(ISSUES_VIEW_DEFAULT);
  });

  test("Filtro by label: the labels the tasks here have, as a chip once picked", async () => {
    const { state, api } = await go();
    const issues = await api.issues.list(ORG_ID);
    const label = issues.flatMap((i) => i.labels)[0] as string;
    await click(within(await menuOf("Filtro")).getByRole("menuitemcheckbox", { name: label }));
    await closeOverlay();
    const with_ = issues.filter((i) => i.status !== "canceled" && i.labels.includes(label));
    expect(rowNumbers().sort()).toEqual(with_.map((i) => String(i.number)).sort());
    expect(state.issuesView?.labels).toEqual([label]);
    await click(screen().getByRole("button", { name: `Limpar ${label}` }));
    expect(state.issuesView?.labels).toEqual([]);
  });

  test("the list: a column's name orders it, a group's name folds it", async () => {
    const state = seedState();
    state.issuesView = { ...ISSUES_VIEW_DEFAULT, layout: "list" };
    await go(state);
    const sort = screen().getByRole("button", { name: "Prioridade", pressed: false });
    await click(sort);
    expect(state.issuesView?.sort).toBe("priority");
    await click(screen().getByRole("button", { name: "Prioridade", pressed: true }));
    expect(state.issuesView?.sort).toBe("manual");
    const todo = screen().getByRole("region", { name: "A fazer" });
    const rows = within(todo).getAllByRole("link", { name: /^#\d+/ }).length;
    expect(rows).toBeGreaterThan(0);
    await click(within(todo).getByRole("button", { name: "Recolher A fazer" }));
    const folded = screen().getByRole("region", { name: "A fazer" });
    expect(within(folded).queryAllByRole("link", { name: /^#\d+/ })).toHaveLength(0);
    // Its count stays on its heading.
    expect(folded.querySelector("[data-count]")?.textContent).toBe(String(rows));
    expect(within(folded).getByRole("button", { name: "Abrir A fazer" }).getAttribute("aria-expanded")).toBe("false");
  });
});
