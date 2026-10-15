import {
  AffixInput,
  Alert,
  Avatar,
  Button,
  Checkbox,
  CountBadge,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Input,
  Kbd,
  LogoMark,
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuSeparator,
  modKey,
  Skeleton,
  SkeletonGroup,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { keys } from "@/api/keys";
import { useChannels, useDms, useOverview, usePrefetchMessages } from "@/api/queries";
import { useAuth } from "@/auth/context";
import { useDirectory } from "@/hooks/useDirectory";
import { type LocaleCode, locales, setLocale } from "@/i18n";
import { audienceChip } from "@/lib/audience";
import { formatUsd } from "@/lib/format";
import { markOpen } from "@/lib/perf";
import { can } from "@/lib/permissions";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import type { SettingsSection } from "@/pages/SettingsPage";
import { AudienceChip } from "./AgentAudience";
import { AgentAvatar } from "./AgentAvatar";
import { openPalette } from "./CommandMenu";
import { NewChannelDialog } from "./NewChannelDialog";
import { useOrg } from "./org-context";
import { ProfilePhotoDialog } from "./ProfilePhoto";

/** Sidebar rows loading: an icon (or avatar) and a name bar, at the real row height. */
function SidebarSkeleton({ count, avatar, label }: { count: number; avatar?: boolean; label: string }) {
  return (
    <SkeletonGroup label={label}>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
        <span key={i} className="sidebar__item sidebar__item--skeleton">
          <Skeleton shape={avatar ? "square" : "block"} width={avatar ? 24 : 16} height={avatar ? 24 : 16} />
          <Skeleton width={[96, 72, 112][i % 3]} />
        </span>
      ))}
    </SkeletonGroup>
  );
}

