import { Button, Chip, Icon, Menu, MenuItem } from "@agenteschat/ui";
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
import { DETAILS_ID, itemIcon } from "./DriveItems";
import { DrivePreview } from "./DrivePreview";

/**
 * The selected item beside the grid (a sheet from the bottom on phones): a
 * large preview, Abrir / Baixar / Copiar link / …, who made it, its versions
 * and where it was shared.
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

  return (
    <>
      <button
        type="button"
        className="drive-scrim"
        tabIndex={-1}
        aria-label={t("drive.closeDetails")}
        onClick={onClose}
      />
      <aside id={DETAILS_ID} className="drive-details" aria-label={t("drive.details", { title: a.title })}>
        <div className="drive-details__head">
          <Chip icon={itemIcon(a)}>{kind}</Chip>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="close"
            aria-label={t("drive.closeDetails")}
            title={t("drive.closeDetails")}
            onClick={onClose}
          />
        </div>
        <DrivePreview artifact={a} size="lg" />
        <div>
          <h2 className="drive-details__title">{a.title}</h2>
          <p className="drive-details__facts tabular">{facts.join(" · ")}</p>
        </div>
        <div className="drive-details__actions">
          <Button variant="primary" icon="external" onClick={() => viewer.open(a.id)}>
            {t("artifacts.openFile")}
          </Button>
          {formats.length > 1 ? (
            <Menu
              align="end"
              label={t("drive.downloadAs")}
              trigger={<Button icon="download">{t("artifacts.downloadMenu")}</Button>}
            >
              {formats.map((f) => (
                <MenuItem
                  key={f.key}
                  icon={f.icon}
                  onSelect={() => void downloads.save(a, f.format, a.version, content)}
                >
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

        <section className="drive-details__section">
          <h3 className="ac-eyebrow">{isAgent ? t("drive.madeBy") : t("drive.sentBy")}</h3>
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
        </section>

        {(versions.data?.length ?? 0) > 0 && (
          <section className="drive-details__section">
            <h3 className="ac-eyebrow">
              {t("artifacts.history")}
              <span className="drive-count tabular">{versions.data?.length}</span>
            </h3>
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
                        onClick={() => viewer.open(a.id, v.version)}
                      >
                        {t("drive.seeVersion")}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        <section className="drive-details__section">
          <h3 className="ac-eyebrow">{t("drive.whereShown")}</h3>
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
        </section>
      </aside>
    </>
  );
}
