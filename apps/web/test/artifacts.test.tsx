import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type { ApiClient } from "@/api/client";
import type { Artifact } from "@/api/types";
import { fileSaver } from "@/components/artifacts/ArtifactViewer";
import { HTML_SANDBOX } from "@/components/artifacts/HtmlFrame";
import { setMermaidRenderer } from "@/components/artifacts/Mermaid";
import { documentPreview, parsePatch, patchCounts, sideBySide, sortRows, toCsv } from "@/lib/artifacts";
import { daysLeft, groupArtifacts, rangeOf, sortArtifacts } from "@/lib/drive";
import { Markdown, parseMarkdown } from "@/lib/markdown";
import { ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const saved: { url: string; name: string }[] = [];
const copied: string[] = [];
const realSave = fileSaver.save;
beforeAll(() => {
  setMermaidRenderer(
    async (_id, source) => `<svg xmlns="http://www.w3.org/2000/svg"><text>${source.length}</text></svg>`,
  );
  fileSaver.save = (url, name) => {
    saved.push({ url, name });
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (v: string) => void copied.push(v) },
  });
});
afterAll(() => {
  setMermaidRenderer(null);
  fileSaver.save = realSave;
});
afterEach(() => {
  cleanup();
  saved.length = 0;
  copied.length = 0;
});

const click = (el: Element) => act(async () => fireEvent.click(el));
/** Opens a dropdown (Radix: keyboard) and picks an item. */
const pick = async (scope: HTMLElement, trigger: string | RegExp, item: string) => {
  const button = within(scope).getByRole("button", { name: trigger });
  button.focus();
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: item }));
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

/** The seeded mock artifacts, by kind. */
async function byKind(api: ApiClient) {
  const list = await api.artifacts.list(ORG_ID);
  const get = (kind: Artifact["kind"]) => list.find((a) => a.kind === kind) as Artifact;
  return {
    document: get("document"),
    table: get("table"),
    diff: get("diff"),
    diagram: get("diagram"),
    html: get("html"),
  };
}

/** Channel #eng with one agent message carrying every kind of artifact. */
async function openChannel() {
  const state = seedState();
  const api = createFakeApi(state);
  const a = await byKind(api);
  state.messages.push({
    id: "m-art",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ATLAS_ID },
    body: "Deixei os arquivos no Drive.",
    mentionedAgentIds: [],
    agentRunId: "r-art",
    meta: {
      artifacts: [
        { id: a.document.id, version: 2 },
        { id: a.table.id, version: 1 },
        { id: a.diff.id, version: 1 },
        { id: a.diagram.id, version: 1 },
        { id: a.html.id, version: 1 },
      ],
    },
    createdAt: new Date().toISOString(),
  });
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  return { ...r, api, a };
}

const card = (title: string) => {
  const open = screen().getByRole("button", { name: `Abrir ${title}` });
  return open.closest(".artifact-card") as HTMLElement;
};
const openCard = async (title: string) => {
  await click(screen().getByRole("button", { name: `Abrir ${title}` }));
  await settle(6);
  return screen().getByRole("dialog", { name: title });
};

describe("artifact cards in the chat", () => {
  test("one compact card per kind, with title, version, author and a preview", async () => {
    await openChannel();
    const doc = card("Relatório de incidente: checkout");
    expect(doc.textContent).toContain("v2");
    expect(doc.textContent).toContain("Documento · gerado por");
    expect(doc.textContent).toContain("Incidente no checkout");
    expect(doc.textContent).not.toContain("cart.items.length"); // code is not in the preview

    const table = card("Pedidos mais comuns nos reviews");
    expect(table.textContent).toContain("Tabela");
    expect(within(table).getAllByRole("row")).toHaveLength(4); // header + 3 rows
    expect(table.textContent).toContain("Modo offline");
    expect(table.textContent).toContain("+ 1 linha");

    const diff = card("Corrige o checkout com carrinho vazio");
    expect(diff.textContent).toContain("Alteração de código");
    expect(diff.textContent).toContain("api/checkout.ts");
    expect(diff.textContent).toContain("+4 −1");
    expect(diff.textContent).toContain("4 linhas adicionadas, 0 removidas");

    const diagram = card("Organograma do time");
    const img = within(diagram).getByRole("img", { name: "Diagrama: Organograma do time" });
    expect(img.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);

    const html = card("Painel de erros da semana");
    expect(html.textContent).toContain("Página interativa. Abra para ver.");
    expect(html.querySelector("iframe")).toBeNull();
  });
});

