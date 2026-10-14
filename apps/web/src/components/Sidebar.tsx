import {
  Avatar,
  Button,
  CountBadge,
  Icon,
  LogoMark,
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuSeparator,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useChannels, useDms, useOverview } from "@/api/queries";
import { useAuth } from "@/auth/context";
import { useDirectory } from "@/hooks/useDirectory";
import { type LocaleCode, locales, setLocale } from "@/i18n";
import { formatUsd } from "@/lib/format";
import { can } from "@/lib/permissions";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { useStreams } from "@/realtime/context";
import { runningAgents } from "@/realtime/streams";
import { NewChannelDialog } from "./NewChannelDialog";
import { useOrg } from "./org-context";

/** The workspace sidebar (telas/Sidebar.dc.html). */
export function Sidebar() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const orgId = org.id;
  const dir = useDirectory(orgId);
  const channels = useChannels(orgId);
  const overview = useOverview(orgId);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const running = useStreams(runningAgents);
  const pending = overview.data?.approvalsWaitingForMe ?? 0;
  const people = dir.members.filter((m) => m.userId !== me.user.id);
  const spent = overview.data ? overview.data.myAgentsSpendUsd : null;
  const dms = useDms(orgId);
  const dmChannels = new Set((dms.data ?? []).map((d) => d.channelId));
  // Unread per DM partner (agents show it on their "Agentes" row; people under "Mensagens diretas").
  const unreadWith = new Map((dms.data ?? []).map((d) => [d.with.id, d.unread]));

  return (
    <nav className="sidebar" aria-label={t("shell.nav")}>
      <div className="sidebar__org">
        <LogoMark className="sidebar__org-mark" />
        <div className="sidebar__org-text">
          <span className="sidebar__org-name">{org.name}</span>
          {overview.data && (
            <span className="sidebar__org-meta">
              {t("shell.summary", {
                count: overview.data.people,
                people: overview.data.people,
                agents: overview.data.agents,
              })}
            </span>
          )}
        </div>
        <Button asChild variant="ghost" iconOnly style={{ width: 32, height: 32 }}>
          <Link to="/org/$orgId/search" params={{ orgId }} aria-label={t("shell.searchWorkspace")}>
            <Icon name="search" />
          </Link>
        </Button>
      </div>

      <div className="sidebar__group">
        <Link to="/org/$orgId/approvals" params={{ orgId }} className="sidebar__item">
          <Icon name="waiting" />
          <span className="sidebar__item-label">{t("shell.approvals")}</span>
          {pending > 0 && (
            <CountBadge aria-label={t("shell.pendingApprovals", { count: pending })}>{pending}</CountBadge>
          )}
        </Link>
        <Link to="/org/$orgId/issues" params={{ orgId }} className="sidebar__item">
          <Icon name="issues" />
          <span className="sidebar__item-label">{t("shell.issues")}</span>
        </Link>
        <Link to="/org/$orgId/routines" params={{ orgId }} className="sidebar__item">
          <Icon name="routines" />
          <span className="sidebar__item-label">{t("shell.routines")}</span>
        </Link>
        <Link to="/org/$orgId/calendar" params={{ orgId }} className="sidebar__item">
          <Icon name="calendar" />
          <span className="sidebar__item-label">{t("shell.calendar")}</span>
        </Link>
        <Link to="/org/$orgId/forum" params={{ orgId }} className="sidebar__item">
          <Icon name="message" />
          <span className="sidebar__item-label">{t("shell.forum")}</span>
        </Link>
        <Link to="/org/$orgId/drive" params={{ orgId }} className="sidebar__item">
          <Icon name="drive" />
          <span className="sidebar__item-label">{t("shell.drive")}</span>
        </Link>
        <Link to="/org/$orgId/members" params={{ orgId }} className="sidebar__item">
          <Icon name="members" />
          <span className="sidebar__item-label">{t("shell.members")}</span>
        </Link>
      </div>

      <div className="sidebar__group">
        <div className="sidebar__label-row">
          <span className="sidebar__label">{t("shell.channels")}</span>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="plus"
            aria-label={t("newChannel.open")}
            onClick={() => setCreatingChannel(true)}
          />
        </div>
        {(channels.data ?? [])
          .filter((c) => !dmChannels.has(c.id))
          .map((c) => (
            <Link
              key={c.id}
              to="/org/$orgId/c/$channelId"
              params={{ orgId, channelId: c.id }}
              className="sidebar__item"
            >
              <Icon name="channel" className="sidebar__channel-icon" />
              <span className="sidebar__item-label">{c.name}</span>
            </Link>
          ))}
      </div>

      {dir.agents.length > 0 && (
        <div className="sidebar__group">
          <span className="sidebar__label">{t("shell.agents")}</span>
          {dir.agents.map((a) => (
            <Link
              key={a.id}
              to="/org/$orgId/dm/agent/$agentId"
              params={{ orgId, agentId: a.id }}
              className="sidebar__item"
              data-unread={(unreadWith.get(a.id) ?? 0) > 0}
            >
              <Avatar
                kind="agent"
                name={a.name}
                initials={dir.agentInitials(a.id)}
                size="sm"
                running={running.has(a.id)}
              />
              <span className="sidebar__item-label">{a.name}</span>
              {(unreadWith.get(a.id) ?? 0) > 0 ? (
                <UnreadCount count={unreadWith.get(a.id) ?? 0} />
              ) : (
                a.role && <span className="sidebar__item-meta">{a.role}</span>
              )}
            </Link>
          ))}
        </div>
      )}

      {people.length > 0 && (
        <div className="sidebar__group">
          <span className="sidebar__label">{t("shell.directMessages")}</span>
          {people.map((m) => {
            const unread = unreadWith.get(m.userId) ?? 0;
            return (
              <Link
                key={m.userId}
                to="/org/$orgId/dm/person/$userId"
                params={{ orgId, userId: m.userId }}
                className="sidebar__item"
                data-unread={unread > 0}
              >
                <Avatar name={m.name} size="sm" imageUrl={m.image} />
                <span className="sidebar__item-label">{m.name}</span>
                {unread > 0 && <UnreadCount count={unread} />}
              </Link>
            );
          })}
        </div>
      )}

      <NewChannelDialog open={creatingChannel} onOpenChange={setCreatingChannel} />

      <div className="sidebar__foot">
        {can(org.role, "manage_agents") && (
          <Button asChild block className="ac-btn--cut">
            <Link to="/org/$orgId/agents/new" params={{ orgId }}>
              <Icon name="plus" />
              {t("shell.createAgent")}
            </Link>
          </Button>
        )}
        <AccountMenu spent={spent === null ? null : formatUsd(t, i18n.language, spent)} />
      </div>
    </nav>
  );
}

