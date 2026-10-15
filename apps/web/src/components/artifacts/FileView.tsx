import { Button, Icon, Spinner } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useArtifactBlob } from "@/api/queries";
import type { ArtifactFileContent } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { fileIcon, formatBytes, MAX_PREVIEW_BYTES, previewKind, previewType } from "@/lib/files";
import { fileSaver } from "./fileSaver";

/** Object URLs for blobs (swappable: test DOMs may lack `URL.createObjectURL`). */
export const objectUrls = {
  create(blob: Blob): string | null {
    return typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : null;
  },
  revoke(url: string) {
    if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
  },
};

/** "relatorio.pdf · 1,2 MB" with the type's icon. */
export function FileSummary({ content }: { content: ArtifactFileContent }) {
  const { i18n } = useTranslation();
  return (
    <span className="file-summary">
      <span className="file-summary__icon">
        <Icon name={fileIcon(content.name, content.contentType)} />
      </span>
      <span className="file-summary__text">
        <span className="file-summary__name" title={content.name}>
          {content.name}
        </span>
        <span className="small muted tabular">{formatBytes(i18n.language, content.size)}</span>
      </span>
    </span>
  );
}

/**
 * An uploaded file in the viewer: name, size and Baixar; an inline preview
 * only for raster images and PDF (a blob of exactly that type, never the
 * file's own origin), and the text of small text files, read-only.
 */
export function FileView({
  content,
  artifactId,
  version,
  title,
}: {
  content: ArtifactFileContent;
  artifactId: string;
  version: number;
  title: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const kind = previewKind(content.contentType);
  const canPreview = kind !== null && content.size <= MAX_PREVIEW_BYTES;
  const blob = useArtifactBlob(org.id, artifactId, version, canPreview);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob.data) return;
    // Exactly the allowed type, whatever the server or the bytes say.
    const typed = new Blob([blob.data], { type: previewType(content.contentType) });
    const next = objectUrls.create(typed);
    setUrl(next);
    return () => {
      if (next) objectUrls.revoke(next);
    };
  }, [blob.data, content.contentType]);
  const download = () => fileSaver.save(api.artifacts.fileUrl(org.id, artifactId, { version }), content.name);

  return (
    <div className="file-view">
      <div className="file-view__head">
        <FileSummary content={content} />
        <Button size="sm" icon="download" onClick={download}>
          {t("artifacts.download")}
        </Button>
      </div>
      {canPreview && (
        <div className="file-view__preview">
          {blob.isError ? (
            <p className="small muted">{t("files.previewFailed")}</p>
          ) : !url ? (
            <span className="row small muted" style={{ gap: 8 }} role="status">
              <Spinner />
              {t("files.previewLoading")}
            </span>
          ) : kind === "image" ? (
            <img className="file-view__image" src={url} alt={t("files.imageAlt", { title })} />
          ) : (
            <iframe className="file-view__pdf" src={url} title={t("files.pdfFrame", { title })} />
          )}
        </div>
      )}
      {kind !== null && !canPreview && <p className="small muted">{t("files.tooBigToPreview")}</p>}
      {kind === null && content.text !== undefined && (
        <pre className="file-view__text">
          <code>{content.text}</code>
        </pre>
      )}
      {kind === null && content.text === undefined && <p className="small muted">{t("files.downloadOnly")}</p>}
    </div>
  );
}
