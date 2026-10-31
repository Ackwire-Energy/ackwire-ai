import type { Agent, AgentGroup, Availability, Channel, ChannelCategory, Member } from "@agenteschat/client";
import {
  agentStateIn,
  runningAgents,
  useAgentGroups,
  useAgentStatuses,
  useAiAccounts,
  useChannelCategories,
  useChannels,
  useConnections,
  useCreateChannelCategory,
  useDeleteChannelCategory,
  useDms,
  useMachineOutages,
  useMissionList,
  useNotificationCount,
  useOverview,
  usePlaceChannel,
  usePlaceChannelCategory,
  usePrefetchMessages,
  usePrefetchRecent,
  useSkills,
} from "@agenteschat/client";
import { agentSections } from "@agenteschat/client/lib/agent-groups";
import { audienceChip, audienceNotice, listsAgent } from "@agenteschat/client/lib/audience";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { waitingAgents } from "@agenteschat/client/lib/outages";
import { can } from "@agenteschat/client/lib/permissions";
import { AVAILABILITIES, clearsText, presenceOfAvailability } from "@agenteschat/client/lib/presence";
import {
  type AgentColor,
  Avatar,
  Button,
  CountBadge,
  CountChip,
  cx,
  Icon,
  type IconName,
  Kbd,
  Menu,
  MenuItem,
  MenuOverlay,
  MenuOverlayGroup,
  MenuOverlayItem,
  MenuOverlaySeparator,
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  modKey,
  Popover,
  PresenceBadge,
  ProviderLogo,
  Skeleton,
  SkeletonGroup,
  selectionSkyUrl,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  type CSSProperties,
  type DragEvent,
  Fragment,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/context";
import { useAuth } from "@/auth/context";
import { useDirectory } from "@/hooks/useDirectory";
import { agentLine, availabilityOf, personLine, useAgentPresence, usePersonPresence } from "@/hooks/usePresence";
import { requestChannelDetails } from "@/lib/channel-details";
import { contextMenuHandler, copyText, type MenuEntry } from "@/lib/context-menu";
import { onPhoneAsk, takePhoneAsk } from "@/lib/desktop";
import { useOpenParam } from "@/lib/open-param";
import { markOpen } from "@/lib/perf";
import { ownPlanLines, planNearLimit, planWord } from "@/lib/plan-usage";
import { STORAGE_KEYS, storage, storedStrings } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import type { SettingsSection } from "@/pages/settings-sections";
import { useLiveStore, useStreams } from "@/realtime/context";
import { ProfileDialog } from "./AccountSettings";
import { AddPasswordDialog } from "./AddPassword";
import { AgentAvatar } from "./AgentAvatar";
import {
  AgentGroupMenu,
  DeleteGroupDialog,
  type GroupDialogFor,
  GroupMenu,
  GroupNameDialog,
  useAgentDrag,
} from "./AgentGroups";
import { MoveChannelDialog, NewCategoryDialog, RenameCategoryDialog } from "./ChannelCategoryDialogs";
import { openPalette } from "./CommandMenu";
import { DeleteAccountDialog } from "./DeleteAccount";
import { COMPACT_QUERY, useMediaQuery, useNavDrawer } from "./NavDrawer";
import { NewChannelDialog } from "./NewChannelDialog";
import { OpenOnPhoneDialog } from "./OpenOnPhone";
import { useOrg } from "./org-context";
import { StatusLine } from "./Presence";
import { MyFace, OrgMark } from "./ProfilePhoto";
import { AgentGlow, AgentTrail, colorOf, MenuHorizon, SidebarHorizon, WorkspaceSky } from "./Sky";
import { SetStatusDialog, useSaveStatus } from "./StatusDialog";
import { isStoppable, useStopRun } from "./StopRun";

/** The chosen item's sky: both themes, the CSS picks one. */
const selectionSky = (color: AgentColor = "sky") =>
  ({ "--sel-sky": selectionSkyUrl(color), "--sel-sky-dark": selectionSkyUrl(color, true) }) as CSSProperties;

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

/**
 * On the icon rail every channel would be the same "#": its initials instead ("eng-backend" → "Eb",
 * "general" → "Ge"), so the rail still reads which is which.
 */
export function channelInitials(name: string) {
  const words = name
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => Array.from(w));
  const letters = (words.length > 1 ? [words[0]?.[0], words[1]?.[0]] : (words[0] ?? []).slice(0, 2)).join("");
  return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
}

