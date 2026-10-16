import {
  AvatarStack,
  Button,
  Checkbox,
  cx,
  EmptyState,
  FilterBar,
  FilterChip,
  Icon,
  Menu,
  MenuItem,
  MenuSeparator,
  SearchInput,
  Segmented,
} from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMissionList } from "@/api/missions";
import { useChannels, useThreadList } from "@/api/queries";
import type { ThreadActor, ThreadInfo, ThreadTab } from "@/api/types";
import { ActorAvatar } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { useActorFilterOptions, useFilterCopy } from "@/components/filters";
import { ErrorState, LoadingList } from "@/components/Loading";
import { NewMissionDialog } from "@/components/missions/MissionDialogs";
import { MissionsTab } from "@/components/missions/MissionList";
import { useOrg } from "@/components/org-context";
import { ThreadStatusChip, useThreadControls } from "@/components/threads/ThreadBits";
import { formatFullDate, relativeTime } from "@/lib/format";
import { threadMessageCount, threadTitle } from "@/lib/threads";
import "./threads.css";

/**
 * Threads (docs/design/telas/Threads.html): the subjects that left the
 * channels and DMs. Tabs, search and filters, rows in aligned columns
 * (stacked cards on a phone), hover actions, ⋯, multi-select with the
 * floating bar, and the details panel. No unread counts (reads are per
 * channel) and no counts on the tabs (the API doesn't give them).
 */

/** "Missões" sits between "Com trabalho" and "Fechadas" (ADR 0029 §11); the sidebar's "Missões" opens it. */
export const THREAD_TABS = ["all", "working", "missions", "closed", "archived"] as const satisfies readonly ThreadTab[];
export type ThreadsTab = (typeof THREAD_TABS)[number];

const actorsOf = (t: ThreadInfo): { type: ThreadActor["type"]; id: string }[] =>
  t.participants.flatMap((p) => (p.id ? [{ type: p.type, id: p.id }] : []));

