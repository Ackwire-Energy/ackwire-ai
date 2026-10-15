import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type { WikiGraph } from "@/api/types";
import { prefixLines, wikiQuery, wrapSelection } from "@/components/WikiEditor";
import { layoutGraph, neighborsOf } from "@/components/WikiGraph";
import { headingId, Markdown, parseWikiToken, wikiLinksIn } from "@/lib/markdown";
import { outlineOf, resolveWikiLink, splitSection, wikiSlug, wikiTree } from "@/lib/wiki";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) =>
  act(async () =>
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } }),
  );
const go = async (path: string, state = seedState(), seed = true) => {
  const api = createFakeApi(state, { seed });
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(8);
  return { ...r, state, api };
};

describe("wiki rules", () => {
  test("links, slugs, sections, outline, tree", () => {
    expect(parseWikiToken("[[Processos/Deploy|o deploy]]")).toEqual({ title: "Processos/Deploy", label: "o deploy" });
    expect(wikiLinksIn("ver [[Deploy]] e [[Glossário#PR]] e [[Deploy]]")).toEqual(["Deploy", "Glossário#PR"]);
    expect(wikiSlug("Guia de Deploy")).toBe("guia-de-deploy");
    expect(wikiSlug("Processos/Férias")).toBe("ferias");
    expect(splitSection("Glossário#PR")).toEqual({ title: "Glossário", section: "PR" });
    const pages = [
      { slug: "deploy", title: "Deploy", folder: "Processos" },
      { slug: "glossario", title: "Glossário", folder: "" },
    ];
    expect(resolveWikiLink(pages, "glossario")?.slug).toBe("glossario");
    expect(resolveWikiLink(pages, "Processos/Deploy")?.slug).toBe("deploy");
    expect(resolveWikiLink(pages, "Glossário#PR")?.slug).toBe("glossario");
    expect(resolveWikiLink(pages, "Nada")).toBeUndefined();
    expect(outlineOf("# A\n\n## Como pedimos acesso\n\ntexto")).toEqual([
      { level: 1, text: "A", id: "h-a" },
      { level: 2, text: "Como pedimos acesso", id: "h-como-pedimos-acesso" },
    ]);
    expect(headingId("Ação rápida!")).toBe("acao-rapida");
    const tree = wikiTree([
      { title: "B", folder: "Processos/Vendas" },
      { title: "A", folder: "" },
      { title: "C", folder: "Processos" },
    ]);
    expect(tree.pages.map((p) => p.title)).toEqual(["A"]);
    expect(tree.folders[0]?.name).toBe("Processos");
    expect(tree.folders[0]?.folders[0]?.name).toBe("Vendas");
  });

  test("editor helpers: [[ query, wrap, line prefixes", () => {
    expect(wikiQuery("veja [[Dep", 10)).toEqual({ start: 5, query: "Dep" });
    expect(wikiQuery("veja [[Dep]] ok", 15)).toBeNull();
    expect(wrapSelection("oi mundo", 3, 8, "**")).toEqual({ text: "oi **mundo**", start: 5, end: 10 });
    expect(prefixLines("a\nb", 0, 3, "- ").text).toBe("- a\n- b");
  });

  test("markdown: tasks, callouts, wiki links", () => {
    const { container } = render(
      <Markdown source={"- [x] feito\n- [ ] falta\n\n> [!warning] Cuidado\n\nVer [[Deploy]]"} />,
    );
    expect(container.querySelectorAll(".md__task")).toHaveLength(2);
    expect(container.querySelector(".md__task[data-done]")?.textContent).toContain("feito");
    expect(container.querySelector(".md__callout[data-kind='warning']")?.textContent).toBe("Cuidado");
    expect(container.querySelector(".wiki-link")?.textContent).toBe("Deploy");
  });

  test("graph layout: inside the box, the same every time; neighbors both ways", () => {
    const g: WikiGraph = {
      nodes: ["a", "b", "c", "d"].map((s) => ({ slug: s, title: s, folder: "", tags: [] })),
      edges: [
        { from: "a", to: "b" },
        { from: "c", to: "a" },
      ],
    };
    const one = layoutGraph(g);
    expect(one).toEqual(layoutGraph(g));
    for (const p of one) {
      expect(p.x).toBeGreaterThanOrEqual(24);
      expect(p.x).toBeLessThanOrEqual(696);
      expect(p.y).toBeGreaterThanOrEqual(24);
      expect(p.y).toBeLessThanOrEqual(436);
    }
    expect([...neighborsOf(g, "a")].sort()).toEqual(["b", "c"]);
  });
});