/** The workspace sidebar. */
export function Sidebar() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const orgId = org.id;
  const dir = useDirectory(orgId);
  const channels = useChannels(orgId);
  const overview = useOverview(orgId);
  // A new channel: `true` with no category, or the category whose + opened it.
  const [creatingChannel, setCreatingChannel] = useState<boolean | string>(false);
  useEffect(() => {
    const open = () => setCreatingChannel(true);
    window.addEventListener(NEW_CHANNEL_EVENT, open);
    return () => window.removeEventListener(NEW_CHANNEL_EVENT, open);
  }, []);
  const pending = overview.data?.approvalsWaitingForMe ?? 0;
  // The bell: unread notifications (live through `notification.counts`); the badge bumps when one arrives.
  const unreadNotifications = useNotificationCount(orgId).data?.unread ?? 0;
  const lastUnread = useRef(unreadNotifications);
  const meRow = useRef<HTMLDivElement>(null);
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
  // The agents' presence and lines (ADR 0084): the one place that polls them; every face reads the same list.
  useAgentStatuses(orgId);
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
  const unreadOf = (agents: Agent[]) => agents.reduce((n, a) => n + (unreadWith.get(a.id) ?? 0), 0);
  const peopleUnread = people.reduce((n, m) => n + (unreadWith.get(m.userId) ?? 0), 0);
  const sections = useSidebarSections(me.user.id, orgId);
  // The workspace's groups of agents (ADR 0083): the agents in none stay under "Agentes", each group is a category.
  // Who manages agents sees them all, to arrange them; everyone else, the agents that answer them and the groups
  // holding one.
  const arranges = can(org, "manage_agents");
  const groups = useAgentGroups(orgId).data ?? [];
  const byGroup = agentSections(
    dir.agents.filter((a) => listsAgent(org, a)),
    groups,
    (a) => a.id,
  );
  const shownGroups = arranges ? byGroup.groups : byGroup.groups.filter((g) => g.items.length > 0);
  const drag = useAgentDrag(groups);
  const [groupDialog, setGroupDialog] = useState<GroupDialogFor | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<AgentGroup | null>(null);

  // How many of the workspace's agents are working now: the sky at the bottom rises with it.
  const agentIds = dir.agents.map((a) => a.id).join();
  const working = useStreams((st) => {
    const busy = runningAgents(st);
    return agentIds ? agentIds.split(",").filter((id) => busy.has(id)).length : 0;
  });
  // Narrow screens: the sidebar is a drawer (id, open state, close on link / swipe).
  const drawer = useNavDrawer();
  // Desktop: the person can shrink the sidebar to an icon rail (remembered). Tablets always get the rail.
  const compact = useMediaQuery(COMPACT_QUERY);
  const tablet = useMediaQuery(TABLET_QUERY);
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const rail = !compact && (tablet || collapsed);
  // Owners and admins organize the groups, with the full sidebar (the rail shows faces only).
  const organize = arranges && !rail;
  const agentRow = (a: Agent) => (
    <AgentRow
      key={a.id}
      agent={a}
      unread={unreadWith.get(a.id) ?? 0}
      waitingFor={waitingFor.get(a.id)}
      onPrefetch={() => prefetchDm(a.id)}
      onOpen={() => markOpen(dmWith.get(a.id) ?? a.id)}
      drag={organize ? drag.row(a.id) : undefined}
      menu={
        organize ? (
          <AgentGroupMenu
            agent={a}
            groups={groups}
            onNewGroup={() => setGroupDialog({ mode: "create", agentIds: [a.id] })}
          />
        ) : undefined
      }
    />
  );

  // Only the middle scrolls: the workspace card on top and the foot stay put. The active item
  // paints its own background (no sliding pill).
  const navRef = useRef<HTMLDivElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The list fades out at an edge only while there is more to scroll past it (no hard cut).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check when the lists load
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const edges = () => {
      nav.dataset.fadeTop = String(nav.scrollTop > 1);
      nav.dataset.fadeBottom = String(nav.scrollTop + nav.clientHeight < nav.scrollHeight - 1);
    };
    edges();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(edges);
    ro?.observe(nav);
    for (const child of Array.from(nav.children)) ro?.observe(child);
    nav.addEventListener("scroll", edges, { passive: true });
    return () => {
      ro?.disconnect();
      nav.removeEventListener("scroll", edges);
    };
  }, [channels.data, dir.agents.length, people.length, rail, groups.length]);

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
    <nav className="sidebar" aria-label={t("shell.nav")} data-rail={rail} style={selectionSky()} {...drawer?.navProps}>
      <div className="sidebar__top">
        <WorkspaceSky part="side" rail={rail} />
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

        <SidebarChannels
          channels={(channels.data ?? []).filter((c) => !dmChannels.has(c.id))}
          loading={channels.isLoading}
          sections={sections}
          onNewChannel={(categoryId) => setCreatingChannel(categoryId ?? true)}
          onPrefetch={prefetch}
        />

        {dir.loading && dir.agents.length === 0 && (
          // Loading: the same header as the open category, so nothing jumps when the list arrives.
          <div className="sidebar__group sidebar__section" data-open="true">
            <div className="sidebar__section-head">
              <span className="sidebar__section-toggle">
                <Icon name="chevronDown" size={14} className="sidebar__section-chevron" />
                <span className="sidebar__label">{t("shell.agents")}</span>
              </span>
            </div>
            <div className="sidebar__section-body">
              <SidebarSkeleton count={2} avatar label={t("common.loadingList")} />
            </div>
          </div>
        )}
        {dir.agents.length > 0 && (
          <SidebarSection
            id="agents"
            label={t("shell.agents")}
            sections={sections}
            summary={unreadOf(byGroup.ungrouped) > 0 && <UnreadCount count={unreadOf(byGroup.ungrouped)} />}
            action={
              organize && (
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="plus"
                  className="sidebar__section-add"
                  aria-label={t("agentGroups.newGroup")}
                  title={t("agentGroups.newGroup")}
                  onClick={() => setGroupDialog({ mode: "create" })}
                />
              )
            }
            drop={organize ? drag.zone(null) : undefined}
          >
            <Link to="/org/$orgId/team" params={{ orgId }} className="sidebar__item" title={t("shell.team")}>
              <Icon name="agent" />
              <span className="sidebar__item-label">{t("shell.team")}</span>
            </Link>
            {byGroup.ungrouped.map(agentRow)}
          </SidebarSection>
        )}
        {dir.agents.length > 0 &&
          shownGroups.map(({ group, items }, i) => {
            // Where a dragged row would land: a line before the row at that place among the others.
            const others = items.filter((a) => a.id !== drag.dragging);
            const lineAt = drag.over?.groupId === group.id ? drag.over.index : null;
            const line = <span className="sidebar__drop-line" aria-hidden="true" />;
            return (
              <SidebarSection
                key={group.id}
                id={`group:${group.id}`}
                label={group.name}
                sections={sections}
                summary={unreadOf(items) > 0 && <UnreadCount count={unreadOf(items)} />}
                action={
                  organize && (
                    <GroupMenu
                      group={group}
                      index={i}
                      count={shownGroups.length}
                      onRename={() => setGroupDialog({ mode: "rename", group })}
                      onDelete={() => setDeletingGroup(group)}
                    />
                  )
                }
                drop={organize ? drag.zone(group.id) : undefined}
              >
                {items.map((a) => (
                  <Fragment key={a.id}>
                    {lineAt === others.indexOf(a) && line}
                    {agentRow(a)}
                  </Fragment>
                ))}
                {lineAt !== null && lineAt >= others.length && line}
                {organize && items.length === 0 && (
                  <span className="sidebar__drop-hint">{t("agentGroups.dropHere")}</span>
                )}
              </SidebarSection>
            );
          })}

        {people.length > 0 && (
          <SidebarSection
            id="people"
            label={t("shell.directMessages")}
            sections={sections}
            summary={peopleUnread > 0 && <UnreadCount count={peopleUnread} />}
          >
            {people.map((m) => (
              <PersonRow
                key={m.userId}
                member={m}
                unread={unreadWith.get(m.userId) ?? 0}
                onPrefetch={() => prefetchDm(m.userId)}
                onOpen={() => markOpen(dmWith.get(m.userId) ?? m.userId)}
              />
            ))}
          </SidebarSection>
        )}
      </div>

      <NewChannelDialog
        open={creatingChannel !== false}
        onOpenChange={(open) => setCreatingChannel(open)}
        category={typeof creatingChannel === "string" ? creatingChannel : null}
      />
      {groupDialog && <GroupNameDialog purpose={groupDialog} onClose={() => setGroupDialog(null)} />}
      {deletingGroup && <DeleteGroupDialog group={deletingGroup} onClose={() => setDeletingGroup(null)} />}

      <div className="sidebar__foot">
        <SidebarHorizon
          working={working}
          total={dir.agents.length}
          clear={() => [meRow.current?.querySelector(".ac-avatar")]}
        />
        {can(org, "create_agents") && (
          <Button asChild block variant="ghost" className="sidebar__create">
            <Link to="/org/$orgId/agents/new" params={{ orgId }} title={t("shell.createAgent")}>
              <Icon name="plus" />
              <span className="sidebar__item-label">{t("shell.createAgent")}</span>
            </Link>
          </Button>
        )}
        <div className="sidebar__me" ref={meRow}>
          <AccountMenu />
        </div>
      </div>
    </nav>
  );
}

