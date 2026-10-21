import type {
  Routine,
  RoutineEvent,
  RoutineInput,
  RoutinePatch,
  RoutineRun,
  RoutineTarget,
  RoutineTargetInput,
} from "@agenteschat/client";
import {
  useCalendar,
  useChannels,
  useDms,
  useMailAccounts,
  useRoutineAction,
  useRoutineRuns,
  useRoutines,
  useRuleDescribe,
  useRuleParse,
} from "@agenteschat/client";
import { relativeTime, toYmd, whenAt } from "@agenteschat/client/lib/format";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { browserTimezone, onceParts, timezoneName } from "@agenteschat/client/lib/routines";
import {
  Button,
  Checkbox,
  Chip,
  cx,
  DetailsDialog,
  DetailsSection,
  Dialog,
  DialogBody,
  DialogFooter,
  EmptyState,
  Field,
  FilterBar,
  FilterChip,
  Icon,
  type IconName,
  Input,
  Menu,
  MenuItem,
  RecurrencePicker,
  type RecurrenceRule,
  RunKey,
  RunLane,
  RunStrip,
  SearchField,
  Segmented,
  Select,
  Switch,
  Textarea,
  Toolbar,
  zonedInstant,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type CSSProperties, useDeferredValue, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, AgentSpinner } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { cleanFilter, type EmailTriggerDraft, EmailTriggerFields, emailWhen, INBOX } from "@/components/EmailTrigger";
import { useActorFilterOptions, useFilterCopy } from "@/components/filters";
import { ErrorState, LoadingCards, LoadingList } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { ZoneSelect } from "@/components/ZoneSelect";
import { lookOf } from "@/lib/look";
import { useOpenParam } from "@/lib/open-param";
import { defaultRule, fromApiRule, recurrenceLabels, ruleSentence, toApiRule, upcomingLabels } from "@/lib/recurrence";
import { useToast } from "@/lib/toast";
import "./routines.css";

export const ROUTINE_EVENTS: RoutineEvent[] = [
  "sentry.issue_created",
  "github.pr_opened",
  "issue.created",
  "deploy.succeeded",
];

/** Weekday + time, "seg 20 out, 09:00". */
const nextLabel = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(/\./g, "")
    .replace(/ de /g, " ");

/** Started by something happening (an event or an email), not by the clock. */
const isEventDriven = (r: Routine) => r.trigger.type === "event" || r.trigger.type === "email";
/** An email routine whose mailbox needs reconnecting (or whose watch fails). */
const mailTrouble = (r: Routine) =>
  r.trigger.type === "email" && r.trigger.status && r.trigger.status !== "active" ? r.trigger.status : null;

/** A one-off that already fired (or was cancelled): shown muted, under "Concluídos". */
export const isDoneOnce = (r: Routine) => r.trigger.type === "once" && !r.active;
const isPaused = (r: Routine) => !isDoneOnce(r) && !r.active;

/** The horizon: the last 4 hours and the next 20. */
const HORIZON_BACK = 4 * 3_600_000;
const HORIZON_AHEAD = 20 * 3_600_000;
const RUN_SLOTS = 14;

/** "now", ticking every minute ("próxima em 10 min" stays true). */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useTargetLabel() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const channels = useChannels(org.id);
  const dms = useDms(org.id);
  return (target: RoutineTarget) => {
    if (target.type === "channel") {
      const c = channels.data?.find((x) => x.id === target.channelId);
      return c ? `#${c.name}` : "#";
    }
    // From the chat: "na DM com o Jorge", "no #general (thread)".
    if (target.type === "conversation") {
      const dm = dms.data?.find((d) => d.channelId === target.channelId);
      if (dm) return t("routines.inDm", agentGrammar(t, dm.with.name));
      const c = channels.data?.find((x) => x.id === target.channelId);
      if (!c) return t("routines.inConversation");
      return t(target.threadId ? "routines.inThread" : "routines.inChannel", { channel: c.name });
    }
    if (target.type === "forum") return t("routines.target.forumShort");
    return t(target.type === "dm" ? "routines.target.dmShort" : "routines.target.artifactShort");
  };
}

const targetIcon = (target: RoutineTarget): IconName =>
  target.type === "dm"
    ? "message"
    : target.type === "conversation"
      ? target.threadId
        ? "reply"
        : "channel"
      : target.type === "forum"
        ? "members"
        : target.type === "artifact"
          ? "file"
          : "channel";

/** The agent's look for the pixel pieces (color and eyes). */
function useLook() {
  const actors = useActors();
  return (agentId: string) => {
    const look = lookOf(actors.dir.agentById.get(agentId));
    return { color: look?.color ?? "sky", eyes: look?.eyes ?? "round" };
  };
}

/** "Quando" in words, in the routine's zone (the zone shows only when it isn't mine). */
function useWhen() {
  const { t, i18n } = useTranslation();
  const { me, org } = useOrg();
  const actors = useActors();
  const mailboxes = useMailAccounts(org.id);
  const myZone = actors.dir.memberById.get(me.user.id)?.timezone || browserTimezone() || "UTC";
  return (r: Routine) => {
    if (r.trigger.type === "email") return emailWhen(t, r, mailboxes.data);
    const zone = r.trigger.type === "event" ? "" : r.trigger.timezone || "UTC";
    const zoneNote = zone && zone !== myZone ? ` (${timezoneName(zone, i18n.language)})` : "";
    if (r.trigger.type === "schedule")
      return `${
        r.trigger.rule
          ? ruleSentence(t, i18n.language, fromApiRule(r.trigger.rule, toYmd(new Date())), new Date(), false)
          : r.trigger.description
      }${zoneNote}`;
    if (r.trigger.type === "once")
      return t("routines.once", { ...onceParts(i18n.language, r.trigger.at, zone), zone: zoneNote });
    return t(`routines.event.${r.trigger.event}`);
  };
}