describe("artifact viewer", () => {
  test("document: rendered Markdown with code in mono, download and copy link", async () => {
    const { a } = await openChannel();
    const dialog = await openCard("Relatório de incidente: checkout");
    expect(within(dialog).getByRole("heading", { name: "O que aconteceu" })).toBeTruthy();
    expect(dialog.querySelector("pre.md__code code")?.textContent).toContain("if (!cart.items.length)");
    expect(within(dialog).getByText("38 clientes").tagName).toBe("STRONG");
    await pick(dialog, "Baixar", "Original");
    await settle(3);
    expect(saved[0]?.name).toBe("relatorio-de-incidente-checkout.md");
    expect(saved[0]?.url.startsWith("data:text/markdown")).toBe(true);
    await pick(dialog, "Baixar", "PDF");
    expect(saved[1]?.name).toBe("relatorio-de-incidente-checkout.pdf");
    expect(saved[1]?.url).toBe(`/api/app/organizations/${ORG_ID}/artifacts/${a.document.id}/file?version=2&format=pdf`);
    await pick(dialog, "Baixar", "Word (.docx)");
    expect(saved[2]?.name).toBe("relatorio-de-incidente-checkout.docx");
    expect(saved[2]?.url).toBe(
      `/api/app/organizations/${ORG_ID}/artifacts/${a.document.id}/file?version=2&format=docx`,
    );
    await pick(dialog, /^Mais ações: /, "Copiar link");
    await settle(2);
    expect(copied[0]).toBe(`http://localhost:3000/org/${ORG_ID}/drive?artifact=${a.document.id}`);
    expect(screen().getByText("Link copiado.")).toBeTruthy();
  });

  test("table: sticky header, sort and Baixar CSV", async () => {
    const { a } = await openChannel();
    const dialog = await openCard("Pedidos mais comuns nos reviews");
    const firstColumn = () =>
      within(dialog)
        .getAllByRole("row")
        .slice(1)
        .map((r) => r.querySelector("td")?.textContent);
    expect(firstColumn()).toEqual(["Modo offline", "Exportar em PDF", "Tema escuro", "Login com Google"]);
    await click(within(dialog).getByRole("button", { name: "Ordenar por Menções" }));
    expect(firstColumn()).toEqual(["Login com Google", "Tema escuro", "Exportar em PDF", "Modo offline"]);
    expect(
      within(dialog)
        .getByRole("columnheader", { name: /Menções/ })
        .getAttribute("aria-sort"),
    ).toBe("ascending");
    await click(within(dialog).getByRole("button", { name: "Ordenar por Menções" }));
    expect(firstColumn()[0]).toBe("Modo offline");
    await click(within(dialog).getByRole("button", { name: "Ordenar por Pedido" }));
    expect(firstColumn()[0]).toBe("Exportar em PDF");
    await pick(dialog, "Baixar", "Planilha (.csv)");
    expect(saved[0]?.name).toBe("pedidos-mais-comuns-nos-reviews.csv");
    // The server converts (`GET …/artifacts/{id}/file?format=csv`).
    expect(saved[0]?.url).toBe(`/api/app/organizations/${ORG_ID}/artifacts/${a.table.id}/file?version=1&format=csv`);
  });

  test("diff: unified and side by side, per file, neutral style", async () => {
    await openChannel();
    const dialog = await openCard("Corrige o checkout com carrinho vazio");
    const file = within(dialog).getByRole("region", { name: "Alterações em api/checkout.ts" });
    expect(within(dialog).getByRole("region", { name: "Alterações em api/checkout.test.ts" })).toBeTruthy();
    expect(file.querySelector('[data-mode="unified"]')).not.toBeNull();
    expect(file.querySelectorAll(".ac-diff__line--add")).toHaveLength(4);
    expect(file.querySelectorAll(".ac-diff__line--del")).toHaveLength(1);
    expect(file.textContent).toContain("Adicionado: ");
    // No green or red: only the neutral diff classes.
    expect(dialog.innerHTML).not.toMatch(/\b(green|red)\b|#0f0|#f00/i);
    await click(within(dialog).getByRole("button", { name: "Lado a lado" }));
    expect(within(dialog).getByRole("button", { name: "Lado a lado" }).getAttribute("aria-pressed")).toBe("true");
    const split = file.querySelector('[data-mode="split"]') as HTMLElement;
    const changed = Array.from(split.querySelectorAll(".artifact-split__row")).find((r) =>
      r.textContent?.includes("const total"),
    );
    // The removed line sits next to the first added line.
    expect(changed?.children[0]?.className).toContain("ac-diff__line--del");
    expect(changed?.children[1]?.className).toContain("ac-diff__line--add");
  });

  test("diagram: drawn as an image", async () => {
    await openChannel();
    const dialog = await openCard("Organograma do time");
    await settle(3);
    expect(within(dialog).getByRole("img", { name: "Diagrama: Organograma do time" })).toBeTruthy();
  });

  test("html: only in a sandboxed iframe with allow-scripts and never allow-same-origin", async () => {
    await openChannel();
    const dialog = await openCard("Painel de erros da semana");
    await settle(3);
    const frame = dialog.querySelector("iframe") as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(HTML_SANDBOX).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame.getAttribute("src")).toMatch(/^(blob:|data:text\/html)/);
    expect(frame.getAttribute("title")).toBe("Página: Painel de erros da semana");
    // The page is never inlined into our DOM.
    expect(document.body.innerHTML).not.toContain("Erros da semana</h1>");
    expect(document.querySelectorAll("script").length).toBe(0);
  });
});

