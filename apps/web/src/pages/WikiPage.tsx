import { Button, EmptyState, Icon, Kbd, SearchField } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import { useWikiReads, useWikiTree } from "@/api/queries";
import type { WikiPageSummary } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { WikiGraphView } from "@/components/WikiGraph";
import { ObsidianMark } from "@/components/wiki/ObsidianMark";
import { useVaultDrop, VaultDropOverlay, WikiImportDialog } from "@/components/wiki/WikiImport";
import { AuthorAvatar, typingIn, WikiReader } from "@/components/wiki/WikiReader";
import { useDirectory } from "@/hooks/useDirectory";
import { relativeTime } from "@/lib/format";
import type { VaultFile } from "@/lib/obsidian";
import { useToast } from "@/lib/toast";
import { type WikiFolder, wikiSlug, wikiTree } from "@/lib/wiki";
import "./wiki.css";

/** The suggested start (Visão geral, Processos/Como trabalhamos, Glossário), in the UI language. */
export function starterPages(t: TFunction) {
  const overview = t("wiki.starterPages.overview");
  const how = t("wiki.starterPages.howWeWork");
  const glossary = t("wiki.starterPages.glossary");
  return [
    {
      title: overview,
      folder: "",
      body: `# ${overview}\n\n${t("wiki.starterPages.overviewBody")}\n\n- [[${how}]]\n- [[${glossary}]]\n`,
    },
    {
      title: how,
      folder: t("wiki.starterPages.processes"),
      body: `# ${how}\n\n${t("wiki.starterPages.howWeWorkBody")}\n`,
    },
    { title: glossary, folder: "", body: `# ${glossary}\n\n${t("wiki.starterPages.glossaryBody")}\n` },
  ];
}

/** Imported in the last day and not edited since: marked "novo" in the tree. */
const isFresh = (p: WikiPageSummary) =>
  p.sourceType === "obsidian" && (p.version ?? 1) === 1 && Date.now() - Date.parse(p.updatedAt) < 86_400_000;

type View = "home" | "graph";

/**
 * The org wiki (prototype: docs/design/telas/Wiki.html): pages on the left
 * (pinned, folders, tags, Obsidian import); the home, a page or the graph in
 * the middle. A vault dropped anywhere opens the import.
 */
