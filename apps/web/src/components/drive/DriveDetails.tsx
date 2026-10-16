import { Button, Chip, DetailsDialog, DetailsSection, Icon, Menu, MenuItem } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useArtifact, useArtifactVersions } from "@/api/queries";
import type { Artifact } from "@/api/types";
import { ActorAvatar } from "@/components/AgentAvatar";
import { ArtifactMoreMenu, useArtifactDownload } from "@/components/artifacts/ArtifactActions";
import { artifactLink, useArtifactViewer, useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { patchCounts } from "@/lib/artifacts";
import { formatBytes } from "@/lib/files";
import { relativeTime } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { itemIcon } from "./DriveItems";
import { DrivePreview } from "./DrivePreview";

/**
 * The selected item's details (the shared details dialog; full screen on a
 * phone): a large preview, Abrir / Baixar / Copiar link / …, who made it,
 * its versions and where it was shared.
 */
export function DriveDetails({
  artifact: a,
  channelName,
  onClose,
  onDelete,
}: {
  artifact: Artifact;
  channelName: (id: string | null) => string | null;
  onClose: () => void;
  onDelete: (a: Artifact) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const viewer = useArtifactViewer();
  const authorName = useAuthorName();
  const dir = useDirectory(org.id);
  const toast = useToast();
  const navigate = useNavigate();
  const downloads = useArtifactDownload();
  const detail = useArtifact(org.id, a.id, a.version);
  const versions = useArtifactVersions(org.id, a.id);
  const content = detail.data?.content;
  const formats = downloads.formats(a.kind);
  const isAgent = a.createdBy.type === "agent";
  const role = isAgent ? dir.agentById.get(a.createdBy.id)?.role : undefined;
  const channel = channelName(a.channelId);
  const kind = t(`artifacts.kind.${a.kind}`);
  const when = (iso: string) => relativeTime(t, i18n.language, iso);

  const facts = [
    content?.kind === "file" ? formatBytes(i18n.language, content.size) : null,
    content?.kind === "diff"
      ? t(
          "artifacts.counts",
          content.files.reduce(
            (s, f) => {
              const c = patchCounts(f.patch);
              return { added: s.added + c.added, removed: s.removed + c.removed };
            },
            { added: 0, removed: 0 },
          ),
        )
      : null,
    t("drive.updated", { when: when(a.updatedAt) }),
  ].filter(Boolean);

  const copyLink = async () => {
    await navigator.clipboard?.writeText(artifactLink(window.location.origin, org.id, a.id));
    toast.show(t("artifacts.linkCopied"));
  };

  const openFile = (version?: number) => {
    onClose();
    viewer.open(a.id, version);
  };

  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("drive.closeDetails")}
      className="drive-details"
      eyebrow={<Chip icon={itemIcon(a)}>{kind}</Chip>}
      title={a.title}
      subtitle={<span className="tabular">{facts.join(" · ")}</span>}
      page={{ label: t("artifacts.openFile"), onOpen: () => openFile() }}
    >
      <DrivePreview artifact={a} size="lg" />
      <div className="drive-details__actions">
        <Button variant="primary" icon="external" onClick={() => openFile()}>
          {t("artifacts.openFile")}
        </Button>
        {formats.length > 1 ? (
          <Menu
            align="end"
            label={t("drive.downloadAs")}
            trigger={<Button icon="download">{t("artifacts.downloadMenu")}</Button>}
          >
            {formats.map((f) => (
              <MenuItem key={f.key} icon={f.icon} onSelect={() => void downloads.save(a, f.format, a.version, content)}>
                {f.label}
              </MenuItem>
            ))}
          </Menu>
        ) : (
          <Button icon="download" onClick={() => void downloads.save(a, formats[0]?.format, a.version, content)}>
            {t("artifacts.download")}
          </Button>
        )}
        <Button
          iconOnly
          icon="link"
          aria-label={t("artifacts.copyLink")}
          title={t("artifacts.copyLink")}
          onClick={() => void copyLink()}
        />
        <ArtifactMoreMenu artifact={a} onDelete={() => onDelete(a)} />
      </div>

      <DetailsSection title={isAgent ? t("drive.madeBy") : t("drive.sentBy")}>
        <div className="drive-author">
          <ActorAvatar size="md" actor={a.createdBy} name={authorName(a.createdBy)} />
          <span>
            <b>{authorName(a.createdBy)}</b>
            <small>
              {isAgent
                ? role
                  ? t("drive.agentRole", { role })
                  : t("drive.agent")
                : t("drive.sentWhen", { when: when(a.createdAt) })}
            </small>
          </span>
        </div>
      </DetailsSection>

      {(versions.data?.length ?? 0) > 0 && (
        <DetailsSection title={t("artifacts.history")} count={versions.data?.length}>
          <ol className="drive-versions">
            {(versions.data ?? []).map((v) => {
              const latest = v.version === a.version;
              return (
                <li key={v.version} className={latest ? "drive-versions__current" : undefined}>
                  <span className="drive-versions__node" aria-hidden="true" />
                  <span className="drive-versions__text">
                    <span className="drive-versions__head">
                      {t("artifacts.version", { version: v.version })}
                      {latest && <Chip icon="check">{t("artifacts.latest")}</Chip>}
                    </span>
                    <span className="drive-versions__note">{v.note ?? t("artifacts.noNote")}</span>
                    <span className="drive-versions__who">
                      <ActorAvatar size="xs" actor={v.author} name={authorName(v.author)} />
                      {authorName(v.author)} · {when(v.createdAt)}
                    </span>
                  </span>
                  {!latest && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("drive.seeVersionLabel", { version: v.version })}
                      onClick={() => openFile(v.version)}
                    >
                      {t("drive.seeVersion")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
        </DetailsSection>
      )}

      <DetailsSection title={t("drive.whereShown")}>
        {a.channelId && channel ? (
          <button
            type="button"
            className="drive-where"
            onClick={() =>
              void navigate({
                to: "/org/$orgId/c/$channelId",
                params: { orgId: org.id, channelId: a.channelId ?? "" },
              })
            }
          >
            <span className="drive-where__icon">
              <Icon name="channel" size={16} />
            </span>
            <span className="drive-where__text">
              <b>{channel}</b>
              <small>{t("drive.sharedIn")}</small>
            </span>
          </button>
        ) : (
          <div className="drive-where">
            <span className="drive-where__icon">
              <Icon name="drive" size={16} />
            </span>
            <span className="drive-where__text">
              <b>{t("drive.onlyDrive")}</b>
              <small>{t("drive.onlyDriveText")}</small>
            </span>
          </div>
        )}
      </DetailsSection>
    </DetailsDialog>
  );
}