/** Unread count: neutral (attention is for what waits on a person, not for unread chat). */
function UnreadCount({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <span className="sidebar__unread" role="img" aria-label={t("shell.unread", { count })}>
      {count}
    </span>
  );
}

function AccountMenu({ spent }: { spent: string | null }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const theme = useTheme();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const others = me.organizations.filter((o) => o.id !== org.id);

  const signOut = async () => {
    await auth.signOut();
    qc.clear();
    await navigate({ to: "/login" });
  };

  return (
    <Menu
      side="top"
      label={t("shell.account")}
      trigger={
        <button type="button" className="sidebar__user" aria-label={`${t("shell.account")}: ${me.user.name}`}>
          <Avatar name={me.user.name} size="sm" imageUrl={me.user.image} />
          <span className="sidebar__user-name">{me.user.name}</span>
          {spent && <span className="sidebar__user-spend">{t("shell.spentThisMonth", { amount: spent })}</span>}
        </button>
      }
    >
      <MenuRadioGroup
        label={t("shell.theme")}
        value={theme.preference}
        onValueChange={(v) => theme.setPreference(v as ThemePreference)}
        options={[
          { value: "system", label: t("shell.themeSystem") },
          { value: "light", label: t("shell.themeLight") },
          { value: "dark", label: t("shell.themeDark") },
        ]}
      />
      <MenuSeparator />
      <MenuRadioGroup
        label={t("shell.language")}
        value={i18n.language}
        onValueChange={(v) => setLocale(v as LocaleCode, i18n)}
        options={locales.map((l) => ({ value: l.code, label: l.label }))}
      />
      <MenuSeparator />
      {others.map((o) => (
        <MenuItem
          key={o.id}
          icon="channel"
          onSelect={() => void navigate({ to: "/org/$orgId", params: { orgId: o.id } })}
        >
          {o.name}
        </MenuItem>
      ))}
      <MenuItem icon="plus" onSelect={() => void navigate({ to: "/onboarding" })}>
        {t("shell.newOrg")}
      </MenuItem>
      {can(org.role, "configure") && (
        <MenuItem
          icon="settings"
          onSelect={() => void navigate({ to: "/org/$orgId/settings", params: { orgId: org.id } })}
        >
          {t("shell.orgSettings")}
        </MenuItem>
      )}
      {import.meta.env.DEV && (
        <MenuItem icon="agent" onSelect={() => void navigate({ to: "/dev/gallery" })}>
          {t("shell.gallery")}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem onSelect={() => void signOut()}>{t("auth.signOut")}</MenuItem>
    </Menu>
  );
}
