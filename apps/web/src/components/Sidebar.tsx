import type {
  Agent,
  AgentSort,
  Availability,
  Channel,
  ChannelCategory,
  Member,
  SidebarSection as SectionKey,
  SidebarItem,
} from "@agenteschat/client";
import {
  agentStateIn,
  agentWorkingIn,
  MISSIONS_WAITING_COUNT,
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
  useSidebarItems,
  useSkills,
  useUnreadThreads,
} from "@agenteschat/client";
import { agentSections, groupOf } from "@agenteschat/client/lib/agent-groups";
import { audienceChip, audienceNames, audienceNotice, canTalk, hiddenAgentIds } from "@agenteschat/client/lib/audience";
import { ErrorBoundary } from "@agenteschat/client/lib/error-boundary";
import { errorText } from "@agenteschat/client/lib/errors";
import { waitingAgents } from "@agenteschat/client/lib/outages";
import { can, managesChannel } from "@agenteschat/client/lib/permissions";
import { AVAILABILITIES, clearsText, isOutOfOffice, presenceOfAvailability } from "@agenteschat/client/lib/presence";
import { recentDms } from "@agenteschat/client/lib/recent";
import { isRightHand, rightHandSeenKey } from "@agenteschat/client/lib/right-hand";
import { inSidebarList, SIDEBAR_ITEMS, sidebarPlace } from "@agenteschat/client/lib/sidebar-items";
import { AGENT_SORTS, sortAgents } from "@agenteschat/client/lib/sidebar-view";
import { badgeCount, looksUnread } from "@agenteschat/client/lib/unread";
import {
  type AgentColor,
  Avatar,
  agentGradient,
  Button,
  CountBadge,
  CountChip,
  cx,
  Icon,
  type IconName,
  Kbd,
  Menu,
  MenuCheckboxItem,
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
import { useSidebarPins } from "@/hooks/useSidebarPins";
import { useUnreadTitle } from "@/hooks/useUnreadTitle";
import { requestAgentPanel } from "@/lib/agent-panel-ask";
import { requestChannelDetails } from "@/lib/channel-details";
import type { MenuEntry } from "@/lib/context-menu";
import { onPhoneAsk, takePhoneAsk } from "@/lib/desktop";
import { entityMenu } from "@/lib/entity-menu";
import { useOpenParam } from "@/lib/open-param";
import { markOpen } from "@/lib/perf";
import { ownPlanLines, planNearLimit, planWord } from "@/lib/plan-usage";
import { rightHandSeen, STORAGE_KEYS, storage, storedStrings } from "@/lib/storage";
import { useToast } from "@/lib/toast";
import type { SettingsSection } from "@/pages/settings-sections";
import { useStreams } from "@/realtime/context";
import { ProfileDialog } from "./AccountSettings";
import { AddPasswordDialog } from "./AddPassword";
import { AgentAvatar } from "./AgentAvatar";
import { type GroupDialogFor, GroupNameDialog, useAgentDrag, useMoveAgent } from "./AgentGroups";
import { MoveChannelDialog, NewCategoryDialog, RenameCategoryDialog } from "./ChannelCategoryDialogs";
import { openPalette } from "./CommandMenu";
import { DeleteAccountDialog } from "./DeleteAccount";
import { MenuEntries } from "./DesktopMenus";
import { useAgentMenu, useChannelMenu, usePersonMenu } from "./entity-menus";
import { useInviteDialog } from "./invite/InviteDialog";
import { useNow } from "./missions/MissionBits";
import { COMPACT_QUERY, useMediaQuery, useNavDrawer } from "./NavDrawer";
import { NewChannelDialog } from "./NewChannelDialog";
import { OpenOnPhoneDialog } from "./OpenOnPhone";
import { useOrg } from "./org-context";
import { StatusLine } from "./Presence";
import { MyFace, OrgMark } from "./ProfilePhoto";
import { sectionName, useSectionOrder } from "./SidebarOrder";
import { SIDEBAR_TOOLS, SidebarSetupDialog, ToolList } from "./SidebarSetup";
import { AgentGlow, AgentTrail, colorOf, MenuHorizon, SidebarHorizon, WorkspaceSky } from "./Sky";
import { SetStatusDialog, useSaveStatus } from "./StatusDialog";

/** An agent's sky for its busy chip (`.sidebar__busy`): both themes, the CSS picks one. */
const selectionSky = (color: AgentColor) =>
  ({ "--sel-sky": selectionSkyUrl(color), "--sel-sky-dark": selectionSkyUrl(color, true) }) as CSSProperties;

/** Sidebar rows loading: an icon (or avatar) and a name bar, at the real row height. */
function SidebarSkeleton({ count, avatar, label }: { count: number; avatar?: boolean; label: string }) {
  return (
    <SkeletonGroup label={label}>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
        <span key={i} className="sidebar__item sidebar__item--skeleton">
          <Skeleton shape={avatar ? "square" : "block"} width={avatar ? 28 : 16} height={avatar ? 28 : 16} />
          <Skeleton width={[96, 72, 112][i % 3]} />
        </span>
      ))}
    </SkeletonGroup>
  );
}