describe("the wiki", () => {
  test("sidebar item; tree with folders, search and tags; a page with links, outline, backlinks and authors", async () => {
    await go("wiki/onboarding");
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(within(nav).getByRole("link", { name: "Wiki" }).getAttribute("data-status")).toBe("active");
    const tree = screen().getByRole("navigation", { name: "Páginas" });
    expect(tree.textContent).toContain("Processos");
    expect(within(tree).getByRole("link", { name: "Onboarding" }).getAttribute("aria-current")).toBe("page");
    expect(screen().getByRole("heading", { level: 1, name: "Onboarding" })).toBeTruthy();
    const body = document.querySelector(".wiki-page__body") as HTMLElement;
    expect(within(body).getByRole("link", { name: "Glossário" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/wiki/glossario`,
    );
    // A missing page: dashed, offers to create it.
    const missing = within(body).getByRole("button", { name: "Plano de férias" });
    expect(missing.className).toContain("wiki-link--missing");
    const outline = screen().getByRole("navigation", { name: "Nesta página" });
    expect(
      within(outline)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Onboarding", "Acessos", "Primeira tarefa"]);
    const backlinks = screen().getByRole("region", { name: "Mencionada em" });
    expect(backlinks.textContent).toContain("Visão geral");
    expect(backlinks.textContent).toContain("Deploy");
    expect(backlinks.textContent).toContain("Leiam o [[Onboarding]] antes de segunda.");
    expect(backlinks.textContent).toContain("#131");
    expect(screen().getByRole("region", { name: "Autores" }).textContent).toContain("por Ada, a pedido de Walter");
    // Search filters the tree.
    await type(screen().getByRole("searchbox", { name: "Buscar páginas" }), "glos");
    expect(within(tree).queryByRole("link", { name: "Onboarding" })).toBeNull();
    expect(within(tree).getByRole("link", { name: "Glossário" })).toBeTruthy();
  });

  test("a missing [[link]] → Criar página with the title → the new page", async () => {
    const { router, state } = await go("wiki/onboarding");
    await click(screen().getByRole("button", { name: "Plano de férias" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Nova página" });
    expect((within(dialog).getByLabelText("Título") as HTMLInputElement).value).toBe("Plano de férias");
    await click(within(dialog).getByRole("button", { name: "Criar página" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "wiki.create")?.args[1]).toMatchObject({ title: "Plano de férias" });
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/wiki/plano-de-ferias`);
  });

  test("editing: [[ autocomplete in glass, ⌘S saves with the version", async () => {
    const { state } = await go("wiki/deploy");
    await click(screen().getByRole("button", { name: "Editar" }));
    const box = screen().getByRole("combobox", { name: "Texto de Deploy" }) as HTMLTextAreaElement;
    await type(box, `${box.value}\n\nVeja [[Glos`);
    const list = screen().getByRole("listbox", { name: "Páginas" });
    expect(within(list).getAllByRole("option")[0]?.textContent).toContain("Glossário");
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(box.value.endsWith("Veja [[Glossário]]")).toBe(true);
    await act(async () => fireEvent.keyDown(box, { key: "s", metaKey: true }));
    await settle(6);
    const call = state.calls.find((c) => c.method === "wiki.update");
    expect(call?.args[1]).toBe("deploy");
    expect(call?.args[2]).toMatchObject({ baseVersion: 1 });
    expect(document.body.textContent).toContain("Página salva.");
  });

  test("version conflict: shows the difference and keeps mine on purpose", async () => {
    const { state, api } = await go("wiki/deploy");
    await click(screen().getByRole("button", { name: "Editar" }));
    const box = screen().getByRole("combobox", { name: "Texto de Deploy" }) as HTMLTextAreaElement;
    await type(box, "# Deploy\n\nMinha versão.");
    // Someone else saves first.
    await act(async () => {
      await api.wiki.update(ORG_ID, "deploy", { body: "# Deploy\n\nA versão do João.", baseVersion: 1 });
    });
    await click(screen().getByRole("button", { name: "Salvar" }));
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: "Alguém editou enquanto você escrevia" });
    expect(dialog.textContent).toContain("A versão do João.");
    expect(dialog.textContent).toContain("Minha versão.");
    await click(within(dialog).getByRole("button", { name: "Manter a minha" }));
    await settle(6);
    const saves = state.calls.filter((c) => c.method === "wiki.update").map((c) => c.args[2]);
    expect(saves.at(-1)).toMatchObject({ body: "# Deploy\n\nMinha versão.", baseVersion: 2 });
  });

  test("history with a diff", async () => {
    const { api } = await go("wiki/deploy");
    await act(async () => {
      await api.wiki.update(ORG_ID, "deploy", { body: "# Deploy\n\nSó de segunda a quarta.", baseVersion: 1 });
    });
    await click(screen().getByRole("button", { name: "Histórico" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Histórico de Deploy" });
    await click(within(dialog).getByRole("button", { name: /^v2/ }));
    await settle(4);
    const diff = within(dialog).getByRole("group", { name: "O que mudou na v2" });
    expect(diff.querySelector(".ac-diff__line--add")?.textContent).toContain("Só de segunda a quarta.");
  });

  test("empty wiki: a friendly start with the suggested structure", async () => {
    const { state, router } = await go("wiki", seedState(), false);
    expect(document.body.textContent).toContain("A wiki está vazia");
    expect(screen().getByRole("list", { name: "Estrutura sugerida" }).textContent).toContain("Glossário");
    await click(screen().getByRole("button", { name: "Usar a estrutura sugerida" }));
    await settle(10);
    expect(
      state.calls.filter((c) => c.method === "wiki.create").map((c) => (c.args[1] as { title: string }).title),
    ).toEqual(["Visão geral", "Como trabalhamos", "Glossário"]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/wiki/visao-geral`);
  });

  test("Grafo: nodes are links; hover lights the neighbors", async () => {
    await go("wiki");
    await click(screen().getByRole("button", { name: "Grafo" }));
    await settle(4);
    const graph = screen().getByRole("region", { name: "Grafo" });
    const node = within(graph).getByRole("link", { name: "Onboarding" });
    await act(async () => fireEvent.pointerEnter(node));
    expect(within(graph).getByRole("link", { name: "Glossário" }).hasAttribute("data-lit")).toBe(true);
    expect(within(graph).getByRole("link", { name: "Onboarding" }).hasAttribute("data-lit")).toBe(true);
  });
});

describe("links everywhere", () => {
  test("chat: [[Página]] is a wiki chip; the composer autocompletes [[", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-wiki",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Está no [[Onboarding]].",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    const row = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Está no")) as HTMLElement;
    expect(within(row).getByRole("link", { name: "Onboarding" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/wiki/onboarding`,
    );
    const box = screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
    await type(box, "leia [[Onb");
    const list = screen().getByRole("listbox", { name: "Páginas" });
    expect(within(list).getAllByRole("option")[0]?.textContent).toContain("Onboarding");
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    expect(box.value).toBe("leia [[Onboarding]] ");
  });

  test("Salvar na wiki from an agent's message appends it with the source", async () => {
    const state = seedState();
    await go(`c/${ENG_ID}`, state);
    // The "…" of Ada's reply (in the agent action bar).
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de Ada" });
    const more = within(bar).getByRole("button", { name: "Mais ações da mensagem" });
    more.focus();
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Salvar na wiki" }));
    const dialog = screen().getByRole("dialog", { name: "Salvar na wiki" });
    await click(within(dialog).getByRole("button", { name: /Glossário/ }));
    await settle(6);
    const call = state.calls.find((c) => c.method === "wiki.append");
    expect(call?.args[1]).toBe("glossario");
    expect(call?.args[2]).toMatchObject({ source: { kind: "message", channelId: ENG_ID } });
    expect(call?.args[2]).toMatchObject({ text: expect.stringContaining("de uma mensagem em #eng") });
  });

  test("⌘K lists wiki pages and Nova página", async () => {
    await go("issues");
    await act(async () => fireEvent.keyDown(window, { key: "k", metaKey: true }));
    await settle(4);
    await type(screen().getByRole("combobox", { name: "Ir para, ou pedir a um agente" }), "glossário");
    const list = screen().getByRole("listbox", { name: "Resultados" });
    expect(within(list).getAllByRole("option")[0]?.textContent).toContain("Glossário");
  });
});