/**
 * The fixed sections, a channel category as `category:<id>` (ADR 0080) and a group of agents as `group:<id>`
 * (ADR 0083).
 */
type SectionId = "channels" | "agents" | "people" | `category:${string}` | `group:${string}`;

/** Which sidebar categories are closed, remembered in this browser for each person in each workspace. */
function useSidebarSections(userId: string, orgId: string) {
  const key = `${STORAGE_KEYS.sidebarSections}.${userId}.${orgId}`;
  const [saved, setSaved] = useState(() => ({ key, closed: new Set(storedStrings(key)) }));
  // The sidebar stays mounted when the workspace changes: that one's own state.
  if (saved.key !== key) setSaved({ key, closed: new Set(storedStrings(key)) });
  const change = (edit: (closed: Set<string>) => void) =>
    setSaved((prev) => {
      const closed = new Set(prev.closed);
      edit(closed);
      storage.set(prev.key, JSON.stringify([...closed]));
      return { key: prev.key, closed };
    });
  const toggle = (id: SectionId) =>
    change((closed) => {
      if (!closed.delete(id)) closed.add(id);
    });
  /** "Fechar todas" / "Abrir todas" for the channel categories. */
  const setAll = (ids: SectionId[], open: boolean) =>
    change((closed) => {
      for (const id of ids) {
        if (open) closed.delete(id);
        else closed.add(id);
      }
    });
  return { isOpen: (id: SectionId) => !saved.closed.has(id), toggle, setAll };
}

/**
 * A sidebar category that opens and closes. Closed, it keeps its open page's row in sight (CSS shows
 * only the active item), and shows `summary` (a count) on its header.
 * On the icon rail the header goes away and every item shows. `drop`: it takes dragged agents (`useAgentDrag`).
 */
