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
  usePrefetchRecent,
  useSkills,
} from "@agenteschat/client";
import { audienceChip } from "@agenteschat/client/lib/audience";
import { formatPercent } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
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
  Popover,
  Segmented,
  Skeleton,
  SkeletonGroup,
} from "@agenteschat/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useAuth } from "@/auth/context";
import { ZoneSelect } from "@/components/ZoneSelect";
import { useDirectory } from "@/hooks/useDirectory";
import { type LocaleCode, locales, setLocale } from "@/i18n";
import {
  contextMenuHandler,
  copyText,
  type MenuEntry,
  type MenuLook,
  menuLook,
  onMenuLookChange,
  setMenuLook,
} from "@/lib/context-menu";
import { inDesktopApp } from "@/lib/desktop";
import { markOpen } from "@/lib/perf";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { type ThemePreference, useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import type { SettingsSection } from "@/pages/settings-sections";
import { useLiveStore, useStreams } from "@/realtime/context";
import { AudienceChip } from "./AgentAudience";
import { AgentAvatar } from "./AgentAvatar";
import { openPalette } from "./CommandMenu";
import { COMPACT_QUERY, useMediaQuery, useNavDrawer } from "./NavDrawer";
import { NewChannelDialog } from "./NewChannelDialog";
import { OpenOnPhoneDialog } from "./OpenOnPhone";
import { useOrg } from "./org-context";
import { OrgMark, ProfilePhotoDialog } from "./ProfilePhoto";
import { AgentGlow, AgentTrail, colorOf, MenuHorizon, SidebarHorizon, SidebarOrgSky } from "./Sky";
import { isStoppable, useStopRun } from "./StopRun";

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
export const TABLET_QUERY = "(min-width: 761px) and (max-width: 1199px)";

/**
 * The sidebar shrunk to its icon rail at desktop widths (remembered), shared with the Mac app's title bar,
 * which carries the toggle there (DesktopTitleBar.tsx). In memory too, for when storage is blocked.
 */
const SIDEBAR_EVENT = "agentes:sidebar";
let sidebarCollapsed = storage.get(STORAGE_KEYS.sidebarCollapsed) === "1";
const onSidebarChange = (cb: () => void) => {
  window.addEventListener(SIDEBAR_EVENT, cb);
  return () => window.removeEventListener(SIDEBAR_EVENT, cb);
};
export const toggleSidebar = () => {
  sidebarCollapsed = !sidebarCollapsed;
  storage.set(STORAGE_KEYS.sidebarCollapsed, sidebarCollapsed ? "1" : "0");
  window.dispatchEvent(new Event(SIDEBAR_EVENT));
};
export function useSidebarCollapsed(): [boolean, () => void] {
  const collapsed = useSyncExternalStore(
    onSidebarChange,
    () => sidebarCollapsed,
    () => false,
  );
  return [collapsed, toggleSidebar];
}

/** File → Novo canal in the desktop app's menu bar (DesktopMenus.tsx): the sidebar opens its dialog. */
export const NEW_CHANNEL_EVENT = "agentes:new-channel";

/** The workspace sidebar. */
export function Sidebar() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const orgId = org.id;
  const dir = useDirectory(orgId);
  const channels = useChannels(orgId);
  const overview = useOverview(orgId);
  const [creatingChannel, setCreatingChannel] = useState(false);
  useEffect(() => {
    const open = () => setCreatingChannel(true);
    window.addEventListener(NEW_CHANNEL_EVENT, open);
    return () => window.removeEventListener(NEW_CHANNEL_EVENT, open);
  }, []);
  const toast = useToast();
  // The desktop app's right click on a channel (lib/context-menu.ts).
  const channelMenu = (c: { id: string; name: string }) =>
    contextMenuHandler(() => [
      { kind: "header", label: `#${c.name}` },
      {
        kind: "item",
        id: "copy-link",
        label: t("contextMenu.copyLink"),
        icon: "link",
        run: () =>
          void copyText(`${window.location.origin}/org/${orgId}/c/${c.id}`, () =>
            toast.show(t("contextMenu.linkCopied")),
          ),
      },
    ]);
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
  // …and the unread and latest ones as soon as the workspace opens.
  usePrefetchRecent(orgId);
  const dmWith = new Map((dms.data ?? []).map((d) => [d.with.id, d.channelId]));
  const prefetchDm = (partnerId: string) => {
    const channelId = dmWith.get(partnerId);
    if (channelId) prefetch(channelId);
  };
  // A closed conversation category still says how many unread messages it holds.
  const agentsUnread = dir.agents.reduce((n, a) => n + (unreadWith.get(a.id) ?? 0), 0);
  const peopleUnread = people.reduce((n, m) => n + (unreadWith.get(m.userId) ?? 0), 0);
  const sections = useSidebarSections();

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
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
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

        {/* The tools people use most stay in sight; the rest open beside the sidebar from More. */}
        <div className="sidebar__group sidebar__tools">
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
          <Link to="/org/$orgId/wiki" params={{ orgId }} className="sidebar__item" title={t("shell.wiki")}>
            <Icon name="book" />
            <span className="sidebar__item-label">{t("shell.wiki")}</span>
          </Link>
          <Link to="/org/$orgId/drive" params={{ orgId }} className="sidebar__item" title={t("shell.drive")}>
            <Icon name="drive" />
            <span className="sidebar__item-label">{t("shell.drive")}</span>
          </Link>
          <MoreTools />
        </div>

        <span className="sidebar__divider" aria-hidden="true" />

        <SidebarSection
          id="channels"
          label={t("shell.channels")}
          sections={sections}
          action={
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="plus"
              className="sidebar__section-add"
              aria-label={t("newChannel.open")}
              onClick={() => setCreatingChannel(true)}
            />
          }
        >
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
                onContextMenu={channelMenu(c)}
              >
                <Icon name="channel" className="sidebar__channel-icon" />
                <span className="sidebar__item-label">{c.name}</span>
              </Link>
            ))}
        </SidebarSection>

        {dir.loading && dir.agents.length === 0 && (
          // Loading: the same header as the open category, so nothing jumps when the list arrives.
          <div className="sidebar__group sidebar__section" data-open="true">
            <div className="sidebar__section-head">
              <span className="sidebar__section-toggle">
                <Icon name="chevronDown" size={14} className="sidebar__section-chevron" />
                <span className="sidebar__label">{t("shell.agents")}</span>
              </span>
            </div>
            <SidebarSkeleton count={2} avatar label={t("common.loadingList")} />
          </div>
        )}
        {dir.agents.length > 0 && (
          <SidebarSection
            id="agents"
            label={t("shell.agents")}
            sections={sections}
            summary={agentsUnread > 0 && <UnreadCount count={agentsUnread} />}
          >
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
          </SidebarSection>
        )}

        {people.length > 0 && (
          <SidebarSection
            id="people"
            label={t("shell.directMessages")}
            sections={sections}
            summary={peopleUnread > 0 && <UnreadCount count={peopleUnread} />}
          >
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
          </SidebarSection>
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
        </div>
      </div>
    </nav>
  );
}

