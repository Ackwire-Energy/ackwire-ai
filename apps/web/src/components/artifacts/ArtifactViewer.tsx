import type { ArtifactAuthor, ArtifactContent, ArtifactDetail } from "@agenteschat/client";
import { useArtifact, useArtifactVersions, useChannels, useSaveArtifact } from "@agenteschat/client";
import { KIND_ICON } from "@agenteschat/client/lib/artifacts";
import { errorText } from "@agenteschat/client/lib/errors";
import { fileIcon, formatBytes, MAX_PREVIEW_BYTES, previewKind } from "@agenteschat/client/lib/files";
import { relativeTime } from "@agenteschat/client/lib/format";
import { filePath } from "@agenteschat/client/lib/message-links";
import {
  Alert,
  Button,
  Chip,
  cx,
  DetailsDialog,
  Field,
  FormActions,
  Icon,
  Input,
  Locked,
  Menu,
  MenuItem,
  Textarea,
} from "@agenteschat/ui";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { ArtifactMoreMenu, type DownloadFormat, useArtifactDownload, useDeleteArtifact } from "./ArtifactActions";
import { fileSaver } from "./fileSaver";
import { useFileShare } from "./ShareDialog";
import { UploadButton, useDriveUpload } from "./Upload";
import { ArtifactContentView, TableEditor } from "./views";

export { fileSaver };

/** Link to an artifact (opens Drive with the viewer). */
export const artifactLink = (origin: string, orgId: string, id: string, version?: number) =>
  `${origin}${filePath(orgId, id, version)}`;

interface ViewerTarget {
  id: string;
  version?: number;
}

const ViewerContext = createContext<{ open: (id: string, version?: number) => void; close: () => void } | null>(null);

/** Opens artifacts in the side panel from anywhere in the workspace (chat cards, Drive). */
export function ArtifactViewerProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const open = useCallback((id: string, version?: number) => setTarget({ id, version }), []);
  const close = useCallback(() => setTarget(null), []);
  const value = useMemo(() => ({ open, close }), [open, close]);
  return (
    <ViewerContext.Provider value={value}>
      {children}
      {target && (
        <ArtifactViewer
          key={target.id}
          id={target.id}
          version={target.version}
          onVersion={(version) => setTarget({ id: target.id, version })}
          onClose={close}
        />
      )}
    </ViewerContext.Provider>
  );
}

export function useArtifactViewer() {
  const value = useContext(ViewerContext);
  if (!value) throw new Error("useArtifactViewer must be used inside ArtifactViewerProvider");
  return value;
}

/** The viewer where there is one; a text with no viewer around it (a page of its own) opens the Drive instead. */
export const useMaybeArtifactViewer = () => useContext(ViewerContext);

export function useAuthorName() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (a: ArtifactAuthor) => dir.authorName({ type: a.type, id: a.id } as Parameters<typeof dir.authorName>[0]);
}