/** In place of an agent's or a person's row that failed to draw (`ErrorBoundary`): the rest of the sidebar works. */
function UnshownRow() {
  const { t } = useTranslation();
  return (
    <span className="sidebar__item sidebar__item--unshown" title={t("shell.unshown")}>
      <Icon name="alert" />
      <span className="sidebar__item-label">{t("shell.unshown")}</span>
    </span>
  );
}
export const unshownRow = () => <UnshownRow />;

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
  // A new category: empty, or with the channel whose menu asked for it.
  const [newCategory, setNewCategory] = useState<{ withChannel?: string } | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    const open = () => setCreatingChannel(true);
    window.addEventListener(NEW_CHANNEL_EVENT, open);
    return () => window.removeEventListener(NEW_CHANNEL_EVENT, open);
  }, []);
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
  const missionList = useMissionList(orgId, MISSIONS_WAITING_COUNT);
  const missionsWaiting = missionList.data?.counts.waitingYou ?? 0;
  // …and whether a thread I follow has a reply I haven't read: the entry lights like an unread channel.
  const unreadThreads = useUnreadThreads(orgId).data ?? 0;
  // The tools on top, each where I put it (the rest in More); one there "when there's something" while its count is.
  const sidebarItems = useSidebarItems(orgId).data;
  // An unread reply counts as "something" for a Threads set to show "when there's something": it comes into the list
  // lit, and leaves once read, as Approvals does once nothing waits.
  const counts: Partial<Record<SidebarItem, number>> = { approvals: pending, threads: missionsWaiting + unreadThreads };
  const listed = SIDEBAR_ITEMS.filter((id) => inSidebarList(sidebarPlace(sidebarItems, id), counts[id] ?? 0));
  const inMore = SIDEBAR_ITEMS.filter((id) => !listed.includes(id));
  const countOf = (id: SidebarItem) =>
    id === "approvals" && pending > 0 ? (
      <CountBadge aria-label={t("shell.pendingApprovals", { count: pending })}>{pending}</CountBadge>
    ) : id === "threads" && missionsWaiting > 0 ? (
      // Missões is a tab of Threads: the missions waiting for me as a neutral count.
      <CountChip
        className="sidebar__count"
        role="img"
        aria-label={t("shell.missionsWaiting", { count: missionsWaiting })}
      >
        {missionsWaiting}
      </CountChip>
    ) : null;
  const toolRow = (id: SidebarItem) => (
    <Link
      key={id}
      to={SIDEBAR_TOOLS[id].to}
      params={{ orgId }}
      className="sidebar__item"
      title={
        id === "threads" && unreadThreads > 0 ? t("shell.unreadThreads", { count: unreadThreads }) : t(`shell.${id}`)
      }
      data-unread={id === "threads" && unreadThreads > 0}
    >
      <Icon name={SIDEBAR_TOOLS[id].icon} />
      <span className="sidebar__item-label">{t(`shell.${id}`)}</span>
      {countOf(id)}
    </Link>
  );
  // Agents waiting for an offline computer: "esperando" instead of anything "working".
  const outages = useMachineOutages(orgId);
  const waitingFor = useMemo(() => waitingAgents(outages.data), [outages.data]);
  // The agents' presence and lines (ADR 0084): the one place that polls them; every face reads the same list.
  useAgentStatuses(orgId);
  // The tab's title: "(3) agentes.chat", what the sidebar's numbers add up to (agents it doesn't list left out).
  const hiddenAgents = useMemo(() => hiddenAgentIds(org, dir.agents), [org, dir.agents]);
  useUnreadTitle(orgId, hiddenAgents);
  const dms = useDms(orgId);
  const dmChannels = new Set((dms.data ?? []).map((d) => d.channelId));
  // Hover or focus loads the conversation before the click.
  const prefetch = usePrefetchMessages(orgId);
  // …and the unread and latest ones as soon as the workspace opens.
  usePrefetchRecent(orgId);
  // The right hand (ADR 0137) has its own row on top; outside its audience, none.
  const rightHand = dir.agents.find(isRightHand);
  const dmOf = new Map((dms.data ?? []).map((d) => [d.with.id, d]));
  const rightHandDm = rightHand ? dmOf.get(rightHand.id) : undefined;
  const sections = useSidebarSections(me.user.id, orgId);
  // "Fixar no topo": pinned rows sit on top of their own section, above a thin line.
  const pinned = useSidebarPins();
  const { view, setView, pins } = pinned;
  // "Mensagens diretas": the people I talked to, latest first (an agent's row in AGENTES is its DM), pinned ones on top.
  const pinnedPeople = pins.people.flatMap((id) => {
    const m = id === me.user.id ? undefined : dir.memberById.get(id);
    return m ? [m] : [];
  });
  const directs = recentDms(dms.data ?? [], hiddenAgents).flatMap((d) => {
    const member = d.with.type === "person" ? dir.memberById.get(d.with.id) : undefined;
    return member && !pins.people.includes(member.userId) ? [{ dm: d, member }] : [];
  });
  const directsUnread = [...pinnedPeople.map((m) => dmOf.get(m.userId)), ...directs.map((x) => x.dm)].reduce(
    (n, d) => n + (d?.unread ?? 0),
    0,
  );

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

  // AGENTES (ADR 0083 and its addendum): the agents that talk to me (who manages agents may list the rest), my pinned
  // ones on top, then the ones in no group, then each group of agents, each in my order.
  const manages = can(org, "manage_agents");
  const team = dir.agents.filter((a) => !isRightHand(a));
  const shownAgents = team.filter((a) => (manages && view.showAllAgents) || canTalk(a));
  const busyKey = useStreams((st) => [...runningAgents(st)].sort().join());
  const busy = useMemo(() => new Set(busyKey ? busyKey.split(",") : []), [busyKey]);
  const groups = useAgentGroups(orgId).data ?? [];
  const pinnedAgents = pins.agents.flatMap((id) => shownAgents.filter((a) => a.id === id));
  const byGroup = agentSections(
    shownAgents.filter((a) => !pins.agents.includes(a.id)),
    groups,
    (a) => a.id,
  );
  const ordered = (list: Agent[]) => sortAgents(list, view.agentSort, me.user.id, busy);
  // Members never see an empty group; who arranges the agents keeps them, to drop agents in.
  const agentGroups = byGroup.groups.filter((g) => g.items.length > 0 || (manages && g.group.agentIds.length === 0));
  const groupIds = agentGroups.map((g) => `group:${g.group.id}` as SectionId);
  // A long team starts with its groups closed. Closed, a group still shows who works, waits or wrote to me.
  const groupsOpen = shownAgents.length <= 12;
  const organize = manages && !rail;
  const drag = useAgentDrag(groups);
  const moveAgent = useMoveAgent(groups);
  const [groupDialog, setGroupDialog] = useState<GroupDialogFor | null>(null);
  const agentsUnread = shownAgents.reduce((n, a) => n + (dmOf.get(a.id)?.unread ?? 0), 0);
  // "Mudar de grupo" in an agent's right click: the keyboard's way to what dragging does.
  const groupEntries = (a: Agent): MenuEntry[] => {
    const current = groupOf(groups, a.id)?.id ?? null;
    const choices = groups.length ? [{ id: null, name: t("agentGroups.none") }, ...groups] : [];
    return [
      { kind: "separator" },
      ...(choices.length ? [{ kind: "header" as const, label: t("sidebarAgents.changeGroup") }] : []),
      ...choices.map(
        (g): MenuEntry => ({
          kind: "item",
          id: `group-${g.id ?? "none"}`,
          label: g.name,
          // The menu's other items have icons: the groups' line up with them. Its own group is dimmed.
          icon: "layers",
          disabled: g.id === current,
          run: () => moveAgent(a.id, g.id),
        }),
      ),
      {
        kind: "item",
        id: "new-group",
        label: t("sidebarAgents.newGroupWith", { name: a.name }),
        icon: "plus",
        run: () => setGroupDialog({ mode: "create", agentIds: [a.id] }),
      },
    ];
  };
  const agentRow = (a: Agent) => {
    const dm = dmOf.get(a.id);
    const unread = dm?.unread ?? 0;
    return (
      <ErrorBoundary
        key={a.id}
        resetKey={a}
        // Still a row the drag counts (`useAgentDrag`), so a drop below it lands where the pointer is.
        fallback={() => (
          <div className="sidebar__row" data-agent-row={a.id}>
            <UnshownRow />
          </div>
        )}
      >
        <AgentRow
          agent={a}
          unread={unread}
          waitingFor={waitingFor.get(a.id)}
          live={busy.has(a.id) || waitingFor.has(a.id) || unread > 0}
          pinned={pins.agents.includes(a.id)}
          onPrefetch={() => dm && prefetch(dm.channelId)}
          onOpen={() => markOpen(dm?.channelId ?? a.id)}
          drag={organize ? drag.row(a.id) : undefined}
          menuExtra={manages ? groupEntries(a) : undefined}
        />
      </ErrorBoundary>
    );
  };
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
  }, [channels.data, directs.length, shownAgents.length, groups.length, rail]);

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
  }, [pathname, channels.data, directs.length, shownAgents.length, rail]);

  // The person's order of the sections (SidebarOrder.tsx); a section with nothing to show leaves no line.
  const sectionOrder = useSectionOrder(orgId);
  const sectionMenu = (id: SectionKey) =>
    entityMenu(() => [{ kind: "header", label: sectionName(t, id) }, ...sectionOrder.entries(id)]);
  // What the headers' + and the sidebar's own menu (right click on its empty space) create, each as far as the role allows.
  const item = (id: string, label: string, icon: IconName, run: () => void): MenuEntry => ({
    kind: "item",
    id,
    label,
    icon,
    run,
  });
  const newChannelItem = can(org, "create_channels")
    ? [item("new-channel", t("shell.sidebarMenu.newChannel"), "channel", () => setCreatingChannel(true))]
    : [];
  const newCategoryItem = can(org, "manage_channels")
    ? [item("new-category", t("channelCategories.newCategory"), "layers", () => setNewCategory({}))]
    : [];
  const createAgentItem = can(org, "create_agents")
    ? [
        item(
          "create-agent",
          t("shell.createAgent"),
          "plus",
          () => void navigate({ to: "/org/$orgId/agents/new", params: { orgId } }),
        ),
      ]
    : [];
  const newGroupItem = manages
    ? [item("new-group", t("agentGroups.newGroup"), "layers", () => setGroupDialog({ mode: "create" }))]
    : [];
  const groupsClosed = groupIds.every((id) => !sections.isOpen(id, groupsOpen));
  // A tool's link keeps the browser's menu, from the mouse and the keyboard alike.
  const spaceEvent = (e: { target: EventTarget }) => !(e.target instanceof Element && e.target.closest("a[href]"));
  const sidebarMenu = entityMenu(() => [
    { kind: "header", label: t("shell.sidebarMenu.title") },
    item("customize", t("shell.customizeSidebar"), "settings", () => setCustomizing(true)),
    { kind: "separator" },
    ...newChannelItem,
    ...newCategoryItem,
    { kind: "separator" },
    ...createAgentItem,
    ...newGroupItem,
    item("team", t("shell.team"), "agent", () => void navigate({ to: "/org/$orgId/team", params: { orgId } })),
    { kind: "separator" },
    sectionOrder.restore,
  ]);
  const blocks: Record<SectionKey, ReactNode> = {
    tools: (
      // The tools each person keeps in sight; the rest open beside the sidebar from More.
      <div className="sidebar__group sidebar__tools">
        <Link to="/org/$orgId/home" params={{ orgId }} className="sidebar__item" title={t("shell.home")}>
          <Icon name="home" />
          <span className="sidebar__item-label">{t("shell.home")}</span>
        </Link>
        <ToolList items={listed} row={toolRow} />
        <MoreTools items={inMore} row={toolRow} countOf={countOf} onCustomize={() => setCustomizing(true)} />
      </div>
    ),
    channels: (
      <SidebarChannels
        channels={(channels.data ?? []).filter((c) => !dmChannels.has(c.id))}
        loading={channels.isLoading}
        sections={sections}
        onNewChannel={(categoryId) => setCreatingChannel(categoryId ?? true)}
        onNewCategory={(withChannel) => setNewCategory(withChannel ? { withChannel } : {})}
        onPrefetch={prefetch}
        headProps={sectionMenu("channels")}
        addEntries={[...newChannelItem, ...newCategoryItem]}
        pinned={pins.channels}
      />
    ),
    agents: (dir.loading || (team.length > 0 ? shownAgents.length > 0 || manages : createAgentItem.length > 0)) && (
      <>
        <SidebarSection
          id="agents"
          label={t("shell.agents")}
          sections={sections}
          className="sidebar__section--part"
          headProps={sectionMenu("agents")}
          // Closed, the part hides its groups too: their unread count with its own.
          summary={agentsUnread > 0 && <UnreadCount count={agentsUnread} />}
          action={
            <>
              <Menu
                align="end"
                label={t("sidebarAgents.options")}
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon="more"
                    className="sidebar__section-add"
                    aria-label={t("sidebarAgents.options")}
                    title={t("sidebarAgents.options")}
                  />
                }
              >
                <MenuRadioGroup
                  label={t("sidebarAgents.order")}
                  value={view.agentSort}
                  onValueChange={(v) => setView((now) => ({ ...now, agentSort: v as AgentSort }))}
                  options={AGENT_SORTS.map((value) => ({ value, label: t(`sidebarAgents.sort.${value}`) }))}
                />
                {manages && (
                  <>
                    <MenuSeparator />
                    <MenuCheckboxItem
                      checked={view.showAllAgents}
                      onCheckedChange={(on) => setView((now) => ({ ...now, showAllAgents: on }))}
                    >
                      {t("sidebarAgents.showAll")}
                    </MenuCheckboxItem>
                  </>
                )}
                {(agentGroups.length > 0 || manages) && <MenuSeparator />}
                {agentGroups.length > 0 && (
                  <MenuItem
                    icon={groupsClosed ? "chevronDown" : "chevronUp"}
                    onSelect={() => sections.setAll(groupIds, groupsClosed)}
                  >
                    {groupsClosed ? t("sidebarAgents.expandAll") : t("sidebarAgents.collapseAll")}
                  </MenuItem>
                )}
                {manages && (
                  <MenuItem icon="layers" onSelect={() => void navigate({ to: "/org/$orgId/team", params: { orgId } })}>
                    {t("sidebarAgents.organize")}
                  </MenuItem>
                )}
              </Menu>
              <SectionAdd label={t("sidebarAgents.add")} entries={[...createAgentItem, ...newGroupItem]} />
            </>
          }
          drop={organize ? drag.zone(null) : undefined}
        >
          {dir.loading && team.length === 0 && <SidebarSkeleton count={2} avatar label={t("common.loadingList")} />}
          {pinnedAgents.map(agentRow)}
          {pinned.hint && (
            <div className="sidebar__pins-hint" role="note">
              <span>{t("sidebarPins.hint")}</span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="close"
                aria-label={t("common.close")}
                title={t("common.close")}
                onClick={pinned.dismissHint}
              />
            </div>
          )}
          {pinnedAgents.length > 0 && (byGroup.ungrouped.length > 0 || agentGroups.length > 0) && (
            <hr className="sidebar__pins-end" />
          )}
          {ordered(byGroup.ungrouped).map(agentRow)}
          {!dir.loading && team.length === 0 && (
            <Link to="/org/$orgId/agents/new" params={{ orgId }} className="sidebar__item sidebar__item--quiet">
              <Icon name="plus" />
              <span className="sidebar__item-label">{t("sidebarAgents.createFirst")}</span>
            </Link>
          )}
        </SidebarSection>
        {agentGroups.map(({ group, items }) => {
          const list = ordered(items);
          // Where a dragged row would land: a line before the row at that place among the others.
          const others = list.filter((a) => a.id !== drag.dragging);
          const lineAt = drag.over?.groupId === group.id ? drag.over.index : null;
          const line = <span className="sidebar__drop-line" aria-hidden="true" />;
          const workingHere = list.filter((a) => busy.has(a.id)).length;
          return (
            <SidebarSection
              key={group.id}
              id={`group:${group.id}`}
              label={group.name}
              sections={sections}
              defaultOpen={groupsOpen}
              className="sidebar__section--category sidebar__section--group"
              summary={
                workingHere > 0 && (
                  <span className="sidebar__section-working">{t("sidebarAgents.working", { count: workingHere })}</span>
                )
              }
              action={
                <span className="sidebar__section-count" title={t("sidebarAgents.count", { count: list.length })}>
                  {list.length}
                </span>
              }
              drop={organize ? drag.zone(group.id) : undefined}
            >
              {list.map((a) => (
                <Fragment key={a.id}>
                  {lineAt === others.indexOf(a) && line}
                  {agentRow(a)}
                </Fragment>
              ))}
              {lineAt !== null && lineAt >= others.length && line}
              {manages && group.agentIds.length === 0 && (
                <span className="sidebar__drop-hint">{t("agentGroups.dropHere")}</span>
              )}
            </SidebarSection>
          );
        })}
        {team.length > 0 && (
          <Link to="/org/$orgId/team" params={{ orgId }} className="sidebar__item sidebar__see-all">
            <Icon name="agent" />
            <span className="sidebar__item-label">{t("sidebarAgents.seeAll", { count: team.length })}</span>
          </Link>
        )}
      </>
    ),
    people: (
      <SidebarSection
        id="people"
        label={t("shell.directMessages")}
        sections={sections}
        className="sidebar__section--part"
        headProps={sectionMenu("people")}
        summary={directsUnread > 0 && <UnreadCount count={directsUnread} />}
        // "Nova mensagem" is Ir para…, which finds anyone (people and agents).
        action={
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon="plus"
            className="sidebar__section-add"
            aria-label={t("shell.sidebarMenu.newMessage")}
            title={t("shell.sidebarMenu.newMessage")}
            onClick={openPalette}
          />
        }
      >
        {pinnedPeople.map((m) => {
          const dm = dmOf.get(m.userId);
          return (
            <ErrorBoundary key={m.userId} resetKey={m} fallback={unshownRow}>
              <PersonRow
                member={m}
                unread={dm?.unread ?? 0}
                pinned
                onPrefetch={() => dm && prefetch(dm.channelId)}
                onOpen={() => markOpen(dm?.channelId ?? m.userId)}
              />
            </ErrorBoundary>
          );
        })}
        {pinnedPeople.length > 0 && directs.length > 0 && <hr className="sidebar__pins-end" />}
        {directs.map(({ dm, member }) => (
          <ErrorBoundary key={dm.channelId} resetKey={member} fallback={unshownRow}>
            <PersonRow
              member={member}
              unread={dm.unread}
              onPrefetch={() => prefetch(dm.channelId)}
              onOpen={() => markOpen(dm.channelId)}
            />
          </ErrorBoundary>
        ))}
        {!rail && pinnedPeople.length === 0 && directs.length === 0 && !dms.isLoading && (
          <p className="sidebar__empty">
            {t("sidebarAgents.dmsEmpty")}{" "}
            <button type="button" className="ac-link" onClick={openPalette}>
              {t("shell.sidebarMenu.newMessage")}
            </button>
          </p>
        )}
      </SidebarSection>
    ),
  };

  return (
    <nav className="sidebar" aria-label={t("shell.nav")} data-rail={rail} {...drawer?.navProps}>
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

      {/* Space, not lines, between the tools, the channels, the agents and the people. A right click on the space
          between the rows (not on a row or a header, which have their own) opens the sidebar's menu; a link with no
          menu of its own (a tool) keeps the browser's. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the right click and Shift+F10 of the sidebar's own menu */}
      <div
        className="sidebar__scroll"
        ref={navRef}
        onKeyDown={(e) => spaceEvent(e) && sidebarMenu.onKeyDown(e)}
        onContextMenu={(e) => spaceEvent(e) && sidebarMenu.onContextMenu(e)}
      >
        {rightHand && rightHand.canTalk !== false && (
          <div className="sidebar__group sidebar__pin">
            <RightHandRow
              agent={rightHand}
              unread={rightHandDm?.unread ?? 0}
              onPrefetch={() => rightHandDm && prefetch(rightHandDm.channelId)}
              onOpen={() => rightHandDm && markOpen(rightHandDm.channelId)}
            />
          </div>
        )}
        {sectionOrder.order.filter((id) => blocks[id]).map((id) => sectionOrder.block(id, blocks[id], !rail))}
      </div>

      <NewChannelDialog
        open={creatingChannel !== false}
        onOpenChange={(open) => setCreatingChannel(open)}
        category={typeof creatingChannel === "string" ? creatingChannel : null}
      />
      <NewCategoryDialog
        open={newCategory !== null}
        onOpenChange={(open) => !open && setNewCategory(null)}
        withChannel={newCategory?.withChannel}
      />
      <SidebarSetupDialog open={customizing} onClose={() => setCustomizing(false)} />
      {groupDialog && <GroupNameDialog purpose={groupDialog} onClose={() => setGroupDialog(null)} />}

      <div className="sidebar__foot">
        <SidebarHorizon working={working} total={dir.agents.length} />
        {/* The full sidebar creates from the Agentes header's + (always shown on touch screens); the rail has no
            headers. */}
        {rail && can(org, "create_agents") && (
          <Button asChild block variant="ghost" className="sidebar__create">
            <Link to="/org/$orgId/agents/new" params={{ orgId }} title={t("shell.createAgent")}>
              <Icon name="plus" />
              <span className="sidebar__item-label">{t("shell.createAgent")}</span>
            </Link>
          </Button>
        )}
        <div className="sidebar__me">
          <AccountMenu />
          <Link
            to="/org/$orgId/notifications"
            params={{ orgId }}
            className="sidebar__bell"
            title={t("shell.notifications")}
            aria-label={
              unreadNotifications > 0
                ? t("shell.unreadNotifications", { count: unreadNotifications })
                : t("shell.notifications")
            }
          >
            <Icon name="bell" />
            {unreadNotifications > 0 && (
              <CountBadge key={bumps} className={bumps > 0 ? "sidebar__bump" : undefined}>
                {unreadNotifications}
              </CountBadge>
            )}
          </Link>
        </div>
      </div>
    </nav>
  );
}

