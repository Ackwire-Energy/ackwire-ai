import { describe, expect, test } from "bun:test";
import type { WikiPageSummary } from "@agenteschat/client";
import { isWikiSlug, plainWikiText, RECENT_COUNT, searchWiki, wikiGroups } from "../../src/features/wiki/logic";

const page = (title: string, over: Partial<WikiPageSummary> = {}): WikiPageSummary => ({
  id: title,
  slug: title.toLowerCase().replace(/\s+/g, "-"),
  title,
  folder: "",
  tags: [],
  updatedAt: "2026-10-01T10:00:00.000Z",
  updatedBy: { type: "person", id: "u1" },
  ...over,
});

describe("wiki home", () => {
  test("pinned first, then the root and the folders, pages by title", () => {
    const groups = wikiGroups([
      page("Vendas", { folder: "Processos" }),
      page("Glossário"),
      page("Deploy", { folder: "Processos", pinned: true }),
      page("Visão geral"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["pinned", "folder:", "folder:Processos"]);
    expect(groups[1]?.pages.map((p) => p.title)).toEqual(["Glossário", "Visão geral"]);
    expect(groups[2]?.pages.map((p) => p.title)).toEqual(["Deploy", "Vendas"]);
  });

  test("the latest edits only when the folders don't already show everything", () => {
    const few = Array.from({ length: RECENT_COUNT }, (_, i) => page(`P${i}`));
    expect(wikiGroups(few).some((g) => g.kind === "recent")).toBe(false);
    const many = Array.from({ length: RECENT_COUNT + 2 }, (_, i) =>
      page(`P${i}`, { updatedAt: `2026-10-0${i + 1}T10:00:00.000Z` }),
    );
    const recent = wikiGroups(many).find((g) => g.kind === "recent");
    expect(recent?.pages.length).toBe(RECENT_COUNT);
    expect(recent?.pages[0]?.title).toBe(`P${RECENT_COUNT + 1}`);
  });
});

describe("wiki search", () => {
  const pages = [
    page("Como fazer deploy", { folder: "Engenharia" }),
    page("Onboarding", { excerpt: "Primeiro dia e o deploy de teste" }),
    page("Férias", { tags: ["rh"] }),
  ];

  test("every word, accents and case ignored; title hits first", () => {
    expect(searchWiki(pages, "DEPLOY").map((p) => p.title)).toEqual(["Como fazer deploy", "Onboarding"]);
    expect(searchWiki(pages, "ferias").map((p) => p.title)).toEqual(["Férias"]);
    expect(searchWiki(pages, "rh").map((p) => p.title)).toEqual(["Férias"]);
    expect(searchWiki(pages, "deploy engenharia").map((p) => p.title)).toEqual(["Como fazer deploy"]);
  });

  test("nothing typed is no results", () => {
    expect(searchWiki(pages, "  ")).toEqual([]);
  });
});

describe("wiki text", () => {
  test("links become their labels, embeds their names", () => {
    expect(plainWikiText("Veja [[Deploy]] e [[Processos/Vendas|vendas]].")).toBe("Veja **Deploy** e **vendas**.");
    expect(plainWikiText("Em [[Deploy#Passos]]")).toBe("Em **Deploy**");
    expect(plainWikiText("![[diagrama.png]]")).toBe("_diagrama.png_");
  });

  test("slugs from the route", () => {
    expect(isWikiSlug("processos/onboarding")).toBe(true);
    expect(isWikiSlug("guia-de-deploy")).toBe(true);
    expect(isWikiSlug("")).toBe(false);
    expect(isWikiSlug("a b")).toBe(false);
    expect(isWikiSlug(undefined)).toBe(false);
  });
});
