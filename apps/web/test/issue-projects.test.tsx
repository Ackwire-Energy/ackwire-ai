import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ISSUES_VIEW_DEFAULT } from "@agenteschat/client/lib/issues-view";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: HTMLElement, k: string) => {
  el.focus();
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await settle(3);
};
const cardOf = (n: number) => document.querySelector<HTMLElement>(`[data-card="${n}"]`) as HTMLElement;
const cards = () => [...document.querySelectorAll<HTMLElement>("[data-card]")].map((c) => Number(c.dataset.card));
const facts = (el: HTMLElement) =>
  [...el.querySelectorAll(".issue-card__facts > .ac-factline__fact")].map((f) => f.textContent);
const title = () => screen().getByRole("heading", { level: 1 }).textContent;

/** The longest name a project takes: 80 characters, no space to wrap at for its first 40. */
const LONG = `${"Reestruturação".repeat(3)} do atendimento da Clínica Teo em 2026 e 2027`.slice(0, 80);

/**
 * Twenty projects, as a software house with a board per client has: one with the longest name, one archived, and the
 * fake's seven tasks spread over three of them, two left with none.
 */
async function withProjects() {
  const state = seedState();
  const api = createFakeApi(state);
  const make = (name: string, color: string) => api.issues.createProject(ORG_ID, { name, color });
  const clinic = await make("Clínica Teo", "teal");
  const bakery = await make("Padaria Lia", "amber");
  const long = await make(LONG, "violet");
  const old = await make("Acme 2025", "graphite");
  for (let k = 1; k <= 16; k++) await make(`Cliente ${String(k).padStart(2, "0")}`, "indigo");
  const tasks = await api.issues.list(ORG_ID, {});
  const put = async (number: number, projectId: string) => {
    const task = tasks.find((i) => i.number === number);
    if (task) await api.issues.update(ORG_ID, task.id, { projectId });
  };
  for (const n of [131, 129, 128]) await put(n, clinic.id);
  await put(132, bakery.id);
  await put(130, long.id);
  await put(127, old.id);
  await api.issues.updateProject(ORG_ID, old.id, { archived: true });
  return { state, api, clinic, bakery, long, old };
}

const go = async (api = createFakeApi(seedState()), search = "") => {
  const r = await renderApp(`/org/${ORG_ID}/issues${search}`, { api });
  await settle(8);
  return { ...r, api };
};
const chip = () => document.querySelector<HTMLElement>(".ac-toolbar .ac-filter__trigger[aria-haspopup=listbox]");
const openChip = async () => {
  await click(chip() as HTMLElement);
  await settle(3);
  return document.querySelector<HTMLElement>(".ac-filter__menu") as HTMLElement;
};
const projectOf = (router: Awaited<ReturnType<typeof go>>["router"]) =>
  (router.state.location.search as { project?: string }).project;