export function ThreadsPage({ initialTab, initialChannel }: { initialTab?: ThreadsTab; initialChannel?: string }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const channels = useChannels(org.id);
  const copy = useFilterCopy();
  const agentOptions = useActorFilterOptions().filter((o) => o.value.startsWith("agent:"));
  const [tab, setTab] = useState<ThreadsTab>(initialTab ?? "all");
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const [channel, setChannel] = useState<string[]>(initialChannel ? [initialChannel] : []);
  const [agent, setAgent] = useState<string[]>([]);
  const [needsYou, setNeedsYou] = useState(false);
  const [mine, setMine] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [newMission, setNewMission] = useState(false);
  const missions = tab === "missions";
  const filters = {
    tab,
    ...(channel[0] ? { channelId: channel[0] } : {}),
    ...(agent[0] ? { agentId: agent[0].slice("agent:".length) } : {}),
    ...(needsYou ? { needsYou: true } : {}),
    ...(mine ? { mine: true } : {}),
    ...(query ? { q: query } : {}),
  };
  const list = useThreadList(org.id, filters, !missions);
  // "Missões" + a count chip: the open missions I see (the server counts them).
  const missionCounts = useMissionList(org.id, { status: "open", limit: 1 }).data?.counts;
  const threads = useMemo(() => list.data?.pages.flatMap((p) => p.threads) ?? [], [list.data]);
  const controls = useThreadControls();
  const open = threads.find((x) => x.id === openId) ?? null;
  const selected = threads.filter((x) => picked.has(x.id));
  const filtered = Boolean(channel.length || agent.length || needsYou || mine || query);
  const clearFilters = () => {
    setChannel([]);
    setAgent([]);
    setNeedsYou(false);
    setMine(false);
    setQ("");
  };
  // A new tab or filter starts a new selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets when the list's filters change
  useEffect(() => setPicked(new Set()), [tab, channel, agent, needsYou, mine, query]);
  // Esc: the details panel first, then the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || (e.target instanceof Element && e.target.closest("[role=dialog], [role=menu]"))) return;
      if (openId) setOpenId(null);
      else setPicked(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);
  const go = (thread: ThreadInfo) =>
    void navigate({ to: "/org/$orgId/threads/$threadId", params: { orgId: org.id, threadId: thread.id } });
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const channelOptions = (channels.data ?? [])
    .filter((c) => c.isMember)
    .map((c) => ({ value: c.id, label: `#${c.name}` }));
  const bulk = (action: "close" | "archive" | "unarchive") => {
    const targets = selected.filter((x) => x.canManage);
    setPicked(new Set());
    if (targets.length > 0) controls.request(targets, action);
  };

  return (
    <div className={cx("page threads", open && "threads--panel")}>
      <div className="threads__main">
        <header className="threads-head">
          <div>
            <h1>{missions ? t("missions.title") : t("threads.title")}</h1>
            <p className="threads-head__sub">{missions ? t("missions.subtitle") : t("threads.subtitle")}</p>
          </div>
          <Button
            size="sm"
            variant={missions ? "primary" : "default"}
            icon={missions ? "plus" : "flag"}
            onClick={() => setNewMission(true)}
          >
            {t("missions.new.open")}
          </Button>
        </header>
        <div className="threads-tabs">
          <Segmented
            label={t("threads.tabsLabel")}
            value={tab}
            onValueChange={(v) => {
              setTab(v);
              setOpenId(null);
            }}
            options={THREAD_TABS.map((v) => ({
              value: v,
              label: t(`threads.tabs.${v}`),
              ...(v === "missions" && missionCounts?.active ? { count: missionCounts.active } : {}),
            }))}
          />
        </div>
        <div className="threads-tools">
          <SearchInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              tab === "archived" ? t("threads.searchArchived") : missions ? t("missions.search") : t("threads.search")
            }
            aria-label={t("threads.search")}
            className="threads-tools__search"
          />
          <FilterBar
            label={t("threads.filters")}
            clearText={copy.clearAll}
            onClear={clearFilters}
            filters={[
              {
                key: "channel",
                active: channel.length > 0,
                node: (
                  <FilterChip
                    label={t("threads.filterChannel")}
                    icon="channel"
                    options={channelOptions}
                    value={channel}
                    onChange={(v) => setChannel(v.slice(-1))}
                    valueText={(o) => o.label}
                    clearLabel={copy.clearOf(t("threads.filterChannel"))}
                    searchLabel={copy.searchLabel}
                    searchPlaceholder={copy.searchPlaceholder}
                    noResults={copy.noResults}
                  />
                ),
              },
              {
                key: "agent",
                active: agent.length > 0,
                node: (
                  <FilterChip
                    label={t("threads.filterAgent")}
                    icon="agent"
                    options={agentOptions}
                    value={agent}
                    onChange={(v) => setAgent(v.slice(-1))}
                    valueText={(o) => o.label}
                    clearLabel={copy.clearOf(t("threads.filterAgent"))}
                    searchLabel={copy.searchLabel}
                    searchPlaceholder={copy.searchPlaceholder}
                    noResults={copy.noResults}
                  />
                ),
              },
              ...(missions
                ? []
                : [
                    {
                      key: "needsYou",
                      active: needsYou,
                      node: (
                        <button
                          type="button"
                          className="threads-toggle"
                          aria-pressed={needsYou}
                          onClick={() => setNeedsYou((v) => !v)}
                        >
                          <Icon name="waiting" size={14} />
                          {t("threads.needsYou")}
                        </button>
                      ),
                    },
                    {
                      key: "mine",
                      active: mine,
                      node: (
                        <button
                          type="button"
                          className="threads-toggle"
                          aria-pressed={mine}
                          onClick={() => setMine((v) => !v)}
                        >
                          <Icon name="person" size={14} />
                          {t("threads.mine")}
                        </button>
                      ),
                    },
                  ]),
            ]}
          />
        </div>
        {tab === "archived" && (
          <p className="threads-note">
            <Icon name="lock" size={14} />
            <span>
              <b>{t("threads.notes.archivedTitle")}</b> {t("threads.notes.archived")}
            </span>
          </p>
        )}
        {tab === "closed" && (
          <p className="threads-note">
            <Icon name="refresh" size={14} />
            <span>{t("threads.notes.closed")}</span>
          </p>
        )}
        {missions && (
          <MissionsTab
            filters={{
              q: query,
              ...(agent[0] ? { agentId: agent[0].slice("agent:".length) } : {}),
              ...(channel[0] ? { channelId: channel[0] } : {}),
            }}
            onNew={() => setNewMission(true)}
          />
        )}
        {!missions && list.isPending && <LoadingList count={5} />}
        {!missions && list.isError && !list.data && (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        )}
        {!missions && list.isSuccess && threads.length === 0 && (
          <ThreadsEmpty tab={tab} filtered={filtered} onClear={clearFilters} onAll={() => setTab("all")} />
        )}
        {!missions && threads.length > 0 && (
          <section
            className="threads-list"
            aria-label={t("threads.listLabel")}
            data-selecting={picked.size > 0 || undefined}
          >
            {threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                open={thread.id === openId}
                picked={picked.has(thread.id)}
                onOpen={() => setOpenId((o) => (o === thread.id ? null : thread.id))}
                onGo={() => go(thread)}
                onPick={() => toggle(thread.id)}
                onAction={(action) => controls.request([thread], action)}
              />
            ))}
          </section>
        )}
        {!missions && list.hasNextPage && (
          <Button className="threads-more" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t("threads.loadMore")}
          </Button>
        )}
        {selected.length > 0 && (
          <div className="drive-selbar threads-selbar" role="toolbar" aria-label={t("threads.selection")}>
            <span className="drive-selbar__count">{t("threads.selected", { count: selected.length })}</span>
            {tab === "archived" ? (
              <Button size="sm" variant="ghost" icon="unarchive" onClick={() => bulk("unarchive")}>
                <span className="drive-selbar__label">{t("threads.actions.unarchive")}</span>
              </Button>
            ) : (
              <>
                {tab !== "closed" && (
                  <Button size="sm" variant="ghost" icon="check" onClick={() => bulk("close")}>
                    <span className="drive-selbar__label">{t("threads.actions.close")}</span>
                  </Button>
                )}
                <Button size="sm" variant="ghost" icon="archiveBox" onClick={() => bulk("archive")}>
                  <span className="drive-selbar__label">{t("threads.actions.archive")}</span>
                </Button>
              </>
            )}
            <span className="drive-selbar__sep" aria-hidden="true" />
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon="close"
              aria-label={t("threads.clearSelection")}
              title={t("threads.clearSelection")}
              onClick={() => setPicked(new Set())}
            />
          </div>
        )}
      </div>
      {open && (
        <ThreadDetails
          thread={open}
          onClose={() => setOpenId(null)}
          onGo={() => go(open)}
          onAction={(action) => controls.request([open], action)}
        />
      )}
      {controls.dialog}
      {newMission && (
        <NewMissionDialog
          open={newMission}
          onOpenChange={setNewMission}
          initialChannelId={channel[0]}
          initialAgentId={agent[0]?.slice("agent:".length)}
        />
      )}
    </div>
  );
}

