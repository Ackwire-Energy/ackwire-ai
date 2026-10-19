import type { Agent } from "@agenteschat/client";
import {
  agentStateIn,
  keys,
  runningAgents,
  useChannels,
  useConnections,
  useDms,
  useMachineOutages,
  useMissionList,
  useNotificationCount,
  useOverview,
  usePrefetchMessages,
  useSkills,
} from "@agenteschat/client";
import { audienceChip } from "@agenteschat/client/lib/audience";
import { formatPercent } from "@agenteschat/client/lib/format";
import { waitingAgents } from "@agenteschat/client/lib/outages";
import { can } from "@agenteschat/client/lib/permissions";
import { browserTimezone } from "@agenteschat/client/lib/routines";
import {
  AffixInput,
  Alert,
  Avatar,
  Button,
  Checkbox,
  CountBadge,
  CountChip,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Kbd,
  MenuOverlay,
  MenuOverlayGroup,
  MenuOverlayItem,
  MenuOverlayRow,
  MenuOverlaySeparator,
  modKey,
  Segmented,
  Skeleton,
  SkeletonGroup,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useAuth } from "@/auth/context";
import { ZoneSelect } from "@/components/ZoneSelect";
import { useDirectory } from "@/hooks/useDirectory";
import { type LocaleCode, locales, setLocale } from "@/i18n";
import { markOpen } from "@/lib/perf";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import type { SettingsSection } from "@/pages/SettingsPage";
import { useStreams } from "@/realtime/context";
import { AudienceChip } from "./AgentAudience";
import { AgentAvatar } from "./AgentAvatar";
import { openPalette } from "./CommandMenu";
import { COMPACT_QUERY, useMediaQuery, useNavDrawer } from "./NavDrawer";
import { NewChannelDialog } from "./NewChannelDialog";
import { useOrg } from "./org-context";
import { OrgMark, ProfilePhotoDialog } from "./ProfilePhoto";
import { AgentGlow, AgentTrail, colorOf, MenuHorizon, SidebarHorizon, SidebarOrgSky } from "./Sky";

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

/** Tablet widths: the sidebar is always an icon rail (NavDrawer.tsx has the other breakpoints). */
const TABLET_QUERY = "(min-width: 761px) and (max-width: 1199px)";