describe("Tarefas: projects", () => {
  test("no project yet: the chip offers only Novo projeto, and the new one opens as its own board", async () => {
    const { api, router } = await go();
    expect(chip()?.textContent).toBe("Projeto");
    expect(facts(cardOf(131)).slice(0, 2)).toEqual(["#131", "produto"]);
    const menu = await openChip();
    expect(menu.querySelectorAll("[role=option]")).toHaveLength(0);
    expect(menu.querySelector(".ac-menu__separator")).toBeNull();
    await click(within(menu).getByRole("button", { name: "Novo projeto" }));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Novo projeto" });
    const create = within(dialog).getByRole("button", { name: "Criar projeto" });
    expect(create.hasAttribute("disabled")).toBe(true);
    // Seven colours, the first one no project wears already chosen.
    const swatches = within(dialog).getAllByRole("radio");
    expect(swatches).toHaveLength(7);
    expect(swatches.map((s) => s.getAttribute("aria-checked"))).toEqual(["true", ...Array(6).fill("false")]);
    await click(swatches[5] as HTMLElement);
    await type(within(dialog).getByLabelText("Nome"), "  Mercado Ana ");
    await click(create);
    await settle(6);
    const made = (await api.issues.projects(ORG_ID)).projects;
    expect(made).toMatchObject([{ name: "Mercado Ana", color: "teal" }]);
    expect(screen().queryByRole("dialog", { name: "Novo projeto" })).toBeNull();
    // Its own board: its URL, its name as the title, nothing in it yet and one way to add.
    expect(projectOf(router)).toBe(made[0]?.id);
    expect(title()).toBe("Mercado Ana");
    // The dot is the title's own first glyph, so it stays with the first line of a name that wraps.
    expect(document.querySelector("h1.ac-pagehead__title > .ac-colordot:first-child")).toBeTruthy();
    expect(screen().getByText("Nenhuma tarefa neste projeto ainda.")).toBeTruthy();
    expect(cards()).toEqual([]);
  });

  test("the main board: each card says its project, the chip lists twenty with their open tasks, the archived last", async () => {
    const { api } = await withProjects();
    await go(api);
    expect(title()).toBe("Tarefas");
    // The dot and the name, right after the number. A task with no project says nothing.
    expect(facts(cardOf(131)).slice(0, 3)).toEqual(["#131", "Clínica Teo", "produto"]);
    expect(cardOf(131).querySelector('.ac-factline__fact[title="Projeto"] > .ac-colordot')).toBeTruthy();
    expect(facts(cardOf(130))[1]).toBe(LONG);
    expect(cardOf(126).querySelector('.ac-factline__fact[title="Projeto"]')).toBeNull();
    // An archived project's task keeps its label.
    expect(facts(cardOf(127))).toContain("Acme 2025");

    const menu = await openChip();
    const rows = [...menu.querySelectorAll<HTMLElement>("[role=option]")];
    const row = (name: string) => rows.find((r) => r.querySelector(".ac-filter__label")?.textContent === name);
    expect(rows).toHaveLength(21);
    // Past eight options the menu has a search.
    expect(within(menu).getByRole("searchbox", { name: "Projeto" })).toBeTruthy();
    expect(row("Clínica Teo")?.querySelector(".ac-countchip")?.textContent).toBe("3");
    expect(row("Padaria Lia")?.querySelector(".ac-countchip")?.textContent).toBe("1");
    expect(row(LONG)?.querySelector(".ac-countchip")?.textContent).toBe("1");
    expect(row("Cliente 07")?.querySelector(".ac-countchip")?.textContent).toBe("0");
    // The one closed task with none isn't counted. Done ones never are.
    expect(row("Sem projeto")?.querySelector(".ac-countchip")?.textContent).toBe("0");
    expect(row("Sem projeto")?.querySelector(".ac-colordot[data-none]")).toBeTruthy();
    expect(rows.at(-1)?.querySelector(".ac-filter__label")?.textContent).toBe("Acme 2025");
    expect(rows.at(-1)?.parentElement?.querySelector(".ac-menu__heading")?.textContent).toBe("Arquivados");
    expect(rows.at(-2)?.querySelector(".ac-filter__label")?.textContent).toBe("Sem projeto");
    expect(within(menu).getByRole("button", { name: "Novo projeto" })).toBeTruthy();
    await type(within(menu).getByRole("searchbox", { name: "Projeto" }), "padaria");
    expect(menu.querySelectorAll("[role=option]")).toHaveLength(1);
  });

  test("a project's board: only its tasks, its name as the title, no label on its cards, × back to everything", async () => {
    const { api, clinic } = await withProjects();
    const { router } = await go(api);
    const menu = await openChip();
    await click(within(menu).getByRole("option", { name: /^Clínica Teo/ }));
    await settle(8);
    expect(projectOf(router)).toBe(clinic.id);
    expect(title()).toBe("Clínica Teo");
    expect(cards().sort()).toEqual([128, 129, 131]);
    expect(facts(cardOf(131)).slice(0, 2)).toEqual(["#131", "produto"]);
    expect(screen().getByText("3 em aberto · 2 com agentes")).toBeTruthy();
    // The chip wears the project: its dot in place of the icon, its name, and a × beside it.
    expect(chip()?.textContent).toBe("Clínica Teo");
    expect(chip()?.querySelector(".ac-colordot")).toBeTruthy();
    expect(chip()?.querySelector("svg.ac-icon")).toBeNull();
    // The search still works, inside the project.
    await type(screen().getByRole("searchbox", { name: "Buscar tarefas" }), "#132");
    await settle(6);
    expect(cards()).toEqual([]);
    await type(screen().getByRole("searchbox", { name: "Buscar tarefas" }), "");
    await settle(6);
    await click(screen().getByRole("button", { name: "Limpar Projeto" }));
    await settle(8);
    expect(projectOf(router)).toBeUndefined();
    expect(title()).toBe("Tarefas");
    expect(cards()).toHaveLength(7);
  });

  test("a project's own link opens its board; Sem projeto is a board too; a link to a deleted one falls back", async () => {
    const { api, bakery } = await withProjects();
    await go(api, `?project=${bakery.id}`);
    expect(title()).toBe("Padaria Lia");
    expect(cards()).toEqual([132]);
    cleanup();
    await go(api, "?project=none");
    expect(title()).toBe("Sem projeto");
    expect(cards()).toEqual([126]);
    cleanup();
    const { router } = await go(api, "?project=00000000-0000-7000-8000-000000000000");
    expect(projectOf(router)).toBeUndefined();
    expect(title()).toBe("Tarefas");
    cleanup();
    // Anything that isn't a project's id never reaches the server.
    const gone = await go(api, "?project=tudo");
    expect(projectOf(gone.router)).toBeUndefined();
  });

  test("Nova tarefa on a project's board starts in it; the Projeto button changes it and makes a new one in place", async () => {
    const { api, clinic, bakery } = await withProjects();
    await go(api, `?project=${clinic.id}`);
    await click(screen().getByRole("button", { name: "Nova tarefa" }));
    const dialog = screen().getByRole("dialog", { name: "Nova tarefa" });
    const button = within(dialog).getByRole("button", { name: "Projeto: Clínica Teo" });
    expect(button.querySelector(".ac-colordot")).toBeTruthy();
    // The first control of the strip.
    expect(dialog.querySelector(".issue-new__props button")).toBe(button);
    await key(button, "Enter");
    const options = within(screen().getByRole("menu")).getAllByRole("menuitemcheckbox");
    // The projects in use (never an archived one), then none.
    expect(options).toHaveLength(20);
    expect(options.map((o) => o.textContent)).not.toContain("Acme 2025");
    expect(options.at(-1)?.textContent).toBe("Sem projeto");
    expect(options.find((o) => o.getAttribute("aria-checked") === "true")?.textContent).toBe("Clínica Teo");
    await click(within(screen().getByRole("menu")).getByRole("menuitemcheckbox", { name: "Padaria Lia" }));
    await settle(3);
    expect(within(dialog).getByRole("button", { name: "Projeto: Padaria Lia" })).toBeTruthy();
    await type(within(dialog).getByLabelText("Título"), "Pedido por encomenda");
    await click(within(dialog).getByRole("button", { name: "Criar tarefa" }));
    await settle(6);
    const created = (await api.issues.list(ORG_ID, { projectId: bakery.id })).map((i) => i.title);
    expect(created).toContain("Pedido por encomenda");

    // "Novo projeto" from the task: made in place, the task's form stays open with it chosen.
    await click(screen().getByRole("button", { name: "Nova tarefa" }));
    const again = screen().getByRole("dialog", { name: "Nova tarefa" });
    await type(within(again).getByLabelText("Título"), "Vitrine de ofertas");
    await key(within(again).getByRole("button", { name: "Projeto: Clínica Teo" }), "Enter");
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Novo projeto" }));
    await settle(3);
    const fresh = screen().getByRole("dialog", { name: "Novo projeto" });
    await type(within(fresh).getByLabelText("Nome"), "Mercado Ana");
    await click(within(fresh).getByRole("button", { name: "Criar projeto" }));
    await settle(6);
    expect(screen().queryByRole("dialog", { name: "Novo projeto" })).toBeNull();
    expect((within(again).getByLabelText("Título") as HTMLInputElement).value).toBe("Vitrine de ofertas");
    expect(within(again).getByRole("button", { name: "Projeto: Mercado Ana" })).toBeTruthy();
  });

  test("the longest name: whole as the board's title and on Nova tarefa's button, never cut", async () => {
    const { api, long } = await withProjects();
    await go(api, `?project=${long.id}`);
    expect(title()).toBe(LONG);
    expect(LONG).toHaveLength(80);
    expect(cards()).toEqual([130]);
    await click(screen().getByRole("button", { name: "Nova tarefa" }));
    const dialog = screen().getByRole("dialog", { name: "Nova tarefa" });
    expect(within(dialog).getByRole("button", { name: `Projeto: ${LONG}` }).textContent).toBe(LONG);
    // The strip's buttons wrap their words, as its selects do.
    const css = await Bun.file(
      new URL("../../../packages/ui/src/styles/components.css", import.meta.url).pathname,
    ).text();
    const rule = css.split(".ac-props > * > .ac-btn--sm:not(.ac-btn--icon) {")[1]?.split("}")[0] ?? "";
    expect(rule).toContain("white-space: normal");
    expect(rule).toContain("overflow-wrap: anywhere");
    expect(rule).toContain("max-width: 100%");
  });

  test("on the main board Nova tarefa has no project until one is picked", async () => {
    const { api } = await withProjects();
    await go(api);
    await click(screen().getByRole("button", { name: "Nova tarefa" }));
    const dialog = screen().getByRole("dialog", { name: "Nova tarefa" });
    expect(within(dialog).getByRole("button", { name: "Projeto" })).toBeTruthy();
    await type(within(dialog).getByLabelText("Título"), "Avulsa");
    await click(within(dialog).getByRole("button", { name: "Criar tarefa" }));
    await settle(6);
    expect((await api.issues.list(ORG_ID, { projectId: "none" })).map((i) => i.title)).toContain("Avulsa");
  });

  test("the board's ⋯ on a project: edit, archive and delete; deleting keeps its tasks and goes back to everything", async () => {
    const { api, clinic } = await withProjects();
    const { router } = await go(api, `?project=${clinic.id}`);
    const more = () => screen().getByRole("button", { name: "Mais opções" });
    await key(more(), "Enter");
    expect(
      within(screen().getByRole("menu"))
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["Adicionar coluna", "Editar projeto", "Arquivar projeto", "Excluir projeto"]);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Editar projeto" }));
    await settle(3);
    const edit = screen().getByRole("dialog", { name: "Editar projeto" });
    expect((within(edit).getByLabelText("Nome") as HTMLInputElement).value).toBe("Clínica Teo");
    expect(within(edit).getByRole("radio", { name: /teal/ }).getAttribute("aria-checked")).toBe("true");
    await type(within(edit).getByLabelText("Nome"), "Clínica Teo e Filhos");
    await click(within(edit).getByRole("button", { name: "Salvar" }));
    await settle(8);
    expect(title()).toBe("Clínica Teo e Filhos");

    // Archived: its board and its tasks stay and say so, and it takes no new task.
    await key(more(), "Enter");
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Arquivar projeto" }));
    await settle(8);
    expect((await api.issues.projects(ORG_ID)).projects.find((p) => p.id === clinic.id)?.archived).toBe(true);
    expect(cards().sort()).toEqual([128, 129, 131]);
    expect(document.querySelector(".ac-pagehead__count")?.textContent).toContain("· Arquivado");
    expect(screen().queryByRole("button", { name: /^Nova tarefa/ })).toBeNull();
    await key(more(), "Enter");
    expect(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Desarquivar projeto" })).toBeTruthy();

    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Excluir projeto" }));
    await settle(3);
    const confirm = screen().getByRole("dialog", { name: "Excluir o projeto Clínica Teo e Filhos?" });
    expect(confirm.textContent).toContain("As tarefas dele continuam, sem projeto.");
    await click(within(confirm).getByRole("button", { name: "Excluir projeto" }));
    await settle(8);
    expect(projectOf(router)).toBeUndefined();
    expect(title()).toBe("Tarefas");
    expect(cards()).toHaveLength(7);
    expect(facts(cardOf(131)).slice(0, 2)).toEqual(["#131", "produto"]);
  });

  test("who can't create tasks sees the projects and their boards, and nothing to make or change one", async () => {
    const { state, api, clinic } = await withProjects();
    const org = state.me?.organizations[0];
    if (org) org.permissions = ["read"];
    await go(api, `?project=${clinic.id}`);
    expect(title()).toBe("Clínica Teo");
    const menu = await openChip();
    expect(menu.querySelectorAll("[role=option]")).toHaveLength(21);
    expect(within(menu).queryByRole("button", { name: "Novo projeto" })).toBeNull();
    await key(screen().getByRole("button", { name: "Mais opções" }), "Enter");
    expect(
      within(screen().getByRole("menu"))
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["Adicionar coluna"]);
  });

  test("no project and no right to make one: no chip at all", async () => {
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) org.permissions = ["read"];
    await go(createFakeApi(state));
    expect(chip()).toBeNull();
    expect(screen().getByRole("button", { name: "Filtro" })).toBeTruthy();
  });

  test("the task's dialog: Projeto is the strip's first field, with the task's own archived project still named", async () => {
    const { api, clinic } = await withProjects();
    await go(api, "?open=127");
    const dialog = screen().getByRole("dialog");
    const strip = dialog.querySelector(".issue-props") as HTMLElement;
    const field = within(strip).getByRole("combobox", { name: "Projeto" });
    expect(strip.querySelector("[role=combobox]")).toBe(field);
    expect(field.textContent).toBe("Acme 2025");
    await key(field, "Enter");
    const options = within(screen().getByRole("listbox")).getAllByRole("option");
    // The nineteen in use, its own archived one, none, and a new one past a line.
    expect(options).toHaveLength(22);
    expect(options.map((o) => o.textContent)).toContain("Acme 2025");
    expect(options.slice(-2).map((o) => o.textContent)).toEqual(["Sem projeto", "Novo projeto"]);
    await click(within(screen().getByRole("listbox")).getByRole("option", { name: "Clínica Teo" }));
    await settle(6);
    expect((await api.issues.get(ORG_ID, 127)).project?.id).toBe(clinic.id);
    await key(within(strip).getByRole("combobox", { name: "Projeto" }), "Enter");
    await click(within(screen().getByRole("listbox")).getByRole("option", { name: "Sem projeto" }));
    await settle(6);
    expect((await api.issues.get(ORG_ID, 127)).project).toBeNull();
    expect(within(strip).getByRole("combobox", { name: "Projeto" }).textContent).toBe("Sem projeto");
  });

  test("on a project's board a task moved to another project stays open, and a link to one outside it opens", async () => {
    const { api, clinic, bakery } = await withProjects();
    await go(api, `?project=${clinic.id}&open=131`);
    const strip = () => screen().getByRole("dialog").querySelector(".issue-props") as HTMLElement;
    await key(within(strip()).getByRole("combobox", { name: "Projeto" }), "Enter");
    await click(within(screen().getByRole("listbox")).getByRole("option", { name: "Padaria Lia" }));
    await settle(8);
    expect((await api.issues.get(ORG_ID, 131)).project?.id).toBe(bakery.id);
    expect(cards().sort()).toEqual([128, 129]);
    expect(within(strip()).getByRole("combobox", { name: "Projeto" }).textContent).toBe("Padaria Lia");
    cleanup();
    await go(api, `?project=${clinic.id}&open=126`);
    expect(within(strip()).getByRole("combobox", { name: "Projeto" }).textContent).toBe("Sem projeto");
  });

  test("the list shows the project too, and Exibição's Projeto toggle takes it off the cards", async () => {
    const { state, api } = await withProjects();
    state.issuesView = { ...structuredClone(ISSUES_VIEW_DEFAULT), layout: "list" };
    await go(api);
    expect(cardOf(131).classList.contains("issue-list__row")).toBe(true);
    expect(facts(cardOf(131))[1]).toBe("Clínica Teo");
    await click(screen().getByRole("button", { name: "Exibição: Lista · Etapa" }));
    await settle(2);
    const display = screen().getByRole("dialog", { name: "Exibição" });
    const toggle = within(display).getByRole("button", { name: "Projeto" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await click(toggle);
    await settle(5);
    expect(state.issuesView?.fields.project).toBe(false);
    expect(facts(cardOf(131))[1]).toBe("produto");
  });
});
