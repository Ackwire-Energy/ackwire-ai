import type { CalendarEvent, CalendarRange, SeriesScope } from "@agenteschat/client";
import { useCalendar, useCalendarAction, useRoutines } from "@agenteschat/client";
import {
  addDays,
  addMinutes,
  type CalendarView,
  type CalItem,
  collapseRoutines,
  type ItemSource,
  isBarItem,
  onDay,
  rangeLabel,
  sameDay,
  startOfDay,
  stepFocus,
  toItems,
  upcomingItems,
  viewDays,
  viewRange,
} from "@agenteschat/client/lib/calendar";
import { formatTime, joinNames, toYmd } from "@agenteschat/client/lib/format";
import { runPixelStatus, runPixels } from "@agenteschat/client/lib/routine-view";
import { browserTimezone } from "@agenteschat/client/lib/routines";
import {
  ApprovalCard,
  Button,
  FilterToggle,
  Icon,
  type IconName,
  Kbd,
  ListRow,
  offsetMinutes,
  Popover,
  Segmented,
  Toolbar,
  useDelayed,
} from "@agenteschat/ui";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useActors } from "@/components/actors";
import { AgendaView } from "@/components/calendar/AgendaView";
import { dayLabel, ItemDetails } from "@/components/calendar/EventChip";
import { EventDialog, type EventDraft, type EventSave } from "@/components/calendar/EventDialog";
import { MiniMonth } from "@/components/calendar/MiniMonth";
import { MonthView } from "@/components/calendar/MonthView";
import { SeriesPrompt } from "@/components/calendar/SeriesPrompt";
import { TimeGrid } from "@/components/calendar/TimeGrid";
import { ErrorState } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { ZoneSelect } from "@/components/ZoneSelect";
import { useToast } from "@/lib/toast";
import "./calendar.css";

export { mondayOf } from "@agenteschat/client/lib/calendar";

const VIEWS: CalendarView[] = ["day", "week", "month", "agenda"];
const SOURCES: { source: ItemSource; icon: IconName }[] = [
  { source: "person", icon: "person" },
  { source: "agent", icon: "agent" },
  { source: "routine", icon: "routines" },
  { source: "deadline", icon: "issues" },
];
type Filters = Record<ItemSource, boolean>;

/** A pending edit or delete of a recurring event: which occurrences? */
interface SeriesAsk {
  action: "edit" | "delete";
  run: (scope: SeriesScope) => void;
}

const isSeries = (e: CalendarEvent | undefined) => Boolean(e?.rule && e.rule.freq !== "once");
const seriesOf = (e: CalendarEvent, scope: SeriesScope) => ({ scope, occurrenceStart: e.occurrenceStart ?? e.start });
/** Nobody's typing and nothing modal is open: single-key shortcuts apply. */
const shortcutsFree = (e: KeyboardEvent) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return false;
  const el = e.target as HTMLElement | null;
  if (el?.closest("input, textarea, select, [contenteditable='true'], [role='combobox']")) return false;
  return !document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]');
};

/**
 * Calendário (v2): Dia / Semana / Mês / Agenda, a collapsible side panel
 * (mini month, Próximos, filters by source, the agents note), drag to create
 * and to move, recurring events with "Só este / Este e os próximos / Todos".
 * Keys: ←/→ move the day, N creates, T goes to today.
 */