function SidebarSection({
  id,
  label,
  sections,
  summary,
  action,
  drop,
  className,
  headProps,
  children,
}: {
  id: SectionId;
  label: string;
  sections: ReturnType<typeof useSidebarSections>;
  summary?: ReactNode;
  action?: ReactNode;
  drop?: ReturnType<ReturnType<typeof useAgentDrag>["zone"]>;
  className?: string;
  /** A channel category's header: its right click and dragging. */
  headProps?: HTMLAttributes<HTMLDivElement>;
  children: ReactNode;
}) {
  const open = sections.isOpen(id);
  const bodyId = `sidebar-section-${id.replace(":", "-")}`;
  return (
    <div className={cx("sidebar__group sidebar__section", className)} data-open={open} {...drop}>
      <div className="sidebar__section-head" {...headProps}>
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

/** Where a dragged channel or category would land: the row or header it is over, and how. */
type DropMark = { key: string; where: "before" | "after" | "into" } | null;
type Dragging = { kind: "channel" | "category"; id: string };
/** One thing a category's ⋯ (and its right click) can do. */
interface CategoryAction {
  id: string;
  label: string;
  icon: IconName;
  run: () => void;
  danger?: boolean;
  description?: string;
}
const CATEGORY_KEY = "category:";

/**
 * The channels (ADR 0080). With no categories, the "Canais" section as before. With them, the channels with
 * none come first with no header, then one section per category, like Agentes; closed, a category keeps the
 * open channel and the unread ones in sight (CSS). Who may manage channels arranges the categories; they and a
 * channel's creator move it by dragging, from its right click in the desktop app ("Mover para…") or in its details.
 */
function SidebarChannels({
  channels,
  loading,
  sections,
  onNewChannel,
  onPrefetch,
}: {
  channels: Channel[];
  loading: boolean;
  sections: ReturnType<typeof useSidebarSections>;
  /** The + of a category (its id) or of "Canais" (null). */
  onNewChannel: (categoryId: string | null) => void;
  onPrefetch: (channelId: string) => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const orgId = org.id;
  const toast = useToast();
  const navigate = useNavigate();
  const categories = useChannelCategories(orgId);
  const place = usePlaceChannel(orgId);
  const placeCategory = usePlaceChannelCategory(orgId);
  const removeCategory = useDeleteChannelCategory(orgId);
  const recreate = useCreateChannelCategory(orgId);
  const manages = can(org, "manage_channels");
  const mayCreate = can(org, "create_channels");
  // A channel's creator edits and moves it too, as the server allows.
  const mayChange = (c: Channel) => c.createdByUserId === me.user.id || manages;
  const [newCategory, setNewCategory] = useState<{ withChannel?: string } | null>(null);
  const [renaming, setRenaming] = useState<ChannelCategory | null>(null);
  const [moving, setMoving] = useState<Channel | null>(null);
  const drag = useRef<Dragging | null>(null);
  const [mark, setMark] = useState<DropMark>(null);
  const failed = (e: unknown) => toast.show(e instanceof Error ? e.message : String(e), "error");

  const list = categories.data ?? [];
  const known = new Set(list.map((c) => c.id));
  // A channel whose category isn't loaded yet (or is gone) shows with the ones with none. So nothing drags until
  // the categories load: a drop would take the channel out of its category.
  const categoryOf = (c: Channel) => (c.categoryId && known.has(c.categoryId) ? c.categoryId : null);
  const loose = channels.filter((c) => categoryOf(c) === null);
  const inCategory = (id: string) => channels.filter((c) => categoryOf(c) === id);
  // A category shows while it holds a channel I can see; who manages channels keeps the empty ones to drop channels in.
  const shown = manages ? list : list.filter((c) => inCategory(c.id).length > 0);
  const categoryIds = shown.map((c) => `${CATEGORY_KEY}${c.id}` as SectionId);

  // ── Dragging: a channel onto a channel (before/after) or a header (into); a header onto a header ──
  const endDrag = () => {
    drag.current = null;
    setMark(null);
  };
  const startDrag = (e: DragEvent, what: Dragging) => {
    drag.current = what;
    e.dataTransfer.effectAllowed = "move";
    // Firefox starts a drag only with some data set. Not text, or a text field it's dropped on types the id.
    e.dataTransfer.setData(`application/x-agentes-${what.kind}`, what.id);
  };
  const half = (e: DragEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2 ? "after" : "before";
  };
  const over = (e: DragEvent, key: string, where: "before" | "after" | "into") => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (mark?.key !== key || mark.where !== where) setMark({ key, where });
  };
  const overChannel = (e: DragEvent, c: Channel) => {
    const d = drag.current;
    if (d?.kind === "channel" && d.id !== c.id) over(e, `channel:${c.id}`, half(e));
  };
  const overCategory = (e: DragEvent, category: ChannelCategory) => {
    const d = drag.current;
    if (d?.kind === "channel") over(e, `${CATEGORY_KEY}${category.id}`, "into");
    else if (d?.kind === "category" && d.id !== category.id) over(e, `${CATEGORY_KEY}${category.id}`, half(e));
  };
  const overLoose = (e: DragEvent) => {
    if (drag.current?.kind === "channel") over(e, "loose", "into");
  };
  const drop = (e: DragEvent) => {
    const d = drag.current;
    const m = mark;
    endDrag();
    if (!d || !m) return;
    e.preventDefault();
    e.stopPropagation();
    if (d.kind === "category") {
      const target = m.key.slice(CATEGORY_KEY.length);
      const i = list.findIndex((c) => c.id === target);
      const before = m.where === "before" ? target : (list[i + 1]?.id ?? null);
      if (before !== d.id) placeCategory.mutate({ categoryId: d.id, beforeCategoryId: before }, { onError: failed });
      return;
    }
    if (m.key === "loose") return place.mutate({ channelId: d.id, categoryId: null }, { onError: failed });
    if (m.key.startsWith(CATEGORY_KEY)) {
      const categoryId = m.key.slice(CATEGORY_KEY.length);
      if (!sections.isOpen(`${CATEGORY_KEY}${categoryId}` as SectionId))
        sections.toggle(`${CATEGORY_KEY}${categoryId}` as SectionId);
      return place.mutate({ channelId: d.id, categoryId }, { onError: failed });
    }
    const target = channels.find((c) => `channel:${c.id}` === m.key);
    if (!target) return;
    const categoryId = categoryOf(target);
    const siblings = categoryId ? inCategory(categoryId) : loose;
    const i = siblings.findIndex((c) => c.id === target.id);
    const before = m.where === "before" ? target.id : (siblings[i + 1]?.id ?? null);
    const from = siblings.findIndex((c) => c.id === d.id);
    // Already there. The server would still renumber the group, and a group arranged by hand takes new
    // channels at its end instead of by name (endOfCategory).
    if (before === d.id || (from >= 0 && (siblings[from + 1]?.id ?? null) === before)) return;
    place.mutate({ channelId: d.id, categoryId, beforeChannelId: before }, { onError: failed });
  };
  const dropMark = (key: string) => (mark?.key === key ? mark.where : undefined);

  // ── Menus: the desktop app's right click (lib/context-menu.ts) and a category's ⋯ ──
  const channelMenu = (c: Channel) =>
    contextMenuHandler(() => {
      const entries: MenuEntry[] = [{ kind: "header", label: `#${c.name}` }];
      if (mayChange(c))
        entries.push({
          kind: "item",
          id: "edit",
          label: t("channelCategories.editChannel"),
          icon: "edit",
          run: () => {
            requestChannelDetails(c.id);
            void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId, channelId: c.id } });
          },
        });
      if (mayChange(c) && list.length > 0)
        entries.push({
          kind: "item",
          id: "move",
          label: t("channelCategories.move"),
          icon: "move",
          run: () => setMoving(c),
        });
      if (manages)
        entries.push({
          kind: "item",
          id: "new-category",
          label: t("channelCategories.newWithChannel"),
          icon: "layers",
          run: () => setNewCategory({ withChannel: c.id }),
        });
      entries.push(
        { kind: "separator" },
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
      );
      return entries;
    });
  const deleteCategory = (category: ChannelCategory) => {
    const taken = inCategory(category.id).map((c) => c.id);
    const next = list[list.findIndex((c) => c.id === category.id) + 1]?.id ?? null;
    removeCategory.mutate(category.id, {
      onError: failed,
      onSuccess: () =>
        toast.show(
          taken.length
            ? t("channelCategories.deleted", { name: category.name, count: taken.length })
            : t("channelCategories.deletedEmpty", { name: category.name }),
          "info",
          {
            label: t("channelCategories.undo"),
            // Undo: the same name and channels, back in its place.
            run: () =>
              recreate.mutate(
                { name: category.name, channelIds: taken },
                {
                  onError: failed,
                  onSuccess: (again) => {
                    if (next) placeCategory.mutate({ categoryId: again.id, beforeCategoryId: next });
                  },
                },
              ),
          },
        ),
    });
  };
  const allClosed = categoryIds.every((id) => !sections.isOpen(id));
  const categoryActions = (category: ChannelCategory) => {
    const actions: CategoryAction[] = [];
    if (mayCreate)
      actions.push({
        id: "new-channel",
        label: t("channelCategories.newChannelHere"),
        icon: "plus",
        run: () => onNewChannel(category.id),
      });
    if (manages)
      actions.push({
        id: "rename",
        label: t("channelCategories.rename"),
        icon: "edit",
        run: () => setRenaming(category),
      });
    actions.push({
      id: "fold",
      label: allClosed ? t("channelCategories.expandAll") : t("channelCategories.collapseAll"),
      icon: "list",
      run: () => sections.setAll(categoryIds, allClosed),
    });
    if (manages)
      actions.push(
        {
          id: "new-category",
          label: t("channelCategories.newCategory"),
          icon: "layers",
          run: () => setNewCategory({}),
        },
        {
          id: "delete",
          label: t("channelCategories.delete"),
          description: t("channelCategories.deleteDesc"),
          icon: "trash",
          danger: true,
          run: () => deleteCategory(category),
        },
      );
    return actions;
  };

  const row = (c: Channel) => {
    const unread = c.unreadCount ?? 0;
    return (
      <Link
        key={c.id}
        to="/org/$orgId/c/$channelId"
        params={{ orgId, channelId: c.id }}
        className="sidebar__item"
        title={`#${c.name}`}
        data-unread={unread > 0}
        data-drop={dropMark(`channel:${c.id}`)}
        draggable={categories.data !== undefined && mayChange(c)}
        onDragStart={(e) => startDrag(e, { kind: "channel", id: c.id })}
        onDragEnd={endDrag}
        onDragOver={(e) => overChannel(e, c)}
        onDrop={drop}
        onMouseEnter={() => onPrefetch(c.id)}
        onFocus={() => onPrefetch(c.id)}
        onClick={() => markOpen(c.id)}
        onContextMenu={channelMenu(c)}
      >
        <Icon name="channel" className="sidebar__channel-icon" />
        <span className="sidebar__channel-abbr" aria-hidden="true">
          {channelInitials(c.name)}
        </span>
        <span className="sidebar__item-label">{c.name}</span>
        {unread > 0 && <UnreadCount count={unread} />}
      </Link>
    );
  };
  const addButton = (categoryId: string | null, label: string) =>
    mayCreate ? (
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        icon="plus"
        className="sidebar__section-add"
        aria-label={label}
        title={label}
        onClick={() => onNewChannel(categoryId)}
      />
    ) : null;
  const dialogs = (
    <>
      <NewCategoryDialog
        open={newCategory !== null}
        onOpenChange={(open) => !open && setNewCategory(null)}
        withChannel={newCategory?.withChannel}
      />
      <RenameCategoryDialog category={renaming} onOpenChange={(open) => !open && setRenaming(null)} />
      <MoveChannelDialog channel={moving} onOpenChange={(open) => !open && setMoving(null)} canCreate={manages} />
    </>
  );
  const newCategoryRow = manages && (
    <button type="button" className="sidebar__item sidebar__new-category" onClick={() => setNewCategory({})}>
      <Icon name="plus" />
      <span className="sidebar__item-label">{t("channelCategories.newCategory")}</span>
    </button>
  );

  if (shown.length === 0) {
    return (
      <>
        <SidebarSection
          id="channels"
          label={t("shell.channels")}
          sections={sections}
          action={addButton(null, t("newChannel.open"))}
        >
          {loading && <SidebarSkeleton count={3} label={t("common.loadingList")} />}
          {channels.map(row)}
        </SidebarSection>
        {!loading && newCategoryRow}
        {dialogs}
      </>
    );
  }
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: the channels with no category, a drop target, not a form group */}
      <div
        className="sidebar__group"
        role="group"
        aria-label={t("shell.channels")}
        data-drop={dropMark("loose")}
        onDragOver={overLoose}
        onDrop={drop}
      >
        {loose.map(row)}
      </div>
      {shown.map((category) => {
        const actions = categoryActions(category);
        return (
          <SidebarSection
            key={category.id}
            id={`${CATEGORY_KEY}${category.id}`}
            label={category.name}
            sections={sections}
            className="sidebar__section--category"
            headProps={
              {
                draggable: manages,
                "data-drop": dropMark(`${CATEGORY_KEY}${category.id}`),
                onDragStart: (e) => startDrag(e, { kind: "category", id: category.id }),
                onDragEnd: endDrag,
                onDragOver: (e) => overCategory(e, category),
                onDrop: drop,
                onContextMenu: contextMenuHandler(() => [
                  { kind: "header", label: category.name },
                  ...actions.map(
                    (a): MenuEntry => ({
                      kind: "item",
                      id: a.id,
                      label: a.label,
                      icon: a.icon,
                      danger: a.danger,
                      run: a.run,
                    }),
                  ),
                ]),
              } as HTMLAttributes<HTMLDivElement>
            }
            action={
              <>
                {addButton(category.id, t("channelCategories.newChannelIn", { name: category.name }))}
                <Menu
                  align="start"
                  label={t("channelCategories.options", { name: category.name })}
                  trigger={
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon="more"
                      className="sidebar__section-add"
                      aria-label={t("channelCategories.options", { name: category.name })}
                    />
                  }
                >
                  {actions.map((a) => (
                    <Fragment key={a.id}>
                      {a.id === "new-category" && <MenuSeparator />}
                      <MenuItem icon={a.icon} danger={a.danger} description={a.description} onSelect={a.run}>
                        {a.label}
                      </MenuItem>
                    </Fragment>
                  ))}
                </Menu>
              </>
            }
          >
            {inCategory(category.id).map(row)}
          </SidebarSection>
        );
      })}
      {newCategoryRow}
      {dialogs}
    </>
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

