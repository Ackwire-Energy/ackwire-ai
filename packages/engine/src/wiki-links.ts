import { and, type Executor, eq, inArray, isNull, or, schema, sql } from "@agenteschat/db";

const { wikiPages, wikiLinks } = schema;

/** One `[[…]]` in a text: `[[Title]]`, `[[Folder/Title|text]]`, `[[Page#section]]`. */
export interface WikiLinkRef {
  /** What was written before `|`, e.g. `Processos/Deploy#Rollback`. */
  target: string;
  /** The page part (no section). */
  title: string;
  section: string | null;
  /** What to show (after `|`, else the title). */
  label: string;
  /** The page it points to (the leaf title, slugified). */
  slug: string;
}

/** A resolved link, as messages carry it in `meta.wikiLinks`. */
export interface ResolvedWikiLink {
  target: string;
  label: string;
  section: string | null;
  slug: string;
  /** The page's title when it exists (never for a restricted page: the link shows what was written). */
  title: string | null;
  exists: boolean;
  /** The page is limited to an audience: the app shows a locked link, and opening it says who may not see it. */
  restricted?: true;
}

/**
 * Whether the person `userId` sees a wiki page, as a condition over `wiki_pages` (ADR 0023 addendum): an open page,
 * or a restricted one they own the workspace of, hold one of its audience roles or are named in.
 */
export function wikiPageVisibleSql(userId: string) {
  return sql<boolean>`(not ${wikiPages.restricted} or ${userId} = any(${wikiPages.audienceUserIds})
    or exists (select 1 from organization_members vm
      where vm.org_id = ${wikiPages.orgId} and vm.user_id = ${userId} and vm.role = 'owner')
    or exists (select 1 from organization_member_roles vr
      where vr.org_id = ${wikiPages.orgId} and vr.user_id = ${userId} and vr.role_id = any(${wikiPages.audienceRoleIds})))`;
}

/** Of these page ids, the ones `userId` sees. */
export async function visibleWikiPageIds(db: Executor, userId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(and(inArray(wikiPages.id, [...new Set(ids)]), wikiPageVisibleSql(userId)));
  return new Set(rows.map((r) => r.id));
}

/** "Processos/Guia de Deploy" → "guia-de-deploy" (the folder is not part of it; unique per org). */
export function wikiSlug(title: string) {
  const leaf = title.split("/").pop()?.trim() || title;
  return leaf
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .replace(/-$/, "");
}

/** `[[…]]`, but not an Obsidian embed `![[file.png]]` (an attachment, not a link). */
const LINK = /(?<!!)\[\[([^[\]\n]+)\]\]/g;

/** The `[[…]]` links of a markdown text (code blocks and inline code are skipped), first occurrence of each. */
export function parseWikiLinks(text: string): WikiLinkRef[] {
  if (!text.includes("[[")) return [];
  const clean = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out: WikiLinkRef[] = [];
  const seen = new Set<string>();
  for (const m of clean.matchAll(LINK)) {
    const inner = m[1] ?? "";
    const bar = inner.indexOf("|");
    const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
    const hash = target.indexOf("#");
    const title = (hash >= 0 ? target.slice(0, hash) : target).trim();
    const section = hash >= 0 ? target.slice(hash + 1).trim() || null : null;
    const label = (bar >= 0 ? inner.slice(bar + 1) : "").trim() || title;
    const slug = wikiSlug(title);
    if (!slug || seen.has(`${slug}#${section ?? ""}`)) continue;
    seen.add(`${slug}#${section ?? ""}`);
    out.push({ target, title, section, label, slug });
    if (out.length >= 100) break;
  }
  return out;
}

/** Live pages for these slugs (current slug or an earlier one), by requested slug. */
export async function pagesBySlug(db: Executor, orgId: string, slugs: string[]) {
  const wanted = [...new Set(slugs)].filter(Boolean);
  const out = new Map<string, { id: string; slug: string; title: string; restricted: boolean }>();
  if (wanted.length === 0) return out;
  const literal = `{${wanted.map((s) => `"${s}"`).join(",")}}`; // slugs are [a-z0-9-]
  const rows = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      aliases: wikiPages.aliases,
      restricted: wikiPages.restricted,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.orgId, orgId),
        isNull(wikiPages.deletedAt),
        or(inArray(wikiPages.slug, wanted), sql`${wikiPages.aliases} && ${literal}::text[]`),
      ),
    );
  // A current slug wins over another page's old one.
  for (const r of rows) for (const a of r.aliases) if (wanted.includes(a) && !out.has(a)) out.set(a, r);
  for (const r of rows) if (wanted.includes(r.slug)) out.set(r.slug, r);
  return out;
}

/** Resolves written link targets (`Title`, `Folder/Title#section`) against the org's pages. */
export async function resolveWikiTargets(db: Executor, orgId: string, refs: WikiLinkRef[]) {
  const pages = await pagesBySlug(
    db,
    orgId,
    refs.map((r) => r.slug),
  );
  return refs.map((r) => resolved(r, pages));
}

function resolved(
  r: WikiLinkRef,
  pages: Map<string, { slug: string; title: string; restricted: boolean }>,
): ResolvedWikiLink {
  const page = pages.get(r.slug);
  if (page?.restricted)
    return {
      target: r.target,
      label: r.label,
      section: r.section,
      slug: r.slug,
      title: null,
      exists: true,
      restricted: true,
    };
  return {
    target: r.target,
    label: r.label,
    section: r.section,
    slug: page?.slug ?? r.slug,
    title: page?.title ?? null,
    exists: Boolean(page),
  };
}

/**
 * Replaces the links recorded for one source (a page, a message, an issue)
 * with the ones in `text`. Targets that don't exist yet are kept with no
 * page, and resolve when the page is created.
 */
export async function syncWikiLinks(
  db: Executor,
  orgId: string,
  from: { type: "page" | "message" | "issue"; id: string; channelId?: string | null },
  text: string,
) {
  const refs = parseWikiLinks(text);
  const slugs = [...new Set(refs.map((r) => r.slug))];
  await db.delete(wikiLinks).where(and(eq(wikiLinks.fromType, from.type), eq(wikiLinks.fromId, from.id)));
  if (slugs.length === 0) return;
  const pages = await pagesBySlug(db, orgId, slugs);
  await db
    .insert(wikiLinks)
    .values(
      slugs.map((slug) => ({
        orgId,
        fromType: from.type,
        fromId: from.id,
        fromPageId: from.type === "page" ? from.id : null,
        channelId: from.channelId ?? null,
        toSlug: slug,
        toPageId: pages.get(slug)?.id ?? null,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Adds `meta.wikiLinks` (target, label, slug, title, exists) to messages that
 * contain `[[…]]`, resolved now (a page created later shows as existing).
 * Messages without links cost nothing.
 */
export async function withWikiLinks<T extends { body: string; meta: Record<string, unknown> }>(
  db: Executor,
  orgId: string,
  list: T[],
): Promise<T[]> {
  const parsed = list.map((m) => parseWikiLinks(m.body));
  if (parsed.every((p) => p.length === 0)) return list;
  const pages = await pagesBySlug(
    db,
    orgId,
    parsed.flat().map((r) => r.slug),
  );
  return list.map((m, i) => {
    const refs = parsed[i] ?? [];
    if (refs.length === 0) return m;
    const wikiLinks = refs.map((r) => resolved(r, pages));
    return { ...m, meta: { ...m.meta, wikiLinks } };
  });
}
