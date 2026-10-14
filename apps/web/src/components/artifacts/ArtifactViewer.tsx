import { Alert, Button, Chip, Field, Icon, Input, Sheet, Textarea } from "@agenteschat/ui";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useArtifact, useArtifactVersions, useChannels, useSaveArtifact } from "@/api/queries";
import type { ArtifactAuthor, ArtifactContent, ArtifactDetail } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { fileName, KIND_ICON, toCsv } from "@/lib/artifacts";
import { relativeTime } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { ArtifactContentView, TableEditor } from "./views";

/** Saves a URL as a file (an `<a download>` click). Swappable for tests. */
export const fileSaver = {
  save(url: string, name: string) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  },
};

/** Link to an artifact (opens Drive with the viewer). */
export const artifactLink = (origin: string, orgId: string, id: string, version?: number) =>
  `${origin}/org/${orgId}/drive?artifact=${encodeURIComponent(id)}${version ? `&v=${version}` : ""}`;

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
  const api = useApi();
  const toast = useToast();
  const authorName = useAuthorName();
  const channels = useChannels(org.id);
  const query = useArtifact(org.id, id, version);
  const [editing, setEditing] = useState(false);
  const a = query.data;
  const channel = a?.channelId ? channels.data?.find((c) => c.id === a.channelId) : undefined;
  const old = a ? a.shownVersion < a.version : false;
  const download = async () => {
    if (!a) return;
    const { url } = await api.artifacts.download(org.id, a.id, a.shownVersion);
    fileSaver.save(url, fileName(a.title, a.content));
  };
  const actions = a && (
    <>
      {a.content.kind === "table" && (
        <Button
          size="sm"
          variant="ghost"
          icon="download"
          onClick={() => {
            if (a.content.kind !== "table") return;
            const csv = toCsv(a.content.columns, a.content.rows);
            fileSaver.save(`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`, fileName(a.title, a.content));
          }}
        >
          {t("artifacts.downloadCsv")}
        </Button>
      )}
      {a.content.kind !== "table" && (
        <Button size="sm" variant="ghost" icon="download" onClick={() => void download()}>
          {t("artifacts.download")}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        icon="link"
        onClick={async () => {
          await navigator.clipboard.writeText(
            artifactLink(window.location.origin, org.id, a.id, old ? a.shownVersion : undefined),
          );
          toast.show(t("artifacts.linkCopied"));
        }}
      >
        {t("artifacts.copyLink")}
      </Button>
      {a.canEdit && !old && !editing && (a.kind === "document" || a.kind === "table") && (
        <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditing(true)}>
          {t("artifacts.edit")}
        </Button>
      )}
    </>
  );
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("artifacts.close")}
      title={a?.title ?? t("artifacts.loading")}
      icon={a ? <Icon name={KIND_ICON[a.kind]} /> : undefined}
      subtitle={
        a
          ? t("artifacts.subtitle", {
              kind: t(`artifacts.kind.${a.kind}`),
              name: authorName(a.createdBy),
              where: channel ? `#${channel.name}` : t("artifacts.noChannel"),
              when: relativeTime(t, i18n.language, a.updatedAt),
            })
          : undefined
      }
      actions={actions}
    >
      {query.isError && <Alert>{t("artifacts.notFound")}</Alert>}
      {a && (
        <div className="artifact-viewer">
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
              <ArtifactContentView content={a.content} title={a.title} />
            )}
          </div>
          <Versions artifact={a} onVersion={onVersion} />
        </div>
      )}
    </Sheet>
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
                <span className="row" style={{ gap: 6 }}>
                  <span style={{ fontWeight: 600 }}>
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
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const save = useSaveArtifact(org.id, artifact.id);
  const [content, setContent] = useState<ArtifactContent>(artifact.content);
  const [note, setNote] = useState("");
  const [stale, setStale] = useState(false);
  return (
    <form
      className="stack-4"
      style={{ gap: 12 }}
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
              else toast.show(error.message, "error");
            },
          },
        );
      }}
    >
      <p className="small muted">{t("artifacts.editing", { version: artifact.version + 1 })}</p>
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
      <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
        <Button type="button" onClick={() => onDone(false)}>
          {t("artifacts.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={save.isPending || stale}>
          {t("artifacts.save")}
        </Button>
      </div>
    </form>
  );
}
