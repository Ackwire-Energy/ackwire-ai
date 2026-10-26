import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  HELP_PAGES,
  type HelpBlock,
  type HelpDocument,
  type HelpSlug,
  helpDocument,
  helpInline,
  isHelpSlug,
} from "../src/help";
import { en, ptBR } from "../src/index";
import { bannedIn, CLOUD_BANNED, SELFHOST_BANNED, TECHNICAL } from "./edition-words";
import { MAKER_WORDS, sourceFiles, withoutComments } from "./maker-words";

const REPO = join(import.meta.dir, "..", "..", "..");
const SLUGS = Object.keys(HELP_PAGES) as HelpSlug[];
const LOCALES = ["pt-BR", "en"] as const;

const blockLines = (b: HelpBlock): string[] => (typeof b === "string" ? [b] : "list" in b ? b.list : [b.code]);
/** Every line a page shows: title, summary, headings, paragraphs, list items and commands. */
const linesOf = (doc: HelpDocument) => [
  doc.title,
  doc.summary,
  ...doc.sections.flatMap((s) => [s.heading, ...s.blocks.flatMap(blockLines)]),
];
const pages = () =>
  SLUGS.flatMap((slug) => LOCALES.map((locale) => ({ slug, locale, doc: helpDocument(slug, locale) })));

describe("help pages", () => {
  test("every page in both languages, with the same sections in the same order and blocks of the same shape", () => {
    expect(SLUGS.length).toBe(7);
    for (const slug of SLUGS) {
      const pt = helpDocument(slug, "pt-BR");
      const english = helpDocument(slug, "en");
      expect(pt).not.toBe(english);
      expect(english.sections.map((s) => s.id)).toEqual(pt.sections.map((s) => s.id));
      expect(new Set(pt.sections.map((s) => s.id)).size).toBe(pt.sections.length);
      const shape = (b: HelpBlock) => (typeof b === "string" ? "p" : "list" in b ? `list:${b.list.length}` : "code");
      expect(english.sections.map((s) => s.blocks.map(shape))).toEqual(pt.sections.map((s) => s.blocks.map(shape)));
    }
    expect(helpDocument("memory", "en-GB")).toBe(helpDocument("memory", "en"));
    expect(isHelpSlug("memory")).toBe(true);
    expect(isHelpSlug("toString")).toBe(false);
  });

  test("no empty block, and no markup left over once a line is split", () => {
    for (const { slug, locale, doc } of pages()) {
      for (const s of doc.sections)
        expect({ slug, locale, id: s.id, blocks: s.blocks.length > 0 }).toMatchObject({ blocks: true });
      for (const line of linesOf(doc)) {
        expect({ slug, locale, line, empty: line.trim() === "" }).toMatchObject({ empty: false });
        // An unpaired ** would bold the rest of the line.
        const stars = line.replace(/`[^`]+`/g, "").split("**").length - 1;
        expect({ slug, locale, line, paired: stars % 2 === 0 }).toMatchObject({ paired: true });
        for (const piece of helpInline(line)) {
          const left = piece.text.includes("**") || piece.text.includes("`") || piece.text.includes("](");
          expect({ slug, locale, piece: piece.text, left }).toMatchObject({ left: false });
        }
      }
    }
  });

  test("Claude, never its maker; a Cloud page keeps to the Cloud's words; no page says the cloud", () => {
    const maker = new RegExp(MAKER_WORDS.source, "i");
    for (const { slug, locale, doc } of pages()) {
      const text = linesOf(doc).join("\n");
      expect({ slug, locale, maker: maker.test(text) }).toMatchObject({ maker: false });
      expect({ slug, locale, words: bannedIn(text, SELFHOST_BANNED) }).toMatchObject({ words: [] });
      if (HELP_PAGES[slug] !== "cloud") continue;
      expect({ slug, locale, words: bannedIn(text, CLOUD_BANNED[locale]) }).toMatchObject({ words: [] });
      expect({ slug, locale, technical: text.match(TECHNICAL)?.[0] ?? null }).toMatchObject({ technical: null });
    }
    expect(Object.values(HELP_PAGES)).toContain("cloud");
  });

  test("a path through the menus stays on one line: no-break spaces around its ›", () => {
    let paths = 0;
    for (const { doc } of pages())
      for (const line of linesOf(doc).filter((l) => l.includes("›"))) {
        paths++;
        expect({ line, alone: line.split("\u00a0›\u00a0").join("").includes("›") }).toEqual({ line, alone: false });
      }
    expect(paths).toBeGreaterThan(0);
  });

  test("a link to another help page lands on a page and a section that exist", () => {
    for (const { doc } of pages())
      for (const line of linesOf(doc))
        for (const piece of helpInline(line)) {
          if (piece.kind !== "link" || !piece.href.startsWith("/help/")) continue;
          const [slug = "", id] = piece.href.slice("/help/".length).split("#");
          expect({ href: piece.href, page: isHelpSlug(slug) }).toEqual({ href: piece.href, page: true });
          const ids = isHelpSlug(slug) ? helpDocument(slug, "en").sections.map((s) => s.id) : [];
          if (id) expect(ids).toContain(id);
        }
  });

  test("the repository is linked only once the install page is listed: the two go public together", () => {
    if ("install-on-a-server" in HELP_PAGES) return;
    for (const { slug, locale, doc } of pages())
      expect({ slug, locale, github: linesOf(doc).some((l) => l.includes("github.com")) }).toMatchObject({
        github: false,
      });
  });
});

