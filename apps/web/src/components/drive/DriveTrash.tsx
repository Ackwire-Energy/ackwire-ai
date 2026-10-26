import { useArtifactTrash } from "@agenteschat/client";
import { daysLeft } from "@agenteschat/client/lib/drive";
import { relativeTime } from "@agenteschat/client/lib/format";
import { Button, Chip, EmptyState, Icon } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useDeleteArtifact } from "@/components/artifacts/ArtifactActions";
import { useAuthorName } from "@/components/artifacts/ArtifactViewer";
import { ErrorState, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { itemIcon } from "./DriveItems";

/** Few days left: the chip turns to attention. */
const SOON_DAYS = 3;

/**
 * "Lixeira": deleted files for 30 days, who made each, when it was deleted,
 * the days left (attention at 3 or fewer) and Restaurar.
 */
export function DriveTrash() {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const trash = useArtifactTrash(org.id);
  const remover = useDeleteArtifact();
  const authorName = useAuthorName();
  const list = trash.data ?? [];
  if (trash.isLoading) return <LoadingList count={3} trailing />;
  if (trash.isError && !trash.data) return <ErrorState error={trash.error} onRetry={() => void trash.refetch()} />;
  if (list.length === 0) {
    return (
      <EmptyState icon="trash" title={t("artifacts.trashEmpty")}>
        {t("drive.trashEmptyText")}
      </EmptyState>
    );
  }
  return (
    <>
      <p className="drive-note ac-iconline">
        <Icon name="clock" size={16} />
        <span>{t("drive.trashNote")}</span>
      </p>
      <ul className="drive-list drive-trash">
        {list.map((a) => {
          const left = daysLeft(a.purgeAt);
          const soon = left <= SOON_DAYS;
          return (
            <li key={a.id} className="drive-trash__row" data-kind={a.kind}>
              <span className="drive-trash__icon">
                <Icon name={itemIcon(a)} />
              </span>
              <span className="drive-trash__text">
                <b>{a.title}</b>
                <small>
                  <ActorAvatar size="xs" actor={a.createdBy} name={authorName(a.createdBy)} />
                  {t("drive.trashBy", {
                    name: authorName(a.createdBy),
                    when: relativeTime(t, i18n.language, a.deletedAt),
                  })}
                </small>
              </span>
              <Chip
                icon="clock"
                tone={soon ? "waiting" : "neutral"}
                title={new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short" }).format(
                  new Date(a.purgeAt),
                )}
              >
                {soon ? t("drive.goneIn", { count: left }) : t("drive.daysLeft", { count: left })}
              </Chip>
              <Button size="sm" icon="undo" onClick={() => void remover.restore(a.id).then(() => void trash.refetch())}>
                {t("artifacts.restore")}
              </Button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
