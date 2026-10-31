import type { WikiAuthor, WikiPage as WikiPageData, WikiPageSummary, WikiVersion } from "@agenteschat/client";
import { ApiError, keys, useWikiAction, useWikiHistory, useWikiPage } from "@agenteschat/client";
import { fileIcon } from "@agenteschat/client/lib/files";
import { relativeTime, whenAt } from "@agenteschat/client/lib/format";
import { can } from "@agenteschat/client/lib/permissions";
import { leafTitle, outlineOf } from "@agenteschat/client/lib/wiki";
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
  Icon,
  Input,
  Kbd,
  Menu,
  MenuItem,
  MenuSeparator,
  modKey,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { AgentAvatar } from "@/components/AgentAvatar";
import { usePreviewUrl } from "@/components/artifacts/FileView";
import { ErrorState, LoadingList, LoadingPage } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { WikiSky } from "@/components/Sky";
import { WikiEditor } from "@/components/WikiEditor";
import { useWikiLinkRenderer } from "@/components/WikiLinks";
import { useDirectory } from "@/hooks/useDirectory";
import { type EmbedRenderer, Markdown } from "@/lib/markdown";
import { isAttachmentName } from "@/lib/obsidian";
import { useToast } from "@/lib/toast";
import { ObsidianMark } from "./ObsidianMark";

/** Typing in a field: single-key shortcuts stay off. */
export const typingIn = (el: Element | null) =>
  !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el as HTMLElement).isContentEditable);

/** The name of who wrote it, and for whom ("Theo", "Ana"). */
function useNames() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (a: WikiAuthor) => ({
    name: a.type === "agent" ? (dir.agentById.get(a.id)?.name ?? "") : (dir.memberById.get(a.id)?.name ?? ""),
    behalf: a.onBehalfOf ? (dir.memberById.get(a.onBehalfOf)?.name ?? null) : null,
  });
}

/** "por Theo, a pedido de Walter" / "por Walter". */
export function useAuthorLabel() {
  const { t } = useTranslation();
  const names = useNames();
  return (a: WikiAuthor) => {
    const { name, behalf } = names(a);
    return behalf ? t("wiki.byFor", { name, person: behalf }) : t("wiki.by", { name });
  };
}

export function AuthorAvatar({ a, size = "xs" }: { a: WikiAuthor; size?: "xs" | "sm" }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  if (a.type === "agent") return <AgentAvatar agentId={a.id} name={dir.agentById.get(a.id)?.name ?? ""} size={size} />;
  const m = dir.memberById.get(a.id);
  return <Avatar size={size} name={m?.name ?? "?"} imageUrl={m?.image} />;
}

/** "**Theo** a pedido de **Ana**". */
export function AuthorLine({ a }: { a: WikiAuthor }) {
  const { t } = useTranslation();
  const { name, behalf } = useNames()(a);
  return (
    <span className="wiki-by">
      <AuthorAvatar a={a} />
      <span>
        <b>{name}</b>
        {behalf && (
          <>
            {" "}
            {t("wiki.atRequestOf")} <b>{behalf}</b>
          </>
        )}
      </span>
    </span>
  );
}

/** A version note: ours translated ("criou a página"), a person's as written. */
export function useNoteText() {
  const { t } = useTranslation();
  return (v: WikiVersion) =>
    v.noteCode ? t(`wiki.note.${v.noteCode}`, { ...v.noteParams, defaultValue: v.note ?? "" }) : (v.note ?? "");
}

/** An attachment in the Drive: an image shows, anything else is a file card. */
function Embed({ id, name, block }: { id: string; name: string; block: boolean }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const image = /\.(png|jpe?g|gif|webp)$/i.test(name);
  const type = image ? `image/${name.split(".").pop()?.toLowerCase().replace("jpg", "jpeg")}` : "";
  const preview = usePreviewUrl(id, 1, type, image);
  const card = (
    <Link
      to="/org/$orgId/drive"
      params={{ orgId: org.id }}
      search={{ artifact: id }}
      className="wiki-embed"
      data-block={block || undefined}
    >
      <span className="wiki-embed__thumb">
        {preview.url ? <img src={preview.url} alt="" /> : <Icon name={fileIcon(name)} />}
      </span>
      <span className="wiki-embed__text">
        <b>{name}</b>
        <small>{t("wiki.embedInDrive")}</small>
      </span>
    </Link>
  );
  if (image && preview.url && block) {
    return (
      <figure className="wiki-figure">
        <img src={preview.url} alt={name} />
        <figcaption>{card}</figcaption>
      </figure>
    );
  }
  return card;
}

