import {
  Avatar,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogFooter,
  Diff,
  diffLines,
  EmptyState,
  Field,
  Icon,
  Input,
  SearchInput,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ApiError } from "@/api/http";
import { keys } from "@/api/keys";
import { useWikiAction, useWikiHistory, useWikiPage, useWikiTree } from "@/api/queries";
import type { WikiAuthor, WikiPage as WikiPageData, WikiPageSummary } from "@/api/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ErrorState, LoadingList, LoadingPage } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { WikiEditor } from "@/components/WikiEditor";
import { WikiGraphView } from "@/components/WikiGraph";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { useDirectory } from "@/hooks/useDirectory";
import { relativeTime, whenAt } from "@/lib/format";
import { Markdown } from "@/lib/markdown";
import { useToast } from "@/lib/toast";
import { leafTitle, outlineOf, type WikiFolder, wikiSlug, wikiTree } from "@/lib/wiki";

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

type Center = "page" | "graph";

/** The org wiki: tree, search, tags and recents on the left; the page; outline, backlinks, info and history on the right. */
export function WikiPage({ slug, newTitle }: { slug?: string; newTitle?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const tree = useWikiTree(org.id);
  const [center, setCenter] = useState<Center>("page");
  const [creating, setCreating] = useState<string | null>(newTitle ?? null);
  useEffect(() => {
    if (newTitle !== undefined) setCreating(newTitle);
  }, [newTitle]);
  const pages = tree.data ?? [];

  return (
    <div className="wiki">
      <aside className="wiki__left" aria-label={t("wiki.nav")}>
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating("")}>
            {t("wiki.new")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={center === "graph"}
            onClick={() => setCenter(center === "graph" ? "page" : "graph")}
          >
            {t("wiki.graph")}
          </Button>
        </div>
        {tree.isLoading ? <LoadingList count={5} avatar={false} /> : <WikiNav pages={pages} current={slug} />}
      </aside>
      <main className="wiki__center">
        {tree.isError && !tree.data ? (
          <ErrorState error={tree.error} onRetry={() => void tree.refetch()} />
        ) : center === "graph" ? (
          <WikiGraphView onOpen={() => setCenter("page")} />
        ) : slug ? (
          <PageView key={slug} slug={slug} pages={pages} onCreate={setCreating} />
        ) : tree.isSuccess && pages.length === 0 ? (
          <WikiEmpty onCreate={() => setCreating("")} />
        ) : tree.isSuccess ? (
          <WikiHome pages={pages} />
        ) : null}
      </main>
      <NewPageDialog initialTitle={creating} pages={pages} onClose={() => setCreating(null)} />
    </div>
  );
}

/** Left pane: search, the folder tree, tags and recent pages. */
function WikiNav({ pages, current }: { pages: WikiPageSummary[]; current?: string }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const query = q.trim().toLowerCase();
  const shown = pages.filter(
    (p) => (!query || `${p.title} ${p.folder}`.toLowerCase().includes(query)) && (!tag || p.tags.includes(tag)),
  );
  const root = useMemo(() => wikiTree(shown), [shown]);
  const tags = [...new Set(pages.flatMap((p) => p.tags))].sort();
  const recent = [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  const PageLink = ({ p }: { p: WikiPageSummary }) => (
    <Link
      to="/org/$orgId/wiki/$slug"
      params={{ orgId: org.id, slug: p.slug }}
      className="wiki-nav__page"
      aria-current={p.slug === current ? "page" : undefined}
    >
      <Icon name="document" size={14} />
      <span>{p.title}</span>
    </Link>
  );
  const Folder = ({ f }: { f: WikiFolder<WikiPageSummary> }) => (
    <details className="wiki-nav__folder" open>
      <summary>
        <Icon name="drive" size={14} />
        {f.name}
      </summary>
      <div className="wiki-nav__children">
        {f.folders.map((sub) => (
          <Folder key={sub.path} f={sub} />
        ))}
        {f.pages.map((p) => (
          <PageLink key={p.slug} p={p} />
        ))}
      </div>
    </details>
  );
  return (
    <>
      <SearchInput
        aria-label={t("wiki.search")}
        placeholder={t("wiki.search")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <nav className="wiki-nav" aria-label={t("wiki.tree")}>
        {root.folders.map((f) => (
          <Folder key={f.path} f={f} />
        ))}
        {root.pages.map((p) => (
          <PageLink key={p.slug} p={p} />
        ))}
        {shown.length === 0 && <p className="small muted">{t("wiki.noMatch")}</p>}
      </nav>
      {tags.length > 0 && (
        <section aria-label={t("wiki.tags")} className="wiki-nav__section">
          <span className="wiki-nav__label">{t("wiki.tags")}</span>
          <div className="wiki-tags">
            {tags.map((tg) => (
              <button
                key={tg}
                type="button"
                className="pill"
                aria-pressed={tag === tg}
                onClick={() => setTag(tag === tg ? null : tg)}
              >
                #{tg}
              </button>
            ))}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section aria-label={t("wiki.recent")} className="wiki-nav__section">
          <span className="wiki-nav__label">{t("wiki.recent")}</span>
          {recent.map((p) => (
            <Link
              key={p.slug}
              to="/org/$orgId/wiki/$slug"
              params={{ orgId: org.id, slug: p.slug }}
              className="wiki-nav__recent"
            >
              <span className="wiki-nav__recent-title">{p.title}</span>
              <span className="wiki-nav__recent-time">{relativeTime(t, i18n.language, p.updatedAt)}</span>
            </Link>
          ))}
        </section>
      )}
    </>
  );
}

/** "Wiki" with no page: a short index of the root pages. */
function WikiHome({ pages }: { pages: WikiPageSummary[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <div className="wiki-page">
      <h1 className="page-title">{t("wiki.title")}</h1>
      <p className="muted">{t("wiki.subtitle")}</p>
      <div className="wiki-home">
        {pages.slice(0, 12).map((p) => (
          <Link
            key={p.slug}
            to="/org/$orgId/wiki/$slug"
            params={{ orgId: org.id, slug: p.slug }}
            className="ac-card ac-card--interactive wiki-home__card"
          >
            <span className="wiki-home__title">{p.title}</span>
            {p.folder && <span className="small muted">{p.folder}</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** No pages yet: a friendly start with the suggested structure. */
function WikiEmpty({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  return (
    <div className="wiki-page">
      <EmptyState
        icon="book"
        title={t("wiki.emptyTitle")}
        actions={
          <div className="row" style={{ gap: 8, justifyContent: "center" }}>
            <Button variant="primary" icon="plus" onClick={onCreate}>
              {t("wiki.createFirst")}
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

/** "Por Theo, a pedido de Walter" / "Por Walter". */
function useAuthorLabel() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (a: WikiAuthor) => {
    const name = a.type === "agent" ? (dir.agentById.get(a.id)?.name ?? "") : (dir.memberById.get(a.id)?.name ?? "");
    const behalf = a.onBehalfOf ? dir.memberById.get(a.onBehalfOf)?.name : undefined;
    return behalf ? t("wiki.byFor", { name, person: behalf }) : t("wiki.by", { name });
  };
}

function AuthorAvatar({ a }: { a: WikiAuthor }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (a.type === "agent") return <AgentAvatar agentId={a.id} name={dir.agentById.get(a.id)?.name ?? ""} size="xs" />;
  const m = dir.memberById.get(a.id);
  return <Avatar size="xs" name={m?.name ?? "?"} imageUrl={m?.image} />;
}

/** One page: reading or editing in the center, outline/backlinks/info/history on the right. */
function PageView({
  slug,
  pages,
  onCreate,
}: {
  slug: string;
  pages: WikiPageSummary[];
  onCreate: (title: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const page = useWikiPage(org.id, slug);
  const action = useWikiAction(org.id);
  const wikiLink = useWikiLinkRenderer();
  const authorLabel = useAuthorLabel();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState<WikiPageData | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  if (page.isLoading) return <LoadingPage rows={4} />;
  if (!page.data) {
    const missing = (page.error as { status?: number } | null)?.status === 404;
    const title = leafTitle(slug.split("/").pop()?.replace(/-/g, " ") ?? slug);
    return missing ? (
      <div className="wiki-page">
        <EmptyState
          icon="book"
          title={t("wiki.missingTitle")}
          actions={
            <Button
              variant="primary"
              icon="plus"
              onClick={() => onCreate(title.charAt(0).toUpperCase() + title.slice(1))}
            >
              {t("wiki.createPage")}
            </Button>
          }
        >
          {t("wiki.missingText")}
        </EmptyState>
      </div>
    ) : (
      <ErrorState error={page.error} onRetry={() => void page.refetch()} />
    );
  }
  const p = page.data;
  const outline = outlineOf(p.body);
  const save = (body: string, baseVersion: number) =>
    action.mutate(
      { type: "update", slug: p.slug, input: { body, baseVersion } },
      {
        onSuccess: () => {
          setEditing(false);
          setConflict(null);
          toast.show(t("wiki.saved"));
        },
        onError: async (e) => {
          if (e instanceof ApiError && e.code === "version_conflict") {
            const latest = await api.wiki.get(org.id, p.slug);
            qc.setQueryData(keys.wikiPage(org.id, p.slug), latest);
            setConflict(latest);
          } else toast.show(e.message, "error");
        },
      },
    );

  return (
    <div className="wiki-body">
      <article className="wiki-page" aria-labelledby="wiki-title">
        <header className="wiki-page__head">
          <div className="stack-4" style={{ gap: 4, flex: 1, minWidth: 0 }}>
            {p.folder && <span className="small muted">{p.folder}</span>}
            <h1 id="wiki-title" className="page-title">
              {p.title}
            </h1>
            {p.tags.length > 0 && (
              <div className="wiki-tags">
                {p.tags.map((tg) => (
                  <Chip key={tg} icon="dash">
                    #{tg}
                  </Chip>
                ))}
              </div>
            )}
          </div>
          {!editing && (
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
                {t("wiki.rename")}
              </Button>
              <Button
                size="sm"
                icon="edit"
                onClick={() => {
                  setDraft(p.body);
                  setEditing(true);
                }}
              >
                {t("wiki.edit")}
              </Button>
            </div>
          )}
        </header>
        {editing ? (
          <>
            <WikiEditor
              value={draft}
              onChange={setDraft}
              onSave={() => save(draft, p.version)}
              pages={pages}
              label={t("wiki.editorLabel", { title: p.title })}
            />
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <Button onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
              <Button
                variant="primary"
                loading={action.isPending}
                disabled={action.isPending || draft === p.body}
                onClick={() => save(draft, p.version)}
              >
                {t("common.save")}
              </Button>
            </div>
          </>
        ) : (
          <div className="wiki-page__body">
            <Markdown source={p.body} wikiLink={wikiLink} />
          </div>
        )}
      </article>
      <aside className="wiki__right" aria-label={t("wiki.aside")}>
        {outline.length > 0 && (
          <nav className="wiki-aside__section" aria-label={t("wiki.outline")}>
            <span className="wiki-nav__label">{t("wiki.outline")}</span>
            {outline.map((h) => (
              <a key={h.id} href={`#${h.id}`} className="wiki-outline__item" data-level={h.level}>
                {h.text}
              </a>
            ))}
          </nav>
        )}
        <section className="wiki-aside__section" aria-label={t("wiki.backlinks")}>
          <span className="wiki-nav__label">{t("wiki.backlinks")}</span>
          {p.backlinks.length === 0 ? (
            <span className="small muted">{t("wiki.noBacklinks")}</span>
          ) : (
            p.backlinks.map((b) =>
              b.kind === "page" ? (
                <Link
                  key={`p:${b.slug}`}
                  to="/org/$orgId/wiki/$slug"
                  params={{ orgId: org.id, slug: b.slug }}
                  className="wiki-backlink"
                >
                  <Icon name="document" size={14} />
                  {b.title}
                </Link>
              ) : b.kind === "message" ? (
                <Link
                  key={`m:${b.messageId}`}
                  to="/org/$orgId/c/$channelId"
                  params={{ orgId: org.id, channelId: b.channelId }}
                  className="wiki-backlink"
                >
                  <Icon name="channel" size={14} />
                  <span className="list-col">
                    <span>#{b.channelName}</span>
                    <span className="small muted">{b.excerpt}</span>
                  </span>
                </Link>
              ) : b.kind === "forum" ? (
                <Link
                  key={`f:${b.topicId}`}
                  to="/org/$orgId/forum/$topicId"
                  params={{ orgId: org.id, topicId: b.topicId }}
                  className="wiki-backlink"
                >
                  <Icon name="message" size={14} />
                  {b.title}
                </Link>
              ) : (
                <Link
                  key={`i:${b.number}`}
                  to="/org/$orgId/issues/$number"
                  params={{ orgId: org.id, number: String(b.number) }}
                  className="wiki-backlink"
                >
                  <Icon name="issues" size={14} />
                  {`#${b.number} ${b.title}`}
                </Link>
              ),
            )
          )}
        </section>
        <section className="wiki-aside__section" aria-label={t("wiki.info")}>
          <span className="wiki-nav__label">{t("wiki.info")}</span>
          {p.authors.map((a) => (
            <span key={`${a.type}:${a.id}`} className="wiki-author">
              <AuthorAvatar a={a} />
              <span className="small">{authorLabel(a)}</span>
            </span>
          ))}
          <span className="small muted">
            {t("wiki.updated", { when: whenAt(t, i18n.language, p.updatedAt), version: p.version })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setHistoryOpen(true)}>
            {t("wiki.history")}
          </Button>
        </section>
      </aside>
      {conflict && (
        <ConflictDialog
          mine={draft}
          theirs={conflict}
          onKeepMine={() => save(draft, conflict.version)}
          onKeepTheirs={() => {
            setConflict(null);
            setEditing(false);
          }}
          onClose={() => setConflict(null)}
          saving={action.isPending}
        />
      )}
      <RenameDialog page={p} open={renaming} onClose={() => setRenaming(false)} />
      <HistoryDialog page={p} open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  );
}

/** "Alguém editou enquanto você escrevia": the difference and which version stays. */
function ConflictDialog({
  mine,
  theirs,
  onKeepMine,
  onKeepTheirs,
  onClose,
  saving,
}: {
  mine: string;
  theirs: WikiPageData;
  onKeepMine: () => void;
  onKeepTheirs: () => void;
  onClose: () => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const authorLabel = useAuthorLabel();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("wiki.conflictTitle")}
      description={t("wiki.conflictText", { who: authorLabel(theirs.updatedBy) })}
      closeLabel={t("common.close")}
      width={760}
    >
      <DialogBody>
        <Diff
          lines={diffLines(theirs.body.split("\n"), mine.split("\n"))}
          addedLabel={t("wiki.yours")}
          removedLabel={t("wiki.theirs")}
          aria-label={t("wiki.conflictDiff")}
        />
      </DialogBody>
      <DialogFooter>
        <Button onClick={onKeepTheirs}>{t("wiki.keepTheirs")}</Button>
        <Button variant="primary" onClick={onKeepMine} loading={saving} disabled={saving}>
          {t("wiki.keepMine")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function RenameDialog({ page, open, onClose }: { page: WikiPageData; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const action = useWikiAction(org.id);
  const [title, setTitle] = useState(page.title);
  useEffect(() => {
    if (open) setTitle(page.title);
  }, [open, page.title]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("wiki.rename")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim() || title.trim() === page.title) return;
          action.mutate(
            { type: "rename", slug: page.slug, title: title.trim() },
            {
              onSuccess: (renamed) => {
                toast.show(t("wiki.renamed"));
                onClose();
                void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug: renamed.slug } });
              },
            },
          );
        }}
      >
        <DialogBody>
          <Field label={t("wiki.form.title")} id="wiki-rename" help={t("wiki.renameHelp")}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={action.isPending} disabled={action.isPending}>
            {t("wiki.rename")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** History: every version; picking one shows what changed from the one before. */
function HistoryDialog({ page, open, onClose }: { page: WikiPageData; open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const history = useWikiHistory(org.id, page.slug, open);
  const authorLabel = useAuthorLabel();
  const [diff, setDiff] = useState<{ version: number; before: string; after: string } | null>(null);
  useEffect(() => {
    if (!open) setDiff(null);
  }, [open]);
  const show = async (version: number) => {
    const after = await api.wiki.version(org.id, page.slug, version);
    const before = version > 1 ? await api.wiki.version(org.id, page.slug, version - 1) : { body: "" };
    setDiff({ version, before: before.body, after: after.body });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("wiki.historyTitle", { title: page.title })}
      closeLabel={t("common.close")}
      width={760}
    >
      <DialogBody>
        {history.isLoading && <LoadingList count={3} />}
        <ol className="wiki-history">
          {(history.data ?? []).map((v) => (
            <li key={v.version}>
              <button
                type="button"
                className="wiki-history__item"
                aria-pressed={diff?.version === v.version}
                onClick={() => void show(v.version)}
              >
                <span className="tabular">v{v.version}</span>
                <span>{authorLabel(v.author)}</span>
                <span className="small muted">{whenAt(t, i18n.language, v.at)}</span>
                {v.note && <span className="small muted">{v.note}</span>}
              </button>
            </li>
          ))}
        </ol>
        {diff && (
          <Diff
            lines={diffLines(diff.before.split("\n"), diff.after.split("\n"))}
            addedLabel={t("wiki.added")}
            removedLabel={t("wiki.removed")}
            aria-label={t("wiki.versionDiff", { version: diff.version })}
          />
        )}
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.close")}</Button>
      </DialogFooter>
    </Dialog>
  );
}

/** "Nova página": title and folder (a `Pasta/Título` title also works). */
function NewPageDialog({
  initialTitle,
  pages,
  onClose,
}: {
  initialTitle: string | null;
  pages: WikiPageSummary[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const action = useWikiAction(org.id);
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (initialTitle === null) return;
    const parts = initialTitle.split("/");
    setTitle(parts.pop()?.trim() ?? "");
    setFolder(parts.join("/"));
    setError(null);
  }, [initialTitle]);
  const folders = [...new Set(pages.map((p) => p.folder).filter(Boolean))].sort();
  return (
    <Dialog
      open={initialTitle !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("wiki.new")}
      closeLabel={t("common.close")}
      width={480}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return setError(t("wiki.form.required"));
          action.mutate(
            { type: "create", input: { title: title.trim(), folder: folder.trim(), body: `# ${title.trim()}\n\n` } },
            {
              onSuccess: (page) => {
                toast.show(t("wiki.created"));
                onClose();
                void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug: page.slug } });
              },
              onError: (err) => setError(err.message),
            },
          );
        }}
      >
        <DialogBody>
          <Field label={t("wiki.form.title")} id="wiki-new-title" error={error ?? undefined}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </Field>
          <Field label={t("wiki.form.folder")} id="wiki-new-folder" help={t("wiki.form.folderHelp")}>
            <Input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder={t("wiki.form.folderPlaceholder")}
            />
          </Field>
          {folders.length > 0 && (
            <div className="wiki-tags">
              {folders.map((f) => (
                <button key={f} type="button" className="pill" aria-pressed={folder === f} onClick={() => setFolder(f)}>
                  {f}
                </button>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={action.isPending} disabled={action.isPending}>
            {t("wiki.createPage")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