/**
 * An agent in the sidebar; while it works, a light sweep in its color runs behind the row (a pulse in the rail).
 * For owners and admins it drags to another group (`drag`) and has a "…" (`menu`) over its end on hover.
 */
function AgentRow({
  agent: a,
  unread,
  waitingFor,
  onPrefetch,
  onOpen,
  drag,
  menu,
}: {
  agent: Agent;
  unread: number;
  /** The offline computer it waits for (its brain runs there). */
  waitingFor?: string;
  onPrefetch: () => void;
  onOpen: () => void;
  drag?: ReturnType<ReturnType<typeof useAgentDrag>["row"]>;
  menu?: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const state = useStreams((st) => agentStateIn(st, a.id));
  const busy = state !== "idle" && !waitingFor;
  const color = colorOf(a);
  const chip = audienceChip(t, a);
  // Its presence from its work and its line (ADR 0084): the badge on its face, both in the row's title (no emoji in
  // the list: the line shows where the agent is opened).
  const shown = useAgentPresence(a.id);
  const word = shown ? t(`presence.${shown.presence}`) : null;
  const line = agentLine(t, shown?.line ?? null);
  const dir = useDirectory(org.id);
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
    <div className="sidebar__row" data-agent-row={a.id}>
      <Link
        onContextMenu={onContextMenu}
        to="/org/$orgId/dm/agent/$agentId"
        params={{ orgId: org.id, agentId: a.id }}
        className="sidebar__item"
        title={[a.name, a.role, word, line?.text].filter(Boolean).join(" · ")}
        onMouseEnter={onPrefetch}
        onFocus={onPrefetch}
        onClick={onOpen}
        data-unread={unread > 0}
        data-busy={busy}
        data-presence={shown?.presence}
        style={selectionSky(color)}
        {...drag}
      >
        {busy && <AgentTrail color={color} />}
        {busy && <AgentGlow color={color} />}
        <AgentAvatar
          agentId={a.id}
          name={a.name}
          size="sm"
          presence={shown?.presence ?? null}
          presenceLabel={word ?? undefined}
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
          (chip ?? a.role) &&
          (chip ? (
            <span className="sidebar__item-meta sidebar__item-meta--audience">
              {a.role && <span>{a.role}</span>}
              <span
                className="sidebar__lock"
                role="img"
                aria-label={chip}
                title={audienceNotice(t, a, (id) => dir.memberById.get(id)?.name) || chip}
              >
                <Icon name="lock" size={14} />
              </span>
            </span>
          ) : (
            <span className="sidebar__item-meta">{a.role}</span>
          ))
        )}
      </Link>
      {menu}
    </div>
  );
}

