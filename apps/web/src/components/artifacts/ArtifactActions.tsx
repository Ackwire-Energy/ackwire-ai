import { Button, Dialog, DialogFooter, Menu, MenuItem, MenuSeparator } from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { ApiError } from "@/api/http";
import { keys } from "@/api/keys";
import type { Artifact } from "@/api/types";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { artifactLink } from "./ArtifactViewer";

/**
 * "Apagar arquivo": a confirmation naming the file (it goes to the trash for
 * 30 days; messages that cite it show "Arquivo removido"), then a toast with
 * "Desfazer", which restores it.
 */
export function useDeleteArtifact(onDeleted?: () => void) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [target, setTarget] = useState<Pick<Artifact, "id" | "title"> | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.artifacts(org.id) });
  };
  const restore = async (id: string) => {
    try {
      await api.artifacts.restore(org.id, id);
      toast.show(t("artifacts.restored"));
    } catch (err) {
      toast.show(
        err instanceof ApiError && err.status === 409 ? t("artifacts.purged") : (err as Error).message,
        "error",
      );
    }
    refresh();
  };
  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.artifacts.remove(org.id, target.id);
      const id = target.id;
      setTarget(null);
      onDeleted?.();
      refresh();
      toast.show(t("artifacts.deleted"), "info", { label: t("artifacts.undo"), run: () => void restore(id) });
    } catch (err) {
      toast.show(
        err instanceof ApiError && err.status === 403 ? t("artifacts.deleteForbidden") : (err as Error).message,
        "error",
      );
    } finally {
      setBusy(false);
    }
  };
  const dialog = (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(o) => !o && setTarget(null)}
      title={t("artifacts.deleteTitle", { title: target?.title ?? "" })}
      description={t("artifacts.deleteBody")}
      closeLabel={t("common.close")}
      width={460}
    >
      <DialogFooter>
        <Button onClick={() => setTarget(null)}>{t("common.cancel")}</Button>
        <Button variant="danger" loading={busy} disabled={busy} onClick={() => void confirm()}>
          {t("artifacts.deleteConfirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
  return { ask: setTarget, dialog, restore };
}

/** "…" on a file (viewer header, Drive rows): link, channel, versions, delete. */
export function ArtifactMoreMenu({
  artifact,
  onVersions,
  onDelete,
  extra,
}: {
  artifact: Artifact;
  onVersions?: () => void;
  onDelete: () => void;
  /** Items before the separator (Drive adds "Abrir"). */
  extra?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const navigate = useNavigate();
  const label = t("artifacts.more", { title: artifact.title });
  return (
    <Menu
      align="end"
      label={label}
      trigger={
        <Button size="sm" variant="ghost" iconOnly icon="more" aria-label={label} title={t("artifacts.moreShort")} />
      }
    >
      {extra}
      <MenuItem
        icon="link"
        onSelect={async () => {
          await navigator.clipboard?.writeText(artifactLink(window.location.origin, org.id, artifact.id));
          toast.show(t("artifacts.linkCopied"));
        }}
      >
        {t("artifacts.copyLink")}
      </MenuItem>
      {artifact.channelId && (
        <MenuItem
          icon="channel"
          onSelect={() =>
            void navigate({
              to: "/org/$orgId/c/$channelId",
              params: { orgId: org.id, channelId: artifact.channelId ?? "" },
            })
          }
        >
          {t("artifacts.openInChannel")}
        </MenuItem>
      )}
      {onVersions && (
        <MenuItem icon="waiting" onSelect={onVersions}>
          {t("artifacts.seeVersions")}
        </MenuItem>
      )}
      {artifact.canDelete && (
        <>
          <MenuSeparator />
          <MenuItem icon="trash" danger onSelect={onDelete}>
            {t("artifacts.delete")}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
