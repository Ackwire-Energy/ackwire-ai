import type { DashboardSummary } from "@agenteschat/client";
import { dashboardGroups, useDashboards, useMembers } from "@agenteschat/client";
import { relativeTime } from "@agenteschat/client/lib/format";
import { Button, EmptyState, Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { DashboardThumb } from "@/components/dashboards/DashboardThumb";
import { NewDashboardDialog } from "@/components/dashboards/NewDashboardDialog";
import { OwnerLine, roleNames, useCustomRoles } from "@/components/dashboards/parts";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { useNow } from "@/hooks/useNow";
import "./dashboards.css";

/**
 * Dashboards (ADR 0134 §14): "My Home" first, then the boards the person sees, grouped as the workspace's, their
 * roles' and only theirs, each a card with its widgets' thumbnail, who made it, how many widgets and when it was
 * updated; "New dashboard" makes one.
 */
export function DashboardsPage() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const list = useDashboards(org.id);
  const members = useMembers(org.id);
  const roles = useCustomRoles(org.id);
  const [creating, setCreating] = useState(false);
  const groups = dashboardGroups(list.data?.dashboards ?? []);
  const myRoleIds = members.data?.find((m) => m.userId === me.user.id)?.roleIds ?? [];
  const myRoles = roleNames(roles, myRoleIds);
  const none = groups.workspace.length + groups.roles.length + groups.mine.length === 0;
  const newButton = (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      {t("dashboards.new")}
    </Button>
  );
  return (
    <div className="page page--list dashboards">
      <header className="list-head">
        <div>
          <h1>{t("dashboards.title")}</h1>
          <p className="list-head__sub">{t("dashboards.subtitle")}</p>
        </div>
        {newButton}
      </header>
      {list.isLoading && <LoadingCards count={3} />}
      {list.isError && !list.data && <ErrorState error={list.error} onRetry={() => void list.refetch()} />}
      {list.data && (
        <>
          <section className="db-group" aria-label={t("dashboards.home")}>
            <div className="db-list">
              <Link to="/org/$orgId/home" params={{ orgId: org.id }} className="ac-card db-card">
                <DashboardThumb thumbs={list.data.home?.thumbs ?? []} />
                <span className="db-card__text">
                  <span className="db-card__title">
                    <Icon name="home" size={16} />
                    {t("dashboards.home")}
                  </span>
                  <span className="db-card__meta">
                    <span>{t("dashboards.meta.widgets", { count: list.data.home?.widgetCount ?? 0 })}</span>
                  </span>
                </span>
              </Link>
            </div>
          </section>
          <BoardGroup
            title={t("dashboards.groups.workspace")}
            hint={t("dashboards.groups.workspaceHint")}
            boards={groups.workspace}
          />
          <BoardGroup
            title={t("dashboards.groups.roles")}
            hint={myRoles ? t("dashboards.groups.rolesHint", { roles: myRoles }) : null}
            boards={groups.roles}
          />
          <BoardGroup title={t("dashboards.groups.mine")} hint={t("dashboards.groups.mineHint")} boards={groups.mine} />
          {none && (
            <EmptyState sky title={t("dashboards.empty.noneTitle")} actions={newButton}>
              {t("dashboards.empty.none")}
            </EmptyState>
          )}
        </>
      )}
      <NewDashboardDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function BoardGroup({ title, hint, boards }: { title: string; hint: string | null; boards: DashboardSummary[] }) {
  if (boards.length === 0) return null;
  return (
    <section className="db-group" aria-label={title}>
      <div className="list-group-head">
        <h2>{title}</h2>
        <span className="list-group-head__count">{boards.length}</span>
        {hint && <span className="db-group__hint">{hint}</span>}
      </div>
      <div className="db-list">
        {boards.map((b) => (
          <BoardCard key={b.id} board={b} />
        ))}
      </div>
    </section>
  );
}

/** A board on the list: its thumbnail, its title (a lock when not the whole workspace's), who made it, its size. */
function BoardCard({ board: b }: { board: DashboardSummary }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const now = useNow(60_000);
  return (
    <Link
      to="/org/$orgId/dashboards/$dashboardId"
      params={{ orgId: org.id, dashboardId: b.id }}
      className="ac-card db-card"
      aria-label={b.title}
    >
      <DashboardThumb thumbs={b.thumbs} />
      <span className="db-card__text">
        <span className="db-card__title">
          <span className="db-card__name">{b.title}</span>
          {b.audience !== "workspace" && <Icon name="lock" size={14} />}
        </span>
        <span className="db-card__meta">
          <OwnerLine owner={b.owner} mine={b.mine} />
          <span>
            {[
              t("dashboards.meta.widgets", { count: b.widgetCount }),
              t("dashboards.meta.updated", { when: relativeTime(t, i18n.language, b.updatedAt, new Date(now)) }),
            ].join(" · ")}
          </span>
        </span>
      </span>
    </Link>
  );
}
