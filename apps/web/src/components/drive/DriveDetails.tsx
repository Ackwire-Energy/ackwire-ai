import type { Artifact } from "@agenteschat/client";
import { useArtifact, useArtifactVersions } from "@agenteschat/client";
import { patchCounts } from "@agenteschat/client/lib/artifacts";
import { artifactPlace } from "@agenteschat/client/lib/drive";
import { formatBytes } from "@agenteschat/client/lib/files";
import { relativeTime } from "@agenteschat/client/lib/format";
import { Button, Chip, DetailsDialog, DetailsSection, Icon, Menu, MenuItem } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { ArtifactMoreMenu, useArtifactDownload } from "@/components/artifacts/ArtifactActions";
import { artifactLink, useArtifactViewer, useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { goToTarget } from "@/components/NotificationOpen";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { itemIcon } from "./DriveItems";
import { DrivePreview } from "./DrivePreview";

/** Who can see a file, in plain words ("Só você e o Theo podem ver: veio de uma mensagem direta"). */
export function AudienceLine({ artifact: a }: { artifact: Pick<Artifact, "audience"> }) {
  const { t } = useTranslation();
  const authorName = useAuthorName();
  const aud = a.audience;
  const text =
    aud.kind === "workspace"
      ? t("drive.audience.workspace")
      : aud.kind === "channel"
        ? t(aud.private ? "drive.audience.privateChannel" : "drive.audience.publicChannel", { name: aud.name })
        : aud.with
          ? t("drive.audience.dm", { name: authorName(aud.with) })
          : t("drive.audience.dmGone");
  const priv = aud.kind === "dm" || (aud.kind === "channel" && aud.private);
  return (
    <p className="drive-audience ac-iconline" data-private={priv || undefined}>
      <Icon name={priv ? "lock" : "audienceEveryone"} size={16} />
      <span>{text}</span>
    </p>
  );
}

/**
 * The selected item's details (the shared details dialog; full screen on a
 * phone): a large preview, Abrir / Baixar / Copiar link / …, who can see it,
 * who made it, its versions and the conversation it came from.
 */
export function DriveDetails({
  artifact: a,
  onClose,
  onDelete,
}: {
  artifact: Artifact;
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
  const place = artifactPlace(a);
  const aud = a.audience;
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
        <ArtifactMoreMenu artifact={a} onDelete={() => onDelete(a)} plain />
      </div>
      <AudienceLine artifact={a} />

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
        {a.channelId ? (
          <WherePlace
            icon={aud.kind === "dm" ? "message" : "channel"}
            title={
              aud.kind === "channel"
                ? `#${aud.name}`
                : aud.kind === "dm" && aud.with
                  ? t("drive.dmWith", { name: authorName(aud.with) })
                  : t("drive.dm")
            }
            text={a.threadId ? t("drive.inThread") : aud.kind === "dm" ? t("drive.inDm") : t("drive.sharedIn")}
            onOpen={
              place
                ? () => {
                    onClose();
                    goToTarget(navigate, org.id, place);
                  }
                : undefined
            }
          />
        ) : (
          <WherePlace icon="drive" title={t("drive.onlyDrive")} text={t("drive.onlyDriveText")} />
        )}
      </DetailsSection>
    </DetailsDialog>
  );
}

/** The conversation a file came from: a button that opens it, or a plain line when there's nowhere to go. */
function WherePlace({
  icon,
  title,
  text,
  onOpen,
}: {
  icon: "message" | "channel" | "drive";
  title: string;
  text: string;
  onOpen?: () => void;
}) {
  const body = (
    <>
      <span className="drive-where__icon">
        <Icon name={icon} size={16} />
      </span>
      <span className="drive-where__text">
        <b>{title}</b>
        <small>{text}</small>
      </span>
    </>
  );
  return onOpen ? (
    <button type="button" className="drive-where" onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div className="drive-where">{body}</div>
  );
}