/** The fixed sections, a channel category as `category:<id>` (ADR 0080) and a group of agents as `group:<id>` (ADR 0083). */
type SectionId = "channels" | "agents" | "people" | `category:${string}` | `group:${string}`;

/**
 * Which sidebar categories are closed, remembered in this browser for each person in each workspace. One closed by
 * default (`byDefault` false) and opened by the person is kept as `+<id>`.
 */
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
  const openIn = (closed: Set<string>, id: SectionId, byDefault: boolean) =>
    closed.has(id) ? false : closed.has(`+${id}`) || byDefault;
  const toggle = (id: SectionId, byDefault = true) =>
    change((closed) => {
      const open = openIn(closed, id, byDefault);
      closed.delete(id);
      closed.delete(`+${id}`);
      if (open) closed.add(id);
      else if (!byDefault) closed.add(`+${id}`);
    });
  /** "Fechar todas" / "Abrir todas" for the channel categories and the groups of agents. */
  const setAll = (ids: SectionId[], open: boolean) =>
    change((closed) => {
      for (const id of ids) {
        closed.delete(id);
        closed.delete(`+${id}`);
        closed.add(open ? `+${id}` : id);
      }
    });
  return { isOpen: (id: SectionId, byDefault = true) => openIn(saved.closed, id, byDefault), toggle, setAll };
}

