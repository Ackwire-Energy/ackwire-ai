import { Checkbox, cx, Icon, type IconName, MenuItem } from "@agenteschat/ui";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Artifact, ArtifactKind } from "@/api/types";
import { ActorAvatar } from "@/components/AgentAvatar";
import { ArtifactMoreMenu } from "@/components/artifacts/ArtifactActions";
import { useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { KIND_ICON } from "@/lib/artifacts";
import { fileIcon } from "@/lib/files";
import { relativeTime } from "@/lib/format";
import { DrivePreview } from "./DrivePreview";

/** The details panel's id (cards and rows control it). */
export const DETAILS_ID = "drive-details";

/** The kind's icon; uploaded files by their name (the list has no content type). */
export const itemIcon = (a: Pick<Artifact, "kind" | "title">): IconName =>
  a.kind === "file" ? fileIcon(a.title) : (KIND_ICON[a.kind as ArtifactKind] ?? "file");

export interface ItemProps {
  artifact: Artifact;
  /** Shown in the details panel. */
  open: boolean;
  selected: boolean;
  channelName: (id: string | null) => string;
  /** A click: details, or selection with Shift / ⌘ / while selecting. */
  onPick: (a: Artifact, e: MouseEvent) => void;
  onToggle: (a: Artifact) => void;
  /** Straight to the viewer (double click, "Abrir"). */
  onOpen: (a: Artifact) => void;
}

/**
 * A grid card: the real preview, the kind (and version) on glass, the title,
 * who made it, where and when. The title's button stretches over the card;
 * the checkbox sits above it.
 */
export function DriveCard({ artifact: a, open, selected, channelName, onPick, onToggle, onOpen }: ItemProps) {
  const { t, i18n } = useTranslation();
  const authorName = useAuthorName();
  const name = authorName(a.createdBy);
  return (
    <article
      className={cx("drive-card", open && "drive-card--open", selected && "drive-card--selected")}
      data-kind={a.kind}
    >
      <DrivePreview artifact={a} />
      <span className="drive-card__kind">
        <Icon name={itemIcon(a)} size={14} />
        <span>
          {t(`artifacts.kind.${a.kind}`)}
          {a.version > 1 && ` · ${t("artifacts.version", { version: a.version })}`}
        </span>
      </span>
      <div className="drive-card__body">
        <button
          type="button"
          className="drive-card__title drive-hit"
          aria-expanded={open}
          aria-controls={open ? DETAILS_ID : undefined}
          onClick={(e) => onPick(a, e)}
          onDoubleClick={() => onOpen(a)}
        >
          {a.title}
        </button>
        <span className="drive-card__meta">
          <ActorAvatar size="xs" actor={a.createdBy} name={name} />
          <span className="drive-card__name">{name}</span>
          <span className="drive-card__where">{channelName(a.channelId)}</span>
          <time className="drive-card__when tabular" dateTime={a.updatedAt}>
            {relativeTime(t, i18n.language, a.updatedAt)}
          </time>
        </span>
      </div>
      <Checkbox
        className="drive-check"
        checked={selected}
        onCheckedChange={() => onToggle(a)}
        aria-label={t("drive.select", { title: a.title })}
      />
    </article>
  );
}

/** A list row: checkbox, small preview + title, who, where, when, "…". */
export function DriveRow({
  artifact: a,
  open,
  selected,
  channelName,
  onPick,
  onToggle,
  onOpen,
  onDelete,
}: ItemProps & { onDelete: (a: Artifact) => void }) {
  const { t, i18n } = useTranslation();
  const authorName = useAuthorName();
  const name = authorName(a.createdBy);
  const when = relativeTime(t, i18n.language, a.updatedAt);
  return (
    <li className={cx("drive-row", open && "drive-row--open", selected && "drive-row--selected")} data-kind={a.kind}>
      <Checkbox
        className="drive-check"
        checked={selected}
        onCheckedChange={() => onToggle(a)}
        aria-label={t("drive.select", { title: a.title })}
      />
      <span className="drive-row__name">
        <DrivePreview artifact={a} size="sm" />
        <span className="drive-row__text">
          <button
            type="button"
            className="drive-row__title drive-hit"
            aria-expanded={open}
            aria-controls={open ? DETAILS_ID : undefined}
            onClick={(e) => onPick(a, e)}
            onDoubleClick={() => onOpen(a)}
          >
            {a.title}
          </button>
          <span className="drive-row__sub">
            <Icon name={itemIcon(a)} size={14} />
            {t(`artifacts.kind.${a.kind}`)}
            {a.version > 1 && ` · ${t("artifacts.version", { version: a.version })}`}
            <span className="drive-row__mobile">{` · ${name} · ${when}`}</span>
          </span>
        </span>
      </span>
      <span className="drive-row__who">
        <ActorAvatar size="xs" actor={a.createdBy} name={name} />
        <span>{name}</span>
      </span>
      <span className="drive-row__where">{channelName(a.channelId)}</span>
      <time className="drive-row__when tabular" dateTime={a.updatedAt}>
        {when}
      </time>
      <span className="drive-row__more">
        <ArtifactMoreMenu
          artifact={a}
          onDelete={() => onDelete(a)}
          extra={
            <MenuItem icon="external" onSelect={() => onOpen(a)}>
              {t("artifacts.openFile")}
            </MenuItem>
          }
        />
      </span>
    </li>
  );
}