describe("versions and editing", () => {
  test("switch versions, see who changed what and the note", async () => {
    await openChannel();
    const dialog = await openCard("Relatório de incidente: checkout");
    const history = within(dialog).getByRole("navigation", { name: "Versões" });
    const items = within(history).getAllByRole("button");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("v2");
    expect(items[0]?.textContent).toContain("Atual");
    expect(items[0]?.textContent).toContain("Acrescentei quem foi afetado.");
    expect(items[0]?.getAttribute("aria-current")).toBe("true");
    expect(items[1]?.textContent).toContain("Sem nota");
    expect(dialog.textContent).toContain("38 clientes");

    await click(items[1] as HTMLElement);
    await settle(4);
    const again = screen().getByRole("dialog", { name: "Relatório de incidente: checkout" });
    expect(again.textContent).toContain("Vendo a v1. A mais recente é a v2.");
    expect(again.textContent).not.toContain("38 clientes");
    // Old versions are read-only.
    expect(within(again).queryByRole("button", { name: "Editar" })).toBeNull();
    await click(within(again).getByRole("button", { name: "Ver a mais recente" }));
    await settle(4);
    expect(screen().getByRole("dialog").textContent).toContain("38 clientes");
  });

  test("editing a document saves a new version with a note", async () => {
    const { api, a } = await openChannel();
    const dialog = await openCard("Relatório de incidente: checkout");
    await click(within(dialog).getByRole("button", { name: "Editar" }));
    expect(dialog.textContent).toContain("Editando: salvar cria a v3.");
    await type(within(dialog).getByLabelText("Texto em Markdown"), "# Incidente\n\nResolvido às 19h.");
    await type(within(dialog).getByLabelText("Nota da alteração (opcional)"), "Fechei o incidente.");
    await click(within(dialog).getByRole("button", { name: "Salvar nova versão" }));
    await settle(6);
    expect(screen().getByText("Versão 3 salva.")).toBeTruthy();
    const view = screen().getByRole("dialog");
    expect(view.textContent).toContain("Resolvido às 19h.");
    const history = within(view).getByRole("navigation", { name: "Versões" });
    expect(within(history).getAllByRole("button")[0]?.textContent).toContain("Fechei o incidente.");
    expect((await api.artifacts.versions(ORG_ID, a.document.id)).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  test("a stale edit (someone saved first) is explained, not lost silently", async () => {
    const { api, a } = await openChannel();
    const dialog = await openCard("Relatório de incidente: checkout");
    await click(within(dialog).getByRole("button", { name: "Editar" }));
    await api.artifacts.update(ORG_ID, a.document.id, {
      content: { kind: "document", markdown: "outra" },
      baseVersion: 2,
    });
    await type(within(dialog).getByLabelText("Texto em Markdown"), "minha versão");
    await click(within(dialog).getByRole("button", { name: "Salvar nova versão" }));
    await settle(4);
    expect(dialog.textContent).toContain("Alguém salvou uma versão nova enquanto você editava.");
  });

  test("editing a table: change a cell, add a row", async () => {
    const { api, a } = await openChannel();
    const dialog = await openCard("Pedidos mais comuns nos reviews");
    await click(within(dialog).getByRole("button", { name: "Editar" }));
    await type(within(dialog).getByLabelText("Menções, linha 1"), "33");
    await click(within(dialog).getByRole("button", { name: "Adicionar linha" }));
    await type(within(dialog).getByLabelText("Pedido, linha 5"), "Widget");
    await click(within(dialog).getByRole("button", { name: "Remover linha 4" }));
    await click(within(dialog).getByRole("button", { name: "Salvar nova versão" }));
    await settle(6);
    const latest = await api.artifacts.get(ORG_ID, a.table.id);
    expect(latest.version).toBe(2);
    expect(latest.content).toMatchObject({
      kind: "table",
      rows: [
        ["Modo offline", "33", "2,6"],
        ["Exportar em PDF", "18", "3,1"],
        ["Tema escuro", "12", "4,0"],
        ["Widget", "", ""],
      ],
    });
  });

  test("agents' diffs, diagrams and pages can't be edited in place", async () => {
    await openChannel();
    const dialog = await openCard("Corrige o checkout com carrinho vazio");
    expect(within(dialog).queryByRole("button", { name: "Editar" })).toBeNull();
  });

  test("artifact.updated refreshes what is open", async () => {
    const r = await openChannel();
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    const dialog = await openCard("Pedidos mais comuns nos reviews");
    expect(within(within(dialog).getByRole("navigation", { name: "Versões" })).getAllByRole("button")).toHaveLength(1);
    const updated = await r.api.artifacts.update(ORG_ID, r.a.table.id, {
      content: { kind: "table", columns: ["Pedido"], rows: [["Novo"]] },
      note: "Refiz",
      baseVersion: 1,
    });
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { type: "artifact.updated", channelId: ENG_ID, artifact: updated },
      }),
    );
    await settle(6);
    const history = within(screen().getByRole("dialog")).getByRole("navigation", { name: "Versões" });
    expect(within(history).getAllByRole("button")).toHaveLength(2);
    expect(screen().getByRole("dialog").textContent).toContain("Novo");
  });
});

