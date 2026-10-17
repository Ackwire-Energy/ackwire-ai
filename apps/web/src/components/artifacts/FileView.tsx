import type { ArtifactFileContent } from "@agenteschat/client";
import { useArtifactBlob } from "@agenteschat/client";
import { fileIcon, formatBytes, MAX_PREVIEW_BYTES, previewKind, previewType } from "@agenteschat/client/lib/files";
import { Button, Icon, Spinner } from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useOrg } from "@/components/org-context";
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

/** Images up to this size get a thumbnail in the chat card (bigger ones only in the viewer). */
export const MAX_THUMB_BYTES = 8 * 1024 * 1024;

/** The blob of a previewable file as an object URL of exactly the allowed type (null until loaded). */
export function usePreviewUrl(artifactId: string, version: number, contentType: string, enabled: boolean) {
  const { org } = useOrg();
  const blob = useArtifactBlob(org.id, artifactId, version, enabled);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob.data) return;
    // Exactly the allowed type, whatever the server or the bytes say.
    const typed = new Blob([blob.data], { type: previewType(contentType) });
    const next = objectUrls.create(typed);
    setUrl(next);
    return () => {
      if (next) objectUrls.revoke(next);
    };
  }, [blob.data, contentType]);
  return { url, failed: blob.isError };
}

/**
 * A file on a chat message, as a tile that sits beside the others: images show
 * their thumbnail (a click opens the viewer); the rest show the type, name and
 * size (a click opens the viewer) with Baixar.
 */
export function FileCardPreview({
  content,
  artifactId,
  version,
  title,
  onOpen,
}: {
  content: ArtifactFileContent;
  artifactId: string;
  version: number;
  title: string;
  onOpen: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const image = previewKind(content.contentType) === "image" && content.size <= MAX_THUMB_BYTES;
  const { url, failed } = usePreviewUrl(artifactId, version, content.contentType, image);
  const download = () => fileSaver.save(api.artifacts.fileUrl(org.id, artifactId, { version }), content.name);
  if (image && !failed) {
    return (
      <button
        type="button"
        className="file-thumb"
        data-loading={url ? undefined : "true"}
        onClick={onOpen}
        aria-label={t("artifacts.open", { title })}
      >
        {url && <img src={url} alt={t("files.imageAlt", { title })} />}
        <span className="file-thumb__caption small">
          <span className="file-thumb__name">{content.name}</span>
          <span className="tabular">{formatBytes(i18n.language, content.size)}</span>
        </span>
      </button>
    );
  }
  return (
    <div className="file-row">
      <button
        type="button"
        className="file-row__open"
        onClick={onOpen}
        aria-label={t("artifacts.open", { title })}
        title={content.name}
      >
        <FileSummary content={content} />
      </button>
      <Button
        size="sm"
        variant="ghost"
        icon="download"
        iconOnly
        aria-label={t("artifacts.download")}
        title={t("artifacts.download")}
        onClick={download}
      />
    </div>
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
  const { url, failed } = usePreviewUrl(artifactId, version, content.contentType, canPreview);
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
          {failed ? (
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