/** The help pages the apps link to, as `[slug, section]`: `helpUrl("<slug>", …, "<section>")` and `<HelpLink …>`. */
function linksIn(source: string): [string, string | undefined][] {
  const calls = [...source.matchAll(/helpUrl\(\s*"([^"]+)"(?:\s*,[^,)]*,\s*"([^"]+)")?/g)].map(
    (m) => [m[1] ?? "", m[2]] as [string, string | undefined],
  );
  const tags = [...source.matchAll(/<HelpLink\b([^>]*)>/g)].map((m) => {
    const attrs = m[1] ?? "";
    return [/\bslug="([^"]+)"/.exec(attrs)?.[1] ?? "", /\bsection="([^"]+)"/.exec(attrs)?.[1]] as [
      string,
      string | undefined,
    ];
  });
  return [...calls, ...tags];
}

describe("links to the help pages", () => {
  test("are read from a call or a tag, with or without a section", () => {
    expect(linksIn('host.openExternal(helpUrl("run-on-your-computer", i18n.language, "who"))')).toEqual([
      ["run-on-your-computer", "who"],
    ]);
    expect(linksIn('Linking.openURL(helpUrl("memory", locale))')).toEqual([["memory", undefined]]);
    expect(linksIn('<HelpLink slug="import" section="other-apps">{t("x")}</HelpLink>')).toEqual([
      ["import", "other-apps"],
    ]);
    expect(linksIn('<HelpLink\n  slug="wiki"\n>')).toEqual([["wiki", undefined]]);
  });

  test("every app links only to pages and sections that exist", () => {
    const apps = readdirSync(join(REPO, "apps"))
      .map((app) => join(REPO, "apps", app, "src"))
      .filter((dir) => existsSync(dir));
    const wrong: string[] = [];
    for (const file of apps.flatMap((dir) => sourceFiles(dir, /\.tsx?$/)))
      for (const [slug, section] of linksIn(withoutComments(readFileSync(file, "utf8")))) {
        const ids = isHelpSlug(slug) ? helpDocument(slug, "en").sections.map((s) => s.id) : null;
        if (!ids || (section && !ids.includes(section))) wrong.push(`${relative(REPO, file)}: ${slug}#${section}`);
      }
    expect(wrong).toEqual([]);
  });
});

describe("the ⓘ's name", () => {
  test("names the label it explains, in both languages", () => {
    expect(en.common.about).toBe("About {{label}}");
    expect(ptBR.common.about).toBe("Sobre {{label}}");
  });
});