/** `![[…]]`: attachments imported to the Drive; another note embedded shows as its link. */
function useEmbedRenderer(attachments: Record<string, string> | undefined): EmbedRenderer {
  const { t } = useTranslation();
  const wikiLink = useWikiLinkRenderer();
  return (target, key, block) => {
    const name = leafTitle(target);
    const id =
      attachments?.[target] ??
      Object.entries(attachments ?? {}).find(([k]) => leafTitle(k).toLowerCase() === name.toLowerCase())?.[1];
    if (id) return <Embed key={key} id={id} name={name} block={block} />;
    if (!isAttachmentName(target)) return wikiLink(target, name, key);
    return (
      <span key={key} className="wiki-embed wiki-embed--missing" title={t("wiki.embedMissing")}>
        <span className="wiki-embed__thumb">
          <Icon name={fileIcon(name)} />
        </span>
        <span className="wiki-embed__text">
          <b>{name}</b>
          <small>{t("wiki.embedMissing")}</small>
        </span>
      </span>
    );
  };
}

/** Outline that follows the scroll (the heading at the top is current). */
function Outline({ items }: { items: { level: number; text: string; id: string }[] }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = items.map((h) => document.getElementById(h.id)).filter((e): e is HTMLElement => Boolean(e));
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setCurrent(top.target.id);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, [items]);
  return (
    <nav className="wiki-aside__block wiki-outline" aria-label={t("wiki.outline")}>
      <span className="wiki-label">{t("wiki.outline")}</span>
      <div className="wiki-outline__list">
        {items.map((h) => (
          <a
            key={h.id}
            href={`#${h.id}`}
            className="wiki-outline__item"
            data-level={h.level}
            aria-current={current === h.id ? "true" : undefined}
          >
            {h.text}
          </a>
        ))}
      </div>
    </nav>
  );
}