/** The workspace sidebar (telas/Sidebar.dc.html). */
export function Sidebar() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const orgId = org.id;
  const dir = useDirectory(orgId);
  const channels = useChannels(orgId);
  const overview = useOverview(orgId);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const pending = overview.data?.approvalsWaitingForMe ?? 0;
  // The bell: unread notifications (live through `notification.counts`); the badge bumps when one arrives.
  const unreadNotifications = useNotificationCount(orgId).data?.unread ?? 0;
  const lastUnread = useRef(unreadNotifications);
  const [bumps, setBumps] = useState(0);
  useEffect(() => {
    if (unreadNotifications > lastUnread.current) setBumps((b) => b + 1);
    lastUnread.current = unreadNotifications;
  }, [unreadNotifications]);
  // Threads: how many open missions wait for me (the server counts: a decision, a review, a suggestion…).
  const missionList = useMissionList(orgId, { status: "waiting_you", limit: 1 });
  const missionsWaiting = missionList.data?.counts.waitingYou ?? 0;
  const people = dir.members.filter((m) => m.userId !== me.user.id);
  // Agents waiting for an offline computer: "esperando" instead of anything "working".
  const outages = useMachineOutages(orgId);
  const waitingFor = useMemo(() => waitingAgents(outages.data), [outages.data]);
  const budgetUsed = overview.data ? overview.data.budgetUsedPercent : null;
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

  // How many of the workspace's agents are working now: the sky at the bottom rises with it.
  const agentIds = dir.agents.map((a) => a.id).join();
  const working = useStreams((st) => {
    const busy = runningAgents(st);
    return agentIds ? agentIds.split(",").filter((id) => busy.has(id)).length : 0;
  });
  const orgRef = useRef<HTMLDivElement>(null);
  // Narrow screens: the sidebar is a drawer (id, open state, close on link / swipe).
  const drawer = useNavDrawer();
  // Desktop: the person can shrink the sidebar to an icon rail (remembered). Tablets always get the rail.
  const compact = useMediaQuery(COMPACT_QUERY);
  const tablet = useMediaQuery(TABLET_QUERY);
  const [collapsed, setCollapsed] = useState(() => storage.get(STORAGE_KEYS.sidebarCollapsed) === "1");
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      storage.set(STORAGE_KEYS.sidebarCollapsed, c ? "0" : "1");
      return !c;
    });
  };
  const rail = !compact && (tablet || collapsed);

  // The active item's soft pill slides between items (one indicator, measured). Only the middle
  // scrolls: the workspace card on top and the foot stay put.
  const navRef = useRef<HTMLDivElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [indicator, setIndicator] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  // Measure from the active item itself, and again whenever anything in the sidebar changes size
  // (lists loading, fonts swapping in, the workspace card), so the pill never sits off its item.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on navigation and when the lists load
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    // The list fades out at an edge only while there is more to scroll past it (no hard cut).
    const edges = () => {
      nav.dataset.fadeTop = String(nav.scrollTop > 1);
      nav.dataset.fadeBottom = String(nav.scrollTop + nav.clientHeight < nav.scrollHeight - 1);
    };
    const measure = () => {
      edges();
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
    nav.addEventListener("scroll", edges, { passive: true });
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
      nav.removeEventListener("scroll", edges);
    };
  }, [pathname, channels.data, dir.agents.length, people.length, rail]);

  // The open conversation stays in sight: once per navigation (as soon as its row exists), a row
  // hidden past the list's edge is brought to the middle. Later scrolling is the person's.
  const shownFor = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry when the lists load
  useLayoutEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('.sidebar__item[data-status="active"]');
    if (!nav || !active || shownFor.current === pathname) return;
    shownFor.current = pathname;
    const n = nav.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    if (a.top < n.top || a.bottom > n.bottom) nav.scrollTop += a.top - n.top - (nav.clientHeight - a.height) / 2;
  }, [pathname, channels.data, dir.agents.length, people.length, rail]);

  return (
    <nav className="sidebar" aria-label={t("shell.nav")} data-rail={rail} {...drawer?.navProps}>
      <div className="sidebar__top">
        <div className="sidebar__org" ref={orgRef}>
          <SidebarOrgSky calm={() => [orgRef.current?.querySelector(".sidebar__org-text") ?? null]} />
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
          <Button asChild variant="ghost" size="sm" iconOnly>
            <Link to="/org/$orgId/search" params={{ orgId }} aria-label={t("shell.searchWorkspace")}>
              <Icon name="search" />
            </Link>
          </Button>
        </div>

        <div className="sidebar__jump-row">
          <button type="button" className="sidebar__jump" onClick={openPalette} title={t("palette.jump")}>
            <Icon name="search" />
            <span className="sidebar__item-label">{t("palette.jump")}</span>
            <Kbd>{modKey()}</Kbd>
            <Kbd>K</Kbd>
          </button>
          {!compact && !tablet && (
            <Button
              variant="ghost"
              iconOnly
              icon="sidebar"
              className="sidebar__collapse"
              aria-label={collapsed ? t("shell.expandNav") : t("shell.collapseNav")}
              title={collapsed ? t("shell.expandNav") : t("shell.collapseNav")}
              aria-expanded={!collapsed}
              onClick={toggleCollapsed}
            />
          )}
        </div>
      </div>

      <div className="sidebar__scroll" ref={navRef}>
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

        <div className="sidebar__group">
          <Link
            to="/org/$orgId/notifications"
            params={{ orgId }}
            className="sidebar__item"
            title={t("shell.notifications")}
          >
            <Icon name="bell" />
            <span className="sidebar__item-label">{t("shell.notifications")}</span>
            {unreadNotifications > 0 && (
              <CountBadge
                key={bumps}
                className={bumps > 0 ? "sidebar__bump" : undefined}
                aria-label={t("shell.unreadNotifications", { count: unreadNotifications })}
              >
                {unreadNotifications}
              </CountBadge>
            )}
          </Link>
          <Link to="/org/$orgId/approvals" params={{ orgId }} className="sidebar__item" title={t("shell.approvals")}>
            <Icon name="waiting" />
            <span className="sidebar__item-label">{t("shell.approvals")}</span>
            {pending > 0 && (
              <CountBadge aria-label={t("shell.pendingApprovals", { count: pending })}>{pending}</CountBadge>
            )}
          </Link>
          {/* Missões is a tab of Threads: one item, with the missions waiting for me as a neutral count. */}
          <Link to="/org/$orgId/threads" params={{ orgId }} className="sidebar__item" title={t("shell.threads")}>
            <Icon name="thread" />
            <span className="sidebar__item-label">{t("shell.threads")}</span>
            {missionsWaiting > 0 && (
              <CountChip
                className="sidebar__count"
                role="img"
                aria-label={t("shell.missionsWaiting", { count: missionsWaiting })}
              >
                {missionsWaiting}
              </CountChip>
            )}
          </Link>
          <Link to="/org/$orgId/issues" params={{ orgId }} className="sidebar__item" title={t("shell.issues")}>
            <Icon name="issues" />
            <span className="sidebar__item-label">{t("shell.issues")}</span>
          </Link>
          <Link to="/org/$orgId/routines" params={{ orgId }} className="sidebar__item" title={t("shell.routines")}>
            <Icon name="routines" />
            <span className="sidebar__item-label">{t("shell.routines")}</span>
          </Link>
          <Link to="/org/$orgId/calendar" params={{ orgId }} className="sidebar__item" title={t("shell.calendar")}>
            <Icon name="calendar" />
            <span className="sidebar__item-label">{t("shell.calendar")}</span>
          </Link>
          <Link to="/org/$orgId/forum" params={{ orgId }} className="sidebar__item" title={t("shell.forum")}>
            <Icon name="message" />
            <span className="sidebar__item-label">{t("shell.forum")}</span>
          </Link>
          <Link to="/org/$orgId/wiki" params={{ orgId }} className="sidebar__item" title={t("shell.wiki")}>
            <Icon name="book" />
            <span className="sidebar__item-label">{t("shell.wiki")}</span>
          </Link>
          <Link to="/org/$orgId/drive" params={{ orgId }} className="sidebar__item" title={t("shell.drive")}>
            <Icon name="drive" />
            <span className="sidebar__item-label">{t("shell.drive")}</span>
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
                title={`#${c.name}`}
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
            <Link to="/org/$orgId/team" params={{ orgId }} className="sidebar__item" title={t("shell.team")}>
              <Icon name="agent" />
              <span className="sidebar__item-label">{t("shell.team")}</span>
            </Link>
            {dir.agents.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                unread={unreadWith.get(a.id) ?? 0}
                waitingFor={waitingFor.get(a.id)}
                onPrefetch={() => prefetchDm(a.id)}
                onOpen={() => markOpen(dmWith.get(a.id) ?? a.id)}
              />
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
                  title={m.name}
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
      </div>

      <NewChannelDialog open={creatingChannel} onOpenChange={setCreatingChannel} />

      <div className="sidebar__foot">
        <SidebarHorizon working={working} total={dir.agents.length} />
        {can(org.role, "manage_agents") && (
          <Button asChild block className="ac-btn--cut sidebar__create">
            <Link to="/org/$orgId/agents/new" params={{ orgId }} title={t("shell.createAgent")}>
              <Icon name="plus" />
              <span className="sidebar__item-label">{t("shell.createAgent")}</span>
            </Link>
          </Button>
        )}
        <div className="sidebar__me">
          <AccountMenu budgetUsed={budgetUsed} />
          <Button asChild variant="ghost" size="sm" iconOnly>
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

/** An agent in the sidebar; while it works, a light sweep in its color runs behind the row (a pulse in the rail). */
function AgentRow({
  agent: a,
  unread,
  waitingFor,
  onPrefetch,
  onOpen,
}: {
  agent: Agent;
  unread: number;
  /** The offline computer it waits for (its brain runs there). */
  waitingFor?: string;
  onPrefetch: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const state = useStreams((st) => agentStateIn(st, a.id));
  const busy = state !== "idle" && !waitingFor;
  const color = colorOf(a);
  const chip = audienceChip(t, a);
  return (
    <Link
      to="/org/$orgId/dm/agent/$agentId"
      params={{ orgId: org.id, agentId: a.id }}
      className="sidebar__item"
      title={a.role ? `${a.name} · ${a.role}` : a.name}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      onClick={onOpen}
      data-unread={unread > 0}
      data-busy={busy}
    >
      {busy && <AgentTrail color={color} />}
      {busy && <AgentGlow color={color} />}
      <AgentAvatar
        agentId={a.id}
        name={a.name}
        size="sm"
        {...(waitingFor ? { state: "idle" as const, expression: "closed" as const } : {})}
      />
      <span className="sidebar__item-label">{a.name}</span>
      {unread > 0 ? (
        <UnreadCount count={unread} />
      ) : waitingFor ? (
        <span className="sidebar__item-meta sidebar__waiting" title={t("outage.sidebar.tip", { name: waitingFor })}>
          <Icon name="waiting" size={14} />
          {t("outage.sidebar.waiting")}
        </span>
      ) : busy ? (
        <span className="sidebar__item-meta sidebar__busy">{t(`sky.busy.${state}`)}</span>
      ) : (
        (chip ?? a.role) && (
          <span className="sidebar__item-meta">{chip ? <AudienceChip agent={a} compact /> : a.role}</span>
        )
      )}
    </Link>
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

/**
 * The account button; under the name, the workspace's budget use this month
 * (a percentage, never money). It opens the account's full-screen menu
 * (telas/MenuOverlay.html): profile, time zone, theme, language, the budget
 * and signing out.
 */
function AccountMenu({ budgetUsed }: { budgetUsed: number | null }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const theme = useTheme();
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [profile, setProfile] = useState<"handle" | "timezone" | null>(null);
  const mine = dir.memberById.get(me.user.id);
  const photo = mine?.image ?? me.user.image;
  const zone = mine?.timezone || browserTimezone() || "UTC";
  // Closes the menu first, then does what was picked (a dialog opens over the app, not over the menu).
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  const signOut = async () => {
    await auth.signOut();
    qc.clear();
    await navigate({ to: "/login" });
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="sidebar__user"
        aria-haspopup="dialog"
        aria-label={
          budgetUsed === null
            ? `${t("shell.account")}: ${me.user.name}`
            : `${t("shell.account")}: ${me.user.name}. ${t("shell.budgetUsed", { percent: formatPercent(i18n.language, budgetUsed) })}`
        }
        title={me.user.name}
        onClick={() => setOpen(true)}
      >
        <Avatar name={me.user.name} size="sm" imageUrl={photo} />
        <span className="sidebar__user-text">
          <span className="sidebar__user-name">{me.user.name}</span>
          {budgetUsed !== null && <BudgetBar percent={budgetUsed} />}
        </span>
      </button>
      <MenuOverlay
        open={open}
        onOpenChange={setOpen}
        anchor={trigger}
        closeLabel={t("common.close")}
        mark={<Avatar name={me.user.name} size="xl" imageUrl={photo} />}
        title={me.user.name}
        meta={[mine?.handle ? `@${mine.handle}` : null, me.user.email].filter(Boolean).join(" · ")}
      >
        <MenuOverlayGroup label={t("shell.account")}>
          <MenuOverlayItem
            icon="person"
            shortcut="1"
            description={t("shell.profileHint")}
            onSelect={pick(() => setProfile("handle"))}
          >
            {t("shell.profile")}
          </MenuOverlayItem>
          <MenuOverlayItem
            icon="clock"
            shortcut="2"
            hint={zone.split("/").at(-1)?.replaceAll("_", " ")}
            onSelect={pick(() => setProfile("timezone"))}
          >
            {t("shell.timezone")}
          </MenuOverlayItem>
          <MenuOverlayRow icon="bulb" label={t("shell.theme")}>
            <Segmented
              size="sm"
              label={t("shell.theme")}
              value={theme.preference}
              onValueChange={(v) => theme.setPreference(v as ThemePreference)}
              options={[
                { value: "system", label: t("shell.themeSystem") },
                { value: "light", label: t("shell.themeLight") },
                { value: "dark", label: t("shell.themeDark") },
              ]}
            />
          </MenuOverlayRow>
          <MenuOverlayRow icon="globe" label={t("shell.language")}>
            <Segmented
              size="sm"
              label={t("shell.language")}
              value={i18n.language}
              onValueChange={(v) => setLocale(v as LocaleCode, i18n)}
              options={locales.map((l) => ({ value: l.code, label: l.label }))}
            />
          </MenuOverlayRow>
          {budgetUsed !== null &&
            (can(org.role, "view_usage") ? (
              <MenuOverlayItem
                icon="wallet"
                shortcut="3"
                description={t("shell.thisMonth")}
                hint={<BudgetBar percent={budgetUsed} />}
                onSelect={pick(
                  () =>
                    void navigate({
                      to: "/org/$orgId/settings/$section",
                      params: { orgId: org.id, section: "usage" },
                    }),
                )}
              >
                {t("shell.budgetOf", { name: org.name })}
              </MenuOverlayItem>
            ) : (
              <MenuOverlayRow icon="wallet" label={t("shell.budgetOf", { name: org.name })}>
                <BudgetBar percent={budgetUsed} />
              </MenuOverlayRow>
            ))}
          {import.meta.env.DEV && (
            <MenuOverlayItem icon="grid" onSelect={pick(() => void navigate({ to: "/dev/gallery" }))}>
              {t("shell.gallery")}
            </MenuOverlayItem>
          )}
          <MenuOverlaySeparator />
          <MenuOverlayItem icon="arrowRight" danger onSelect={pick(() => void signOut())}>
            {t("auth.signOut")}
          </MenuOverlayItem>
        </MenuOverlayGroup>
      </MenuOverlay>
      <ProfileDialog focus={profile} onClose={() => setProfile(null)} />
    </>
  );
}

/**
 * The workspace header ("Acme · 2 membros · 3 agentes") opens the workspace's
 * full-screen menu (telas/MenuOverlay.html): invite, members, connectors,
 * agents' access, skills and settings as far as the role allows, then the
 * other workspaces to switch to.
 */
function WorkspaceMenu({ summary }: { summary: string | null }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="sidebar__org-button"
        aria-haspopup="dialog"
        aria-label={t("shell.workspaceMenuOf", { name: org.name })}
        onClick={() => setOpen(true)}
      >
        <OrgMark logo={org.logo} className="sidebar__org-mark" />
        <span className="sidebar__org-text">
          <span className="sidebar__org-name">{org.name}</span>
          {summary && <span className="sidebar__org-meta">{summary}</span>}
        </span>
        <Icon name="chevronDown" size={16} />
      </button>
      <MenuOverlay
        open={open}
        onOpenChange={setOpen}
        anchor={trigger}
        closeLabel={t("common.close")}
        backdrop={<MenuHorizon />}
        mark={<OrgMark logo={org.logo} size={64} />}
        title={org.name}
        meta={
          <>
            {summary}
            {dir.agents.length > 0 && (
              <span className="sidebar__menu-crew">
                {dir.agents.slice(0, 4).map((a) => (
                  <AgentAvatar key={a.id} agent={a} name={a.name} size="xs" />
                ))}
              </span>
            )}
          </>
        }
      >
        <WorkspaceMenuOptions onDone={() => setOpen(false)} />
      </MenuOverlay>
    </>
  );
}

/** The workspace menu's options (mounted only while open: the counts load then). */
function WorkspaceMenuOptions({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const navigate = useNavigate();
  const overview = useOverview(org.id);
  const admin = can(org.role, "configure");
  const connections = useConnections(org.id);
  const skills = useSkills(org.id, admin);
  const go = (section?: SettingsSection) => () => {
    onDone();
    void (section
      ? navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section } })
      : navigate({ to: "/org/$orgId/settings", params: { orgId: org.id } }));
  };
  let key = 0;
  const next = () => String(++key);
  return (
    <>
      <MenuOverlayGroup label={t("shell.workspaceMenuOf", { name: org.name })}>
        {can(org.role, "manage_members") && (
          <MenuOverlayItem icon="plus" shortcut={next()} description={t("shell.inviteHint")} onSelect={go("members")}>
            {t("shell.invite")}
          </MenuOverlayItem>
        )}
        <MenuOverlayItem icon="members" shortcut={next()} count={overview.data?.people} onSelect={go("members")}>
          {t("shell.members")}
        </MenuOverlayItem>
        <MenuOverlayItem
          icon="plug"
          shortcut={next()}
          count={connections.data?.length || undefined}
          onSelect={go("connectors")}
        >
          {t("settings.section.connectors")}
        </MenuOverlayItem>
        {admin && (
          <MenuOverlayItem icon="agent" shortcut={next()} onSelect={go("access")}>
            {t("settings.section.access")}
          </MenuOverlayItem>
        )}
        {admin && (
          <MenuOverlayItem
            icon="book"
            shortcut={next()}
            count={skills.data?.length || undefined}
            onSelect={go("skills")}
          >
            {t("settings.section.skills")}
          </MenuOverlayItem>
        )}
        <MenuOverlayItem icon="settings" shortcut={next()} onSelect={go()}>
          {t("shell.workspaceSettings")}
        </MenuOverlayItem>
      </MenuOverlayGroup>
      <MenuOverlayGroup heading={t("shell.yourWorkspaces")}>
        {me.organizations.map((o) => (
          <MenuOverlayItem
            key={o.id}
            leading={<OrgMark logo={o.logo} size={32} />}
            description={t(`roles.${o.role}`)}
            current={o.id === org.id}
            hint={o.id === org.id ? t("shell.youAreHere") : undefined}
            onSelect={() => {
              onDone();
              if (o.id !== org.id) void navigate({ to: "/org/$orgId", params: { orgId: o.id } });
            }}
          >
            {o.name}
          </MenuOverlayItem>
        ))}
        <MenuOverlaySeparator />
        <MenuOverlayItem
          icon="plus"
          onSelect={() => {
            onDone();
            void navigate({ to: "/onboarding" });
          }}
        >
          {t("shell.newWorkspace")}
        </MenuOverlayItem>
      </MenuOverlayGroup>
    </>
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
    setZone(mine?.timezone || browserTimezone() || "UTC");
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
            <ZoneSelect value={zone || "UTC"} disabled={useOrgZone} onChange={setZone} />
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

/** Thin bar + "37%": how much of the agents' monthly budgets the workspace used. */
function BudgetBar({ percent }: { percent: number }) {
  const { t, i18n } = useTranslation();
  const level = percent >= 100 ? "full" : percent >= 80 ? "high" : "ok";
  return (
    <span
      className="sidebar__usage"
      data-level={level}
      title={t("shell.budgetUsedHint", { percent: formatPercent(i18n.language, percent) })}
      aria-hidden="true"
    >
      <span className="sidebar__usage-track">
        <span className="sidebar__usage-bar" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </span>
      <span className="sidebar__usage-value">{formatPercent(i18n.language, percent)}</span>
    </span>
  );
}