export function CalendarPage({ today: todayProp }: { today?: Date }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const action = useCalendarAction(org.id);
  const [today] = useState(() => todayProp ?? new Date());
  const [now, setNow] = useState(() => new Date());
  const [view, setView] = useState<CalendarView>("week");
  const [focus, setFocus] = useState(() => startOfDay(today));
  const [businessOnly, setBusinessOnly] = useState(false);
  const [panel, setPanel] = useState(() => typeof window === "undefined" || window.innerWidth >= 1180);
  const [filters, setFilters] = useState<Filters>({ person: true, agent: true, routine: true, deadline: true });
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ draft: EventDraft | null; event: CalendarEvent | null } | null>(null);
  const [ask, setAsk] = useState<SeriesAsk | null>(null);

  // The current-time line moves every minute.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const days = viewDays(view, focus, businessOnly);
  const { from, to } = viewRange(view, focus);
  const range = useCalendar(org.id, from.toISOString(), to.toISOString());
  const soon = useCalendar(org.id, startOfDay(now).toISOString(), addDays(startOfDay(now), 14).toISOString());
  // The calendar can be read in another zone: items are shown at that zone's wall-clock time.
  const [viewZone, setViewZone] = useState(() => browserTimezone() ?? "UTC");
  const toView = (d: Date) => new Date(d.getTime() + (offsetMinutes(viewZone, d) + d.getTimezoneOffset()) * 60_000);
  const fromView = (d: Date) => new Date(d.getTime() - (offsetMinutes(viewZone, d) + d.getTimezoneOffset()) * 60_000);
  const shiftItems = (list: CalItem[]) =>
    list.map((it) => (it.allDay ? it : { ...it, start: toView(it.start), end: toView(it.end) }));
  // biome-ignore lint/correctness/useExhaustiveDependencies: toView only depends on the zone
  const all = useMemo(() => shiftItems(toItems(range.data)), [range.data, viewZone]);
  // A routine that runs often is one band, not a chip per run; its lane shows how the recent runs went.
  const routines = useRoutines(org.id);
  const routineById = useMemo(() => new Map((routines.data ?? []).map((r) => [r.id, r])), [routines.data]);
  const items = collapseRoutines(
    all.filter((it) => filters[it.source]),
    days,
  ).map((it) => {
    const r = it.routineId ? routineById.get(it.routineId) : undefined;
    if (!r) return it;
    if (!it.runs) {
      // A single run: how it went when it already ran (a run within 5 minutes of it), and the routine's last result.
      const recent = runPixels(r.recentRuns);
      const own = recent.find((x) => Math.abs(toView(new Date(x.at)).getTime() - it.start.getTime()) < 5 * 60_000);
      const last = r.lastRun ? (runPixelStatus(r.lastRun.status) ?? undefined) : undefined;
      return { ...it, result: own?.status, lastResult: recent[0]?.status ?? last };
    }
    const pastRuns = runPixels(r.recentRuns).map((x) => ({
      at: toView(new Date(x.at)),
      status: x.status,
      weight: x.weight,
    }));
    return { ...it, pastRuns, running: r.state === "running" };
  });
  const counts = Object.fromEntries(
    SOURCES.map(({ source }) => [source, all.filter((it) => it.source === source).length]),
  );
  const events = useMemo(() => eventsByKey(range.data), [range.data]);
  const upcoming = upcomingItems(
    shiftItems(toItems(soon.data)).filter((it) => filters[it.source]),
    now,
  );
  const placeholders = useDelayed(range.isLoading);
  const busy = useMemo(() => new Set(all.map((it) => toYmd(it.start))), [all]);
  const proposal = range.data?.proposals[0];

  const newAt = (day: Date) => {
    const start = addMinutes(startOfDay(day), 9 * 60);
    setDialog({ draft: { start, end: addMinutes(start, 30) }, event: null });
  };
  // Keyboard: ←/→ (↑/↓ by week), N, T.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shortcutsFree(e)) return;
      const k = e.key;
      if (k === "n" || k === "N") {
        e.preventDefault();
        newAt(focus);
      } else if (k === "t" || k === "T") {
        e.preventDefault();
        setFocus(startOfDay(today));
      } else if (k === "ArrowLeft" || k === "ArrowRight") {
        e.preventDefault();
        setFocus((f) => addDays(f, k === "ArrowLeft" ? -1 : 1));
      } else if ((k === "ArrowUp" || k === "ArrowDown") && view !== "day") {
        e.preventDefault();
        setFocus((f) => addDays(f, k === "ArrowUp" ? -7 : 7));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const save = ({ input, patch }: EventSave) => {
    const editing = dialog?.event;
    const done = (msg: string) => () => {
      toast.show(msg);
      setDialog(null);
    };
    if (!editing) {
      action.mutate(
        { type: "create", input: { ...input, recurrence: "none" } },
        { onSuccess: done(t("calendar.form.created")) },
      );
      return;
    }
    if (Object.keys(patch).length === 0) {
      setDialog(null);
      return;
    }
    const id = editing.id;
    if (isSeries(editing)) {
      setAsk({
        action: "edit",
        run: (scope) =>
          action.mutate(
            { type: "update", id, patch, series: seriesOf(editing, scope) },
            { onSuccess: done(t("calendar.saved")) },
          ),
      });
      return;
    }
    action.mutate({ type: "update", id, patch }, { onSuccess: done(t("calendar.saved")) });
  };
  const move = (item: CalItem, r: { start: Date; end: Date }) => {
    const e = events.get(item.key);
    if (!e) return;
    const patch = { start: fromView(r.start).toISOString(), end: fromView(r.end).toISOString() };
    const run = (scope?: SeriesScope) =>
      action.mutate(
        { type: "update", id: e.id, patch, ...(scope ? { series: seriesOf(e, scope) } : {}) },
        { onSuccess: () => toast.show(t("calendar.moved")) },
      );
    if (isSeries(e)) setAsk({ action: "edit", run });
    else run();
  };
  const remove = (item: CalItem) => {
    const e = events.get(item.key);
    if (!e) return;
    setOpenKey(null);
    const run = (scope?: SeriesScope) =>
      action.mutate(
        { type: "remove", id: e.id, ...(scope ? { series: seriesOf(e, scope) } : {}) },
        { onSuccess: () => toast.show(t("calendar.deleted")) },
      );
    if (isSeries(e)) setAsk({ action: "delete", run });
    else run();
  };
  const details = (item: CalItem) => (
    <ItemDetails
      item={item}
      onEdit={
        item.kind === "event"
          ? () => {
              setOpenKey(null);
              setDialog({ draft: null, event: events.get(item.key) ?? null });
            }
          : undefined
      }
      onDelete={item.kind === "event" ? () => remove(item) : undefined}
    />
  );
  const inGrid = items.filter((it) => days.some((d) => onDay(it, d)));
  const filterChips = (
    <Toolbar size="sm" label={t("calendar.filters")}>
      {SOURCES.map(({ source, icon }) => (
        <FilterToggle
          key={source}
          icon={icon}
          pressed={filters[source]}
          count={counts[source] ?? 0}
          onPressedChange={() => setFilters((f) => ({ ...f, [source]: !f[source] }))}
        >
          {t(`calendar.filter.${source}`)}
        </FilterToggle>
      ))}
    </Toolbar>
  );

  return (
    <div className="cal-page" data-panel={panel || undefined}>
      <header className="cal-page__header">
        <div className="cal-page__title">
          <h1 className="page-title">{t("calendar.title")}</h1>
          <span className="cal-page__range" aria-live="polite">
            {rangeLabel(i18n.language, view, days, focus)}
          </span>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: prev / today / next as one compact group */}
        <div className="cal-nav" role="group" aria-label={t("calendar.nav")}>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="chevronLeft"
            aria-label={t(`calendar.prev.${view}`)}
            onClick={() => setFocus((f) => stepFocus(view, f, -1))}
          />
          <Button size="sm" variant="ghost" onClick={() => setFocus(startOfDay(today))}>
            {t("calendar.today")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="chevronRight"
            aria-label={t(`calendar.next.${view}`)}
            onClick={() => setFocus((f) => stepFocus(view, f, 1))}
          />
        </div>
        <Segmented
          label={t("calendar.view")}
          size="sm"
          value={view}
          onValueChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`calendar.views.${v}`) }))}
        />
        {view === "week" && (
          <FilterToggle pressed={businessOnly} onPressedChange={setBusinessOnly}>
            {t("calendar.businessDays")}
          </FilterToggle>
        )}
        <span className="cal-page__spacer" />
        {!panel && (
          <Popover
            label={t("calendar.filters")}
            side="bottom"
            align="end"
            trigger={
              <Button size="sm" variant="ghost" icon="filter">
                {t("calendar.filters")}
              </Button>
            }
          >
            {filterChips}
          </Popover>
        )}
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon="sidebar"
          aria-label={panel ? t("calendar.hidePanel") : t("calendar.showPanel")}
          aria-expanded={panel}
          onClick={() => setPanel((p) => !p)}
        />
        <Button variant="primary" icon="plus" className="cal-page__new" onClick={() => newAt(focus)}>
          {t("calendar.new")}
          <Kbd aria-hidden="true">N</Kbd>
        </Button>
      </header>
      <div className="cal-page__body">
        <div className="cal-page__main">
          {range.isError && !range.data && <ErrorState error={range.error} onRetry={() => void range.refetch()} />}
          {(view === "day" || view === "week") && (
            <TimeGrid
              days={days}
              items={items}
              today={today}
              now={toView(now)}
              loading={placeholders}
              focusDay={focus}
              openKey={openKey}
              onOpenKey={setOpenKey}
              details={details}
              onCreate={(r) => setDialog({ draft: { start: fromView(r.start), end: fromView(r.end) }, event: null })}
              onMove={move}
              onFocusDay={setFocus}
              emptyHint={range.isSuccess && inGrid.length === 0 ? t("calendar.emptyHint") : null}
            />
          )}
          {view === "month" && (
            <MonthView
              days={days}
              month={focus.getMonth()}
              items={items}
              today={today}
              focusDay={focus}
              openKey={openKey}
              onOpenKey={setOpenKey}
              details={details}
              onFocusDay={setFocus}
            />
          )}
          {view === "agenda" && (
            <AgendaView
              days={days}
              items={items}
              today={today}
              openKey={openKey}
              onOpenKey={setOpenKey}
              details={details}
            />
          )}
        </div>
        {panel && (
          <aside className="cal-side" aria-label={t("calendar.panel")}>
            {proposal && <Proposal proposal={proposal} />}
            <MiniMonth
              focus={focus}
              today={today}
              busy={busy}
              onPick={(d) => {
                setFocus(d);
                if (view === "agenda") setView("day");
              }}
            />
            <section className="cal-side__section" aria-label={t("calendar.upcoming")}>
              <h2 className="cal-side__title">{t("calendar.upcoming")}</h2>
              {upcoming.length === 0 ? (
                <p className="small muted">{t("calendar.upcomingEmpty")}</p>
              ) : (
                <ol className="cal-upcoming">
                  {upcoming.map((it) => {
                    const day = sameDay(it.start, now) ? t("calendar.today") : dayLabel(i18n.language, it.start);
                    return (
                      <li key={it.key}>
                        <ListRow
                          lead={
                            it.agentId ? (
                              <AgentAvatar agentId={it.agentId} size="xs" name="" />
                            ) : (
                              <Icon name="calendar" size={16} aria-hidden="true" />
                            )
                          }
                          title={it.title}
                          meta={
                            it.allDay || isBarItem(it)
                              ? day
                              : t("calendar.upcomingMeta", {
                                  day,
                                  time: formatTime(i18n.language, it.start.toISOString()),
                                })
                          }
                          onClick={() => {
                            setFocus(startOfDay(it.start));
                            if (view === "agenda" || view === "month") setView("week");
                          }}
                        />
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
            <section className="cal-side__section" aria-label={t("calendar.filters")}>
              <h2 className="cal-side__title">{t("calendar.filters")}</h2>
              {filterChips}
            </section>
            <section className="cal-side__section" aria-label={t("calendar.viewZone")}>
              <h2 className="cal-side__title">{t("calendar.viewZone")}</h2>
              <ZoneSelect value={viewZone} onChange={setViewZone} aria-label={t("calendar.viewZone")} />
            </section>
            <p className="cal-side__note">{t("calendar.note")}</p>
          </aside>
        )}
      </div>
      {dialog && (
        <EventDialog
          open
          draft={dialog.draft}
          event={dialog.event}
          onClose={() => setDialog(null)}
          onSave={save}
          saving={action.isPending}
        />
      )}
      <SeriesPrompt
        open={Boolean(ask)}
        action={ask?.action ?? "edit"}
        onCancel={() => setAsk(null)}
        onPick={(scope) => {
          ask?.run(scope);
          setAsk(null);
        }}
      />
    </div>
  );
}

/** Range events by the key their items use (an occurrence: series id + its start). */
function eventsByKey(range: CalendarRange | undefined) {
  const map = new Map<string, CalendarEvent>();
  for (const e of range?.events ?? [])
    map.set(e.occurrenceStart ? `${e.seriesId ?? e.id}@${e.occurrenceStart}` : e.id, e);
  return map;
}

function Proposal({ proposal }: { proposal: CalendarRange["proposals"][number] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actors = useActors();
  const action = useCalendarAction(org.id);
  const agent = { type: "agent" as const, id: proposal.agentId };
  const when = `${dayLabel(i18n.language, new Date(proposal.start))}, ${formatTime(i18n.language, proposal.start)}–${formatTime(i18n.language, proposal.end)}`;
  const people = joinNames(proposal.participants.map(actors.name), t("newAgent.and"));
  return (
    <ApprovalCard
      status="waiting"
      aria-label={t("calendar.proposal")}
      avatar={actors.avatar(agent)}
      who={<Trans i18nKey="calendar.proposes" values={{ name: actors.name(agent) }} components={[<b key="b" />]} />}
      title={proposal.title}
      detail={[t("calendar.proposalDetail", { when, people }), proposal.note].filter(Boolean).join(" · ")}
      actions={
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={action.isPending}
            loading={action.isPending && action.variables?.type === "confirm"}
            onClick={() =>
              action.mutate(
                { type: "confirm", id: proposal.id },
                { onSuccess: () => toast.show(t("calendar.confirmed")) },
              )
            }
          >
            {t("calendar.confirm")}
          </Button>
          <Button
            size="sm"
            disabled={action.isPending}
            loading={action.isPending && action.variables?.type === "dismiss"}
            onClick={() => action.mutate({ type: "dismiss", id: proposal.id })}
          >
            {t("calendar.otherTime")}
          </Button>
        </>
      }
    />
  );
}