/** Rotinas: scheduled and event-driven agent tasks. */
export function RoutinesPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const routines = useRoutines(org.id);
  const now = useNow();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Routine | null>(null);
  // The routine whose details are open, in the URL (`?open=…`).
  const [openId, setOpenId] = useOpenParam();
  const [showDone, setShowDone] = useState(false);
  const [status, setStatus] = useState<"all" | "active" | "paused" | "event">("all");
  const [q, setQ] = useState("");
  const list = routines.data ?? [];
  const [agents, setAgents] = useState<string[]>([]);
  const copy = useFilterCopy();
  const agentOptions = useActorFilterOptions().filter((o) => o.value.startsWith("agent:"));
  const when = useWhen();
  const query = q.trim().toLowerCase();
  const matches = (r: Routine) =>
    (agents.length === 0 || agents.includes(`agent:${r.agentId}`)) &&
    (!query || `${r.name} ${r.prompt} ${when(r)}`.toLowerCase().includes(query));
  const shown = list.filter(matches);
  const current = shown.filter((r) => !isDoneOnce(r));
  const done = shown.filter(isDoneOnce);
  const counts = {
    all: current.length,
    active: current.filter((r) => r.active).length,
    paused: current.filter(isPaused).length,
    event: current.filter(isEventDriven).length,
  };
  const byStatus = (r: Routine) =>
    status === "all" ||
    (status === "active" && r.active) ||
    (status === "paused" && isPaused(r)) ||
    (status === "event" && isEventDriven(r));
  const live = current.filter((r) => byStatus(r) && !isPaused(r));
  const paused = current.filter((r) => byStatus(r) && isPaused(r));
  const open = list.find((r) => r.id === openId) ?? null;
  const toggleOpen = (id: string) => setOpenId(openId === id ? null : id);
  const filtered = agents.length > 0 || query.length > 0 || status !== "all";
  // "N" opens "Nova rotina" (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== "n") return;
      if (el?.closest("input, textarea, [contenteditable], [role=dialog], [role=menu]")) return;
      e.preventDefault();
      setCreating(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const group = (title: string, rows: Routine[]) =>
    rows.length > 0 && (
      <section className="routines-group" aria-label={title}>
        <h2 className="routines-group__title">
          {title}
          <span>{rows.length}</span>
        </h2>
        <div className="routines-list">
          {rows.map((r) => (
            <RoutineRow
              key={r.id}
              routine={r}
              now={now}
              selected={r.id === openId}
              onOpen={() => toggleOpen(r.id)}
              onEdit={() => setEditing(r)}
            />
          ))}
        </div>
      </section>
    );
  return (
    <div className="page routines">
      <div className="routines__main">
        <header className="routines-head">
          <div>
            <h1>{t("routines.title")}</h1>
            <p className="routines-head__sub">{t("routines.subtitle")}</p>
            <p className="routines-head__guard">
              <Icon name="shield" size={14} />
              {t("routines.guard")}
            </p>
          </div>
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            {t("routines.new")}
          </Button>
        </header>
        {routines.isLoading && <LoadingCards count={3} />}
        {routines.isError && !routines.data && (
          <ErrorState error={routines.error} onRetry={() => void routines.refetch()} />
        )}
        {routines.isSuccess && list.length === 0 && (
          <EmptyState
            sky
            title={t("routines.emptyTitle")}
            actions={
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                {t("routines.new")}
              </Button>
            }
          >
            {t("routines.empty")}
          </EmptyState>
        )}
        {list.length > 0 && (
          <>
            <RoutineHorizon routines={list} now={now} onOpen={toggleOpen} />
            <Toolbar
              search={
                <SearchField
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onClear={() => setQ("")}
                  clearLabel={copy.clearSearch}
                  placeholder={t("routines.search")}
                  aria-label={t("routines.search")}
                />
              }
            >
              <Segmented
                label={t("routines.statusLabel")}
                value={status}
                onValueChange={setStatus}
                options={(["all", "active", "paused", "event"] as const).map((v) => ({
                  value: v,
                  label: t(`routines.status.${v}`),
                  count: counts[v],
                }))}
              />
              <FilterBar
                label={t("routines.filters")}
                clearText={copy.clearAll}
                onClear={() => {
                  setAgents([]);
                  setQ("");
                  setStatus("all");
                }}
                filters={[
                  {
                    key: "agents",
                    active: agents.length > 0,
                    node: (
                      <FilterChip
                        label={t("routines.agentFilter")}
                        icon="agent"
                        multiple
                        options={agentOptions}
                        value={agents}
                        onChange={setAgents}
                        valueText={(o) => o.label}
                        countText={copy.people}
                        clearLabel={copy.clearOf(t("routines.agentFilter"))}
                      />
                    ),
                  },
                ]}
              />
            </Toolbar>
            {group(status === "paused" ? t("routines.groupPaused") : t("routines.groupLive"), live)}
            {group(t("routines.groupPaused"), paused)}
            {live.length === 0 && paused.length === 0 && filtered && (
              <EmptyState icon="search" title={t("routines.noResults")} />
            )}
            {done.length > 0 && status === "all" && (
              <section className="routines-group" aria-label={t("routines.done")}>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={showDone ? "chevronDown" : "chevronRight"}
                  aria-expanded={showDone}
                  aria-controls="routines-done-list"
                  onClick={() => setShowDone((v) => !v)}
                >
                  {t("routines.doneToggle", { count: done.length })}
                </Button>
                {showDone && (
                  <div id="routines-done-list" className="routines-list">
                    {done.map((r) => (
                      <RoutineRow
                        key={r.id}
                        routine={r}
                        now={now}
                        selected={r.id === openId}
                        onOpen={() => toggleOpen(r.id)}
                        onEdit={() => setEditing(r)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
      {open && (
        <RoutineDetails routine={open} now={now} onClose={() => setOpenId(null)} onEdit={() => setEditing(open)} />
      )}
      <RoutineDialog open={creating} onClose={() => setCreating(false)} />
      <RoutineDialog
        key={editing?.id ?? "none"}
        open={Boolean(editing)}
        routine={editing ?? undefined}
        onClose={() => setEditing(null)}
      />
    </div>
  );
}

/** A title for the card: a routine made from a chat message may be named with its whole prompt. */
export function routineTitle(r: Pick<Routine, "name" | "prompt">) {
  const name = r.name.trim();
  if (name !== r.prompt.trim() && name.length <= 80) return name;
  const first = (name.split("\n")[0] ?? name).trim();
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd()}…`;
}

/** The runs as words, for the strip's label and the horizon's tooltips. */
function useRunWords() {
  const { t, i18n } = useTranslation();
  return {
    status: (s: RoutineRun["status"]) => t(`routines.statusWord.${s}`),
    caption: (r: Routine, now: Date) => {
      if (r.running) return t("routines.runningNow");
      const runs = r.recentRuns ?? (r.lastRun ? [r.lastRun] : []);
      const last = runs[0];
      if (!last) return t("routines.neverRan");
      const silent = runs.filter((x) => x.status === "silent").length;
      if (last.status === "silent" && silent > 1) return t("routines.silentOf", { count: silent, total: runs.length });
      return t(`routines.lastRun.${last.status}`, { when: relativeTime(t, i18n.language, last.at, now) });
    },
    label: (r: Routine) => {
      const runs = (r.recentRuns ?? []).slice(0, RUN_SLOTS);
      if (runs.length === 0) return t("routines.stripNone");
      return t("routines.stripLabel", {
        list: runs.map((x) => `${whenAt(t, i18n.language, x.at)}: ${t(`routines.statusWord.${x.status}`)}`).join("; "),
      });
    },
  };
}

/** "Próxima em 10 min" (within a day), else "Próxima sex 16 out, 10:00". */
function useNextText() {
  const { t, i18n } = useTranslation();
  return (r: Routine, now: Date) => {
    if (r.running) return t("routines.runningNow");
    if (isDoneOnce(r))
      return r.lastRun
        ? t("routines.firedAt", { when: whenAt(t, i18n.language, r.lastRun.at) })
        : t("routines.canceled");
    if (!r.active) return t("routines.paused");
    if (isEventDriven(r)) {
      const week = (r.recentRuns ?? []).filter((x) => now.getTime() - new Date(x.at).getTime() < 7 * 86_400_000).length;
      if (r.trigger.type === "email")
        return week > 0 ? t("mail.routine.thisWeek", { count: week }) : t("mail.routine.waiting");
      return week > 0 ? t("routines.eventThisWeek", { count: week }) : t("routines.waitingEvent");
    }
    if (!r.nextRunAt) return "";
    const ms = new Date(r.nextRunAt).getTime() - now.getTime();
    if (ms <= 60_000) return t("routines.nextSoon");
    if (ms < 3_600_000)
      return t("routines.nextIn", { when: t("format.inMinutes", { count: Math.floor(ms / 60_000) }) });
    if (ms < 20 * 3_600_000) {
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      return t("routines.nextIn", {
        when: m ? t("routines.hoursMinutes", { h, m }) : t("format.inHours", { count: h }),
      });
    }
    return t("routines.next", { when: nextLabel(i18n.language, r.nextRunAt) });
  };
}

function RoutineRow({
  routine: r,
  now,
  selected,
  onOpen,
  onEdit,
}: {
  routine: Routine;
  now: Date;
  selected: boolean;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const toast = useToast();
  const action = useRoutineAction(org.id);
  const [deleting, setDeleting] = useState(false);
  const target = useTargetLabel();
  const when = useWhen();
  const nextText = useNextText();
  const words = useRunWords();
  const look = useLook()(r.agentId);
  const agent = { type: "agent" as const, id: r.agentId };
  const title = routineTitle(r);
  const reminder = r.target.type === "conversation" && r.target.reminder === true;
  const done = isDoneOnce(r);
  const paused = isPaused(r);
  const more = t("routines.more", { name: title });
  const setActive = (active: boolean) =>
    action.mutate(
      { type: "active", id: r.id, active },
      { onSuccess: () => toast.show(t(active ? "routines.resumedToast" : "routines.pausedToast")) },
    );
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a mouse shortcut; the title is the keyboard way to the details
    <article
      className={cx("routine-row", selected && "routine-row--on")}
      aria-label={title}
      data-active={r.active || undefined}
      data-paused={paused || undefined}
      data-done={done || undefined}
      data-running={r.running || undefined}
      onClick={(e) => {
        // The row opens the details; its own controls don't.
        if ((e.target as HTMLElement).closest("button, a, [role=switch], [role=menu]")) return;
        onOpen();
      }}
    >
      <span className="routine-row__who">{actors.avatar(agent, "sm")}</span>
      <div className="routine-row__main">
        <button type="button" className="routine-row__title" title={r.name} aria-expanded={selected} onClick={onOpen}>
          {title}
        </button>
        <span className="routine-row__sub">
          <Icon name={targetIcon(r.target)} size={14} />
          <span>
            {r.target.type === "conversation"
              ? t("routines.deliversIn", { agent: actors.name(agent), place: target(r.target) })
              : t("routines.deliversTo", { agent: actors.name(agent), target: target(r.target) })}
          </span>
          {reminder && (
            <Chip icon="bell" className="routine-row__chip">
              {t("routines.reminder")}
            </Chip>
          )}
          {mailTrouble(r) && (
            <Chip icon="alert" tone="waiting" className="routine-row__chip">
              {t(mailTrouble(r) === "error" ? "mail.routine.error" : "mail.routine.needsReconnect")}
            </Chip>
          )}
        </span>
      </div>
      <div className="routine-row__when">
        <span className="routine-row__when-icon" aria-hidden="true">
          <Icon
            name={
              r.trigger.type === "event"
                ? "bolt"
                : r.trigger.type === "email"
                  ? "mail"
                  : r.trigger.type === "once"
                    ? reminder
                      ? "bell"
                      : "calendar"
                    : "repeat"
            }
            size={16}
          />
        </span>
        <span className="routine-row__when-text">
          <b>{when(r)}</b>
          <small className={cx(r.running && "is-live")}>{nextText(r, now)}</small>
        </span>
      </div>
      <div className="routine-row__runs" role="img" aria-label={words.label(r)}>
        <RunStrip runs={r.recentRuns ?? []} color={look.color} slots={RUN_SLOTS} running={r.running} />
        <small>{words.caption(r, now)}</small>
      </div>
      <div className="routine-row__actions">
        {done ? (
          <span className="routine-row__ph routine-row__ph--switch" aria-hidden="true" />
        ) : (
          <Switch
            checked={r.active}
            onCheckedChange={setActive}
            aria-label={t("routines.activeLabel", { name: title })}
          />
        )}
        {!done && !reminder ? (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={r.running ? "spinner" : "play"}
            title={r.running ? t("routines.running") : t("routines.runNow")}
            aria-label={r.running ? t("routines.running") : t("routines.runNow")}
            disabled={r.running || action.isPending}
            onClick={() => action.mutate({ type: "run", id: r.id })}
          />
        ) : (
          <span className="routine-row__ph" aria-hidden="true" />
        )}
        <Menu
          align="end"
          label={more}
          trigger={<Button variant="ghost" size="sm" iconOnly icon="more" aria-label={more} />}
        >
          <MenuItem icon="edit" onSelect={onEdit}>
            {t("routines.edit")}
          </MenuItem>
          <MenuItem icon="waiting" onSelect={() => !selected && onOpen()}>
            {t("routines.runs")}
          </MenuItem>
          <MenuItem
            icon="copy"
            onSelect={() =>
              action.mutate(
                { type: "duplicate", id: r.id, name: t("routines.copyName", { name: r.name }) },
                {
                  onSuccess: (copy) =>
                    toast.show(t("routines.duplicated", { name: (copy as Routine | undefined)?.name ?? r.name })),
                },
              )
            }
          >
            {t("routines.duplicate")}
          </MenuItem>
          {r.webhookUrl && (
            <MenuItem
              icon="link"
              onSelect={async () => {
                await navigator.clipboard?.writeText(r.webhookUrl ?? "");
                toast.show(t("routines.webhookCopied"));
              }}
            >
              {t("routines.copyWebhook")}
            </MenuItem>
          )}
          <MenuItem icon="trash" onSelect={() => setDeleting(true)}>
            {t("routines.delete")}
          </MenuItem>
        </Menu>
      </div>
      <Dialog
        open={deleting}
        onOpenChange={(o) => !o && setDeleting(false)}
        title={t("routines.deleteTitle", { name: title })}
        description={t("routines.deleteBody")}
        closeLabel={t("common.close")}
        width={440}
      >
        <DialogFooter>
          <Button onClick={() => setDeleting(false)}>{t("common.cancel")}</Button>
          <Button
            variant="danger"
            loading={action.isPending && action.variables?.type === "delete"}
            onClick={() =>
              action.mutate(
                { type: "delete", id: r.id },
                {
                  onSuccess: () => {
                    setDeleting(false);
                    toast.show(t("routines.deleted"));
                  },
                },
              )
            }
          >
            {t("routines.deleteConfirm")}
          </Button>
        </DialogFooter>
      </Dialog>
    </article>
  );
}

/**
 * The next hours as a horizon: one lane per scheduled routine, its recent runs
 * as pixel columns, the next run as the agent's sprite on the line, "agora" as
 * a dotted pixel line. Future slots come from the calendar range (the server's
 * schedule math).
 */
function RoutineHorizon({ routines, now, onOpen }: { routines: Routine[]; now: Date; onOpen: (id: string) => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const look = useLook();
  const words = useRunWords();
  // The window moves with the minute; the slots are asked once per hour (the calendar caches by start).
  const hour = Math.floor(now.getTime() / 3_600_000);
  const range = useMemo(() => {
    const start = new Date(hour * 3_600_000);
    return { from: start.toISOString(), to: new Date(start.getTime() + HORIZON_AHEAD + 3_600_000).toISOString() };
  }, [hour]);
  const slots = useCalendar(org.id, range.from, range.to);
  const from = new Date(now.getTime() - HORIZON_BACK);
  const to = new Date(now.getTime() + HORIZON_AHEAD);
  const lanes = routines.filter((r) => r.active && !isDoneOnce(r) && !isEventDriven(r));
  if (lanes.length === 0) return null;
  const futureOf = (r: Routine) => {
    const at = (slots.data?.routines ?? [])
      .filter((s) => s.routineId === r.id && new Date(s.at) > now && new Date(s.at) <= to)
      .map((s) => s.at);
    // Before the calendar answers, the next run alone.
    if (at.length === 0 && r.nextRunAt && new Date(r.nextRunAt) <= to) return [r.nextRunAt];
    return at.sort();
  };
  const pos = (d: Date) => ((d.getTime() - from.getTime()) / (to.getTime() - from.getTime())) * 100;
  const scale: { at: Date; label: string; day: boolean }[] = [];
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  first.setHours(Math.ceil(first.getHours() / 3) * 3);
  for (let d = new Date(first); d <= to; d = new Date(d.getTime() + 3 * 3_600_000)) {
    const p = pos(d);
    if (p < 3 || p > 97 || Math.abs(d.getTime() - now.getTime()) < 1.2 * 3_600_000) continue;
    const midnight = d.getHours() === 0;
    scale.push({
      at: d,
      day: midnight,
      label: midnight
        ? new Intl.DateTimeFormat(i18n.language, { weekday: "short" }).format(d).replace(/\./g, "")
        : new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(d),
    });
  }
  const timeOf = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  const later = lanes.filter((r) => futureOf(r).length === 0).length;
  const nowAt = pos(now);
  return (
    <section className="routines-horizon" aria-label={t("routines.horizon.label")}>
      <div className="routines-horizon__head">
        <h2>{t("routines.horizon.title", { count: HORIZON_AHEAD / 3_600_000 })}</h2>
        <span className="routines-horizon__sub">
          {t("routines.horizon.lanes", { count: lanes.length })}
          {later > 0 && ` · ${t("routines.horizon.later", { count: later })}`}
        </span>
        <span className="routines-horizon__legend" aria-hidden="true">
          {(["ok", "silent", "failed", "next"] as const).map((k) => (
            <span key={k}>
              <RunKey status={k} />
              {t(`routines.horizon.legend.${k}`)}
            </span>
          ))}
        </span>
      </div>
      <div className="routines-horizon__body" style={{ "--now-k": nowAt / 100 } as CSSProperties}>
        <span />
        <div className="routines-horizon__scale" aria-hidden="true">
          {scale.map((s) => (
            <span key={s.at.getTime()} style={{ left: `${pos(s.at)}%` }} className={cx(s.day && "is-day")}>
              {s.label}
            </span>
          ))}
        </div>
        {lanes.map((r) => {
          const future = futureOf(r);
          const next = future[0];
          const soon = next && new Date(next).getTime() - now.getTime() < 3_600_000;
          const hourly = r.trigger.type === "schedule" && r.trigger.rule?.freq === "hourly";
          const { color, eyes } = look(r.agentId);
          const title = routineTitle(r);
          return (
            <div className="routines-horizon__lane" key={r.id}>
              <button type="button" className="routines-horizon__label" title={title} onClick={() => onOpen(r.id)}>
                <AgentFace agentId={r.agentId} />
                <b>{title}</b>
              </button>
              <div
                className="routines-horizon__track"
                role="img"
                aria-label={
                  next
                    ? t("routines.horizon.lane", { name: title, when: whenAt(t, i18n.language, next) })
                    : t("routines.horizon.laneNone", { name: title })
                }
                title={words.label(r)}
              >
                <RunLane
                  from={from}
                  to={to}
                  now={now}
                  color={color}
                  eyes={eyes}
                  running={r.running}
                  past={(r.recentRuns ?? []).filter((x) => new Date(x.at) >= from && new Date(x.at) <= now)}
                  future={future}
                />
                {next && !r.running && (!hourly || soon) && (
                  <span
                    className={cx("routines-horizon__next", soon && "is-soon")}
                    style={{ left: `max(${pos(new Date(next))}%, calc(${nowAt}% + 12px))` }}
                  >
                    {soon
                      ? t("format.inMinutes", {
                          count: Math.max(1, Math.floor((new Date(next).getTime() - now.getTime()) / 60_000)),
                        })
                      : timeOf(next)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <span className="routines-horizon__past" aria-hidden="true" />
        <span className="routines-horizon__now" aria-hidden="true">
          <span>{t("routines.horizon.now")}</span>
        </span>
      </div>
    </section>
  );
}

function AgentFace({ agentId }: { agentId: string }) {
  const actors = useActors();
  return actors.avatar({ type: "agent", id: agentId }, "xs");
}

/** The routine's details: what it does, when, where it delivers and the run history. */
function RoutineDetails({
  routine: r,
  now,
  onClose,
  onEdit,
}: {
  routine: Routine;
  now: Date;
  onClose: () => void;
  onEdit: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const action = useRoutineAction(org.id);
  const runs = useRoutineRuns(org.id, r.id);
  const target = useTargetLabel();
  const when = useWhen();
  const nextText = useNextText();
  const toast = useToast();
  const agent = { type: "agent" as const, id: r.agentId };
  const name = actors.name(agent);
  const title = routineTitle(r);
  const done = isDoneOnce(r);
  const paused = isPaused(r);
  const reminder = r.target.type === "conversation" && r.target.reminder === true;
  const described = useRuleDescribe(
    org.id,
    r.active && r.trigger.type === "schedule" && r.trigger.rule ? r.trigger.rule : null,
  );
  const nexts = described.data?.ok ? described.data.nextRuns.slice(0, 4) : r.nextRunAt ? [r.nextRunAt] : [];
  const state = r.running ? "running" : done ? "done" : paused ? "paused" : "live";
  const whereHint =
    r.target.type === "conversation"
      ? r.target.threadId
        ? "thread"
        : "channel"
      : r.target.type === "dm"
        ? "dm"
        : r.target.type;
  return (
    <DetailsDialog
      open
      onOpenChange={(o) => !o && onClose()}
      closeLabel={t("routines.panel.close")}
      className="routine-details"
      eyebrow={t("routines.panel.eyebrow")}
      icon={<AgentAvatar agentId={r.agentId} name={name} size="md" running={r.running} />}
      title={title}
      subtitle={
        <>
          <span>{name}</span>
          <Chip
            icon={
              state === "running" ? "spinner" : state === "paused" ? "pause" : state === "done" ? "check" : "repeat"
            }
            lead={state === "running" ? <AgentSpinner agentId={r.agentId} /> : undefined}
          >
            {t(`routines.panel.state.${state}`)}
          </Chip>
        </>
      }
    >
      <div className="routine-details__actions">
        <Button size="sm" icon="edit" onClick={onEdit}>
          {t("routines.edit")}
        </Button>
        {!done && !reminder && (
          <Button
            size="sm"
            icon="play"
            disabled={r.running || action.isPending}
            onClick={() => action.mutate({ type: "run", id: r.id })}
          >
            {r.running ? t("routines.running") : t("routines.runNow")}
          </Button>
        )}
        {!done && (
          <Button
            size="sm"
            icon={r.active ? "pause" : "play"}
            onClick={() =>
              action.mutate(
                { type: "active", id: r.id, active: !r.active },
                { onSuccess: () => toast.show(t(r.active ? "routines.pausedToast" : "routines.resumedToast")) },
              )
            }
          >
            {r.active ? t("routines.panel.pause") : t("routines.resume")}
          </Button>
        )}
      </div>
      <DetailsSection title={t("routines.panel.what", agentGrammar(t, name))}>
        <p className="routine-details__prompt">{r.prompt}</p>
      </DetailsSection>
      <DetailsSection title={t("routines.panel.when")}>
        <p className="routine-details__sentence">{when(r)}</p>
        {mailTrouble(r) && (
          <Chip icon="alert" tone="waiting">
            {t(mailTrouble(r) === "error" ? "mail.routine.error" : "mail.routine.needsReconnect")}
          </Chip>
        )}
        {r.trigger.type === "email" ? (
          <p className="small muted">{t("mail.routine.every")}</p>
        ) : r.trigger.type === "event" ? (
          <p className="small muted">{t("routines.panel.eventEvery")}</p>
        ) : (
          nexts.length > 0 &&
          !done && (
            <div className="routine-details__nexts">
              {nexts.map((iso) => (
                <span key={iso}>{nextLabel(i18n.language, iso)}</span>
              ))}
            </div>
          )
        )}
        {!done && <p className="small muted">{nextText(r, now)}</p>}
      </DetailsSection>
      <DetailsSection title={t("routines.panel.where")}>
        <div className="routine-details__where">
          <span className="routine-details__where-icon">
            <Icon name={targetIcon(r.target)} size={16} />
          </span>
          <span>
            <b>{target(r.target)}</b>
            <small>{t(`routines.panel.whereHint.${whereHint}`)}</small>
          </span>
        </div>
      </DetailsSection>
      <DetailsSection title={t("routines.panel.runs")}>
        {runs.isLoading && <LoadingList count={3} avatar={false} />}
        {(r.running || (runs.data?.length ?? 0) > 0) && (
          <ol className="routine-runs">
            {r.running && (
              <li className="routine-runs__item">
                <span className="routine-runs__node routine-runs__node--running">
                  <Icon name="play" size={14} />
                </span>
                <span>
                  <b>{t("routines.runningNow")}</b>
                  <small>{t("routines.panel.runningBy", agentGrammar(t, name))}</small>
                </span>
                <time>{t("common.now")}</time>
              </li>
            )}
            {(runs.data ?? []).slice(0, 30).map((x) => (
              <li key={x.id} className="routine-runs__item">
                <span className={`routine-runs__node routine-runs__node--${x.status}`}>
                  <Icon
                    name={
                      x.status === "ok"
                        ? "check"
                        : x.status === "failed"
                          ? "close"
                          : x.status === "silent"
                            ? "dash"
                            : "wallet"
                    }
                    size={14}
                  />
                </span>
                <span>
                  <b>{runSummary(t, x)}</b>
                  <small>{t(`routines.statusWord.${x.status}`)}</small>
                </span>
                <time dateTime={x.at}>{whenAt(t, i18n.language, x.at)}</time>
              </li>
            ))}
          </ol>
        )}
        {runs.isSuccess && runs.data.length === 0 && !r.running && (
          <p className="small muted">
            {t("routines.noRuns")}
            {nexts[0] && !done && ` ${t("routines.panel.firstRun", { when: nextLabel(i18n.language, nexts[0]) })}`}
          </p>
        )}
      </DetailsSection>
    </DetailsDialog>
  );
}

/** Starting points for "Nova rotina" (the words come from i18n; the phrase is read by the server). */
const PRESETS = [
  { key: "digest", icon: "file", kind: "schedule" },
  { key: "errors", icon: "alert", kind: "schedule" },
  { key: "prs", icon: "bolt", kind: "event", event: "github.pr_opened" },
  { key: "week", icon: "calendar", kind: "schedule" },
] as const satisfies readonly { key: string; icon: IconName; kind: "schedule" | "event"; event?: RoutineEvent }[];

const TARGET_DM = "dm";
const TARGET_ARTIFACT = "artifact";
const TARGET_FORUM = "forum";
/** Editing a routine made in the chat (a thread or DM): keep where it delivers. */
const TARGET_KEEP = "keep";
const FORUM_ROUNDS = ["1", "2", "3", "5"] as const;

/** Where a routine delivers, as the form's select value. */
function targetChoice(target: RoutineTarget | undefined): string {
  if (!target) return "";
  if (target.type === "channel") return target.channelId;
  if (target.type === "dm") return TARGET_DM;
  if (target.type === "artifact") return TARGET_ARTIFACT;
  if (target.type === "forum") return TARGET_FORUM;
  return TARGET_KEEP;
}

/** The phrase the routine was written with, as the person wrote it (made with the picker, or new: none). */
const phraseOf = (r: Routine | undefined) => (r?.trigger.type === "schedule" ? (r.trigger.phrase ?? "") : "");

/** The rule a routine runs on, in `zone` (new, or an old cron-only routine: Mondays at 09:00). */
function ruleOf(r: Routine | undefined, zone: string): RecurrenceRule {
  const base = defaultRule(zone);
  if (r?.trigger.type === "once") return onceRule(r.trigger.at, zone);
  if (r?.trigger.type === "schedule" && r.trigger.rule)
    return { ...fromApiRule(r.trigger.rule, base.start), timezone: zone };
  if (r?.trigger.type === "schedule") return base;
  const { timezone, start } = base;
  return {
    freq: "weekly",
    interval: 1,
    byWeekday: ["MO"],
    times: ["09:00"],
    timezone,
    start,
    until: null,
    count: null,
  };
}
const zoneOf = (r: Routine | undefined) =>
  r && r.trigger.type !== "event" && r.trigger.type !== "email" ? r.trigger.timezone || "UTC" : "";

/** The email trigger a routine has (new, or another kind: none picked yet, the inbox). */
const emailDraftOf = (r: Routine | undefined): EmailTriggerDraft =>
  r?.trigger.type === "email"
    ? { accountId: r.trigger.accountId, folder: r.trigger.folder, filter: r.trigger.filter ?? {} }
    : { accountId: "", folder: "", filter: {} };
const isUtc = (z: string) => z === "UTC" || z === "Etc/UTC";

/**
 * "Nova rotina" and "Editar" (the same form). Editing starts from the routine
 * and saves only what changed; a routine still read in UTC (made before time
 * zones) starts in my zone, with a hint to keep UTC instead.
 */
function RoutineDialog({ open, onClose, routine }: { open: boolean; onClose: () => void; routine?: Routine }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const actors = useActors();
  const channels = useChannels(org.id);
  const targetLabel = useTargetLabel();
  const action = useRoutineAction(org.id);
  const agents = actors.dir.agents;
  const editing = Boolean(routine);
  const initialForum = routine?.target.type === "forum" ? routine.target : null;
  const myZone = actors.dir.memberById.get(me.user.id)?.timezone || browserTimezone() || "America/Sao_Paulo";
  const savedZone = zoneOf(routine);
  const wasUtc = editing && routine !== undefined && !isEventDriven(routine) && isUtc(savedZone);
  const [agentId, setAgentId] = useState(routine?.agentId ?? "");
  const [target, setTarget] = useState(targetChoice(routine?.target));
  // "Um tópico no fórum": which agents discuss, and how many rounds.
  const [forumAgents, setForumAgents] = useState<string[]>(initialForum?.agentIds ?? []);
  const [forumRounds, setForumRounds] = useState<(typeof FORUM_ROUNDS)[number]>(
    (FORUM_ROUNDS as readonly string[]).includes(String(initialForum?.rounds))
      ? (String(initialForum?.rounds) as (typeof FORUM_ROUNDS)[number])
      : "3",
  );
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [name, setName] = useState(routine?.name ?? "");
  const [kind, setKind] = useState<"schedule" | "event" | "email">(
    routine?.trigger.type === "event" ? "event" : routine?.trigger.type === "email" ? "email" : "schedule",
  );
  // "Quando chegar um email": the mailbox, folder and filters.
  const [email, setEmail] = useState<EmailTriggerDraft>(() => emailDraftOf(routine));
  const mailboxes = useMailAccounts(org.id);
  // "Quando chegar um email" shows where the organization has mailboxes (or the routine already uses one).
  const hasMail = kind === "email" || (mailboxes.data?.length ?? 0) > 0;
  // What the person typed, in any language: the server reads it (never the browser) and fills the picker.
  const [phrase, setPhrase] = useState(phraseOf(routine));
  const [event, setEvent] = useState<RoutineEvent>(
    routine?.trigger.type === "event" ? routine.trigger.event : "sentry.issue_created",
  );
  const [active, setActive] = useState(routine?.active ?? true);
  const [touched, setTouched] = useState(false);
  // One source of truth for "when": the rule (the picker), with the phrase kept in step.
  const [rule, setRule] = useState<RecurrenceRule>(() => ruleOf(routine, wasUtc ? myZone : savedZone || myZone));
  // What the routine had, to tell whether "when" changed.
  const [savedRule] = useState(() => JSON.stringify(toApiRule(ruleOf(routine, savedZone || myZone))));
  const zone = rule.timezone;
  // My zone may arrive after the form opens (the people list loads): follow it until a zone is picked.
  const [zoneTouched, setZoneTouched] = useState(false);
  const setZone = (z: string) => {
    setZoneTouched(true);
    setRule((r) => ({ ...r, timezone: z }));
  };
  const followsMyZone = !routine || wasUtc;
  useEffect(() => {
    if (followsMyZone && !zoneTouched) setRule((r) => (r.timezone === myZone ? r : { ...r, timezone: myZone }));
  }, [myZone, followsMyZone, zoneTouched]);
  // The phrase was typed (its parse fills the picker); picking in the picker clears it.
  const [phraseTyped, setPhraseTyped] = useState(false);
  const pickRule = (next: RecurrenceRule) => {
    setRule(next);
    setPhrase("");
    setPhraseTyped(false);
  };
  const typePhrase = (text: string) => {
    setPhrase(text);
    setPhraseTyped(true);
  };
  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agentId, agents]);
  useEffect(() => {
    if (!target && channels.data?.[0]) setTarget(channels.data[0].id);
  }, [target, channels.data]);
  const typed = useDeferredValue(phrase.trim());
  const once = rule.freq === "once";
  const parsed = useRuleParse(org.id, typed, open && kind === "schedule" && phraseTyped && typed.length > 0, zone);
  // A phrase the server understood fills the picker (one source of truth: the rule).
  const parsedRule = parsed.data?.ok ? parsed.data.rule : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: apply each new parse once
  useEffect(() => {
    if (parsedRule && phraseTyped) setRule((r) => ({ ...fromApiRule(parsedRule, r.start), timezone: r.timezone }));
  }, [parsedRule]);
  const apiRule = kind === "schedule" && !once ? toApiRule(rule) : null;
  const described = useRuleDescribe(org.id, open ? apiRule : null);
  const info = described.data?.ok ? described.data : null;
  // The picker opens on demand ("Ajustar"); the sentence and next runs always show.
  const [pickerOpen, setPickerOpen] = useState(false);
  const upcoming = info?.nextRuns.length
    ? info.nextRuns.slice(0, 3).map((iso) => runLabel(i18n.language, iso, rule.timezone))
    : upcomingLabels(i18n.language, rule);
  const phraseFailed = phraseTyped && typed.length > 0 && parsed.data?.ok === false;
  const shownZone = zone;
  const scheduleOk = kind === "event" || (kind === "email" ? Boolean(email.accountId) : once || !phraseFailed);
  const targetValue = (): RoutineTargetInput =>
    target === TARGET_FORUM
      ? { type: "forum", agentIds: forumAgents.length > 0 ? forumAgents : [agentId], rounds: Number(forumRounds) }
      : target === TARGET_DM
        ? { type: "dm" }
        : target === TARGET_ARTIFACT
          ? { type: "artifact" }
          : { type: "channel", channelId: target };
  const emailTrigger = () => ({
    type: "email" as const,
    accountId: email.accountId,
    folder: email.folder || INBOX,
    filter: cleanFilter(email.filter),
  });
  const trigger = (): RoutineInput["trigger"] =>
    kind === "email"
      ? emailTrigger()
      : kind === "event"
        ? { type: "event", event }
        : once
          ? {
              type: "once",
              at: zonedInstant(rule.start, rule.times[0] ?? "09:00", rule.timezone).toISOString(),
              timezone: rule.timezone,
            }
          : { type: "schedule", rule: toApiRule(rule) };
  /** What changed against the routine (`PATCH` sends only this). */
  const changes = (r: Routine): RoutinePatch => {
    const patch: RoutinePatch = {};
    if (name.trim() && name.trim() !== r.name) patch.name = name.trim();
    if (prompt.trim() !== r.prompt) patch.prompt = prompt.trim();
    if (agentId !== r.agentId) patch.agentId = agentId;
    const forumChanged =
      target === TARGET_FORUM &&
      r.target.type === "forum" &&
      (JSON.stringify([...(forumAgents.length > 0 ? forumAgents : [agentId])].sort()) !==
        JSON.stringify([...r.target.agentIds].sort()) ||
        Number(forumRounds) !== (r.target.rounds ?? 3));
    if (target !== TARGET_KEEP && (target !== targetChoice(r.target) || forumChanged)) patch.target = targetValue();
    const triggerChanged =
      kind === "email"
        ? r.trigger.type !== "email" ||
          JSON.stringify(emailTrigger()) !==
            JSON.stringify({
              type: "email",
              accountId: r.trigger.accountId,
              folder: r.trigger.folder,
              filter: cleanFilter(r.trigger.filter ?? {}),
            })
        : kind === "event"
          ? r.trigger.type !== "event" || r.trigger.event !== event
          : once
            ? r.trigger.type !== "once" ||
              JSON.stringify(trigger()) !== JSON.stringify({ type: "once", at: r.trigger.at, timezone: savedZone })
            : r.trigger.type !== "schedule" || JSON.stringify(toApiRule(rule)) !== savedRule;
    if (triggerChanged) patch.trigger = trigger();
    if (active !== r.active) patch.active = active;
    return patch;
  };
  // Only a phrase that wasn't understood says something here; the sentence above already says what was.
  const phraseError = () => {
    if (phraseFailed && parsed.data && !parsed.data.ok) {
      const tt = t as unknown as (k: string, o: Record<string, unknown>) => string;
      const code = parsed.data.code;
      return code
        ? tt(`routines.form.parseError.${code.replace(/\./g, "_")}`, { defaultValue: parsed.data.error })
        : parsed.data.error;
    }
    return undefined;
  };
  /** A starting point: what to do, a name and when (the phrase is read by the server, like a typed one). */
  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setPrompt(t(`routines.presets.${p.key}.prompt`));
    setName(t(`routines.presets.${p.key}.name`));
    setKind(p.kind);
    if (p.kind === "event") setEvent(p.event);
    else typePhrase(t(`routines.presets.${p.key}.phrase`));
  };
  const submit = () => {
    setTouched(true);
    if (!prompt.trim() || !agentId || !scheduleOk) return;
    if (routine) {
      const patch = changes(routine);
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      action.mutate(
        { type: "update", id: routine.id, patch },
        {
          onSuccess: (saved) => {
            const next = (saved as Routine | undefined)?.nextRunAt;
            toast.show(
              next
                ? t("routines.form.saved", { next: t("routines.next", { when: nextLabel(i18n.language, next) }) })
                : t("routines.form.savedNoNext"),
            );
            onClose();
          },
        },
      );
      return;
    }
    action.mutate(
      {
        type: "create",
        input: {
          name: name.trim() || undefined,
          agentId,
          prompt: prompt.trim(),
          target: targetValue(),
          trigger: trigger(),
        },
      },
      {
        onSuccess: () => {
          toast.show(t("routines.form.created"));
          setPrompt("");
          setName("");
          setTouched(false);
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={editing ? t("routines.editTitle") : t("routines.new")}
      closeLabel={t("common.close")}
      width={560}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <DialogBody>
          {agents.length === 0 && <p className="small muted">{t("routines.form.noAgents")}</p>}
          {!editing && !prompt.trim() && (
            <fieldset className="routine-presets">
              <legend className="ac-eyebrow">{t("routines.presets.title")}</legend>
              <div className="routine-presets__list">
                {PRESETS.map((p) => (
                  <button key={p.key} type="button" className="routine-preset" onClick={() => applyPreset(p)}>
                    <span className="routine-preset__icon" aria-hidden="true">
                      <Icon name={p.icon} size={16} />
                    </span>
                    <span>
                      <b>{t(`routines.presets.${p.key}.name`)}</b>
                      <small>{t(`routines.presets.${p.key}.text`)}</small>
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <div className="grid-fields">
            <Field label={t("routines.form.agent")} id="nr-agent">
              <Select
                value={agentId || undefined}
                onValueChange={setAgentId}
                options={agents.map((a) => ({ value: a.id, label: a.name, description: a.role || undefined }))}
              />
            </Field>
            <Field label={t("routines.form.target")} id="nr-target">
              <Select
                value={target || undefined}
                onValueChange={setTarget}
                options={[
                  ...(routine && target === TARGET_KEEP
                    ? [{ value: TARGET_KEEP, label: targetLabel(routine.target) }]
                    : []),
                  ...(channels.data ?? []).map((c) => ({ value: c.id, label: `#${c.name}` })),
                  { value: TARGET_DM, label: t("routines.target.dm") },
                  { value: TARGET_ARTIFACT, label: t("routines.target.artifact") },
                  { value: TARGET_FORUM, label: t("routines.target.forum") },
                ]}
              />
            </Field>
          </div>
          {target === TARGET_FORUM && (
            <div className="routine-forum">
              <span className="ac-field__label">{t("routines.form.forumAgents")}</span>
              {agents.map((a) => {
                const id = `nr-fa-${a.id}`;
                return (
                  <label key={a.id} htmlFor={id} className="scope-row">
                    <Checkbox
                      id={id}
                      aria-label={a.name}
                      checked={forumAgents.includes(a.id) || (forumAgents.length === 0 && a.id === agentId)}
                      onCheckedChange={(on) =>
                        setForumAgents((l) => {
                          const base = l.length === 0 ? [agentId] : l;
                          return on ? [...new Set([...base, a.id])] : base.filter((x) => x !== a.id);
                        })
                      }
                    />
                    <span className="scope-row__text" aria-hidden="true">
                      <span>{a.name}</span>
                    </span>
                  </label>
                );
              })}
              <span className="ac-field__label">{t("forum.form.rounds")}</span>
              <Segmented
                label={t("forum.form.rounds")}
                value={forumRounds}
                onValueChange={setForumRounds}
                options={FORUM_ROUNDS.map((r) => ({ value: r, label: r }))}
              />
            </div>
          )}
          <Field
            label={t("routines.form.what")}
            id="nr-what"
            error={touched && !prompt.trim() ? t("routines.form.required") : undefined}
          >
            <Textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("routines.form.whatPlaceholder")}
            />
          </Field>
          <Field label={editing ? t("routines.form.title") : t("routines.form.name")} id="nr-name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="routine-kind">
            <span className="ac-field__label">{t("routines.form.when")}</span>
            <Segmented
              label={t("routines.form.when")}
              value={kind}
              onValueChange={setKind}
              options={[
                { value: "schedule" as const, label: t("routines.form.kind.schedule") },
                { value: "event" as const, label: t("routines.form.kind.event") },
                ...(hasMail ? [{ value: "email" as const, label: t("routines.form.kind.email") }] : []),
              ]}
            />
          </div>
          {kind === "email" && <EmailTriggerFields value={email} onChange={setEmail} />}
          {kind === "schedule" && (
            <div className="routine-when">
              <div className="routine-when__head">
                <span className="routine-when__sentence" aria-live="polite">
                  {ruleSentence(t, i18n.language, rule, new Date(), false)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  icon="repeat"
                  aria-expanded={pickerOpen}
                  onClick={() => setPickerOpen((o) => !o)}
                >
                  {t("routines.form.adjust")}
                </Button>
              </div>
              {!pickerOpen && upcoming.length > 0 && (
                <div className="ac-recur__upcoming">
                  <span className="ac-recur__label">{t("routines.form.next")}</span>
                  <ol>
                    {upcoming.map((label) => (
                      <li key={label} className="tabular">
                        {label}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {pickerOpen && (
                <RecurrencePicker
                  value={rule}
                  onChange={pickRule}
                  labels={recurrenceLabels(t, i18n.language, rule)}
                  locale={i18n.language}
                  upcoming={upcoming}
                  hideTimezone
                />
              )}
            </div>
          )}
          {kind === "schedule" && (
            <>
              {!once && (
                <Field label={t("routines.form.frequency")} id="nr-when" error={phraseError()}>
                  <Input
                    value={phrase}
                    onChange={(e) => typePhrase(e.target.value)}
                    placeholder={t("recurrence.phrasePlaceholder")}
                  />
                </Field>
              )}
              <Field label={t("routines.form.timezone")} id="nr-zone">
                <ZoneSelect value={zone} onChange={setZone} />
              </Field>
            </>
          )}
          {kind === "schedule" && wasUtc && !isUtc(shownZone) && (
            <p className="routine-utc-hint small">
              <Icon name="waiting" size={14} />
              <span>{t("routines.form.utcHint", { zone: timezoneName(shownZone, i18n.language) })}</span>
              <button type="button" className="ac-link" onClick={() => setZone("UTC")}>
                {t("routines.form.keepUtc")}
              </button>
            </p>
          )}
          {kind !== "event" ? null : (
            <Field
              label={t("routines.form.event")}
              id="nr-event"
              help={t("routines.form.eventHelp", { org: org.name })}
            >
              <Select
                value={event}
                onValueChange={(v) => setEvent(v as RoutineEvent)}
                options={ROUTINE_EVENTS.map((e) => ({ value: e, label: t(`routines.event.${e}`) }))}
              />
            </Field>
          )}
          {editing && !(routine && isDoneOnce(routine)) && (
            <label className="routine-active" htmlFor="nr-active">
              <Switch id="nr-active" checked={active} onCheckedChange={setActive} />
              <span>{t("routines.form.active")}</span>
            </label>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("routines.form.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={action.isPending || !agentId || !scheduleOk}>
            {editing ? t("routines.form.save") : t("routines.form.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** A one-off routine's moment as a rule ("Uma vez", that day and time in its zone). */
function onceRule(at: string, timezone: string): RecurrenceRule {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    freq: "once",
    interval: 1,
    times: [`${get("hour")}:${get("minute")}`],
    timezone,
    start: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/** A next run ("seg, 20 out · 09:00") in the rule's zone. */
function runLabel(locale: string, iso: string, timeZone: string) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone })
    .format(d)
    .replace(/\./g, "")
    .replace(/ de /g, " ");
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(d);
  return `${date} · ${time}`;
}

/** A run's summary in the UI language (from its code), else the server's words. */
function runSummary(t: TFunction, run: RoutineRun) {
  if (!run.summaryCode) return run.summary;
  const key = `routines.summary.${run.summaryCode.replace(/^routine_run\./, "")}`;
  const tt = t as unknown as (k: string, o: Record<string, unknown>) => string;
  return tt(key, { ...(run.summaryParams ?? {}), defaultValue: run.summary });
}
