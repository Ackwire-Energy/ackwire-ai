import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type WikiGraph } from "@agenteschat/client";
import {
  outlineOf,
  prefixLines,
  resolveWikiLink,
  splitSection,
  toggleTask,
  wikiQuery,
  wikiSlug,
  wikiTree,
  wrapSelection,
} from "@agenteschat/client/lib/wiki";
import { readZip } from "@agenteschat/client/lib/zip";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { layoutGraph, neighborsOf } from "@/components/WikiGraph";
import { VaultCard } from "@/components/wiki/VaultCard";
import { useVaultReader } from "@/components/wiki/WikiImport";
import { headingId, Markdown, parseWikiToken, wikiLinksIn } from "@/lib/markdown";
import { filesFromList, homeOf, parseNote, readVault, type VaultFile } from "@/lib/obsidian";
import { ADA_ID, ADMIN_ROLE_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) =>
  act(async () =>
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } }),
  );
/** The setup's Context step card, with a reader of its own. */
function SetupVaultCard() {
  return <VaultCard reader={useVaultReader([])} />;
}

const go = async (path: string, state = seedState(), seed = true) => {
  const api = createFakeApi(state, { seed });
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(8);
  return { ...r, state, api };
};

describe("toggleTask", () => {
  test("checks and unchecks one task line, leaves other lines alone", () => {
    const body = "# Passos\n- [ ] Abrir\n- [x] Revisar\nTexto";
    expect(toggleTask(body, 1)).toBe("# Passos\n- [x] Abrir\n- [x] Revisar\nTexto");
    expect(toggleTask(body, 2)).toBe("# Passos\n- [ ] Abrir\n- [ ] Revisar\nTexto");
    expect(toggleTask(body, 3)).toBe(body);
    expect(toggleTask(body, 9)).toBe(body);
  });
});

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
    ).toEqual(["Acessos", "Primeira tarefa"]);
    const backlinks = screen().getByRole("region", { name: "Mencionada em" });
    expect(backlinks.textContent).toContain("Visão geral");
    expect(backlinks.textContent).toContain("Deploy");
    expect(backlinks.textContent).toContain("Leiam o [[Onboarding]] antes de segunda.");
    expect(backlinks.textContent).toContain("#131");
    const aside = screen().getByRole("complementary", { name: "Sobre a página" });
    expect(aside.textContent).toContain("por Ada, a pedido de Walter");
    expect(within(aside).getByRole("region", { name: "Agentes que usam esta página" }).textContent).toContain(
      "Nenhum agente consultou ainda",
    );
    // Search filters the tree.
    await type(screen().getByRole("searchbox", { name: "Buscar páginas" }), "glos");
    expect(within(tree).queryByRole("link", { name: "Onboarding" })).toBeNull();
    expect(within(tree).getByRole("link", { name: "Glossário" })).toBeTruthy();
  });

  test("a missing [[link]] → a new page written in place, with the title → the new page", async () => {
    const { router, state } = await go("wiki/onboarding");
    await click(screen().getByRole("button", { name: "Plano de férias" }));
    await settle(4);
    expect((screen().getByLabelText("Título") as HTMLInputElement).value).toBe("Plano de férias");
    await type(screen().getByRole("combobox", { name: "Texto de Plano de férias" }), "Quem cobre quem.");
    await click(screen().getByRole("button", { name: /^Salvar/ }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "wiki.create")?.args[1]).toMatchObject({ title: "Plano de férias" });
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/wiki/plano-de-ferias`);
  });

  test("editing: [[ autocomplete in glass, ⌘S saves with the version", async () => {
    const { state } = await go("wiki/deploy");
    await click(screen().getByRole("button", { name: /^Editar/ }));
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
    await click(screen().getByRole("button", { name: /^Editar/ }));
    const box = screen().getByRole("combobox", { name: "Texto de Deploy" }) as HTMLTextAreaElement;
    await type(box, "# Deploy\n\nMinha versão.");
    // Someone else saves first.
    await act(async () => {
      await api.wiki.update(ORG_ID, "deploy", { body: "# Deploy\n\nA versão do João.", baseVersion: 1 });
    });
    await click(screen().getByRole("button", { name: /^Salvar/ }));
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: "Alguém editou enquanto você escrevia" });
    expect(dialog.textContent).toContain("A versão do João.");
    expect(dialog.textContent).toContain("Minha versão.");
    await click(within(dialog).getByRole("button", { name: "Manter a minha" }));
    await settle(6);
    const saves = state.calls.filter((c) => c.method === "wiki.update").map((c) => c.args[2]);
    expect(saves.at(-1)).toMatchObject({ body: "# Deploy\n\nMinha versão.", baseVersion: 2 });
  });

  test("Quem vê: limit a page to a role; the page shows Restrita", async () => {
    const { state } = await go("wiki/deploy");
    const more = screen().getByRole("button", { name: "Mais ações" });
    more.focus();
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Quem vê" }));
    const dialog = screen().getByRole("dialog", { name: "Quem vê Deploy" });
    await click(within(dialog).getByRole("radio", { name: /Só os agentes e quem eu escolher/ }));
    await click(within(dialog).getByRole("checkbox", { name: "Admin" }));
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    const call = state.calls.find((c) => c.method === "wiki.audience");
    expect(call?.args.slice(1)).toEqual(["deploy", { roleIds: [ADMIN_ROLE_ID], userIds: [] }]);
    expect(screen().getByText("Restrita")).toBeTruthy();
  });

  test("a page outside your audience: a plain no access", async () => {
    const api = createFakeApi(seedState(), { seed: true });
    api.wiki.get = async () => {
      throw new ApiError(403, "wiki.no_access", "You don't have access to this page");
    };
    await renderApp(`/org/${ORG_ID}/wiki/deploy`, { api });
    await settle(8);
    expect(document.body.textContent).toContain("Você não tem acesso a esta página");
  });

  test("history with a diff", async () => {
    const { api } = await go("wiki/deploy");
    await act(async () => {
      await api.wiki.update(ORG_ID, "deploy", { body: "# Deploy\n\nSó de segunda a quarta.", baseVersion: 1 });
    });
    await click(screen().getByRole("button", { name: /^v1$/ }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Histórico de Deploy" });
    await click(within(dialog).getByRole("button", { name: /v2/ }));
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
    await click(screen().getByRole("button", { name: /^Grafo/ }));
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

/** A tiny .zip with stored (uncompressed) entries: enough for the reader (it doesn't check CRCs). */
function storedZip(files: Record<string, string>) {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => [v & 255, (v >> 8) & 255];
  const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name);
    const d = enc.encode(text);
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0x800),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(d.length),
      ...u32(d.length),
      ...u16(n.length),
      ...u16(0),
    ]);
    parts.push(local, n, d);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0x800),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(d.length),
        ...u32(d.length),
        ...u16(n.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
      ]),
      n,
    );
    offset += local.length + n.length + d.length;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const count = Object.keys(files).length;
  const end = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(count),
    ...u16(count),
    ...u32(size),
    ...u32(offset),
    ...u16(0),
  ]);
  return new Blob([...parts, ...central, end] as BlobPart[]);
}

const vaultFiles = (files: Record<string, string>): VaultFile[] =>
  Object.entries(files).map(([path, text]) => ({
    path,
    size: text.length,
    text: async () => text,
    blob: async () => new Blob([text]),
  }));

describe("Obsidian vaults", () => {
  test("zip: names and contents of stored entries", async () => {
    const entries = await readZip(storedZip({ "Vault/Início.md": "# Oi", "Vault/sub/": "" }));
    expect(entries.map((e) => e.name)).toEqual(["Vault/Início.md"]);
    expect(new TextDecoder().decode(await entries[0]?.read())).toBe("# Oi");
    await expect(readZip(new Blob(["não é zip"]))).rejects.toThrow();
  });

  test("a note: frontmatter tags and aliases, inline tags, links and embeds (code skipped)", () => {
    const n = parseNote(
      "Clientes/Mercado Bom.md",
      "---\ntags: [cliente, Varejo]\naliases:\n  - MB\n---\nVer [[Início]] e [[Clientes/Casa Verde|a Casa]] #vip\n![[foto.png]]\n`[[não]]`",
    );
    expect(n).toMatchObject({
      title: "Mercado Bom",
      folder: "Clientes",
      tags: ["cliente", "varejo", "vip"],
      aliases: ["MB"],
      links: ["Início", "Clientes/Casa Verde"],
      embeds: ["foto.png"],
    });
    expect(n.body.startsWith("Ver")).toBe(true);
  });

  test("reading a vault: the vault's folder is dropped, .obsidian left out, broken links and conflicts found", async () => {
    const report = await readVault(
      vaultFiles({
        "Acme/Início.md": "Veja [[Glossário]], [[Nada]] e ![[foto.png]].\n> [!tip] Dica\n> ok",
        "Acme/Glossário.md": "# Glossário",
        "Acme/Clientes/Bom.md": "```dataview\nLIST\n```",
        "Acme/anexos/foto.png": "png",
        "Acme/.obsidian/app.json": "{}",
        "Acme/Mapa.canvas": "{}",
      }),
      { existing: [{ title: "Glossário" }] },
    );
    expect(report).toMatchObject({
      name: "Acme",
      folders: [
        { name: "Clientes", count: 1 },
        { name: "", count: 2 },
      ],
      broken: ["Nada"],
      conflicts: ["Glossário"],
      embeddedCount: 1,
      dataview: 1,
      callouts: 1,
      canvases: ["Mapa.canvas"],
      skipped: { config: 1, trash: 0, other: 0 },
    });
    await expect(readVault(vaultFiles({ "a.txt": "x" }))).rejects.toThrow();
  });

  test("loose .md files and a .zip both read", async () => {
    const md = await filesFromList([new File(["# A"], "A.md")]);
    expect(md.map((f) => f.path)).toEqual(["A.md"]);
    const zipped = await filesFromList([new File([storedZip({ "V/A.md": "x" })], "vault.zip")]);
    expect(zipped.map((f) => f.path)).toEqual(["V/A.md"]);
    expect(await zipped[0]?.text()).toBe("x");
  });

  test("homeOf: the vault's home note, else the first", () => {
    const p = (title: string) => ({
      id: title,
      slug: title,
      title,
      folder: "",
      tags: [],
      updatedAt: "",
      updatedBy: { type: "person" as const, id: "u" },
    });
    expect(homeOf([p("Glossário"), p("Início")])?.title).toBe("Início");
    expect(homeOf([p("Glossário")])?.title).toBe("Glossário");
  });

  test("markdown: callout title and body; embeds go to the renderer", () => {
    const { container } = render(
      <Markdown
        source={"> [!warning] Atenção\n> Só às terças.\n\n![[foto.png]]\n\nTexto com ![[doc.pdf]] no meio."}
        embed={(target, key, block) => (
          <span key={key} className="emb" data-block={block || undefined}>
            {target}
          </span>
        )}
      />,
    );
    const callout = container.querySelector(".md__callout[data-kind='warning']");
    expect(callout?.querySelector(".md__callout-title")?.textContent).toBe("Atenção");
    expect(callout?.querySelector(".md__callout-body")?.textContent).toBe("Só às terças.");
    expect([...container.querySelectorAll(".emb")].map((e) => [e.textContent, e.hasAttribute("data-block")])).toEqual([
      ["foto.png", true],
      ["doc.pdf", false],
    ]);
    expect(container.textContent).not.toContain("!");
  });

  test("import: pick .md files → review → import sends the notes; done opens the home note", async () => {
    const { state, router } = await go("wiki");
    await click(screen().getByRole("button", { name: /^Importar$/ }));
    const dialog = screen().getByRole("dialog", { name: "Importar do Obsidian" });
    const input = within(dialog).getByLabelText("Escolher .zip ou .md") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: {
          files: [
            new File(["Veja [[Notas]].\n#mapa"], "Início.md"),
            new File(["---\naliases: [N]\n---\nVolta ao [[Início]]"], "Notas.md"),
          ],
        },
      });
    });
    await settle(10);
    await act(() => new Promise((r) => setTimeout(r, 700)));
    await settle(4);
    const review = screen().getByRole("dialog");
    expect(review.textContent).toContain("2 de 2");
    expect(review.textContent).toContain("1 tag do frontmatter e do texto");
    await click(within(review).getByRole("button", { name: "Importar 2 notas" }));
    await settle(10);
    const call = state.calls.find((c) => c.method === "wiki.import");
    expect(call?.args[1]).toMatchObject({
      source: { type: "obsidian" },
      onConflict: "keep_both",
      notes: [
        { title: "Início", tags: ["mapa"] },
        { title: "Notas", aliases: ["N"] },
      ],
    });
    expect(document.body.textContent).toContain("2 páginas na wiki");
    await click(screen().getByRole("button", { name: "Abrir Início" }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/wiki/inicio`);
  });

  test("the setup's card: one line on what it becomes, then what it found, and no mapping (the wiki's import has it)", async () => {
    await renderPage(<SetupVaultCard />, { api: createFakeApi(seedState()) });
    const card = screen().getByRole("region", { name: "Já tem documentação no Obsidian?" });
    expect(card.querySelector(".vault-card__t .small")?.textContent).toBe("Ela vira a wiki do workspace.");
    // The drop zone already says a folder works too: under it, only the way to pick one, said as the import step
    // says it, with its folder icon.
    const folder = within(card).getByRole("button", { name: "Escolher uma pasta" });
    expect(card.querySelector(".vault-drop__area + .ac-btn--ghost")).toBe(folder);
    expect(folder.querySelector("svg")).not.toBeNull();
    await act(async () => {
      fireEvent.change(within(card).getByLabelText("Escolher .zip ou .md"), {
        target: { files: [new File(["Veja [[Notas]].\n#mapa"], "Início.md"), new File(["Volta."], "Notas.md")] },
      });
    });
    await settle(8);
    await act(() => new Promise((r) => setTimeout(r, 700)));
    await settle(4);
    expect(card.textContent).toContain("Pronta");
    expect(card.textContent).toContain("2notas");
    expect(card.querySelector(".vault-notice")?.textContent).toBe("Entra na wiki quando você continuar.");
    expect(card.querySelector(".vault-lines")).toBeNull();
    expect(card.textContent).not.toContain("frontmatter");
  });
});

describe("the wiki's header", () => {
  test("one subtitle line, then one link to how the wiki works", async () => {
    await go("wiki");
    const head = document.querySelector(".wiki-home__head") as HTMLElement;
    expect(head.querySelector("p.muted")?.textContent).toBe("O que a empresa sabe, em páginas ligadas.");
    const how = within(head).getByRole("link", { name: "Como a wiki funciona" });
    expect(how.getAttribute("href")).toBe("https://app.agentes.chat/help/wiki?lang=pt-BR");
    expect(how.getAttribute("target")).toBe("_blank");
    expect(how.getAttribute("rel")).toBe("noopener noreferrer");
    expect(how.className).toBe("ac-link ac-link--muted");
  });
});