/**
 * A sidebar category that opens and closes. Closed, it keeps its open page's row in sight (CSS shows
 * only the active item), and shows `summary` (a count) on its header.
 * On the icon rail the header goes away and every item shows. `drop`: it takes dragged channels or agents.
 */
function SidebarSection({
  id,
  label,
  sections,
  defaultOpen = true,
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
  /** Open until the person closes it (a long team's groups start closed). */
  defaultOpen?: boolean;
  summary?: ReactNode;
  action?: ReactNode;
  /** It takes a drop: dragged agents (`useAgentDrag`), or channels taken out of their category. */
  drop?: HTMLAttributes<HTMLDivElement> & { "data-drop"?: string | boolean };
  className?: string;
  /** A channel category's header: its right click and dragging. */
  headProps?: HTMLAttributes<HTMLDivElement>;
  children: ReactNode;
}) {
  const open = sections.isOpen(id, defaultOpen);
  const bodyId = `sidebar-section-${id.replace(":", "-")}`;
  return (
    <div className={cx("sidebar__group sidebar__section", className)} data-open={open} {...drop}>
      <div className="sidebar__section-head" {...headProps}>
        <button
          type="button"
          className="sidebar__section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => sections.toggle(id, defaultOpen)}
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

/** A part header's +: a menu of what it creates (none of it allowed: no +). */
function SectionAdd({ label, entries }: { label: string; entries: MenuEntry[] }) {
  if (!entries.length) return null;
  return (
    <Menu
      align="end"
      label={label}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          icon="plus"
          className="sidebar__section-add"
          aria-label={label}
          title={label}
        />
      }
    >
      <MenuEntries entries={entries} />
    </Menu>
  );
}

/** A button over a row's end on hover or focus (`.sidebar__row-acts`), in place of its count or role. */
function RowAction({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      icon={icon}
      className="sidebar__row-menu"
      aria-label={label}
      title={label}
      onClick={onClick}
    />
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
 * The channels (ADR 0080): the "Canais" part, its channels with no category first, then one section per category
 * (closed, "Canais" hides them too, but the open channel's); closed, a category keeps the open channel and the unread
 * ones in sight (CSS). Who may manage channels arranges the categories; they and a channel's creator move it by
 * dragging, from its right click ("Mover para…") or in its details.
 */
function SidebarChannels({
  channels,
  loading,
  sections,
  onNewChannel,
  onNewCategory,
  onPrefetch,
  headProps,
  addEntries,
  pinned,
}: {
  channels: Channel[];
  loading: boolean;
  sections: ReturnType<typeof useSidebarSections>;
  /** A category's + (its id), or a new channel with none (null). */
  onNewChannel: (categoryId: string | null) => void;
  /** A new category, with the channel whose menu asked for it. */
  onNewCategory: (withChannel?: string) => void;
  onPrefetch: (channelId: string) => void;
  /** "Canais"' header: the section's own menu (its place in the sidebar). */
  headProps?: HTMLAttributes<HTMLDivElement>;
  /** What "Canais"' + creates. */
  addEntries: MenuEntry[];
  /** The channels pinned on top of "Canais" ("Fixar no topo"), in order. */
  pinned: readonly string[];
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
  const mayChange = (c: Channel) => managesChannel(c, me.user.id, org);
  const [renaming, setRenaming] = useState<ChannelCategory | null>(null);
  const [moving, setMoving] = useState<Channel | null>(null);
  const drag = useRef<Dragging | null>(null);
  const [mark, setMark] = useState<DropMark>(null);
  const failed = (e: unknown) => toast.show(errorText(t, e), "error");

  const list = categories.data ?? [];
  const known = new Set(list.map((c) => c.id));
  // A channel whose category isn't loaded yet (or is gone) shows with the ones with none. So nothing drags until
  // the categories load: a drop would take the channel out of its category.
  const categoryOf = (c: Channel) => (c.categoryId && known.has(c.categoryId) ? c.categoryId : null);
  const pinnedChannels = pinned.flatMap((id) => channels.filter((c) => c.id === id && c.isMember));
  const unpinned = channels.filter((c) => !pinnedChannels.includes(c));
  const loose = unpinned.filter((c) => categoryOf(c) === null);
  const inCategory = (id: string) => unpinned.filter((c) => categoryOf(c) === id);
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
    if (d?.kind !== "channel") return;
    if (d.id !== c.id) return over(e, `channel:${c.id}`, half(e));
    // Over its own row it lands nowhere: not at the end of the section around it.
    e.stopPropagation();
    if (mark) setMark(null);
  };
  // "Into" the part the channel is already in lands nowhere: the server would move it to that part's end.
  const intoPart = (e: DragEvent, key: string) => {
    const d = drag.current;
    if (d?.kind !== "channel") return;
    const dragged = channels.find((c) => c.id === d.id);
    const home = dragged && categoryOf(dragged);
    if (home === undefined || key !== (home === null ? "loose" : `${CATEGORY_KEY}${home}`)) return over(e, key, "into");
    e.stopPropagation();
    if (mark) setMark(null);
  };
  const overCategory = (e: DragEvent, category: ChannelCategory) => {
    const d = drag.current;
    if (d?.kind === "channel") intoPart(e, `${CATEGORY_KEY}${category.id}`);
    else if (d?.kind === "category" && d.id !== category.id) over(e, `${CATEGORY_KEY}${category.id}`, half(e));
  };
  const overLoose = (e: DragEvent) => intoPart(e, "loose");
  // Anywhere in a category but on a row (its empty end, a row's hover buttons): a channel goes in, at its end.
  const overCategoryBody = (e: DragEvent, category: ChannelCategory) => intoPart(e, `${CATEGORY_KEY}${category.id}`);
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

  // ── Menus: a channel's and a category's right click (lib/entity-menu.ts), and a category's ⋯ ──
  const channelEntries = useChannelMenu();
  const channelMenu = (c: Channel) =>
    entityMenu(() =>
      channelEntries(c, [
        ...(mayChange(c) && list.length > 0
          ? ([
              {
                kind: "item",
                id: "move",
                label: t("channelCategories.move"),
                icon: "move",
                run: () => setMoving(c),
              },
            ] satisfies MenuEntry[])
          : []),
        ...(manages
          ? ([
              {
                kind: "item",
                id: "new-category",
                label: t("channelCategories.newWithChannel"),
                icon: "layers",
                run: () => onNewCategory(c.id),
              },
            ] satisfies MenuEntry[])
          : []),
      ]),
    );
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
          run: () => onNewCategory(),
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

  // A pinned row stays put: it doesn't drag, and nothing drops on it.
  const row = (c: Channel, top = false) => {
    // Discord's marks: something new lights the row (a pill on its left edge, the name in full ink); only a mention
    // of me gets a number. Muted, it rests dim whatever comes, but a mention still shows.
    const unread = looksUnread(c);
    const mentions = c.mentionCount ?? 0;
    const link = (
      <Link
        key={c.id}
        to="/org/$orgId/c/$channelId"
        params={{ orgId, channelId: c.id }}
        className="sidebar__item"
        title={`#${c.name}`}
        data-kind="channel"
        data-unread={unread}
        data-muted={c.muted || undefined}
        {...(top
          ? {}
          : {
              "data-drop": dropMark(`channel:${c.id}`),
              draggable: categories.data !== undefined && mayChange(c),
              onDragStart: (e: DragEvent) => startDrag(e, { kind: "channel", id: c.id }),
              onDragEnd: endDrag,
              onDragOver: (e: DragEvent) => overChannel(e, c),
              onDrop: drop,
            })}
        onMouseEnter={() => onPrefetch(c.id)}
        onFocus={() => onPrefetch(c.id)}
        onClick={() => markOpen(c.id)}
        {...channelMenu(c)}
      >
        <Icon name="channel" className="sidebar__channel-icon" />
        <span className="sidebar__channel-abbr" aria-hidden="true">
          {channelInitials(c.name)}
        </span>
        <span className="sidebar__item-label">{c.name}</span>
        {mentions > 0 ? (
          <UnreadCount count={mentions} mentions />
        ) : (
          <>
            {unread && <span className="ac-visually-hidden">{t("shell.unreadMark")}</span>}
            {top && <PinnedMark />}
          </>
        )}
      </Link>
    );
    // On hover or focus, like Discord's invite and settings: who manages the channel adds members or opens its details.
    if (!mayChange(c)) return link;
    const open = (ask: "details" | "add") => () => {
      requestChannelDetails(c.id, ask);
      void navigate({ to: "/org/$orgId/c/$channelId", params: { orgId, channelId: c.id } });
    };
    return (
      <div key={c.id} className="sidebar__row" data-unread={unread} data-acts={2}>
        {link}
        <span className="sidebar__row-acts">
          <RowAction icon="personAdd" label={t("shell.sidebarMenu.addMembers")} onClick={open("add")} />
          <RowAction icon="cog" label={t("shell.sidebarMenu.channelSettings")} onClick={open("details")} />
        </span>
      </div>
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
      <RenameCategoryDialog category={renaming} onOpenChange={(open) => !open && setRenaming(null)} />
      <MoveChannelDialog channel={moving} onOpenChange={(open) => !open && setMoving(null)} canCreate={manages} />
    </>
  );
  const mentions = channels.reduce((n, c) => n + (c.isMember ? (c.mentionCount ?? 0) : 0), 0);

  return (
    <>
      <SidebarSection
        id="channels"
        label={t("shell.channels")}
        sections={sections}
        className="sidebar__section--part"
        headProps={headProps}
        summary={mentions > 0 && <UnreadCount count={mentions} mentions />}
        action={<SectionAdd label={t("shell.sidebarMenu.addToChannels")} entries={addEntries} />}
        // The channels with no category take a channel dragged out of one.
        drop={shown.length > 0 ? { "data-drop": dropMark("loose"), onDragOver: overLoose, onDrop: drop } : undefined}
      >
        {loading && <SidebarSkeleton count={3} label={t("common.loadingList")} />}
        {pinnedChannels.map((c) => row(c, true))}
        {pinnedChannels.length > 0 && (loose.length > 0 || shown.length > 0) && <hr className="sidebar__pins-end" />}
        {loose.map((c) => row(c))}
      </SidebarSection>
      {shown.map((category) => {
        const actions = categoryActions(category);
        return (
          <SidebarSection
            key={category.id}
            id={`${CATEGORY_KEY}${category.id}`}
            label={category.name}
            sections={sections}
            className="sidebar__section--category"
            drop={{ onDragOver: (e) => overCategoryBody(e, category), onDrop: drop }}
            headProps={
              {
                draggable: manages,
                "data-drop": dropMark(`${CATEGORY_KEY}${category.id}`),
                onDragStart: (e) => startDrag(e, { kind: "category", id: category.id }),
                onDragEnd: endDrag,
                onDragOver: (e) => overCategory(e, category),
                onDrop: drop,
                ...entityMenu(() => [
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
            {inCategory(category.id).map((c) => row(c))}
          </SidebarSection>
        );
      })}
      {dialogs}
    </>
  );
}

/**
 * More: the tools the person keeps out of the list, in a panel beside the sidebar (so nothing below moves), each with a
 * line on what it is for, then "Personalizar a barra lateral". The one opened from it stays in sight under it (CSS
 * shows only the active row).
 */
function MoreTools({
  items,
  row,
  countOf,
  onCustomize,
}: {
  items: SidebarItem[];
  row: (id: SidebarItem) => ReactNode;
  countOf: (id: SidebarItem) => ReactNode;
  onCustomize: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
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
          <button ref={trigger} type="button" className="sidebar__item sidebar__more" title={t("shell.more")}>
            <Icon name="more" />
            <span className="sidebar__item-label">{t("shell.more")}</span>
            <Icon name="chevronRight" size={16} className="sidebar__more-chevron" />
          </button>
        }
      >
        {items.map((id) => (
          <Link
            key={id}
            to={SIDEBAR_TOOLS[id].to}
            params={{ orgId: org.id }}
            className="ac-menu__item sidebar__more-item"
            onClick={() => setOpen(false)}
          >
            <Icon name={SIDEBAR_TOOLS[id].icon} />
            <span className="ac-menu__label">
              {t(`shell.${id}`)}
              <span className="ac-menu__desc">{t(`shell.moreWhat.${id}`)}</span>
            </span>
            {countOf(id)}
          </Link>
        ))}
        {/* Dashboards (ADR 0135 §14) and the task manager (ADR 0128): always here, not tools a person places. */}
        <Link
          to="/org/$orgId/dashboards"
          params={{ orgId: org.id }}
          className="ac-menu__item sidebar__more-item"
          onClick={() => setOpen(false)}
        >
          <Icon name="chart" />
          <span className="ac-menu__label">
            {t("dashboards.sidebar")}
            <span className="ac-menu__desc">{t("dashboards.navWhat")}</span>
          </span>
        </Link>
        <Link
          to="/org/$orgId/task-manager"
          params={{ orgId: org.id }}
          className="ac-menu__item sidebar__more-item"
          onClick={() => setOpen(false)}
        >
          <Icon name="chart" />
          <span className="ac-menu__label">
            {t("taskManager.title")}
            <span className="ac-menu__desc">{t("taskManager.navWhat")}</span>
          </span>
        </Link>
        <div className="ac-menu__separator" aria-hidden="true" />
        <button
          type="button"
          className="ac-menu__item sidebar__more-item"
          onClick={() => {
            setOpen(false);
            // Closing the dialog brings focus back to More, not to this line, gone with the panel.
            trigger.current?.focus();
            onCustomize();
          }}
        >
          <Icon name="settings" />
          <span className="ac-menu__label">{t("shell.customizeSidebar")}</span>
        </button>
      </Popover>
      <div className="sidebar__more-active">
        {items.map(row)}
        {/* A board's own page too (`/dashboards/<id>`): the link is active on the pages under it. */}
        <Link
          to="/org/$orgId/dashboards"
          params={{ orgId: org.id }}
          className="sidebar__item"
          title={t("dashboards.sidebar")}
        >
          <Icon name="chart" />
          <span className="sidebar__item-label">{t("dashboards.sidebar")}</span>
        </Link>
        <Link
          to="/org/$orgId/task-manager"
          params={{ orgId: org.id }}
          className="sidebar__item"
          title={t("taskManager.title")}
        >
          <Icon name="chart" />
          <span className="sidebar__item-label">{t("taskManager.nav")}</span>
        </Link>
      </div>
    </>
  );
}

/** A small pin at a pinned row's end, in place of its hover buttons. */
function PinnedMark() {
  const { t } = useTranslation();
  return (
    <span className="sidebar__item-meta sidebar__pinned" role="img" aria-label={t("sidebarPins.pinned")}>
      <Icon name="pin" size={14} />
    </span>
  );
}

/**
 * An agent in AGENTES (its row is its DM); while it works, a light sweep in its color runs behind the row (a pulse in
 * the rail) and the line under its name says where. For who manages agents it drags to another group (`drag`) and its
 * right click has Mudar de grupo (`menuExtra`). `live`: it works, waits or wrote to me, so a closed group still shows it.
 */
function AgentRow({
  agent: a,
  unread,
  waitingFor,
  live,
  pinned,
  onPrefetch,
  onOpen,
  drag,
  menuExtra,
}: {
  agent: Agent;
  unread: number;
  /** The offline computer it waits for (its brain runs there). */
  waitingFor?: string;
  live?: boolean;
  pinned?: boolean;
  onPrefetch: () => void;
  onOpen: () => void;
  drag?: ReturnType<ReturnType<typeof useAgentDrag>["row"]>;
  menuExtra?: MenuEntry[];
}) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const state = useStreams((st) => agentStateIn(st, a.id));
  const workingIn = useStreams((st) => agentWorkingIn(st, a.id));
  const busy = state !== "idle" && !waitingFor;
  const color = colorOf(a);
  const chip = audienceChip(t, a);
  // Its presence from its work and its line (ADR 0084): the badge on its face, both in the row's title (no emoji in
  // the list: the line shows where the agent is opened).
  const shown = useAgentPresence(a.id);
  // Background work's minutes move with the anchor's line, every half minute.
  useNow(shown?.line?.kind === "work", 30_000);
  const word = shown ? t(`presence.${shown.presence}`) : null;
  const line = agentLine(t, shown?.line ?? null, i18n.language);
  const dir = useDirectory(org.id);
  const channelList = useChannels(org.id).data;
  const here = workingIn ? channelList?.find((c) => c.id === workingIn)?.name : undefined;
  const navigate = useNavigate();
  const agentEntries = useAgentMenu();
  const rowMenu = entityMenu(() => agentEntries(a, menuExtra));
  // Its owner and the admins: its settings on hover, like a channel's.
  const edits = can(org, "manage_agents") || a.ownerUserId === me.user.id;
  // Listed for who manages agents though it doesn't talk to them: the line says who it talks to.
  const locked = !canTalk(a);
  const names = locked ? audienceNames(a, (id) => dir.memberById.get(id)?.name, dir.roleName) : [];
  const under = locked
    ? names.length > 1
      ? t("sidebarAgents.talksOnlyMore", { name: names[0], count: names.length - 1 })
      : names[0]
        ? t("sidebarAgents.talksOnly", { name: names[0] })
        : chip
    : busy
      ? here
        ? t("sidebarAgents.workingIn", { channel: here })
        : t(`sky.busy.${state}`)
      : (shown?.line?.kind === "work" || shown?.presence === "out") && line
        ? line.text
        : a.role;
  return (
    <div className="sidebar__row" data-agent-row={a.id} data-live={live || undefined} data-acts={edits ? 1 : undefined}>
      <Link
        {...rowMenu}
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
        style={{ ...selectionSky(color), "--sel-glow-color": agentGradient(color)[1] } as CSSProperties}
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
          asleep={isOutOfOffice(shown?.line)}
          {...(waitingFor ? { state: "idle" as const, expression: "closed" as const } : {})}
        />
        <span className="sidebar__item-text">
          <span className="sidebar__item-label">{a.name}</span>
          {under && (
            <span
              className={cx(
                "sidebar__item-role",
                (busy || shown?.line?.kind === "work") && !locked && "sidebar__item-work",
              )}
            >
              {under}
            </span>
          )}
        </span>
        {unread > 0 ? (
          <UnreadCount count={unread} />
        ) : waitingFor ? (
          <span className="sidebar__item-meta sidebar__waiting" title={t("outage.sidebar.tip", { name: waitingFor })}>
            <Icon name="waiting" size={14} />
            {t("outage.sidebar.waiting")}
          </span>
        ) : pinned ? (
          <PinnedMark />
        ) : (
          chip && (
            <span className="sidebar__item-meta sidebar__item-meta--audience">
              <span
                className="sidebar__lock"
                role="img"
                aria-label={chip}
                title={audienceNotice(t, a, (id) => dir.memberById.get(id)?.name, dir.roleName) || chip}
              >
                <Icon name="lock" size={14} />
              </span>
            </span>
          )
        )}
      </Link>
      {edits && (
        <span className="sidebar__row-acts">
          <RowAction
            icon="cog"
            label={t("shell.sidebarMenu.agentSettings", { name: a.name })}
            onClick={() => {
              if (requestAgentPanel(a.id, "settings")) return;
              onOpen();
              void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: a.id } });
            }}
          />
        </span>
      )}
    </div>
  );
}

/**
 * The team's right hand (ADR 0137), pinned above the tools: its face, its name and "seu braço direito" muted on the
 * right, a one-time "Novo" until its DM first opens (in this browser), and its DM's unread count. It opens the
 * person's DM with it. Not part of the sections, so it is never moved or hidden.
 */
function RightHandRow({
  agent: a,
  unread,
  onPrefetch,
  onOpen,
}: {
  agent: Agent;
  unread: number;
  onPrefetch: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const fresh = rightHandSeen.useFresh(rightHandSeenKey(me.user.id, org.id));
  const shown = useAgentPresence(a.id);
  const label = t("rightHand.label");
  return (
    <Link
      to="/org/$orgId/dm/agent/$agentId"
      params={{ orgId: org.id, agentId: a.id }}
      className="sidebar__item sidebar__pin-row"
      title={`${a.name} · ${label}`}
      onMouseEnter={onPrefetch}
      onFocus={onPrefetch}
      onClick={onOpen}
      data-unread={unread > 0}
      data-right-hand=""
    >
      <AgentAvatar agentId={a.id} name={a.name} size="sm" presence={shown?.presence ?? null} />
      <span className="sidebar__item-label">{a.name}</span>
      {unread > 0 ? (
        <UnreadCount count={unread} />
      ) : fresh ? (
        <span className="sidebar__item-meta sidebar__new">
          <span className="sidebar__new-dot" aria-hidden="true" />
          {t("rightHand.newDot")}
        </span>
      ) : (
        <span className="sidebar__item-meta">{label}</span>
      )}
    </Link>
  );
}

/** A person under "Mensagens diretas": their face with its presence badge, the name; their line in the title (ADR 0084). */
function PersonRow({
  member: m,
  unread,
  pinned,
  onPrefetch,
  onOpen,
}: {
  member: Member;
  unread: number;
  pinned?: boolean;
  onPrefetch: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const shown = usePersonPresence(m.userId);
  const word = shown ? t(`presence.${shown.presence}`) : null;
  const line = shown?.status ? personLine(shown.status) : null;
  const personEntries = usePersonMenu();
  return (
    <Link
      {...entityMenu(() => personEntries(m))}
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
      {unread > 0 ? <UnreadCount count={unread} /> : pinned && <PinnedMark />}
    </Link>
  );
}

/** The number on a row: unread messages of a DM, or mentions of me in a channel (`mentions`), as Discord counts. */
function UnreadCount({ count, mentions = false }: { count: number; mentions?: boolean }) {
  const { t } = useTranslation();
  return (
    <CountBadge
      className="sidebar__unread"
      role="img"
      aria-label={t(mentions ? "shell.unreadMentions" : "shell.unread", { count })}
    >
      {badgeCount(count)}
    </CountBadge>
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
      <ProfileDialog focus={profile ? "name" : null} onClose={() => setProfile(false)} />
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
  const invite = useInviteDialog();
  const go = (section?: SettingsSection) => () => {
    onDone();
    void (section
      ? navigate({ to: "/org/$orgId/settings/$section", params: { orgId: org.id, section } })
      : navigate({ to: "/org/$orgId/settings", params: { orgId: org.id } }));
  };
  // The workspace's invite dialog (ADR 0090), over the page this menu was opened on.
  const inviteNow = () => {
    if (invite) {
      onDone();
      invite.open();
    } else go("members")();
  };
  let key = 0;
  const next = () => String(++key);
  return (
    <>
      <MenuOverlayGroup label={t("shell.workspaceMenuOf", { name: org.name })}>
        {can(org, "invite_people") && (
          <MenuOverlayItem icon="plus" shortcut={next()} description={t("shell.inviteHint")} onSelect={inviteNow}>
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