/** A person under "Mensagens diretas": their face with its presence badge, the name; their line in the title (ADR 0084). */
function PersonRow({
  member: m,
  unread,
  onPrefetch,
  onOpen,
}: {
  member: Member;
  unread: number;
  onPrefetch: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const shown = usePersonPresence(m.userId);
  const word = shown ? t(`presence.${shown.presence}`) : null;
  const line = shown?.status ? personLine(shown.status) : null;
  return (
    <Link
      to="/org/$orgId/dm/person/$userId"
      params={{ orgId: org.id, userId: m.userId }}
      className="sidebar__item"
      title={[m.name, word, line?.text].filter(Boolean).join(" · ")}
      data-unread={unread > 0}
      data-presence={shown?.presence}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      onClick={onOpen}
    >
      <Avatar
        name={m.name}
        size="sm"
        imageUrl={m.image}
        presence={shown?.presence ?? null}
        presenceLabel={word ?? undefined}
      />
      <span className="sidebar__item-label">{m.name}</span>
      {unread > 0 && <UnreadCount count={unread} />}
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
 * The account button: your face with your presence badge; under the name, your line (or how you appear). It opens a
 * menu right above it: you on top (face, name, @ and how you appear, your line in a well, a plan near its limit), then
 * your status (how you appear, or what you're up to), your profile, your settings (Configurações › Sua conta) and
 * signing out. Deleting the account starts at the bottom of Sua conta, not here beside Sair, where a slip would open
 * it. It and adding a password keep their dialogs here, in the address (`?account=delete`, `?account=password`) on any
 * page: adding a password may ask for a sign-in again, which comes back.
 */
function AccountMenu() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const dir = useDirectory(org.id);
  const auth = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const compact = useMediaQuery(COMPACT_QUERY);
  const saveStatus = useSaveStatus();
  const [profile, setProfile] = useState(false);
  const [phone, setPhone] = useState(false);
  const [account, setAccount] = useOpenParam("account");
  const [statusOpen, setStatusOpen] = useState(false);
  // The app's "Show QR code" for this server (Preferences › Servers).
  useEffect(() => {
    if (takePhoneAsk()) setPhone(true);
    return onPhoneAsk(() => {
      takePhoneAsk();
      setPhone(true);
    });
  }, []);
  const handle = dir.memberById.get(me.user.id)?.handle;
  // How you appear to yourself (hidden stays hidden; what you picked, even before your socket is up) and your line.
  const shown = usePersonPresence(me.user.id);
  const picked = shown?.person.availability;
  const presence = picked ? presenceOfAvailability(picked) : (shown?.presence ?? null);
  const presenceWord = presence ? t(`presence.${presence}`) : undefined;
  const availability = picked ?? availabilityOf(shown?.presence);
  const line = shown?.status ? personLine(shown.status) : null;
  // Under your name: your line, or how you appear (Online, Ocupado, Ausente, Oculto) when you wrote none (ADR 0084).
  const who = [me.user.name, line?.text ?? presenceWord].filter(Boolean).join(" · ");
  const under = Boolean(line || presenceWord);

  const signOut = async () => {
    await auth.signOut();
    qc.clear();
    await navigate({ to: "/login" });
  };
  // A dialog opens once the menu is gone and focus is back on this row, so closing the dialog lands here too.
  const afterMenu = useRef<(() => void) | null>(null);
  const openAfter = (open: () => void) => () => {
    afterMenu.current = open;
  };
  // How you appear, then what you're up to: the dialog, with your line in it when you wrote one (it shows on top).
  const statusChoices = (
    <>
      <MenuRadioGroup
        label={t("presence.appearAs")}
        value={availability}
        onValueChange={(v) => v !== availability && saveStatus({ availability: v as Availability })}
        options={AVAILABILITIES.map((a) => ({
          value: a,
          label: t(`presence.${presenceOfAvailability(a)}`),
          leading: <PresenceBadge presence={presenceOfAvailability(a)} size="lg" ring={false} />,
        }))}
      />
      <MenuSeparator />
      <MenuItem icon="message" onSelect={openAfter(() => setStatusOpen(true))}>
        {t("presence.placeholder")}
      </MenuItem>
    </>
  );

  return (
    <>
      <Menu
        side="top"
        className="profile-menu"
        onClosed={() => {
          afterMenu.current?.();
          afterMenu.current = null;
        }}
        trigger={
          <button
            type="button"
            // The face stands beside the lines under it (your status line): the name's capitals at its top. A name
            // alone (while how you appear loads) centres on it.
            className={cx("sidebar__user", under && "ac-faceline")}
            aria-label={`${t("shell.account")}: ${who}`}
            title={who}
          >
            <MyFace size="sm" presence={presence} presenceLabel={presenceWord} />
            <span className="sidebar__user-text">
              <span className={cx("sidebar__user-name", under && "ac-captop")}>{me.user.name}</span>
              {line ? (
                <StatusLine emoji={line.emoji} text={line.text} className="sidebar__user-line" />
              ) : (
                presenceWord && <StatusLine text={presenceWord} className="sidebar__user-line" />
              )}
            </span>
          </button>
        }
      >
        <div className="profile-card__head profile-menu__head">
          <MyFace size="lg" presence={presence} presenceLabel={presenceWord} />
          <span className="list-col">
            <span className="profile-card__name">{me.user.name}</span>
            <span className="small muted">{[handle && `@${handle}`, presenceWord].filter(Boolean).join(" · ")}</span>
          </span>
        </div>
        {line && shown?.status && (
          <div className="profile-card__status profile-menu__line">
            <span className="profile-card__status-emoji" aria-hidden="true">
              {line.emoji}
            </span>
            <span>
              {line.text}
              <small>{clearsText(t, i18n.language, shown.status.until)}</small>
            </span>
          </div>
        )}
        <PlanNearLimitItem />
        <MenuSeparator />
        {/* A phone has no room beside the menu for another one: there the choices are in it. */}
        {compact ? (
          <>
            {statusChoices}
            <MenuSeparator />
          </>
        ) : (
          <MenuSub icon="smile" label={t("presence.setStatus")}>
            {statusChoices}
          </MenuSub>
        )}
        <MenuItem icon="edit" onSelect={openAfter(() => setProfile(true))}>
          {t("shell.editProfile")}
        </MenuItem>
        <MenuItem
          icon="settings"
          onSelect={() =>
            void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "account" } })
          }
        >
          {t("shell.settings")}
        </MenuItem>
        {import.meta.env.DEV && (
          <MenuItem icon="grid" onSelect={() => void navigate({ to: "/dev/gallery" })}>
            {t("shell.gallery")}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon="arrowRight" danger onSelect={() => void signOut()}>
          {t("auth.signOut")}
        </MenuItem>
      </Menu>
      <ProfileDialog focus={profile ? "handle" : null} onClose={() => setProfile(false)} />
      <SetStatusDialog open={statusOpen} onClose={() => setStatusOpen(false)} />
      <OpenOnPhoneDialog open={phone} onClose={() => setPhone(false)} />
      <AddPasswordDialog
        open={account === "password" && me.user.hasPassword === false}
        onClose={() => setAccount(null)}
      />
      <DeleteAccountDialog open={account === "delete"} onClose={() => setAccount(null)} />
    </>
  );
}

/**
 * In the account menu, the one of your plans near or at its limit (from `PLAN_ALMOST`, 80%: "Quase no limite"), at
 * its limit first: its maker's mark, its name and its state, opening Configurações › Uso. Nothing otherwise. Your
 * accounts are read, and their usage looked up again (it comes back as `machine.updated`), when the menu opens.
 */
function PlanNearLimitItem() {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const api = useApi();
  const dir = useDirectory(org.id);
  const navigate = useNavigate();
  const plan = planNearLimit(ownPlanLines(t, useAiAccounts(org.id).data, dir.agents, me.user.id));
  useEffect(() => {
    void api.machines.refreshAccountUsage(org.id).catch(() => undefined);
  }, [api, org.id]);
  if (!plan) return null;
  return (
    <MenuItem
      leading={<ProviderLogo id={plan.logo} size="xs" />}
      hint={planWord(t, i18n.language, plan.usage)}
      onSelect={() =>
        void navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section: "usage" } })
      }
    >
      <span className="profile-menu__plan">{plan.name}</span>
    </MenuItem>
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
        mark={<OrgMark logo={org.logo} size={82} />}
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
  const managesAgents = can(org, "manage_agents");
  const connections = useConnections(org.id);
  const skills = useSkills(org.id, managesAgents);
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
        {can(org, "invite_people") && (
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
        {managesAgents && (
          <MenuOverlayItem icon="agent" shortcut={next()} onSelect={go("access")}>
            {t("settings.section.access")}
          </MenuOverlayItem>
        )}
        {managesAgents && (
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
        {/* On agentes.chat Cloud, while sign-up is by invitation, only an invitation makes a workspace (ADR 0078). */}
        {me.user.canCreateWorkspace !== false && (
          <>
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
          </>
        )}
      </MenuOverlayGroup>
    </>
  );
}