export function ArtifactViewer({
  id,
  version,
  onVersion,
  onClose,
}: {
  id: string;
  version?: number;
  onVersion: (version: number | undefined) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const authorName = useAuthorName();
  const channels = useChannels(org.id);
  const query = useArtifact(org.id, id, version);
  const [editing, setEditing] = useState(false);
  const remover = useDeleteArtifact(onClose);
  const a = query.data;
  const channel = a?.channelId ? channels.data?.find((c) => c.id === a.channelId) : undefined;
  const old = a ? a.shownVersion < a.version : false;
  const uploader = useDriveUpload((saved) => {
    toast.show(t("artifacts.saved", { version: saved.version }));
    onVersion(undefined);
  });
  const downloads = useArtifactDownload();
  const share = useFileShare();
  const save = (format?: DownloadFormat) => {
    if (a) void downloads.save(a, format, a.shownVersion, a.content);
  };
  const download = () => save();
  const formats = a ? downloads.formats(a.kind) : [];
  const canEditNow = Boolean(a?.canEdit && !old && !editing && (a?.kind === "document" || a?.kind === "table"));
  // A snapshot (a screenshot, a photo) has no versions: no history beside it, no "Enviar nova versão" (ADR 0019).
  const versioned = a?.versioned !== false;
  const canUploadVersion = Boolean(a?.canEdit && !old && a?.kind === "file" && versioned);
  // A picture or a video takes the whole viewer: its versions open beside it only when asked.
  const fileKind = a?.content.kind === "file" ? previewKind(a.content.contentType) : null;
  const image =
    fileKind === "video" || (fileKind === "image" && a?.content.kind === "file" && a.content.size <= MAX_PREVIEW_BYTES);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const sideVersions = versioned && (!image || versionsOpen);
  const focusVersions = () =>
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".artifact-viewer__versions button")?.focus());
  const actions = a && (
    <>
      {a.kind === "file" ? (
        <Button
          size="sm"
          variant="ghost"
          icon="download"
          className="artifact-download"
          title={t("artifacts.download")}
          onClick={download}
        >
          <span className="artifact-sheet__label">{t("artifacts.download")}</span>
        </Button>
      ) : (
        <Menu
          align="end"
          label={t("artifacts.downloadMenu")}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              icon="download"
              className="artifact-download"
              title={t("artifacts.downloadMenu")}
            >
              <span className="artifact-sheet__label">{t("artifacts.downloadMenu")}</span>
            </Button>
          }
        >
          {formats.map((f) => (
            <MenuItem key={f.key} icon={f.icon} onSelect={() => save(f.format)}>
              {f.label}
            </MenuItem>
          ))}
        </Menu>
      )}
      {a.inDrive !== false && (
        <Button
          size="sm"
          variant="ghost"
          icon="personAdd"
          className="artifact-share"
          title={t("share.button")}
          onClick={() => share.open(a)}
        >
          <span className="artifact-sheet__label">{t("share.button")}</span>
        </Button>
      )}
      {canUploadVersion && (
        <UploadButton
          variant="ghost"
          label={uploader.busy ? t("files.uploadingVersion") : t("files.uploadVersion")}
          busy={uploader.busy}
          onFiles={(files) => void uploader.upload(files.slice(0, 1), { artifactId: a.id })}
        />
      )}
      {canEditNow && (
        <Button
          size="sm"
          variant="ghost"
          icon="edit"
          className="artifact-edit"
          title={t("artifacts.edit")}
          onClick={() => setEditing(true)}
        >
          <span className="artifact-edit__label">{t("artifacts.edit")}</span>
        </Button>
      )}
      {image && versioned && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="waiting"
          aria-label={t("artifacts.history")}
          title={t("artifacts.history")}
          aria-pressed={versionsOpen}
          onClick={() => setVersionsOpen(!versionsOpen)}
        />
      )}
      <ArtifactMoreMenu
        artifact={a}
        onVersions={
          versioned
            ? () => {
                setVersionsOpen(true);
                focusVersions();
              }
            : undefined
        }
        onDelete={() => remover.ask(a)}
      />
    </>
  );
  return (
    <DetailsDialog
      open
      size="xl"
      fill={image}
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("artifacts.close")}
      className={image ? "artifact-sheet artifact-sheet--image" : "artifact-sheet"}
      title={
        a ? (
          <span className="artifact-sheet__title" title={a.title}>
            {a.title}
          </span>
        ) : (
          t("artifacts.loading")
        )
      }
      icon={
        a ? (
          <Icon
            name={a.content.kind === "file" ? fileIcon(a.content.name, a.content.contentType) : KIND_ICON[a.kind]}
          />
        ) : undefined
      }
      subtitle={
        a
          ? t(a.content.kind === "file" ? "artifacts.subtitleSize" : "artifacts.subtitle", {
              kind: t(`artifacts.kind.${a.kind}`),
              name: authorName(a.createdBy),
              where: channel ? `#${channel.name}` : t("artifacts.noChannel"),
              when: relativeTime(t, i18n.language, a.updatedAt),
              size: a.content.kind === "file" ? formatBytes(i18n.language, a.content.size) : "",
            })
          : undefined
      }
      actions={actions}
    >
      {query.isError && <Alert>{t("artifacts.notFound")}</Alert>}
      {a && (
        <div
          className={cx(
            "artifact-viewer",
            !sideVersions && "artifact-viewer--single",
            image && "artifact-viewer--image",
          )}
        >
          <div className="artifact-viewer__main">
            {old && (
              <div className="row artifact-viewer__old" role="status">
                <span className="small">{t("artifacts.viewing", { version: a.shownVersion, latest: a.version })}</span>
                <Button size="sm" onClick={() => onVersion(undefined)}>
                  {t("artifacts.backToLatest")}
                </Button>
              </div>
            )}
            {editing ? (
              <Editor
                artifact={a}
                onDone={(saved) => {
                  setEditing(false);
                  if (saved) onVersion(undefined);
                }}
              />
            ) : (
              <ArtifactContentView
                content={a.content}
                title={a.title}
                source={{ id: a.id, version: a.shownVersion, agentId: a.createdBy.id }}
              />
            )}
          </div>
          {sideVersions && <Versions artifact={a} onVersion={onVersion} />}
        </div>
      )}
      {remover.dialog}
      {share.dialog}
    </DetailsDialog>
  );
}

