import { Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { useArtifact } from "@/api/queries";
import type { ArtifactContent, ArtifactRef } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { documentPreview, KIND_ICON, patchCounts } from "@/lib/artifacts";
import { useArtifactViewer, useAuthorName } from "./ArtifactViewer";
import { MermaidDiagram } from "./Mermaid";

const PREVIEW_ROWS = 3;
const PREVIEW_FILES = 3;

/** Compact neutral card on an agent message: kind, title, version, author and a short preview. */
export function ArtifactCard({ artifact: ref }: { artifact: ArtifactRef }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const viewer = useArtifactViewer();
  const authorName = useAuthorName();
  const query = useArtifact(org.id, ref.deleted ? null : ref.id, ref.version);
  const a = query.data;
  // Deleted (to the trash): a quiet placeholder, never a broken card.
  if (ref.deleted) {
    return (
      <div className="artifact-card artifact-card--removed" role="note">
        <Icon name="trash" size={16} />
        <span className="small muted">{t("artifacts.removedFile")}</span>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="artifact-card artifact-card--missing">
        <span className="small muted">{t("artifacts.notFound")}</span>
      </div>
    );
  }
  if (!a) return <div className="artifact-card artifact-card--loading" aria-busy="true" />;
  return (
    <div className="artifact-card" data-kind={a.kind}>
      <button
        type="button"
        className="artifact-card__open"
        aria-label={t("artifacts.open", { title: a.title })}
        onClick={() => viewer.open(a.id, a.shownVersion < a.version ? a.shownVersion : undefined)}
      >
        {/* A tiny page for documents; the kind's icon for the rest. */}
        {a.kind === "document" ? (
          <span className="artifact-thumb" aria-hidden="true">
            <span style={{ width: "70%" }} />
            <span />
            <span style={{ width: "85%" }} />
            <span style={{ width: "55%" }} />
          </span>
        ) : (
          <span className="artifact-card__icon">
            <Icon name={KIND_ICON[a.kind]} />
          </span>
        )}
        <span className="artifact-card__meta">
          <span className="artifact-card__title">{a.title}</span>
          <span className="small muted">
            {t("artifacts.createdBy", { kind: t(`artifacts.kind.${a.kind}`), name: authorName(a.createdBy) })}
          </span>
        </span>
      </button>
      <span className="artifact-card__version small muted tabular">
        {t("artifacts.version", { version: a.shownVersion })}
      </span>
      <div className="artifact-card__preview">
        <Preview content={a.content} title={a.title} />
      </div>
    </div>
  );
}

function Preview({ content, title }: { content: ArtifactContent; title: string }) {
  const { t } = useTranslation();
  switch (content.kind) {
    case "document":
      return (
        <div className="artifact-card__doc">
          {documentPreview(content.markdown).map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static preview
            <p key={i}>{l}</p>
          ))}
        </div>
      );
    case "table": {
      const more = content.rows.length - PREVIEW_ROWS;
      return (
        <>
          <table className="artifact-card__table">
            <thead>
              <tr>
                {content.columns.map((c, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static preview
                  <th key={i} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {content.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static preview
                <tr key={i}>
                  {content.columns.map((_, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static preview
                    <td key={j}>{r[j] ?? ""}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {more > 0 && <span className="small muted">{t("artifacts.moreRows", { count: more })}</span>}
        </>
      );
    }
    case "diff": {
      const more = content.files.length - PREVIEW_FILES;
      return (
        <>
          <ul className="artifact-card__files">
            {content.files.slice(0, PREVIEW_FILES).map((f) => {
              const c = patchCounts(f.patch);
              return (
                <li key={f.path}>
                  <code>{f.path}</code>
                  <span className="small muted tabular">
                    <span aria-hidden="true">{t("artifacts.counts", c)}</span>
                    <span className="ac-visually-hidden">{t("artifacts.countsLabel", c)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          {more > 0 && <span className="small muted">{t("artifacts.moreFiles", { count: more })}</span>}
        </>
      );
    }
    case "diagram":
      return <MermaidDiagram source={content.mermaid} label={t("artifacts.diagramLabel", { title })} compact />;
    case "html":
      return (
        <div className="artifact-card__thumb">
          <Icon name="page" />
          <span className="small muted">{t("artifacts.htmlPreview")}</span>
        </div>
      );
  }
}
