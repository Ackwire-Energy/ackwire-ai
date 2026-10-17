import { headingId, parseMarkdown, wikiLinksIn } from "./markdown";

/** "Guia de deploy" → "guia-de-deploy" (unique in the org, like the backend; the folder isn't in it). */
export const wikiSlug = (title: string) =>
  leafTitle(title)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** `Página#seção` → { title: "Página", section: "seção" }. */
export function splitSection(title: string) {
  const at = title.indexOf("#");
  return at < 0 ? { title, section: null } : { title: title.slice(0, at).trim(), section: title.slice(at + 1).trim() };
}

/** The last part of a path title: "Processos/Deploy" → "Deploy". */
export function leafTitle(title: string) {
  return title.split("/").pop()?.trim() || title;
}

/** Resolves a `[[link]]` title against the pages: by title (case and accents ignored) or by slug. */
export function resolveWikiLink<T extends { slug: string; title: string; folder: string }>(
  pages: T[],
  title: string,
): T | undefined {
  const fold = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  const want = fold(splitSection(title).title);
  const slug = wikiSlug(splitSection(title).title);
  return (
    pages.find((p) => fold(p.title) === want) ??
    pages.find((p) => fold(p.folder ? `${p.folder}/${p.title}` : p.title) === want) ??
    pages.find((p) => p.slug === slug)
  );
}

export { wikiLinksIn };

/** The outline: headings with their anchor ids. */
export const outlineOf = (body: string) =>
  parseMarkdown(body)
    .filter((b): b is { type: "heading"; level: number; text: string } => b.type === "heading")
    .map((b) => ({ level: b.level, text: b.text, id: `h-${headingId(b.text)}` }));

/** Folders as a tree: { name, path, folders, pages }. */
export interface WikiFolder<T> {
  name: string;
  path: string;
  folders: WikiFolder<T>[];
  pages: T[];
}

export function wikiTree<T extends { folder: string; title: string }>(pages: T[]): WikiFolder<T> {
  const root: WikiFolder<T> = { name: "", path: "", folders: [], pages: [] };
  for (const p of pages) {
    let node = root;
    for (const part of p.folder.split("/").filter(Boolean)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path, folders: [], pages: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.pages.push(p);
  }
  const sort = (f: WikiFolder<T>) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.pages.sort((a, b) => a.title.localeCompare(b.title));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}