function Versions({ artifact, onVersion }: { artifact: ArtifactDetail; onVersion: (v: number | undefined) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const versions = useArtifactVersions(org.id, artifact.id);
  const authorName = useAuthorName();
  return (
    <nav className="artifact-viewer__versions" aria-label={t("artifacts.history")}>
      <h3 className="ac-eyebrow">{t("artifacts.history")}</h3>
      <ol>
        {(versions.data ?? []).map((v) => {
          const current = v.version === artifact.shownVersion;
          return (
            <li key={v.version}>
              <button
                type="button"
                className="ac-navcard"
                aria-current={current ? "true" : undefined}
                onClick={() => onVersion(v.version === artifact.version ? undefined : v.version)}
              >
                <span className="artifact-viewer__vhead">
                  <span className="artifact-viewer__vname">
                    {t("artifacts.versionBy", {
                      version: v.version,
                      name: authorName(v.author),
                      when: relativeTime(t, i18n.language, v.createdAt),
                    })}
                  </span>
                  {v.version === artifact.version && <Chip icon="check">{t("artifacts.latest")}</Chip>}
                </span>
                <span className="small muted">{v.note ?? t("artifacts.noNote")}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Editor({ artifact, onDone }: { artifact: ArtifactDetail; onDone: (saved: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSaveArtifact(org.id, artifact.id);
  const [content, setContent] = useState<ArtifactContent>(artifact.content);
  const [note, setNote] = useState("");
  const [stale, setStale] = useState(false);
  return (
    <form
      className="ac-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(
          { content, note: note.trim() || null, baseVersion: artifact.version },
          {
            onSuccess: (saved) => {
              toast.show(t("artifacts.saved", { version: saved.version }));
              onDone(true);
            },
            onError: (error) => {
              if ((error as { status?: number }).status === 409) setStale(true);
              else toast.show(errorText(t, error, i18n.language), "error");
            },
          },
        );
      }}
    >
      <p className="small muted">{t("artifacts.editing", { version: artifact.version + 1 })}</p>
      <Locked when={save.isPending}>
        {content.kind === "document" && (
          <Field label={t("artifacts.markdownSource")} id="artifact-md">
            <Textarea
              rows={18}
              value={content.markdown}
              onChange={(e) => setContent({ kind: "document", markdown: e.target.value })}
            />
          </Field>
        )}
        {content.kind === "table" && (
          <TableEditor
            columns={content.columns}
            rows={content.rows}
            onChange={(rows) => setContent({ ...content, rows })}
          />
        )}
        <Field label={t("artifacts.note")} id="artifact-note">
          <Input value={note} placeholder={t("artifacts.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Locked>
      {stale && (
        <div className="stack-4" style={{ gap: 8 }}>
          <Alert>{t("artifacts.stale")}</Alert>
          <div className="row">
            <Button type="button" size="sm" onClick={() => onDone(true)}>
              {t("artifacts.backToLatest")}
            </Button>
          </div>
        </div>
      )}
      <FormActions>
        <Button type="button" onClick={() => onDone(false)}>
          {t("artifacts.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={stale} loading={save.isPending}>
          {t("artifacts.save")}
        </Button>
      </FormActions>
    </form>
  );
}