/** The workspace sidebar (telas/Sidebar.dc.html). */
export function Sidebar() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const orgId = org.id;
  const dir = useDirectory(orgId);
  const channels = useChannels(orgId);
  const overview = useOverview(orgId);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const pending = overview.data?.approvalsWaitingForMe ?? 0;
  const people = dir.members.filter((m) => m.userId !== me.user.id);
  const spent = overview.data ? overview.data.myAgentsSpendUsd : null;
  const dms = useDms(orgId);
  const dmChannels = new Set((dms.data ?? []).map((d) => d.channelId));
  // Unread per DM partner (agents show it on their "Agentes" row; people under "Mensagens diretas").
  const unreadWith = new Map((dms.data ?? []).map((d) => [d.with.id, d.unread]));
  // Hover or focus loads the conversation before the click (DMs: once we know their channel).
  const prefetch = usePrefetchMessages(orgId);
  const dmWith = new Map((dms.data ?? []).map((d) => [d.with.id, d.channelId]));
  const prefetchDm = (partnerId: string) => {
    const channelId = dmWith.get(partnerId);
    if (channelId) prefetch(channelId);
  };

  // The active item's soft pill slides between items (one indicator, measured).
  const navRef = useRef<HTMLElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [indicator, setIndicator] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  // Measure from the active item itself, and again whenever anything in the sidebar changes size
  // (lists loading, fonts swapping in, the workspace card), so the pill never sits off its item.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on navigation and when the lists load
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const active = nav.querySelector<HTMLElement>('.sidebar__item[data-status="active"]');
      if (!active) {
        setIndicator(null);
        return;
      }
      const n = nav.getBoundingClientRect();
      const a = active.getBoundingClientRect();
      const next = { top: a.top - n.top + nav.scrollTop, left: a.left - n.left, width: a.width, height: a.height };
      setIndicator((prev) =>
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      );
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(nav);
    for (const child of Array.from(nav.children)) ro?.observe(child);
    document.fonts?.ready.then(measure).catch(() => {});
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [pathname, channels.data, dir.agents.length, people.length]);

  return (
    <nav className="sidebar" aria-label={t("shell.nav")} ref={navRef}>
      {indicator && (
        <span
          className="sidebar__indicator"
          aria-hidden="true"
          style={{
            transform: `translate(${indicator.left}px, ${indicator.top}px)`,
            width: indicator.width,
            height: indicator.height,
          }}
        />
      )}
      <div className="sidebar__org">
        <WorkspaceMenu
          summary={
            overview.data
              ? t("shell.summary", {
                  count: overview.data.people,
                  people: overview.data.people,
                  agents: overview.data.agents,
                })
              : null
          }
        />
        <Button asChild variant="ghost" iconOnly style={{ width: 32, height: 32 }}>
          <Link to="/org/$orgId/search" params={{ orgId }} aria-label={t("shell.searchWorkspace")}>
            <Icon name="search" />
          </Link>
        </Button>
      </div>

      <button type="button" className="sidebar__jump" onClick={openPalette}>
        <Icon name="search" />
        <span className="sidebar__item-label">{t("palette.jump")}</span>
        <Kbd>{modKey()}</Kbd>
        <Kbd>K</Kbd>
      </button>

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
        <Link to="/org/$orgId/wiki" params={{ orgId }} className="sidebar__item">
          <Icon name="book" />
          <span className="sidebar__item-label">{t("shell.wiki")}</span>
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
        {channels.isLoading && <SidebarSkeleton count={3} label={t("common.loadingList")} />}
        {(channels.data ?? [])
          .filter((c) => !dmChannels.has(c.id))
          .map((c) => (
            <Link
              key={c.id}
              to="/org/$orgId/c/$channelId"
              params={{ orgId, channelId: c.id }}
              className="sidebar__item"
              onMouseEnter={() => prefetch(c.id)}
              onFocus={() => prefetch(c.id)}
              onClick={() => markOpen(c.id)}
            >
              <Icon name="channel" className="sidebar__channel-icon" />
              <span className="sidebar__item-label">{c.name}</span>
            </Link>
          ))}
      </div>

      {dir.loading && dir.agents.length === 0 && (
        <div className="sidebar__group">
          <span className="sidebar__label">{t("shell.agents")}</span>
          <SidebarSkeleton count={2} avatar label={t("common.loadingList")} />
        </div>
      )}
      {dir.agents.length > 0 && (
        <div className="sidebar__group">
          <span className="sidebar__label">{t("shell.agents")}</span>
          {dir.agents.map((a) => (
            <Link
              key={a.id}
              to="/org/$orgId/dm/agent/$agentId"
              params={{ orgId, agentId: a.id }}
              className="sidebar__item"
              onMouseEnter={() => prefetchDm(a.id)}
              onFocus={() => prefetchDm(a.id)}
              onClick={() => markOpen(dmWith.get(a.id) ?? a.id)}
              data-unread={(unreadWith.get(a.id) ?? 0) > 0}
            >
              <AgentAvatar agentId={a.id} name={a.name} size="sm" />
              <span className="sidebar__item-label">{a.name}</span>
              {(unreadWith.get(a.id) ?? 0) > 0 ? (
                <UnreadCount count={unreadWith.get(a.id) ?? 0} />
              ) : (
                (audienceChip(t, a) ?? a.role) && (
                  <span className="sidebar__item-meta">
                    {audienceChip(t, a) ? <AudienceChip agent={a} compact /> : a.role}
                  </span>
                )
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
                onMouseEnter={() => prefetchDm(m.userId)}
                onFocus={() => prefetchDm(m.userId)}
                onClick={() => markOpen(dmWith.get(m.userId) ?? m.userId)}
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
        <div className="sidebar__me">
          <AccountMenu spent={spent === null ? null : formatUsd(t, i18n.language, spent)} />
          <Button asChild variant="ghost" iconOnly style={{ width: 32, height: 32 }}>
            <Link
              to="/org/$orgId/settings"
              params={{ orgId }}
              aria-label={t("shell.settings")}
              title={t("shell.settings")}
            >
              <Icon name="settings" />
            </Link>
          </Button>
        </div>
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
  const dir = useDirectory(org.id);
  const theme = useTheme();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const others = me.organizations.filter((o) => o.id !== org.id);
  const [profile, setProfile] = useState<"handle" | "timezone" | null>(null);

  const signOut = async () => {
    await auth.signOut();
    qc.clear();
    await navigate({ to: "/login" });
  };

  return (
    <>
      <Menu
        side="top"
        label={t("shell.account")}
        trigger={
          <button type="button" className="sidebar__user" aria-label={`${t("shell.account")}: ${me.user.name}`}>
            <Avatar name={me.user.name} size="sm" imageUrl={dir.memberById.get(me.user.id)?.image ?? me.user.image} />
            <span className="sidebar__user-name">{me.user.name}</span>
            {spent && <span className="sidebar__user-spend">{t("shell.spentThisMonth", { amount: spent })}</span>}
          </button>
        }
      >
        <MenuItem icon="person" onSelect={() => setProfile("handle")}>
          {t("shell.profile")}
        </MenuItem>
        <MenuItem icon="waiting" onSelect={() => setProfile("timezone")}>
          {t("shell.timezone")}
        </MenuItem>
        <MenuSeparator />
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
        {import.meta.env.DEV && (
          <MenuItem icon="agent" onSelect={() => void navigate({ to: "/dev/gallery" })}>
            {t("shell.gallery")}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem onSelect={() => void signOut()}>{t("auth.signOut")}</MenuItem>
      </Menu>
      <ProfileDialog focus={profile} onClose={() => setProfile(null)} />
    </>
  );
}

/**
 * The workspace header ("Acme · 2 membros · 3 agentes") opens this menu:
 * settings sections and members, as far as the role allows.
 */
function WorkspaceMenu({ summary }: { summary: string | null }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const go = (section?: SettingsSection) =>
    void (section
      ? navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section } })
      : navigate({ to: "/org/$orgId/settings", params: { orgId: org.id } }));
  const admin = can(org.role, "configure");
  return (
    <Menu
      label={t("shell.workspaceMenu")}
      trigger={
        <button
          type="button"
          className="sidebar__org-button"
          aria-label={t("shell.workspaceMenuOf", { name: org.name })}
        >
          <LogoMark className="sidebar__org-mark" />
          <span className="sidebar__org-text">
            <span className="sidebar__org-name">{org.name}</span>
            {summary && <span className="sidebar__org-meta">{summary}</span>}
          </span>
          <Icon name="chevronDown" size={16} />
        </button>
      }
    >
      <MenuItem icon="settings" onSelect={() => go()}>
        {t("shell.workspaceSettings")}
      </MenuItem>
      <MenuItem icon="link" onSelect={() => go("connectors")}>
        {t("settings.section.connectors")}
      </MenuItem>
      {admin && (
        <MenuItem icon="document" onSelect={() => go("skills")}>
          {t("settings.section.skills")}
        </MenuItem>
      )}
      {admin && (
        <MenuItem icon="agent" onSelect={() => go("access")}>
          {t("settings.section.access")}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem icon="members" onSelect={() => go("members")}>
        {t("shell.members")}
      </MenuItem>
      {can(org.role, "manage_members") && (
        <MenuItem icon="plus" onSelect={() => go("members")}>
          {t("shell.invite")}
        </MenuItem>
      )}
    </Menu>
  );
}

/** "Perfil" and "Fuso" in the account menu: my handle and time zone in this workspace. */
function ProfileDialog({ focus, onClose }: { focus: "handle" | "timezone" | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const dir = useDirectory(org.id);
  const mine = dir.memberById.get(me.user.id);
  const [handle, setHandle] = useState("");
  const [zone, setZone] = useState("");
  const [useOrgZone, setUseOrgZone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photo, setPhoto] = useState(false);
  useEffect(() => {
    if (!focus) return;
    setHandle(mine?.handle ?? "");
    setZone(mine?.timezone ?? "");
    setUseOrgZone(false);
    setError(null);
  }, [focus, mine]);
  const zoneOk = useOrgZone || isTimeZone(zone.trim());
  const save = useMutation({
    mutationFn: () =>
      api.orgs.updateMe(org.id, {
        handle: handle.trim() || undefined,
        timezone: useOrgZone ? null : zone.trim(),
      }),
    meta: { silent: true },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.members(org.id) });
      void qc.invalidateQueries({ queryKey: keys.people(org.id) });
      toast.show(t("shell.profileSaved"));
      onClose();
    },
    onError: (e) => setError(e.message),
  });
  return (
    <Dialog
      open={focus !== null}
      onOpenChange={(o) => !o && onClose()}
      title={t("shell.profileTitle")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (zoneOk) save.mutate();
        }}
      >
        <DialogBody>
          <div className="row" style={{ gap: 12, alignItems: "center" }}>
            <Avatar name={me.user.name} size="lg" imageUrl={mine?.image ?? me.user.image} />
            <div className="stack-4" style={{ gap: 2, flex: 1 }}>
              <span style={{ fontWeight: 600 }}>{t("photo.label")}</span>
              <span className="small muted">{t("photo.labelHelp")}</span>
            </div>
            <Button size="sm" type="button" onClick={() => setPhoto(true)}>
              {t("photo.change")}
            </Button>
          </div>
          <Field label={t("shell.handle")} id="me-handle" help={t("shell.handleHelp")}>
            <AffixInput
              prefix="@"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              autoFocus={focus === "handle"}
            />
          </Field>
          <Field
            label={t("shell.timezone")}
            id="me-zone"
            help={t("shell.timezoneHelp")}
            error={!zoneOk ? t("shell.timezoneInvalid") : undefined}
          >
            <Input
              value={zone}
              disabled={useOrgZone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="America/Sao_Paulo"
              autoFocus={focus === "timezone"}
            />
          </Field>
          <span className="row" style={{ gap: 8, alignItems: "center" }}>
            <Checkbox id="me-zone-org" checked={useOrgZone} onCheckedChange={setUseOrgZone} />
            <label htmlFor="me-zone-org">{t("shell.useOrgZone")}</label>
          </span>
          {error && <Alert>{error}</Alert>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!zoneOk || save.isPending} loading={save.isPending}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </form>
      <ProfilePhotoDialog open={photo} onClose={() => setPhoto(false)} />
    </Dialog>
  );
}

/** An IANA zone the browser knows ("America/Sao_Paulo"). */
export function isTimeZone(zone: string) {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