export function WikiPage({ slug, newTitle }: { slug?: string; newTitle?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const tree = useWikiTree(org.id);
  const pages = tree.data ?? [];
  const [view, setView] = useState<View>("home");
  const [writing, setWriting] = useState<{ title: string; folder: string } | null>(null);
  const [importing, setImporting] = useState<{ files?: Promise<VaultFile[]> } | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const current = pages.find((p) => p.slug === slug);

  useEffect(() => {
    if (newTitle === undefined) return;
    const parts = newTitle.split("/");
    setWriting({ title: parts.pop()?.trim() ?? "", folder: parts.join("/") });
  }, [newTitle]);
  useEffect(() => {
    setNavOpen(false);
    if (slug) {
      setView("home");
      setWriting(null);
    }
  }, [slug]);

  const startNew = (title = "", folder = current?.folder ?? "") => {
    setWriting({ title, folder });
    setNavOpen(false);
  };
  // N: a new page (when not typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "n" || e.metaKey || e.ctrlKey || e.altKey || typingIn(document.activeElement)) return;
      if (writing || importing) return;
      e.preventDefault();
      startNew();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const drop = useVaultDrop((files) => setImporting({ files }), importing === null && writing === null);

  let center: ReactNode;
  if (tree.isError && !tree.data) center = <ErrorState error={tree.error} onRetry={() => void tree.refetch()} />;
  else if (writing)
    center = (
      <WikiReader
        key={`new:${writing.title}`}
        initial={writing}
        pages={pages}
        onCreate={startNew}
        onDiscard={() => setWriting(null)}
        onTag={setTag}
      />
    );
  else if (view === "graph") center = <WikiGraphView onOpen={() => setView("home")} />;
  else if (slug) center = <WikiReader key={slug} slug={slug} pages={pages} onCreate={startNew} onTag={setTag} />;
  else if (tree.isLoading) center = <LoadingCards count={4} />;
  else if (pages.length === 0)
    center = <WikiEmpty onNew={() => startNew()} onImport={() => setImporting({})} onNav={() => setNavOpen(true)} />;
  else
    center = (
      <WikiHome
        pages={pages}
        onNew={() => startNew()}
        onImport={() => setImporting({})}
        onGraph={() => setView("graph")}
        onNav={() => setNavOpen(true)}
      />
    );

  return (
    <div className="wiki" {...drop.props}>
      <WikiNav
        pages={pages}
        loading={tree.isLoading}
        current={writing ? undefined : slug}
        view={writing ? null : view}
        open={navOpen}
        tag={tag}
        onTag={setTag}
        onHome={() => {
          setView("home");
          setWriting(null);
        }}
        onGraph={() => {
          setView("graph");
          setWriting(null);
          setNavOpen(false);
        }}
        onNew={() => startNew()}
        onImport={() => setImporting({})}
        onClose={() => setNavOpen(false)}
      />
      {navOpen && (
        <button
          type="button"
          className="wiki__scrim"
          aria-hidden="true"
          tabIndex={-1}
          onClick={() => setNavOpen(false)}
        />
      )}
      <div className="wiki__center">
        {(slug || writing || view === "graph") && (
          <Button size="sm" variant="ghost" icon="menu" className="wiki__navbtn" onClick={() => setNavOpen(true)}>
            {t("wiki.tree")}
          </Button>
        )}
        {center}
      </div>
      {drop.over && <VaultDropOverlay />}
      {importing && <WikiImportDialog files={importing.files} onClose={() => setImporting(null)} />}
    </div>
  );
}

/** Left pane: search, home and graph, pinned pages, the folder tree, tags, Obsidian import. */
function WikiNav({
  pages,
  loading,
  current,
  view,
  open,
  tag,
  onTag,
  onHome,
  onGraph,
  onNew,
  onImport,
  onClose,
}: {
  pages: WikiPageSummary[];
  loading: boolean;
  current?: string;
  view: View | null;
  open: boolean;
  tag: string | null;
  onTag: (tag: string | null) => void;
  onHome: () => void;
  onGraph: () => void;
  onNew: () => void;
  onImport: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const query = q.trim().toLowerCase();
  const filtering = Boolean(query || tag);
  const shown = useMemo(
    () =>
      pages.filter(
        (p) =>
          (!query || `${p.title} ${p.folder} ${p.excerpt ?? ""}`.toLowerCase().includes(query)) &&
          (!tag || p.tags.includes(tag)),
      ),
    [pages, query, tag],
  );
  const root = useMemo(() => wikiTree(shown), [shown]);
  const tags = useMemo(() => [...new Set(pages.flatMap((p) => p.tags))].sort(), [pages]);
  const pinned = pages.filter((p) => p.pinned);
  const count = (f: WikiFolder<WikiPageSummary>): number =>
    f.pages.length + f.folders.reduce((n, sub) => n + count(sub), 0);

  const PageRow = ({ p }: { p: WikiPageSummary }) => (
    <Link
      to="/org/$orgId/wiki/$slug"
      params={{ orgId: org.id, slug: p.slug }}
      className="wiki-row"
      aria-current={p.slug === current ? "page" : undefined}
      onClick={onClose}
    >
      <Icon name={p.locked ? "lock" : "document"} size={14} />
      <span className="wiki-row__t">{p.title}</span>
      {isFresh(p) && <span className="wiki-row__new">{t("wiki.fresh")}</span>}
    </Link>
  );
  const Folder = ({ f }: { f: WikiFolder<WikiPageSummary> }) => {
    const isOpen = filtering || !closed.has(f.path);
    return (
      <>
        <button
          type="button"
          className="wiki-row wiki-row--folder"
          aria-expanded={isOpen}
          onClick={() => {
            const next = new Set(closed);
            if (next.has(f.path)) next.delete(f.path);
            else next.add(f.path);
            setClosed(next);
          }}
        >
          <Icon name="chevronDown" size={14} className="wiki-row__car" />
          <Icon name="drive" size={14} />
          <span className="wiki-row__t">{f.name}</span>
          <span className="wiki-row__n">{count(f)}</span>
        </button>
        {isOpen && (
          <div className="wiki-sub">
            {f.folders.map((sub) => (
              <Folder key={sub.path} f={sub} />
            ))}
            {f.pages.map((p) => (
              <PageRow key={p.slug} p={p} />
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <aside className="wiki-nav" data-open={open || undefined} aria-label={t("wiki.nav")}>
      <div className="wiki-nav__head">
        <b>{t("wiki.title")}</b>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="plus"
          aria-label={t("wiki.new")}
          title={`${t("wiki.new")} (N)`}
          onClick={onNew}
        />
      </div>
      <SearchField
        size="sm"
        aria-label={t("wiki.search")}
        placeholder={t("wiki.searchPlaceholder")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onClear={() => setQ("")}
        clearLabel={t("filters.clearSearch")}
      />
      <div className="wiki-nav__list">
        <button
          type="button"
          className="wiki-row"
          aria-current={view === "home" && !current ? "page" : undefined}
          onClick={onHome}
        >
          <Icon name="book" size={14} />
          <span className="wiki-row__t">{t("wiki.home")}</span>
        </button>
        <button
          type="button"
          className="wiki-row"
          aria-current={view === "graph" ? "page" : undefined}
          onClick={onGraph}
        >
          <Icon name="diagram" size={14} />
          <span className="wiki-row__t">{t("wiki.graph")}</span>
          <span className="wiki-row__n">{pages.length}</span>
        </button>
      </div>
      {!filtering && pinned.length > 0 && (
        <section className="wiki-nav__section" aria-label={t("wiki.pinnedPages")}>
          <span className="wiki-label">{t("wiki.pinnedPages")}</span>
          <div className="wiki-nav__list">
            {pinned.map((p) => (
              <PageRow key={p.slug} p={p} />
            ))}
          </div>
        </section>
      )}
      <nav className="wiki-nav__section" aria-label={t("wiki.tree")}>
        <span className="wiki-label">{filtering ? t("wiki.results", { count: shown.length }) : t("wiki.tree")}</span>
        {loading ? (
          <LoadingList count={5} avatar={false} />
        ) : (
          <div className="wiki-nav__list">
            {root.folders.map((f) => (
              <Folder key={f.path} f={f} />
            ))}
            {root.pages.map((p) => (
              <PageRow key={p.slug} p={p} />
            ))}
            {shown.length === 0 && <p className="small muted wiki-nav__empty">{t("wiki.noMatch")}</p>}
          </div>
        )}
      </nav>
      {tags.length > 0 && (
        <section className="wiki-nav__section" aria-label={t("wiki.tags")}>
          <span className="wiki-label">{t("wiki.tags")}</span>
          <div className="wiki-tags">
            {tags.map((tg) => (
              <button
                key={tg}
                type="button"
                className="wiki-tag"
                aria-pressed={tag === tg}
                onClick={() => onTag(tag === tg ? null : tg)}
              >
                #{tg}
              </button>
            ))}
          </div>
        </section>
      )}
      <button type="button" className="wiki-import-card" onClick={onImport}>
        <ObsidianMark size={20} />
        <span>
          <b>{t("wiki.import.cta")}</b>
          <small>{t("wiki.import.ctaText")}</small>
        </span>
      </button>
    </aside>
  );
}

function HomeHead({ onNew, onImport, onNav }: { onNew: () => void; onImport: () => void; onNav: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <header className="wiki-home__head">
      <div>
        <h1 className="wiki-home__title">{t("wiki.homeTitle", { org: org.name })}</h1>
        <p className="muted">{t("wiki.subtitle")}</p>
      </div>
      <div className="wiki-home__acts">
        <Button size="sm" variant="ghost" icon="menu" className="wiki__navbtn" onClick={onNav}>
          {t("wiki.tree")}
        </Button>
        <Button size="sm" onClick={onImport}>
          <ObsidianMark size={16} />
          {t("wiki.import.short")}
        </Button>
        <Button size="sm" variant="primary" icon="plus" onClick={onNew}>
          {t("wiki.new")}
          <Kbd>N</Kbd>
        </Button>
      </div>
    </header>
  );
}

/** The home: recently edited pages, what the agents read most, folders and the graph. */
function WikiHome({
  pages,
  onNew,
  onImport,
  onGraph,
  onNav,
}: {
  pages: WikiPageSummary[];
  onNew: () => void;
  onImport: () => void;
  onGraph: () => void;
  onNav: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const reads = useWikiReads(org.id);
  const recent = [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const top = (reads.data ?? []).slice(0, 5);
  const max = top[0]?.total ?? 1;
  const tops = wikiTree(pages).folders;
  const count = (f: WikiFolder<WikiPageSummary>): number =>
    f.pages.length + f.folders.reduce((n, sub) => n + count(sub), 0);
  const name = (a: WikiPageSummary["updatedBy"]) =>
    a.type === "agent" ? (dir.agentById.get(a.id)?.name ?? "") : (dir.memberById.get(a.id)?.name ?? "");
  return (
    <div className="wiki-home">
      <HomeHead onNew={onNew} onImport={onImport} onNav={onNav} />
      <section className="wiki-home__sec" aria-label={t("wiki.recent")}>
        <h2 className="wiki-home__h">{t("wiki.recent")}</h2>
        <div className="wiki-cards">
          {recent.map((p) => (
            <Link
              key={p.slug}
              to="/org/$orgId/wiki/$slug"
              params={{ orgId: org.id, slug: p.slug }}
              className="wiki-card"
            >
              <span className="wiki-card__where">
                <Icon name={p.locked ? "lock" : "drive"} size={14} />
                {p.folder || t("wiki.root")}
              </span>
              {p.sourceType === "obsidian" && (
                <span className="wiki-card__src">
                  <ObsidianMark size={14} />
                  {t("wiki.legend.obsidian")}
                </span>
              )}
              <b className="wiki-card__title">{p.title}</b>
              {p.excerpt && <span className="wiki-card__text">{p.excerpt}</span>}
              <span className="wiki-card__by">
                <AuthorAvatar a={p.updatedBy} />
                <span>
                  <b>{name(p.updatedBy)}</b>
                  {p.updatedBy.onBehalfOf
                    ? ` ${t("wiki.atRequestOf")} ${dir.memberById.get(p.updatedBy.onBehalfOf)?.name ?? ""}`
                    : ""}
                  {" · "}
                  {relativeTime(t, i18n.language, p.updatedAt)}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>
      <div className="wiki-home__two">
        <section className="wiki-home__sec" aria-label={t("wiki.topReads")}>
          <h2 className="wiki-home__h">
            {t("wiki.topReads")} <span className="wiki-label__n">{t("wiki.last7Days")}</span>
          </h2>
          <div className="wiki-panel">
            {reads.isLoading ? (
              <LoadingList count={3} />
            ) : top.length === 0 ? (
              <p className="wiki-panel__empty small muted">{t("wiki.topReadsEmpty")}</p>
            ) : (
              top.map((r) => (
                <Link
                  key={r.slug}
                  to="/org/$orgId/wiki/$slug"
                  params={{ orgId: org.id, slug: r.slug }}
                  className="wiki-read"
                >
                  <span className="wiki-read__crew">
                    {r.agents.slice(0, 3).map((a) => (
                      <AgentAvatar
                        key={a.agentId}
                        agentId={a.agentId}
                        name={dir.agentById.get(a.agentId)?.name ?? ""}
                        size="sm"
                      />
                    ))}
                  </span>
                  <span className="wiki-read__t">
                    <b>{r.title}</b>
                    <small>
                      {r.agents
                        .slice(0, 3)
                        .map((a) => dir.agentById.get(a.agentId)?.name)
                        .filter(Boolean)
                        .join(", ")}
                    </small>
                  </span>
                  <span className="wiki-read__bar" aria-hidden="true">
                    <i style={{ width: `${Math.round((r.total / max) * 100)}%` }} />
                  </span>
                  <span className="dot-num wiki-read__n" title={t("wiki.uses.count", { count: r.total })}>
                    {r.total}
                  </span>
                </Link>
              ))
            )}
          </div>
        </section>
        <section className="wiki-home__sec" aria-label={t("wiki.folders")}>
          <h2 className="wiki-home__h">
            {t("wiki.folders")} <span className="wiki-label__n">{t("wiki.pageCount", { count: pages.length })}</span>
          </h2>
          <div className="wiki-panel">
            {tops.length > 0 && (
              <div className="wiki-folders">
                {tops.map((f) => (
                  <div key={f.path} className="wiki-folder">
                    <span className="wiki-folder__icon">
                      <Icon name="drive" size={16} />
                    </span>
                    <span>
                      <b>{f.name}</b>
                      <small>{t("wiki.pageCount", { count: count(f) })}</small>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="wiki-minigraph" onClick={onGraph} aria-label={t("wiki.openGraph")}>
              <WikiGraphView mini />
              <span className="wiki-minigraph__label">
                <Icon name="diagram" size={14} />
                {t("wiki.openGraph")}
              </span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

/** No pages yet: import a vault, the suggested start, or a blank page. */
function WikiEmpty({ onNew, onImport, onNav }: { onNew: () => void; onImport: () => void; onNav: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <div className="wiki-home">
      <HomeHead onNew={onNew} onImport={onImport} onNav={onNav} />
      <EmptyState
        sky
        icon="book"
        title={t("wiki.emptyTitle")}
        actions={
          <div className="wiki-empty__acts">
            <Button variant="primary" onClick={onImport}>
              <ObsidianMark size={16} />
              {t("wiki.import.cta")}
            </Button>
            <Button
              loading={busy}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  // Straight to the API: the empty state goes away as soon as the first page exists.
                  for (const p of starterPages(t)) {
                    await api.wiki.create(org.id, { title: p.title, folder: p.folder, body: p.body });
                  }
                  void qc.invalidateQueries({ queryKey: keys.wiki(org.id) });
                  toast.show(t("wiki.starterCreated"));
                  void navigate({
                    to: "/org/$orgId/wiki/$slug",
                    params: { orgId: org.id, slug: wikiSlug(t("wiki.starterPages.overview")) },
                  });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("wiki.useStarter")}
            </Button>
            <Button variant="ghost" icon="plus" onClick={onNew}>
              {t("wiki.blankPage")}
            </Button>
          </div>
        }
      >
        {t("wiki.emptyText")}
      </EmptyState>
      <ul className="wiki-starter" aria-label={t("wiki.starter")}>
        {starterPages(t).map((p) => (
          <li key={p.title}>
            <Icon name="document" size={14} />
            {p.folder ? `${p.folder} / ${p.title}` : p.title}
          </li>
        ))}
      </ul>
    </div>
  );
}