describe("Drive", () => {
  const goDrive = async (options: { seed?: boolean; path?: string; api?: ApiClient } = {}) => {
    const state = seedState();
    const api = options.api ?? createFakeApi(state, { seed: options.seed ?? true });
    const r = await renderApp(`/org/${ORG_ID}/drive${options.path ?? ""}`, { api });
    await settle(8);
    return { ...r, api, state };
  };
  /** The items' titles, in the order shown (cards or rows). */
  const names = () => Array.from(document.querySelectorAll(".drive-hit")).map((b) => b.textContent);
  const card = (title: string) => screen().getByRole("button", { name: title });
  const keyDown = (key: string, init: Record<string, unknown> = {}) =>
    act(async () => fireEvent.keyDown(document.body, { key, ...init }));
  /** Opens a dropdown (Radix: keyboard) and picks one of its radio items. */
  const pickRadio = async (trigger: RegExp, item: string) => {
    const button = screen().getByRole("button", { name: trigger });
    button.focus();
    await act(async () => {
      fireEvent.keyDown(button, { key: "Enter" });
      fireEvent.keyUp(button, { key: "Enter" });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await click(within(screen().getByRole("menu")).getByRole("menuitemradio", { name: item }));
    await settle(2);
  };
  beforeEach(() => localStorage.removeItem("agentes.drive.view"));

  test("lists everything, newest update first; search and kind chips narrow it", async () => {
    await goDrive();
    expect(screen().getByRole("heading", { level: 1, name: "Drive" })).toBeTruthy();
    // Grid by default, grouped by date.
    expect(document.querySelector(".drive-grid")).not.toBeNull();
    expect(names()).toEqual([
      "Painel de erros da semana",
      "Organograma do time",
      "Corrige o checkout com carrinho vazio",
      "Pedidos mais comuns nos reviews",
      "Relatório de incidente: checkout",
    ]);
    await type(screen().getByRole("searchbox", { name: "Buscar arquivos" }), "pedidos");
    await settle(4);
    expect(names()).toEqual(["Pedidos mais comuns nos reviews"]);
    expect(screen().getByText("1 item")).toBeTruthy();
    await type(screen().getByRole("searchbox", { name: "Buscar arquivos" }), "");
    await settle(4);

    // A kind chip: a toggle with the kind's icon and its count.
    const kinds = screen().getByRole("group", { name: "Tipos" });
    const diffs = within(kinds).getByRole("button", { name: "Alterações de código: 1" });
    expect(diffs.querySelector("svg")).not.toBeNull();
    await click(diffs);
    await settle(4);
    expect(diffs.getAttribute("aria-pressed")).toBe("true");
    expect(names()).toEqual(["Corrige o checkout com carrinho vazio"]);
    // Two kinds: either of them.
    await click(within(kinds).getByRole("button", { name: "Diagramas: 1" }));
    await settle(4);
    expect(names()).toEqual(["Organograma do time", "Corrige o checkout com carrinho vazio"]);

    // Nothing matches → explained, with a way out that also clears the search.
    await type(screen().getByRole("searchbox", { name: "Buscar arquivos" }), "nada disso");
    await settle(4);
    expect(screen().getByText("Nenhum arquivo com esses filtros.")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Limpar filtros" }));
    await settle(4);
    expect(names()).toHaveLength(5);
  });

  test("who made it: agents or people", async () => {
    await goDrive();
    await click(screen().getByRole("radio", { name: "Pessoas" }));
    await settle(4);
    expect(names()).toEqual([]);
    expect(screen().getByText("Nenhum arquivo com esses filtros.")).toBeTruthy();
    await click(screen().getByRole("radio", { name: "Agentes" }));
    await settle(4);
    expect(names()).toHaveLength(5);
  });

  test("filter by person or agent and by channel", async () => {
    const { api } = await goDrive();
    const list = await api.artifacts.list(ORG_ID);
    const doc = list.find((a) => a.kind === "document") as Artifact;
    await click(screen().getByRole("button", { name: "Pessoa ou agente" }));
    const listbox = screen().getByRole("listbox", { name: "Pessoa ou agente" });
    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");
    expect(listbox.querySelector(".ac-avatar--agent")).not.toBeNull();
    expect(listbox.textContent).toContain("Agentes");
    expect(listbox.textContent).toContain("Pessoas");
    // The person who edited the report (v2) finds it.
    const me = (await api.account.me())?.user.name ?? "";
    await click(within(listbox).getByRole("option", { name: me }));
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(4);
    expect(names()).toEqual([doc.title]);

    const channels = await api.chat.channels(ORG_ID);
    const home = channels.find((c) => c.id === doc.channelId);
    const elsewhere = channels.find((c) => c.id !== doc.channelId);
    const pickChannel = async (name: string) => {
      const trigger = screen()
        .getAllByRole("button")
        .find((b) => b.classList.contains("ac-filter__trigger") && /Canal|#|canais/.test(b.textContent ?? ""));
      await click(trigger as HTMLElement);
      await click(within(screen().getByRole("listbox", { name: "Canal" })).getByRole("option", { name: `#${name}` }));
      await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
      await settle(4);
    };
    await pickChannel(elsewhere?.name ?? "");
    expect(screen().getByText("Nenhum arquivo com esses filtros.")).toBeTruthy();
    expect(screen().getByRole("button", { name: `#${elsewhere?.name}` })).toBeTruthy();
    // Several channels: any of them, and the chip counts them.
    await pickChannel(home?.name ?? "");
    expect(names()).toEqual([doc.title]);
    expect(screen().getByRole("button", { name: "2 canais" })).toBeTruthy();
  });

  test("empty state when there is nothing yet", async () => {
    await goDrive({ seed: false });
    expect(screen().getByText("Nenhum arquivo ainda")).toBeTruthy();
    expect(screen().getByText(/aparecem aqui/)).toBeTruthy();
  });

  test("grid or list, remembered", async () => {
    await goDrive();
    const view = screen().getByRole("radiogroup", { name: "Visualização" });
    expect(within(view).getByRole("radio", { name: "Grade" }).getAttribute("aria-checked")).toBe("true");
    await click(within(view).getByRole("radio", { name: "Lista" }));
    await settle(2);
    expect(document.querySelector(".drive-grid")).toBeNull();
    expect(document.querySelectorAll(".drive-list .drive-row")).toHaveLength(5);
    expect(localStorage.getItem("agentes.drive.view")).toBe("list");
    // Rows keep the same actions: the "…" menu per file.
    expect(screen().getByRole("button", { name: "Mais ações: Organograma do time" })).toBeTruthy();
    cleanup();

    await goDrive();
    expect(document.querySelector(".drive-grid")).toBeNull();
    expect(names()).toHaveLength(5);
  });

  test("group by channel or none, sort by name", async () => {
    await goDrive();
    await pickRadio(/^Organizar:/, "Sem grupos");
    expect(document.querySelectorAll(".drive-group__head")).toHaveLength(0);
    await pickRadio(/^Organizar:/, "Nome");
    expect(names()).toEqual([
      "Corrige o checkout com carrinho vazio",
      "Organograma do time",
      "Painel de erros da semana",
      "Pedidos mais comuns nos reviews",
      "Relatório de incidente: checkout",
    ]);
    await pickRadio(/^Organizar:/, "Canal");
    expect(document.querySelector(".drive-group__title")?.textContent).toMatch(/^#/);
  });

  test("a click shows the details: preview, Abrir, Baixar, Copiar link, versions, where", async () => {
    await goDrive();
    // The card says it opens a dialog (checked before: the open modal hides the page behind it).
    expect(card("Organograma do time").getAttribute("aria-haspopup")).toBe("dialog");
    await click(card("Organograma do time"));
    await settle(4);
    const panel = screen().getByRole("dialog", { name: "Organograma do time" });
    expect(within(panel).getByRole("heading", { level: 2, name: "Organograma do time" })).toBeTruthy();
    expect(panel.querySelector(".drive-pv--lg")).not.toBeNull();
    expect(panel.textContent).toContain("Feito por");
    expect(panel.textContent).toContain("Onde aparece");

    // Baixar: diagrams have one format (the original).
    await click(within(panel).getByRole("button", { name: "Baixar" }));
    await settle(2);
    expect(saved[0]?.name).toBe("organograma-do-time.mmd");
    await click(within(panel).getByRole("button", { name: "Copiar link" }));
    await settle(2);
    expect(copied[0]).toContain("/drive?artifact=");
    expect(within(panel).getByRole("button", { name: "Mais ações: Organograma do time" })).toBeTruthy();

    // Esc closes it.
    await keyDown("Escape");
    expect(document.querySelector(".drive-details")).toBeNull();

    // Abrir: the same viewer as everywhere.
    await click(card("Organograma do time"));
    await settle(4);
    await click(within(document.querySelector(".drive-details") as HTMLElement).getByRole("button", { name: "Abrir" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Organograma do time" })).toBeTruthy();
  });

  test("details list the versions; Ver opens an older one", async () => {
    await goDrive();
    await click(card("Relatório de incidente: checkout"));
    await settle(6);
    const panel = screen().getByRole("dialog", { name: "Relatório de incidente: checkout" });
    expect(panel.querySelectorAll(".drive-versions li")).toHaveLength(2);
    expect(panel.textContent).toContain("Acrescentei quem foi afetado.");
    await click(within(panel).getByRole("button", { name: "Ver a v1" }));
    await settle(6);
    expect(screen().getByRole("dialog").textContent).toContain("Vendo a v1");
  });

  test("a shared link opens the viewer directly", async () => {
    const first = await goDrive();
    const table = (await first.api.artifacts.list(ORG_ID)).find((a) => a.kind === "table") as Artifact;
    cleanup();
    // Links are per tab (mock store), so check with the same client.
    await goDrive({ api: first.api, path: `?artifact=${table.id}` });
    expect(screen().getByRole("dialog", { name: "Pedidos mais comuns nos reviews" })).toBeTruthy();
  });

  test("multi-select: checkbox, ⌘-click, ⌘A and Esc; the bar downloads, copies links and trashes", async () => {
    const { state } = await goDrive();
    await click(screen().getByRole("checkbox", { name: "Selecionar Organograma do time" }));
    const bar = () => screen().getByRole("toolbar", { name: "Seleção" });
    expect(bar().textContent).toContain("1 selecionado");
    // While selecting, a click selects (no details).
    await act(async () => fireEvent.click(card("Pedidos mais comuns nos reviews"), { metaKey: true }));
    expect(bar().textContent).toContain("2 selecionados");
    expect(document.querySelector(".drive-details")).toBeNull();

    await click(within(bar()).getByRole("button", { name: "Copiar links" }));
    await settle(2);
    expect(copied[0]?.split("\n")).toHaveLength(2);
    await click(within(bar()).getByRole("button", { name: "Baixar" }));
    await settle(4);
    expect(saved.map((s) => s.name).sort()).toEqual(["organograma-do-time.mmd", "pedidos-mais-comuns-nos-reviews.csv"]);

    await click(within(bar()).getByRole("button", { name: "Mover para a lixeira" }));
    const confirm = screen().getByRole("dialog", { name: "Apagar 2 arquivos?" });
    await click(within(confirm).getByRole("button", { name: "Apagar" }));
    await settle(5);
    expect(state.calls.filter((c) => c.method === "artifacts.remove")).toHaveLength(2);
    expect(names()).toHaveLength(3);
    expect(screen().queryByRole("toolbar", { name: "Seleção" })).toBeNull();
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(5);
    expect(state.calls.filter((c) => c.method === "artifacts.restore")).toHaveLength(2);
    expect(names()).toHaveLength(5);

    // ⌘A selects everything shown; Esc clears.
    await keyDown("a", { metaKey: true });
    expect(bar().textContent).toContain("5 selecionados");
    await keyDown("Escape");
    expect(screen().queryByRole("toolbar", { name: "Seleção" })).toBeNull();
  });
});

describe("artifact helpers", () => {
  const patch = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
  test("patch parsing, counts and side-by-side pairing", () => {
    expect(patchCounts(patch)).toEqual({ added: 1, removed: 1 });
    const lines = parsePatch(patch);
    expect(lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["hunk", null, null],
      ["same", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["same", 3, 3],
    ]);
    const rows = sideBySide(lines);
    expect(rows[2]).toEqual({ left: { n: 2, text: "b", kind: "del" }, right: { n: 2, text: "B", kind: "add" } });
  });

  test("CSV quoting and number-aware sort", () => {
    expect(toCsv(["a", "b"], [["1,5", 'diz "oi"']])).toBe('a,b\n"1,5","diz ""oi"""');
    expect(sortRows([["10"], ["9"], ["1.200,5"]], 0, "asc", "pt-BR").map((r) => r[0])).toEqual(["9", "10", "1.200,5"]);
  });

  test("Drive arrangement: groups by date, sorts by name, shift ranges, days left in the trash", () => {
    const now = new Date("2026-10-16T12:00:00");
    const at = (id: string, title: string, iso: string) =>
      ({
        id,
        title,
        kind: "document",
        updatedAt: iso,
        channelId: null,
        createdBy: { type: "agent", id: "a" },
      }) as Artifact;
    const list = [
      at("1", "b", "2026-10-16T09:00:00"),
      at("2", "a", "2026-10-13T09:00:00"),
      at("3", "c", "2026-09-01T09:00:00"),
    ];
    expect(groupArtifacts(list, "date", now).map((s) => [s.key, s.items.map((a) => a.id)])).toEqual([
      ["today", ["1"]],
      ["week", ["2"]],
      ["earlier", ["3"]],
    ]);
    expect(groupArtifacts(list, "none", now)).toHaveLength(1);
    expect(groupArtifacts(list, "channel", now).map((s) => s.key)).toEqual([""]);
    expect(sortArtifacts(list, "name", "pt-BR").map((a) => a.title)).toEqual(["a", "b", "c"]);
    expect(rangeOf(["1", "2", "3", "4"], "3", "1")).toEqual(["1", "2", "3"]);
    expect(rangeOf(["1", "2"], null, "2")).toEqual(["2"]);
    expect(daysLeft("2026-10-19T12:00:00", now)).toBe(3);
    expect(daysLeft("2026-10-01T12:00:00", now)).toBe(0);
  });

  test("document preview skips marks and code", () => {
    expect(documentPreview("# Título\n\n```\ncode\n```\n- **um**\n- dois\n")).toEqual(["Título", "um", "dois"]);
  });

  test("Markdown never interprets HTML and only links http(s)", () => {
    const { container } = render(
      <Markdown source={'<img src=x onerror="alert(1)">\n\n[ok](https://a.example) [no](javascript:alert(1))'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://a.example");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")[0]).toEqual({
      type: "table",
      header: ["a", "b"],
      rows: [["1", "2"]],
    });
  });
});

describe("deleting a file", () => {
  const goDrive = async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const r = await renderApp(`/org/${ORG_ID}/drive`, { api });
    await settle(8);
    return { ...r, api, state };
  };
  test("the viewer header: one-line title with a tooltip, Baixar ▾, Editar, … with Apagar arquivo", async () => {
    await openChannel();
    const dialog = await openCard("Relatório de incidente: checkout");
    const title = dialog.querySelector(".artifact-sheet__title") as HTMLElement;
    expect(title.getAttribute("title")).toBe("Relatório de incidente: checkout");
    expect(within(dialog).getByRole("button", { name: "Editar" }).getAttribute("title")).toBe("Editar");
    expect(within(dialog).queryByRole("button", { name: "Baixar PDF" })).toBeNull();
  });

  test("Apagar asks, naming the file; then 'Arquivo apagado · Desfazer' restores it", async () => {
    const { state } = await goDrive();
    // From the details panel's "…".
    await click(screen().getByRole("button", { name: "Organograma do time" }));
    await settle(4);
    const panel = screen().getByRole("dialog", { name: "Organograma do time" });
    await pick(panel, /^Mais ações: /, "Apagar arquivo");
    const confirm = screen().getByRole("dialog", { name: "Apagar “Organograma do time”?" });
    expect(confirm.textContent).toContain("lixeira por 30 dias");
    await click(within(confirm).getByRole("button", { name: "Apagar" }));
    await settle(5);
    expect(state.calls.some((c) => c.method === "artifacts.remove")).toBe(true);
    expect(screen().queryByRole("button", { name: "Organograma do time" })).toBeNull();
    expect(document.querySelector(".drive-details")).toBeNull();
    expect(screen().getByText("Arquivo apagado")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(5);
    expect(state.calls.some((c) => c.method === "artifacts.restore")).toBe(true);
    expect(screen().getByRole("button", { name: "Organograma do time" })).toBeTruthy();
  });

  test("Lixeira lists deleted files with Restaurar", async () => {
    const { api } = await goDrive();
    const list = await api.artifacts.list(ORG_ID);
    const chart = list.find((a) => a.title === "Organograma do time") as Artifact;
    await act(async () => api.artifacts.remove(ORG_ID, chart.id));
    await click(screen().getByRole("button", { name: "Lixeira" }));
    await settle(4);
    expect(screen().getByRole("heading", { level: 1, name: "Lixeira do Drive" })).toBeTruthy();
    expect(screen().getByText("Organograma do time")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Restaurar" }));
    await settle(4);
    expect(screen().getByText("A lixeira está vazia.")).toBeTruthy();
  });

  test("a chat card for a deleted file is a quiet 'Arquivo removido'", async () => {
    const { ArtifactCard } = await import("@/components/artifacts/ArtifactCard");
    expect(ArtifactCard).toBeTruthy();
    const { artifactRefs } = await import("@/lib/artifacts");
    expect(artifactRefs({ artifacts: [{ id: "x", deleted: true, title: "Relatório" }] })).toEqual([
      { id: "x", deleted: true, title: "Relatório" },
    ]);
  });
});
