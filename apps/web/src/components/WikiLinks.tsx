import { Popover } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWikiPage, useWikiTree } from "@/api/queries";
import type { WikiPageSummary } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { headingId, Markdown, type WikiLinkRenderer } from "@/lib/markdown";
import { resolveWikiLink, splitSection } from "@/lib/wiki";

/** The first lines of a page, for the hover card. */
export const previewOf = (body: string, lines = 4) =>
  body
    .split("\n")
    .filter((l) => l.trim() && !/^#\s/.test(l))
    .slice(0, lines)
    .join("\n");

function PreviewCard({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const page = useWikiPage(org.id, slug);
  if (!page.data) return <p className="small muted">{t("common.loading")}</p>;
  return (
    <div className="wiki-preview">
      <span className="wiki-preview__title">{page.data.title}</span>
      {page.data.folder && <span className="small muted">{page.data.folder}</span>}
      <div className="wiki-preview__body">
        <Markdown source={previewOf(page.data.body)} variant="message" />
      </div>
    </div>
  );
}

/**
 * A `[[link]]`: a chip to the page (hover or focus shows its first lines),
 * or, when the page doesn't exist, a dashed link that offers "Criar página".
 */
export function WikiLinkChip({ title, label, pages }: { title: string; label: string; pages?: WikiPageSummary[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const tree = useWikiTree(org.id, pages === undefined);
  const page = resolveWikiLink(pages ?? tree.data ?? [], title);
  const { section } = splitSection(title);
  const [open, setOpen] = useState(false);
  if (!page) {
    return (
      <button
        type="button"
        className="wiki-link wiki-link--missing"
        title={t("wiki.missingHint", { title })}
        onClick={() =>
          void navigate({
            to: "/org/$orgId/wiki",
            params: { orgId: org.id },
            search: { new: splitSection(title).title },
          })
        }
      >
        {label}
      </button>
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t("wiki.previewOf", { title: page.title })}
      side="top"
      className="wiki-preview-pop"
      trigger={
        <Link
          to="/org/$orgId/wiki/$slug"
          params={{ orgId: org.id, slug: page.slug }}
          hash={section ? `h-${headingId(section)}` : undefined}
          className="wiki-link"
          onPointerEnter={(e) => e.pointerType === "mouse" && setOpen(true)}
          onPointerLeave={(e) => e.pointerType === "mouse" && setOpen(false)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
        >
          {label}
        </Link>
      }
    >
      {open && <PreviewCard slug={page.slug} />}
    </Popover>
  );
}

/** The renderer to pass to `<Markdown wikiLink>` in chat, forum, issues and the wiki itself. */
export function useWikiLinkRenderer(): WikiLinkRenderer {
  const { org } = useOrg();
  const tree = useWikiTree(org.id);
  const pages = tree.data ?? [];
  return (title, label, key): ReactNode => <WikiLinkChip key={key} title={title} label={label} pages={pages} />;
}
