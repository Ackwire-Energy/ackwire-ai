import type { Dashboard } from "@agenteschat/client";
import { useDashboard, useDeleteDashboard, useUpdateDashboard } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { relativeTime } from "@agenteschat/client/lib/format";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  Icon,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Textarea,
  useDarkTheme,
  widgetTileVars,
} from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { NewWidgetDialog } from "@/components/dashboards/NewWidgetDialog";
import { ProposalBanner } from "@/components/dashboards/ProposalBanner";
import { OwnerLine, VisibilityChip } from "@/components/dashboards/parts";
import { ShareDashboardDialog } from "@/components/dashboards/ShareDialog";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { BoardActionsPill } from "@/components/widgets/parts";
import { WidgetBoard } from "@/components/widgets/WidgetBoard";
import { WidgetPanel } from "@/components/widgets/WidgetPanel";
import { useDirectory } from "@/hooks/useDirectory";
import { useNow } from "@/hooks/useNow";
import { useOpenParam } from "@/lib/open-param";
import { useToast } from "@/lib/toast";
import "./dashboards.css";

/**
 * One board (ADR 0135 §14): back to Dashboards, its title with Share, Organize and "+", a line with who sees it, who
 * made it, how many widgets and when it was updated, an agent's request to publish it, then its widgets (the
 * 4-column grid, Organize to drag and resize) or an empty state. `?widget=<id>` opens a widget's side panel, so a
 * notification or a link opens it. A home board belongs on Home.
 */