type SectionId = "channels" | "agents" | "people";

/** Which sidebar categories are closed, remembered per browser. */
function useSidebarSections() {
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      const saved = storage.get(STORAGE_KEYS.sidebarSections);
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch {
      // A bad value falls back to the defaults.
    }
    return new Set();
  });
  const toggle = (id: SectionId) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      storage.set(STORAGE_KEYS.sidebarSections, JSON.stringify([...next]));
      return next;
    });
  return { isOpen: (id: SectionId) => !closed.has(id), toggle };
}

/**
 * A sidebar category that opens and closes. Closed, it keeps its open page's row in sight (CSS shows
 * only the active item), and shows `summary` (a count) on its header.
 * On the icon rail the header goes away and every item shows.
 */
function SidebarSection({
  id,
  label,
  sections,
  summary,
  action,
  children,
}: {
  id: SectionId;
  label: string;
  sections: ReturnType<typeof useSidebarSections>;
  summary?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const open = sections.isOpen(id);
  const bodyId = `sidebar-section-${id}`;
  return (
    <div className="sidebar__group sidebar__section" data-open={open}>
      <div className="sidebar__section-head">
        <button
          type="button"
          className="sidebar__section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => sections.toggle(id)}
        >
          <Icon name="chevronDown" size={14} className="sidebar__section-chevron" />
          <span className="sidebar__label">{label}</span>
        </button>
        {!open && summary}
        {action}
      </div>
      <div id={bodyId} className="sidebar__section-body">
        {children}
      </div>
    </div>
  );
}

/** The tools behind More, in groups, each with a line on what it is for. */
const MORE_TOOLS = [
  { group: "schedule", to: "/org/$orgId/routines", icon: "routines", key: "routines" },
  { group: "schedule", to: "/org/$orgId/calendar", icon: "calendar", key: "calendar" },
  { group: "decisions", to: "/org/$orgId/forum", icon: "message", key: "forum" },
] as const;
const MORE_GROUPS = ["schedule", "decisions"] as const;

/**
 * More: the tools people reach for less, in a panel beside the sidebar (so nothing below moves).
 * The one you opened from it stays in sight under it (CSS shows only the active row).
 */
function MoreTools() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        label={t("shell.more")}
        side="right"
        align="start"
        className="sidebar__more-menu"
        trigger={
          <button type="button" className="sidebar__item sidebar__more" title={t("shell.more")}>
            <Icon name="more" />
            <span className="sidebar__item-label">{t("shell.more")}</span>
            <Icon name="chevronRight" size={16} className="sidebar__more-chevron" />
          </button>
        }
      >
        {MORE_GROUPS.map((group) => (
          <div key={group} className="sidebar__more-group">
            <div className="ac-menu__heading">{t(`shell.moreGroups.${group}`)}</div>
            {MORE_TOOLS.filter((x) => x.group === group).map((x) => (
              <Link
                key={x.key}
                to={x.to}
                params={{ orgId: org.id }}
                className="ac-menu__item sidebar__more-item"
                onClick={() => setOpen(false)}
              >
                <Icon name={x.icon} />
                <span className="ac-menu__label">
                  {t(`shell.${x.key}`)}
                  <span className="ac-menu__desc">{t(`shell.moreWhat.${x.key}`)}</span>
                </span>
              </Link>
            ))}
          </div>
        ))}
      </Popover>
      <div className="sidebar__more-active">
        {MORE_TOOLS.map((x) => (
          <Link key={x.key} to={x.to} params={{ orgId: org.id }} className="sidebar__item" title={t(`shell.${x.key}`)}>
            <Icon name={x.icon} />
            <span className="sidebar__item-label">{t(`shell.${x.key}`)}</span>
          </Link>
        ))}
      </div>
    </>
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
  const navigate = useNavigate();
  const live = useLiveStore();
  const runs = useStopRun();
  const toast = useToast();
  // The desktop app's right click on an agent: talk, its page, its link, and stop while it works.
  const onContextMenu = contextMenuHandler(() => {
    const working = Object.values(live.get().streams.runs).filter(
      (r) => r.agentId === a.id && isStoppable(r) && runs.canStop(r),
    );
    return [
      { kind: "header", label: a.name },
      {
        kind: "item",
        id: "agent-page",
        label: t("contextMenu.agentPage"),
        icon: "agent",
        run: () => void navigate({ to: "/org/$orgId/agents/$agentId", params: { orgId: org.id, agentId: a.id } }),
      },
      {
        kind: "item",
        id: "copy-link",
        label: t("contextMenu.copyLink"),
        icon: "link",
        run: () =>
          void copyText(`${window.location.origin}/org/${org.id}/dm/agent/${a.id}`, () =>
            toast.show(t("contextMenu.linkCopied")),
          ),
      },
      ...(working.length
        ? ([
            { kind: "separator" },
            {
              kind: "item",
              id: "stop",
              label: t("run.stopAgent", agentGrammar(t, a.name)),
              icon: "stop",
              danger: true,
              run: () => {
                for (const r of working) runs.stop(r);
              },
            },
          ] satisfies MenuEntry[])
        : []),
    ];
  });
  return (
    <Link
      onContextMenu={onContextMenu}
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
 * (a percentage, never money). It opens the account's full-screen menu:
 * profile, time zone, opening the phone app, theme, language, the budget and
 * signing out.
 */
function AccountMenu({ budgetUsed }: { budgetUsed: number | null }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const theme = useTheme();
  const look = useSyncExternalStore(onMenuLookChange, menuLook, () => "ours" as const);
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [profile, setProfile] = useState<"handle" | "timezone" | null>(null);
  const [phone, setPhone] = useState(false);
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
          <MenuOverlayItem
            icon="phone"
            shortcut="3"
            description={t("shell.openOnPhoneHint")}
            onSelect={pick(() => setPhone(true))}
          >
            {t("shell.openOnPhone")}
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
          {inDesktopApp() && (
            <MenuOverlayRow icon="pointer" label={t("contextMenu.look")}>
              <Segmented
                size="sm"
                label={t("contextMenu.look")}
                value={look}
                onValueChange={(v) => setMenuLook(v as MenuLook)}
                options={[
                  { value: "ours", label: t("contextMenu.lookOurs") },
                  { value: "system", label: t("contextMenu.lookSystem") },
                ]}
              />
            </MenuOverlayRow>
          )}
          {budgetUsed !== null &&
            (can(org.role, "view_usage") ? (
              <MenuOverlayItem
                icon="wallet"
                shortcut="4"
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
      <OpenOnPhoneDialog open={phone} onClose={() => setPhone(false)} />
    </>
  );
}

/**
 * The workspace header ("Acme · 2 membros · 3 agentes") opens the workspace's
 * full-screen menu: invite, members, connectors,
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