type RowAction = "close" | "reopen" | "archive" | "unarchive";

/** Quick actions on hover (and in ⋯): what makes sense for the thread's state. */
function quickActions(thread: ThreadInfo): RowAction[] {
  if (!thread.canManage) return [];
  if (thread.state === "archived") return ["unarchive"];
  if (thread.state === "closed") return ["reopen", "archive"];
  return ["close", "archive"];
}
const ACTION_ICON = { close: "check", reopen: "refresh", archive: "archiveBox", unarchive: "unarchive" } as const;

function ThreadRow({
  thread,
  open,
  picked,
  onOpen,
  onGo,
  onPick,
  onAction,
}: {
  thread: ThreadInfo;
  open: boolean;
  picked: boolean;
  onOpen: () => void;
  onGo: () => void;
  onPick: () => void;
  onAction: (action: RowAction) => void;
}) {
  const { t, i18n } = useTranslation();
  const actors = useActors();
  const title = threadTitle(thread);
  const people = actorsOf(thread);
  const last = thread.lastMessage;
  const where = thread.channelKind === "dm" ? t("threads.dm") : `#${thread.channelName}`;
  const more = t("threads.more", { title });
  return (
    // biome-ignore lint/a11y: a mouse shortcut to the details; the title button is the keyboard way
    <article
      className={cx("thread-row", open && "is-open", picked && "is-picked")}
      aria-label={title}
      data-dim={thread.state !== "open" || undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a, [role=checkbox], [role=menu]")) return;
        onOpen();
      }}
      onDoubleClick={onGo}
    >
      <Checkbox
        className="thread-row__check"
        checked={picked}
        onCheckedChange={onPick}
        aria-label={t("threads.pick", { title })}
      />
      <span className="thread-kind" aria-hidden="true">
        <Icon name="thread" size={16} />
      </span>
      <div className="thread-row__title">
        <button type="button" className="thread-row__name" aria-expanded={open} onClick={onOpen}>
          {title}
        </button>
        <small>
          <span className="thread-row__where">
            <Icon name={thread.channelKind === "dm" ? "person" : "channel"} size={14} />
            {where}
          </span>
          {thread.mission && (
            <>
              <span aria-hidden="true">·</span>
              <span className="thread-row__where">
                <Icon name="flag" size={14} />
                {t("missions.chip", { done: thread.mission.planDone, count: thread.mission.planTotal })}
              </span>
            </>
          )}
          {last && (
            <>
              <span aria-hidden="true">·</span>
              <span className="thread-row__last">
                {t("threads.lastLine", { name: actors.name(lastActor(last.author)), text: last.excerpt })}
              </span>
            </>
          )}
        </small>
      </div>
      <div className="thread-row__meta">
        <span className="thread-row__count">{t("threads.messages", { count: threadMessageCount(thread) })}</span>
        <span className="thread-row__who">
          <AvatarStack aria-label={people.map((p) => actors.name(p)).join(", ")}>
            {people.slice(0, 4).map((p) => (
              <ActorAvatar key={`${p.type}:${p.id}`} actor={p} name={actors.name(p)} size="xs" />
            ))}
          </AvatarStack>
          {people.length > 4 && <span className="thread-row__more">+{people.length - 4}</span>}
        </span>
        <span className="thread-row__state">
          <ThreadStatusChip thread={thread} />
        </span>
      </div>
      <div className="thread-row__end">
        <span className="thread-row__ago">{relativeTime(t, i18n.language, thread.lastActivityAt)}</span>
        <span className="thread-row__actions">
          {quickActions(thread).map((a) => (
            <Button
              key={a}
              size="sm"
              variant="ghost"
              iconOnly
              icon={ACTION_ICON[a]}
              className="thread-row__quick"
              aria-label={t(`threads.actions.${a}`)}
              title={t(`threads.actions.${a}`)}
              onClick={() => onAction(a)}
            />
          ))}
          <Menu
            align="end"
            label={more}
            trigger={<Button size="sm" variant="ghost" iconOnly icon="more" aria-label={more} />}
          >
            <MenuItem icon="external" onSelect={onGo}>
              {thread.state === "archived" ? t("threads.read") : t("threads.open")}
            </MenuItem>
            <MenuItem icon="layers" onSelect={onOpen}>
              {t("threads.details")}
            </MenuItem>
            {quickActions(thread).length > 0 && <MenuSeparator />}
            {quickActions(thread).map((a) => (
              <MenuItem
                key={a}
                icon={ACTION_ICON[a]}
                description={a === "close" ? t("threads.actions.closeHint") : undefined}
                onSelect={() => onAction(a)}
              >
                {t(`threads.actions.${a}`)}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem icon="check" onSelect={onPick}>
              {picked ? t("threads.unpick") : t("threads.pickShort")}
            </MenuItem>
          </Menu>
        </span>
      </div>
    </article>
  );
}

const lastActor = (a: ThreadActor) => ({ type: a.type, id: a.id ?? "" });

/** The details panel (bottom sheet on a phone): state, actions, origin, participants, facts. */
function ThreadDetails({
  thread,
  onClose,
  onGo,
  onAction,
}: {
  thread: ThreadInfo;
  onClose: () => void;
  onGo: () => void;
  onAction: (action: RowAction) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const actors = useActors();
  const title = threadTitle(thread);
  const people = actorsOf(thread);
  const where = thread.channelKind === "dm" ? t("threads.dm") : `#${thread.channelName}`;
  const ctx = thread.context;
  const creator = thread.createdBy
    ? actors.name({ type: "person", id: thread.createdBy })
    : actors.name(lastActor(thread.rootAuthor));
  const toChannel = () =>
    void navigate({
      to: "/org/$orgId/c/$channelId",
      params: { orgId: org.id, channelId: ctx?.channelId ?? thread.channelId },
      search: { m: ctx && !ctx.moved ? ctx.firstMessageId : thread.id },
    });
  return (
    <aside className="thread-details" aria-label={t("threads.panel.label", { title })}>
      <div className="thread-details__head">
        <ThreadStatusChip thread={thread} />
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="close"
          aria-label={t("threads.panel.close")}
          onClick={onClose}
        />
      </div>
      <div>
        <h2 className="thread-details__title">{title}</h2>
        <p className="thread-details__facts">
          <span>{where}</span>
          <span aria-hidden="true">·</span>
          <span>{t("threads.messages", { count: threadMessageCount(thread) })}</span>
          <span aria-hidden="true">·</span>
          <span>{relativeTime(t, i18n.language, thread.lastActivityAt)}</span>
        </p>
      </div>
      {thread.state === "archived" && (
        <div className="thread-banner">
          <Icon name="lock" size={16} />
          <div>
            <b>{t("threads.panel.archivedTitle")}</b>
            <small>{t("threads.panel.archived")}</small>
          </div>
        </div>
      )}
      {thread.state === "closed" && (
        <div className="thread-banner">
          <Icon name="refresh" size={16} />
          <div>
            <b>{t("threads.panel.closedTitle")}</b>
            <small>{t("threads.panel.closed", { where })}</small>
          </div>
        </div>
      )}
      <div className="thread-details__actions">
        <Button size="sm" variant={thread.state === "archived" ? "default" : "primary"} icon="external" onClick={onGo}>
          {thread.state === "archived" ? t("threads.read") : t("threads.open")}
        </Button>
        {quickActions(thread)
          .slice(0, 1)
          .map((a) => (
            <Button key={a} size="sm" icon={ACTION_ICON[a]} onClick={() => onAction(a)}>
              {t(`threads.actions.${a}`)}
            </Button>
          ))}
      </div>
      <section className="thread-details__section">
        <h3>{t("threads.panel.origin")}</h3>
        <button type="button" className="thread-where" onClick={toChannel}>
          <span className="thread-where__icon" aria-hidden="true">
            <Icon name={ctx ? "layers" : "message"} size={14} />
          </span>
          <span className="thread-where__text">
            <b>
              {ctx
                ? t("threads.panel.fromRange", { count: ctx.count, where })
                : t("threads.panel.fromMessage", { name: actors.name(lastActor(thread.rootAuthor)), where })}
            </b>
            <small>{ctx?.moved ? t("threads.panel.movedHint") : t("threads.panel.seeInChannel")}</small>
          </span>
          <Icon name="chevronRight" size={16} />
        </button>
      </section>
      <section className="thread-details__section">
        <h3>{t("threads.panel.people", { count: people.length })}</h3>
        <ul className="thread-people">
          {people.map((p) => (
            <li key={`${p.type}:${p.id}`}>
              <ActorAvatar actor={p} name={actors.name(p)} size="sm" />
              <span>
                {actors.name(p)}
                <small> · {p.type === "agent" ? t("threads.panel.agent") : t("threads.panel.person")}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="thread-details__section">
        <dl className="thread-facts">
          <dt>{t("threads.panel.created")}</dt>
          <dd>
            {t("threads.panel.createdBy", { when: formatFullDate(i18n.language, thread.createdAt), name: creator })}
          </dd>
          <dt>{t("threads.panel.lives")}</dt>
          <dd>{where}</dd>
        </dl>
      </section>
    </aside>
  );
}

function ThreadsEmpty({
  tab,
  filtered,
  onClear,
  onAll,
}: {
  tab: ThreadsTab;
  filtered: boolean;
  onClear: () => void;
  onAll: () => void;
}) {
  const { t } = useTranslation();
  if (filtered) {
    return (
      <EmptyState
        icon="search"
        title={t("threads.empty.noResults")}
        actions={
          <Button size="sm" onClick={onClear}>
            {t("threads.empty.clear")}
          </Button>
        }
      >
        {t("threads.empty.noResultsText")}
      </EmptyState>
    );
  }
  return (
    <EmptyState
      // The light sky only where the subject is an agent: "nobody working" is about agents.
      sky={tab === "working"}
      icon={tab === "archived" ? "archiveBox" : tab === "closed" ? "check" : "thread"}
      title={t(`threads.empty.${tab}Title`)}
      actions={
        tab === "all" ? undefined : (
          <Button size="sm" onClick={onAll}>
            {t("threads.empty.seeAll")}
          </Button>
        )
      }
    >
      {t(`threads.empty.${tab}`)}
    </EmptyState>
  );
}