export function DashboardPage({ dashboardId }: { dashboardId: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const query = useDashboard(org.id, dashboardId);
  const [widgetId, setWidgetId] = useOpenParam("widget");
  const board = query.data;
  // A person's home board is their Home page: its widgets open there.
  useEffect(() => {
    if (board?.kind !== "home") return;
    void navigate({
      to: "/org/$orgId/home",
      params: { orgId: org.id },
      search: (widgetId ? { widget: widgetId } : {}) as never,
      replace: true,
    });
  }, [board?.kind, navigate, org.id, widgetId]);
  if (query.isLoading)
    return (
      <div className="page page--list dashboards">
        <LoadingCards count={3} />
      </div>
    );
  if (!board) {
    const missing = ["dashboard.not_found", "dashboard.forbidden"].includes(errorCode(query.error) ?? "");
    return (
      <div className="page page--list dashboards">
        <BackCrumb />
        {missing ? (
          <EmptyState icon="grid" title={t("dashboards.errors.notFound")} />
        ) : (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        )}
      </div>
    );
  }
  if (board.kind === "home") return null;
  return <Board board={board} widgetId={widgetId} onWidget={setWidgetId} />;
}

function BackCrumb() {
  const { t } = useTranslation();
  const { org } = useOrg();
  return (
    <Link to="/org/$orgId/dashboards" params={{ orgId: org.id }} className="db-crumb">
      <Icon name="chevronLeft" size={16} />
      {t("dashboards.back")}
    </Link>
  );
}

function Board({
  board,
  widgetId,
  onWidget,
}: {
  board: Dashboard;
  widgetId: string | null;
  onWidget: (id: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const dark = useDarkTheme();
  const now = useNow(60_000);
  const [arranging, setArranging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const update = useUpdateDashboard(org.id);
  const toast = useToast();
  const count = board.widgets.length;
  const empty = count === 0;
  // The empty state's art is in the tones of the board's owner when an agent made it, else of the first agent.
  const artAgent = dir.anyAgent(board.owner?.kind === "agent" ? board.owner.id : (dir.agents[0]?.id ?? ""));
  const setPinned = (pinned: boolean) =>
    update.mutate({ dashboardId: board.id, pinned }, { onError: (error) => toast.show(errorText(t, error), "error") });
  return (
    <div className="page page--list dashboards db-page">
      <header className="db-head">
        <BackCrumb />
        <div className="db-head__row">
          <h1>{board.title}</h1>
          <div className="db-acts">
            {board.canManage && (
              <Button
                size="sm"
                icon={board.audience === "workspace" ? "globe" : "lock"}
                onClick={() => setSharing(true)}
              >
                {t("dashboards.share.action")}
              </Button>
            )}
            {board.canEdit && (
              <BoardActionsPill
                label={board.title}
                arranging={arranging}
                onArrange={empty ? undefined : () => setArranging((a) => !a)}
                onAdd={() => setAdding(true)}
              />
            )}
            {(board.canEdit || board.canManage) && (
              <Menu
                label={t("widgets.menu.label")}
                align="end"
                trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={t("widgets.menu.label")} />}
              >
                {board.canEdit && (
                  <MenuItem icon="edit" onSelect={() => setRenaming(true)}>
                    {t("dashboards.rename")}
                  </MenuItem>
                )}
                {board.canManage && (
                  <MenuItem icon="pin" onSelect={() => setPinned(!board.pinned)}>
                    {board.pinned ? t("dashboards.unpin") : t("dashboards.pinTop")}
                  </MenuItem>
                )}
                {board.canManage && <MenuSeparator />}
                {board.canManage && (
                  <MenuItem icon="trash" danger onSelect={() => setDeleting(true)}>
                    {t("dashboards.delete.action")}
                  </MenuItem>
                )}
              </Menu>
            )}
          </div>
        </div>
        {board.about && <p className="list-head__sub">{board.about}</p>}
        <div className="db-meta">
          <VisibilityChip board={board} />
          <OwnerLine owner={board.owner} mine={board.mine} />
          <span className="db-dot" aria-hidden="true">
            ·
          </span>
          <span>{t("dashboards.meta.widgets", { count })}</span>
          <span className="db-dot" aria-hidden="true">
            ·
          </span>
          <span>
            {t("dashboards.meta.updated", { when: relativeTime(t, i18n.language, board.updatedAt, new Date(now)) })}
          </span>
        </div>
      </header>
      <ProposalBanner board={board} />
      {empty ? (
        <div className="db-empty" style={widgetTileVars(colorOf(artAgent), dark)}>
          <span className="db-empty__art" aria-hidden="true" />
          <b>{t("dashboards.empty.title")}</b>
          <span>{t("dashboards.empty.text")}</span>
          {board.canEdit && (
            <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>
              {t("widgets.add.label")}
            </Button>
          )}
        </div>
      ) : (
        <WidgetBoard
          orgId={org.id}
          board={board}
          arranging={arranging}
          onOpen={(id) => onWidget(id)}
          onChangeSchedule={(id) => onWidget(id)}
        />
      )}
      <WidgetPanel orgId={org.id} widgetId={widgetId} onClose={() => onWidget(null)} />
      <NewWidgetDialog orgId={org.id} open={adding} onClose={() => setAdding(false)} dashboardId={board.id} />
      <ShareDashboardDialog board={board} open={sharing} onClose={() => setSharing(false)} />
      <RenameDialog board={board} open={renaming} onClose={() => setRenaming(false)} />
      <DeleteDialog board={board} open={deleting} onClose={() => setDeleting(false)} />
    </div>
  );
}

/** Rename: the board's title and what it is for. */
function RenameDialog({ board, open, onClose }: { board: Dashboard; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("dashboards.rename")}
      closeLabel={t("common.close")}
      width={440}
    >
      {open && <RenameBody board={board} onClose={onClose} />}
    </Dialog>
  );
}

function RenameBody({ board, onClose }: { board: Dashboard; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const update = useUpdateDashboard(org.id);
  const [title, setTitle] = useState(board.title);
  const [about, setAbout] = useState(board.about);
  const ready = title.trim().length > 0;
  return (
    <form
      className="db-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        update.mutate(
          { dashboardId: board.id, title: title.trim(), about: about.trim() },
          { onSuccess: onClose, onError: (error) => toast.show(errorText(t, error), "error") },
        );
      }}
    >
      <DialogBody className="db-dialog__body">
        <Field label={t("dashboards.create.name")}>
          <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={t("dashboards.about")}>
          <Textarea
            rows={2}
            value={about}
            maxLength={280}
            placeholder={t("dashboards.aboutPlaceholder")}
            onChange={(e) => setAbout(e.target.value)}
          />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={!ready} loading={update.isPending}>
          {t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Delete: the board, its widgets and their routines (ADR 0135 §8: its owner and admins). */
function DeleteDialog({ board, open, onClose }: { board: Dashboard; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const remove = useDeleteDashboard(org.id);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("dashboards.delete.title", { title: board.title })}
      description={t("dashboards.delete.text")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={remove.isPending}
          onClick={() =>
            remove.mutate(board.id, {
              onSuccess: () => {
                toast.show(t("dashboards.delete.done", { title: board.title }));
                onClose();
                void navigate({ to: "/org/$orgId/dashboards", params: { orgId: org.id } });
              },
              onError: (error) => toast.show(errorText(t, error), "error"),
            })
          }
        >
          {t("dashboards.delete.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
