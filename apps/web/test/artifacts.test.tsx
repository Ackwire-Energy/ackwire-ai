import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type { ApiClient } from "@/api/client";
import type { Artifact } from "@/api/types";
import { fileSaver } from "@/components/artifacts/ArtifactViewer";
import { HTML_SANDBOX } from "@/components/artifacts/HtmlFrame";
import { setMermaidRenderer } from "@/components/artifacts/Mermaid";
import { documentPreview, parsePatch, patchCounts, sideBySide, sortRows, toCsv } from "@/lib/artifacts";
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
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};

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
    await click(within(dialog).getByRole("button", { name: "Baixar" }));
    await settle(3);
    expect(saved[0]?.name).toBe("relatorio-de-incidente-checkout.md");
    expect(saved[0]?.url.startsWith("data:text/markdown")).toBe(true);
    await click(within(dialog).getByRole("button", { name: "Baixar PDF" }));
    expect(saved[1]?.name).toBe("relatorio-de-incidente-checkout.pdf");
    expect(saved[1]?.url).toBe(`/api/app/organizations/${ORG_ID}/artifacts/${a.document.id}/file?version=2&format=pdf`);
    await click(within(dialog).getByRole("button", { name: "Baixar DOCX" }));
    expect(saved[2]?.name).toBe("relatorio-de-incidente-checkout.docx");
    expect(saved[2]?.url).toBe(
      `/api/app/organizations/${ORG_ID}/artifacts/${a.document.id}/file?version=2&format=docx`,
    );
    await click(within(dialog).getByRole("button", { name: "Copiar link" }));
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
    await click(within(dialog).getByRole("button", { name: "Baixar CSV" }));
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
  const goDrive = async (options: { seed?: boolean; path?: string } = {}) => {
    const api = createFakeApi(seedState(), { seed: options.seed ?? true });
    const r = await renderApp(`/org/${ORG_ID}/drive${options.path ?? ""}`, { api });
    await settle(8);
    return { ...r, api };
  };
  const names = () =>
    screen()
      .queryAllByRole("row")
      .slice(1)
      .map((r) => r.querySelector("button")?.textContent);

  test("lists everything, newest update first; search and filters narrow it", async () => {
    await goDrive();
    expect(screen().getByRole("heading", { level: 1, name: "Drive" })).toBeTruthy();
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
    await type(screen().getByRole("searchbox", { name: "Buscar arquivos" }), "");
    await settle(4);

    const kind = screen().getByRole("combobox", { name: "Tipo" });
    kind.focus();
    await key(kind, "Enter");
    await click(within(screen().getByRole("listbox")).getByRole("option", { name: "Alteração de código" }));
    await settle(4);
    expect(names()).toEqual(["Corrige o checkout com carrinho vazio"]);

    // Nothing matches → explained, with a way out.
    await type(screen().getByRole("searchbox", { name: "Buscar arquivos" }), "nada disso");
    await settle(4);
    expect(screen().getByText("Nenhum arquivo com esses filtros.")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Limpar filtros" }));
    await settle(4);
    expect(names()).toHaveLength(5);
  });

  test("filter by person or agent and by channel", async () => {
    const { api } = await goDrive();
    const list = await api.artifacts.list(ORG_ID);
    const doc = list.find((a) => a.kind === "document") as Artifact;
    const author = screen().getByRole("combobox", { name: "Pessoa ou agente" });
    author.focus();
    await key(author, "Enter");
    const listbox = screen().getByRole("listbox");
    expect(listbox.textContent).toContain("Agentes");
    expect(listbox.textContent).toContain("Pessoas");
    // The person who edited the report (v2) finds it.
    const me = (await api.account.me())?.user.name ?? "";
    await click(within(listbox).getByRole("option", { name: me }));
    await settle(4);
    expect(names()).toEqual([doc.title]);

    const channels = await api.chat.channels(ORG_ID);
    const home = channels.find((c) => c.id === doc.channelId);
    const elsewhere = channels.find((c) => c.id !== doc.channelId);
    const pickChannel = async (name: string) => {
      const channel = screen().getByRole("combobox", { name: "Canal" });
      channel.focus();
      await key(channel, "Enter");
      await click(within(screen().getByRole("listbox")).getByRole("option", { name: `#${name}` }));
      await settle(4);
    };
    await pickChannel(elsewhere?.name ?? "");
    expect(screen().getByText("Nenhum arquivo com esses filtros.")).toBeTruthy();
    await pickChannel(home?.name ?? "");
    expect(names()).toEqual([doc.title]);
  });

  test("empty state when there is nothing yet", async () => {
    await goDrive({ seed: false });
    expect(screen().getByText("Nenhum arquivo ainda")).toBeTruthy();
    expect(screen().getByText(/aparecem aqui/)).toBeTruthy();
  });

  test("rows open the same viewer; a shared link opens it directly", async () => {
    const first = await goDrive();
    await click(screen().getByRole("button", { name: "Organograma do time" }));
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Organograma do time" })).toBeTruthy();
    const table = (await first.api.artifacts.list(ORG_ID)).find((a) => a.kind === "table") as Artifact;
    cleanup();

    // Links are per tab (mock store), so check with the same client.
    await renderApp(`/org/${ORG_ID}/drive?artifact=${table.id}`, { api: first.api });
    await settle(8);
    expect(screen().getByRole("dialog", { name: "Pedidos mais comuns nos reviews" })).toBeTruthy();
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