/** "Agentes que usam esta página": who used it in the last 7 days, and the latest use. */
function AgentUses({ page }: { page: WikiPageData }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const reads = page.reads;
  const top = (reads?.agents ?? []).slice(0, 3);
  const last = reads?.last;
  const lastAgent = last ? dir.agentById.get(last.agentId) : undefined;
  return (
    <section className="wiki-aside__block" aria-label={t("wiki.uses.title")}>
      <span className="wiki-label">{t("wiki.uses.title")}</span>
      <div className="wiki-uses">
        <WikiSky variant="strip" />
        {top.length > 0 && (
          <span className="wiki-uses__crew">
            {top.map((r) => (
              <AgentAvatar
                key={r.agentId}
                agentId={r.agentId}
                name={dir.agentById.get(r.agentId)?.name ?? ""}
                size="sm"
              />
            ))}
          </span>
        )}
        <div className="wiki-uses__in">
          {reads && reads.total > 0 ? (
            <>
              <p className="wiki-uses__row">
                <b className="ac-num wiki-uses__big">{reads.total}</b>
                <span>{t("wiki.uses.count", { count: reads.total })}</span>
              </p>
              {last && lastAgent && (
                <p className="wiki-uses__row">
                  <AgentAvatar agentId={lastAgent.id} name={lastAgent.name} size="xs" />
                  <span>
                    {last.channelName
                      ? t("wiki.uses.lastIn", {
                          name: lastAgent.name,
                          when: relativeTime(t, i18n.language, last.at),
                          channel: last.channelName,
                        })
                      : t("wiki.uses.last", { name: lastAgent.name, when: relativeTime(t, i18n.language, last.at) })}
                  </span>
                </p>
              )}
            </>
          ) : (
            <p className="wiki-uses__row">{t("wiki.uses.none")}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function Backlinks({ page }: { page: WikiPageData }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <section className="wiki-aside__block" aria-label={t("wiki.backlinks")}>
      <span className="wiki-label">
        {t("wiki.backlinks")} <span className="wiki-label__n ac-num">{page.backlinks.length}</span>
      </span>
      {page.backlinks.length === 0 ? (
        <p className="small muted">{t("wiki.noBacklinksHint", { title: page.title })}</p>
      ) : (
        <div className="wiki-backlinks">
          {page.backlinks.map((b) =>
            b.kind === "page" ? (
              <Link
                key={`p:${b.slug}`}
                to="/org/$orgId/wiki/$slug"
                params={{ orgId: org.id, slug: b.slug }}
                className="wiki-backlink"
              >
                <b>{b.title}</b>
                {b.excerpt && <span>{b.excerpt}</span>}
              </Link>
            ) : b.kind === "message" ? (
              <Link
                key={`m:${b.messageId}`}
                to="/org/$orgId/c/$channelId"
                params={{ orgId: org.id, channelId: b.channelId }}
                className="wiki-backlink"
              >
                <b>
                  <Icon name="channel" size={14} /> {b.channelName}
                </b>
                <span>{b.excerpt}</span>
              </Link>
            ) : b.kind === "forum" ? (
              <Link
                key={`f:${b.topicId}`}
                to="/org/$orgId/forum/$topicId"
                params={{ orgId: org.id, topicId: b.topicId }}
                className="wiki-backlink"
              >
                <b>
                  <Icon name="message" size={14} /> {b.title}
                </b>
              </Link>
            ) : (
              <Link
                key={`i:${b.number}`}
                to="/org/$orgId/issues/$number"
                params={{ orgId: org.id, number: String(b.number) }}
                className="wiki-backlink"
              >
                <b>
                  <Icon name="issues" size={14} /> {`#${b.number} ${b.title}`}
                </b>
              </Link>
            ),
          )}
        </div>
      )}
    </section>
  );
}

function ShortHistory({ page, onOpen }: { page: WikiPageData; onOpen: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const history = useWikiHistory(org.id, page.slug, true);
  const names = useNames();
  const note = useNoteText();
  const versions = (history.data ?? []).slice(0, 3);
  return (
    <section className="wiki-aside__block" aria-label={t("wiki.history")}>
      <span className="wiki-label">{t("wiki.history")}</span>
      {history.isLoading && <LoadingList count={2} />}
      <div className="wiki-hist">
        {versions.map((v) => {
          const { name, behalf } = names(v.author);
          return (
            <button key={v.version} type="button" className="wiki-hist__item" onClick={onOpen}>
              <AuthorAvatar a={v.author} />
              <span>
                <b>{name}</b>
                {behalf ? ` ${t("wiki.atRequestOf")} ${behalf}` : ""}
                {note(v) ? ` · ${note(v)}` : ""}
                <small>
                  v{v.version} · {relativeTime(t, i18n.language, v.at)}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {page.version > 3 && (
        <Button size="sm" variant="ghost" onClick={onOpen}>
          {t("wiki.allVersions", { count: page.version })}
        </Button>
      )}
    </section>
  );
}

type Draft = { title: string; folder: string; tags: string; body: string };
const tagsOf = (text: string) =>
  [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((x) => x.replace(/^#/, "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 20);

/** Title, folder and tags while editing (a new page or an existing one). */
function EditHead({
  draft,
  setDraft,
  folders,
  autoFocus,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  folders: string[];
  autoFocus: boolean;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <>
      <input
        ref={ref}
        className="wiki-title-input"
        aria-label={t("wiki.form.title")}
        placeholder={t("wiki.form.titlePlaceholder")}
        value={draft.title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
      />
      <div className="wiki-meta wiki-meta--edit">
        <div className="wiki-meta__field">
          <Icon name="drive" size={14} />
          <Input
            aria-label={t("wiki.form.folder")}
            list={listId}
            value={draft.folder}
            placeholder={t("wiki.form.rootFolder")}
            onChange={(e) => setDraft({ ...draft, folder: e.target.value })}
          />
          <datalist id={listId}>
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </div>
        <div className="wiki-meta__field">
          <span className="wiki-meta__hash" aria-hidden="true">
            #
          </span>
          <Input
            aria-label={t("wiki.form.tags")}
            value={draft.tags}
            placeholder={t("wiki.form.tagsPlaceholder")}
            onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
          />
        </div>
      </div>
    </>
  );
}

/**
 * One page: reading (title, who wrote it, the text) with the outline, the
 * agents that use it, backlinks and history on the side; editing in place.
 * Without `slug` it is a new page being written (`initial` title and folder).
 */
export function WikiReader({
  slug,
  initial,
  pages,
  onCreate,
  onDiscard,
  onTag,
}: {
  slug?: string;
  initial?: { title: string; folder: string };
  pages: WikiPageSummary[];
  onCreate: (title: string, folder?: string) => void;
  onDiscard?: () => void;
  onTag: (tag: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const page = useWikiPage(org.id, slug ?? null);
  const action = useWikiAction(org.id);
  const wikiLink = useWikiLinkRenderer();
  const authorLabel = useAuthorLabel();
  const isNew = !slug;
  const [draft, setDraft] = useState<Draft | null>(
    isNew ? { title: initial?.title ?? "", folder: initial?.folder ?? "", tags: "", body: "" } : null,
  );
  const [conflict, setConflict] = useState<WikiPageData | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const embed = useEmbedRenderer(page.data?.source?.attachments);
  const p = page.data;
  const folders = [...new Set(pages.map((x) => x.folder).filter(Boolean))].sort();
  // Who edits pages (and pins, moves and deletes them); a locked page, and locking it, only who configures.
  const writes = can(org, "edit_wiki");
  const admin = can(org, "configure");
  const editing = draft !== null;

  const startEdit = () => {
    if (!p || !writes) return;
    if (p.locked && !admin) {
      toast.show(t("wiki.lockedHint"), "error");
      return;
    }
    setDraft({ title: p.title, folder: p.folder, tags: p.tags.map((x) => `#${x}`).join(" "), body: p.body });
  };

  // E edits (when not typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "e" || e.metaKey || e.ctrlKey || e.altKey || typingIn(document.activeElement)) return;
      if (!editing && p) {
        e.preventDefault();
        startEdit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = async (baseVersion?: number) => {
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) {
      toast.show(t("wiki.form.required"), "error");
      return;
    }
    const tags = tagsOf(draft.tags);
    if (isNew) {
      action.mutate(
        { type: "create", input: { title, folder: draft.folder.trim(), body: draft.body, tags } },
        {
          onSuccess: (created) => {
            toast.show(t("wiki.created"));
            setDraft(null);
            void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug: created.slug } });
          },
          onError: (e) => toast.show(e.message, "error"),
        },
      );
      return;
    }
    if (!p) return;
    try {
      let current = p;
      const folder = draft.folder.trim();
      const changed = draft.body !== p.body || folder !== p.folder || tags.join(" ") !== p.tags.join(" ");
      if (changed) {
        current = await action.mutateAsync({
          type: "update",
          slug: p.slug,
          input: { body: draft.body, baseVersion: baseVersion ?? p.version, folder, tags },
        });
      }
      if (title !== p.title) {
        current = await action.mutateAsync({ type: "rename", slug: current.slug, title });
        void navigate({ to: "/org/$orgId/wiki/$slug", params: { orgId: org.id, slug: current.slug } });
      }
      setDraft(null);
      setConflict(null);
      toast.show(title !== p.title ? t("wiki.renamed") : t("wiki.saved"));
    } catch (e) {
      if (e instanceof ApiError && e.code === "version_conflict") {
        const latest = await api.wiki.get(org.id, p.slug);
        qc.setQueryData(keys.wikiPage(org.id, p.slug), latest);
        setConflict(latest);
      } else toast.show((e as Error).message, "error");
    }
  };

  if (!isNew && page.isLoading) return <LoadingPage rows={4} />;
  if (!isNew && !p) {
    const missing = (page.error as { status?: number } | null)?.status === 404;
    const title = leafTitle(slug?.split("/").pop()?.replace(/-/g, " ") ?? "");
    return missing ? (
      <div className="wiki-doc">
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

  const crumbs = (editing ? draft.folder : (p?.folder ?? "")).split("/").filter(Boolean);
  const outline = p && !editing ? outlineOf(p.body).filter((h) => !(h.level === 1 && h.text.trim() === p.title)) : [];
  let actions: ReactNode;
  if (editing) {
    actions = (
      <>
        <Button
          variant="ghost"
          onClick={() => {
            setDraft(null);
            if (isNew) onDiscard?.();
          }}
        >
          {t("common.cancel")}
        </Button>
        <Button variant="primary" loading={action.isPending} disabled={action.isPending} onClick={() => void save()}>
          {t("common.save")}
          <Kbd>{`${modKey()} S`}</Kbd>
        </Button>
      </>
    );
  } else if (p) {
    actions = (
      <>
        {p.locked && (
          <Chip icon="lock" title={t("wiki.lockedHint")}>
            {t("wiki.locked")}
          </Chip>
        )}
        {writes && (
          <Button icon="edit" onClick={startEdit}>
            {t("wiki.edit")}
            <Kbd>E</Kbd>
          </Button>
        )}
        <Menu
          label={t("wiki.more")}
          trigger={<Button iconOnly icon="more" aria-label={t("wiki.more")} title={t("wiki.more")} />}
        >
          <MenuItem
            icon="link"
            onSelect={() => {
              void navigator.clipboard?.writeText(`[[${p.title}]]`);
              toast.show(t("wiki.linkCopied", { title: p.title }));
            }}
          >
            {t("wiki.copyLink")}
          </MenuItem>
          <MenuItem icon="clock" onSelect={() => setHistoryOpen(true)}>
            {t("wiki.history")}
          </MenuItem>
          {(writes || admin) && <MenuSeparator />}
          {writes && (
            <MenuItem icon="edit" onSelect={startEdit}>
              {t("wiki.renameOrMove")}
            </MenuItem>
          )}
          {writes && (
            <MenuItem
              icon="pin"
              onSelect={() =>
                action.mutate(
                  { type: "pin", slug: p.slug, pinned: !p.pinned },
                  { onSuccess: (x) => toast.show(x.pinned ? t("wiki.pinned") : t("wiki.unpinned")) },
                )
              }
            >
              {p.pinned ? t("wiki.unpin") : t("wiki.pin")}
            </MenuItem>
          )}
          {admin && (
            <MenuItem
              icon="lock"
              onSelect={() =>
                action.mutate(
                  { type: "lock", slug: p.slug, locked: !p.locked },
                  { onSuccess: (x) => toast.show(x.locked ? t("wiki.lockedDone") : t("wiki.unlockedDone")) },
                )
              }
            >
              {p.locked ? t("wiki.unlock") : t("wiki.lock")}
            </MenuItem>
          )}
          {writes && <MenuSeparator />}
          {writes && (
            <MenuItem icon="trash" danger onSelect={() => setConfirmDelete(true)}>
              {t("wiki.delete")}
            </MenuItem>
          )}
        </Menu>
      </>
    );
  }

  return (
    <div className="wiki-doc" data-editing={editing || undefined}>
      <article className="wiki-doc__main" aria-labelledby={editing ? undefined : "wiki-title"}>
        <div className="wiki-crumbs">
          <Link to="/org/$orgId/wiki" params={{ orgId: org.id }}>
            {t("wiki.title")}
          </Link>
          {crumbs.map((c, i) => (
            <span key={crumbs.slice(0, i + 1).join("/")}>
              <span aria-hidden="true">/</span> {c}
            </span>
          ))}
        </div>
        <header className="wiki-doc__head">
          <div className="wiki-doc__titles">
            {editing ? (
              <EditHead draft={draft} setDraft={setDraft} folders={folders} autoFocus={isNew && !draft.title} />
            ) : (
              p && (
                <h1 id="wiki-title" className="wiki-title">
                  {p.title}
                </h1>
              )
            )}
          </div>
          <div className="wiki-doc__actions">{actions}</div>
        </header>
        {!editing && p && (
          <div className="wiki-meta">
            <AuthorLine a={p.updatedBy} />
            <span className="wiki-meta__dot" aria-hidden="true" />
            <span title={whenAt(t, i18n.language, p.updatedAt)}>{relativeTime(t, i18n.language, p.updatedAt)}</span>
            <span className="wiki-meta__dot" aria-hidden="true" />
            <button type="button" className="wiki-chip" onClick={() => setHistoryOpen(true)}>
              <Icon name="clock" size={14} />v{p.version}
            </button>
            {p.source?.type === "obsidian" && (
              <span className="wiki-chip">
                <ObsidianMark size={14} />
                {t("wiki.fromObsidian")}
              </span>
            )}
            {p.tags.map((tag) => (
              <button key={tag} type="button" className="wiki-chip" aria-label={`#${tag}`} onClick={() => onTag(tag)}>
                <Icon name="channel" size={14} />
                {tag}
              </button>
            ))}
          </div>
        )}
        {editing ? (
          <WikiEditor
            value={draft.body}
            onChange={(body) => setDraft({ ...draft, body })}
            onSave={() => void save()}
            pages={pages}
            label={t("wiki.editorLabel", { title: draft.title || t("wiki.newPage") })}
            autoFocus={!isNew || Boolean(draft.title)}
          />
        ) : (
          p && (
            <div className="wiki-page__body wiki-prose">
              {p.body.trim() ? (
                <Markdown source={p.body} wikiLink={wikiLink} embed={embed} title={p.title} />
              ) : (
                <p className="muted">{t("wiki.emptyPage")}</p>
              )}
            </div>
          )
        )}
      </article>
      {!editing && p && (
        <aside className="wiki-aside" aria-label={t("wiki.aside")}>
          {outline.length > 0 && <Outline items={outline} />}
          <AgentUses page={p} />
          <Backlinks page={p} />
          <ShortHistory page={p} onOpen={() => setHistoryOpen(true)} />
          <p className="small muted wiki-aside__authors">{p.authors.map((a) => authorLabel(a)).join(" · ")}</p>
        </aside>
      )}
      {conflict && draft && (
        <ConflictDialog
          mine={draft.body}
          theirs={conflict}
          onKeepMine={() => void save(conflict.version)}
          onKeepTheirs={() => {
            setConflict(null);
            setDraft(null);
          }}
          onClose={() => setConflict(null)}
          saving={action.isPending}
        />
      )}
      {p && <HistoryDialog page={p} open={historyOpen} onClose={() => setHistoryOpen(false)} />}
      {p && confirmDelete && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirmDelete(false)}
          title={t("wiki.deleteTitle", { title: p.title })}
          description={t("wiki.deleteText")}
          closeLabel={t("common.close")}
          width={440}
        >
          <DialogFooter>
            <Button onClick={() => setConfirmDelete(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={async () => {
                await api.wiki.remove(org.id, p.slug);
                setConfirmDelete(false);
                void qc.invalidateQueries({ queryKey: keys.wiki(org.id) });
                toast.show(t("wiki.deleted", { title: p.title }));
                void navigate({ to: "/org/$orgId/wiki", params: { orgId: org.id } });
              }}
            >
              {t("wiki.delete")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
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

/** History: every version on the left; the one picked shows what changed from the one before. */
function HistoryDialog({ page, open, onClose }: { page: WikiPageData; open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const history = useWikiHistory(org.id, page.slug, open);
  const names = useNames();
  const note = useNoteText();
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
      description={t("wiki.historyText")}
      closeLabel={t("common.close")}
      width={900}
    >
      <DialogBody>
        <div className="wiki-history">
          <ol className="wiki-history__list">
            {history.isLoading && <LoadingList count={3} />}
            {(history.data ?? []).map((v) => {
              const { name, behalf } = names(v.author);
              return (
                <li key={v.version}>
                  <button
                    type="button"
                    className="wiki-history__item"
                    aria-pressed={diff?.version === v.version}
                    onClick={() => void show(v.version)}
                  >
                    <AuthorAvatar a={v.author} size="sm" />
                    <span>
                      <span className="tabular">v{v.version}</span> <b>{name}</b>
                      {behalf ? ` ${t("wiki.atRequestOf")} ${behalf}` : ""}
                      {note(v) && <small>{note(v)}</small>}
                      <small>{whenAt(t, i18n.language, v.at)}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="wiki-history__diff">
            {diff ? (
              <Diff
                lines={diffLines(diff.before.split("\n"), diff.after.split("\n"))}
                addedLabel={t("wiki.added")}
                removedLabel={t("wiki.removed")}
                aria-label={t("wiki.versionDiff", { version: diff.version })}
              />
            ) : (
              <p className="small muted">{t("wiki.pickVersion")}</p>
            )}
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onClose}>{t("common.close")}</Button>
      </DialogFooter>
    </Dialog>
  );
}
