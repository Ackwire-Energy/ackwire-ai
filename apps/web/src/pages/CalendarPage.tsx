import {
  ApprovalCard,
  Button,
  Checkbox,
  Chip,
  DatePicker,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Select,
  Skeleton,
  TimeSelect,
  useDelayed,
} from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { type CSSProperties, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useCalendar, useCalendarAction, useChannels } from "@/api/queries";
import type { Actor, CalendarRange, Recurrence, RoutineTarget } from "@/api/types";
import { useActors } from "@/components/actors";
import { ErrorState } from "@/components/Loading";
import { PeoplePicker, type PickKey } from "@/components/MemberPicker";
import { useOrg } from "@/components/org-context";
import { formatTime, joinNames, toYmd } from "@/lib/format";
import { useToast } from "@/lib/toast";

const DAYS = 5;
const FIRST_HOUR = 8;
const LAST_HOUR = 19;
const HOUR_PX = 48;
const RECURRENCES: Recurrence[] = ["none", "weekdays", "weekly", "monthly"];

export function mondayOf(d: Date) {
  const offset = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
}
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const hours = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() + d.getMinutes() / 60;
};

/** "20 a 24 de outubro" / "27 de outubro a 1 de novembro". */
export function weekLabel(t: TFunction, locale: string, monday: Date) {
  const friday = addDays(monday, DAYS - 1);
  const month = (d: Date) => new Intl.DateTimeFormat(locale, { month: "long" }).format(d);
  return monday.getMonth() === friday.getMonth()
    ? t("calendar.rangeSameMonth", { from: monday.getDate(), to: friday.getDate(), month: month(friday) })
    : t("calendar.rangeTwoMonths", {
        from: monday.getDate(),
        fromMonth: month(monday),
        to: friday.getDate(),
        toMonth: month(friday),
      });
}

const dayName = (locale: string, d: Date) =>
  new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d).replace(/\.$/, "");
const dayFull = (locale: string, d: Date) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" })
    .format(d)
    .replace(/\./g, "")
    .replace(/ de /g, " ");

type Item =
  | { kind: "event"; id: string; title: string; start: string; end: string; detail: string; people: Actor[] }
  | { kind: "routine"; id: string; title: string; start: string; end: string; agentId: string; target: RoutineTarget }
  | { kind: "deadline"; id: string; title: string; number: number; date: string };

type Layers = { events: boolean; routines: boolean; deadlines: boolean };

/** Calendário (telas/Calendario.dc.html): week of events, routine runs and issue due dates. */
export function CalendarPage({ today = new Date() }: { today?: Date }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const [monday, setMonday] = useState(() => mondayOf(today));
  const [layers, setLayers] = useState<Layers>({ events: true, routines: true, deadlines: true });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const from = monday.toISOString();
  const to = addDays(monday, 7).toISOString();
  const range = useCalendar(org.id, from, to);
  const items = useMemo(() => toItems(range.data), [range.data]);
  // Loading the week: a few placeholder blocks in the grid (after 150 ms, never a flash).
  const placeholders = useDelayed(range.isLoading);
  const days = Array.from({ length: DAYS }, (_, i) => addDays(monday, i));
  const sameDay = (iso: string, d: Date) => toYmd(new Date(iso)) === toYmd(d);
  const visible = (it: Item) =>
    (it.kind === "event" && layers.events) ||
    (it.kind === "routine" && layers.routines) ||
    (it.kind === "deadline" && layers.deadlines);
  const current = items.find((it) => it.id === selected) ?? null;
  const proposal = range.data?.proposals[0];
  return (
    <div className="calendar-page">
      <header className="calendar-page__header">
        <h1 className="page-title">{t("calendar.title")}</h1>
        <div className="row" style={{ gap: 4, alignItems: "center" }}>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="chevronLeft"
            aria-label={t("calendar.prevWeek")}
            onClick={() => setMonday((m) => addDays(m, -7))}
          />
          <Button size="sm" onClick={() => setMonday(mondayOf(today))}>
            {t("calendar.today")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon="chevronRight"
            aria-label={t("calendar.nextWeek")}
            onClick={() => setMonday((m) => addDays(m, 7))}
          />
          <span className="calendar-page__range" aria-live="polite">
            {weekLabel(t, i18n.language, monday)}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        {/* biome-ignore lint/a11y/useSemanticElements: a group of layer toggles */}
        <div className="row" role="group" aria-label={t("calendar.layers")} style={{ gap: 12 }}>
          {(["events", "routines", "deadlines"] as const).map((l) => (
            <span key={l} className="row" style={{ gap: 6, alignItems: "center" }}>
              <Checkbox
                id={`ly-${l}`}
                checked={layers[l]}
                onCheckedChange={(v) => setLayers((s) => ({ ...s, [l]: v }))}
              />
              <label htmlFor={`ly-${l}`}>{t(`calendar.layer.${l}`)}</label>
            </span>
          ))}
        </div>
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          {t("calendar.new")}
        </Button>
      </header>
      <div className="calendar-page__body">
        <div className="calendar-grid" style={{ "--hour-px": `${HOUR_PX}px` } as CSSProperties}>
          <div className="calendar-grid__corner" />
          {days.map((d) => (
            <div key={toYmd(d)} className="calendar-grid__day" data-today={toYmd(d) === toYmd(today) || undefined}>
              <span className="small muted">{dayName(i18n.language, d)}</span>
              <span className="calendar-grid__num tabular">{d.getDate()}</span>
              {items
                .filter((it) => it.kind === "deadline" && visible(it) && it.date === toYmd(d))
                .map((it) =>
                  it.kind === "deadline" ? (
                    <button
                      key={it.id}
                      type="button"
                      className="calendar-deadline"
                      aria-pressed={selected === it.id}
                      onClick={() => setSelected(it.id)}
                    >
                      <Chip icon="issues">{t("calendar.deadline", { number: it.number, title: it.title })}</Chip>
                    </button>
                  ) : null,
                )}
            </div>
          ))}
          <div className="calendar-grid__hours" aria-hidden="true">
            {Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i).map((h) => (
              <div key={h} className="calendar-grid__hour small muted tabular">
                {String(h).padStart(2, "0")}:00
              </div>
            ))}
          </div>
          {days.map((d) => (
            <div key={toYmd(d)} className="calendar-grid__col" data-day={toYmd(d)}>
              {placeholders && d.getDay() % 2 === 1 && (
                <Skeleton
                  shape="block"
                  className="calendar-item calendar-item--skeleton"
                  style={{ top: (d.getDay() + 1) * HOUR_PX + 2, height: HOUR_PX - 4 }}
                />
              )}
              {items
                .filter((it) => it.kind !== "deadline" && visible(it) && sameDay(it.start, d))
                .map((it) => {
                  if (it.kind === "deadline") return null;
                  const top = Math.max(0, hours(it.start) - FIRST_HOUR) * HOUR_PX;
                  const height = Math.max(22, (hours(it.end) - hours(it.start)) * HOUR_PX - 4);
                  const time = `${formatTime(i18n.language, it.start)}–${formatTime(i18n.language, it.end)}`;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      className={`calendar-item calendar-item--${it.kind}`}
                      style={{ top: top + 2, height }}
                      aria-pressed={selected === it.id}
                      aria-label={t("calendar.eventAria", { title: it.title, time })}
                      onClick={() => setSelected(it.id)}
                    >
                      <span className="calendar-item__title">{it.title}</span>
                      <span className="calendar-item__time small muted tabular">{time}</span>
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
        <aside className="calendar-aside" aria-label={t("calendar.details")}>
          {range.isLoading && (
            <p className="ac-visually-hidden" role="status">
              {t("common.loadingList")}
            </p>
          )}
          {range.isError && !range.data && <ErrorState error={range.error} onRetry={() => void range.refetch()} />}
          {proposal && <Proposal proposal={proposal} />}
          {current ? <Selected item={current} /> : <p className="small muted">{t("calendar.noSelection")}</p>}
          <p className="small muted">{t("calendar.note")}</p>
        </aside>
      </div>
      <NewEventDialog open={creating} onClose={() => setCreating(false)} monday={monday} />
    </div>
  );
}

function toItems(range: CalendarRange | undefined): Item[] {
  if (!range) return [];
  return [
    ...range.events.map((e) => ({
      kind: "event" as const,
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      detail: e.description,
      people: e.participants,
    })),
    ...range.routines.map((r) => ({
      kind: "routine" as const,
      id: `${r.routineId}@${r.at}`,
      title: r.name,
      start: r.at,
      end: new Date(new Date(r.at).getTime() + 30 * 60_000).toISOString(),
      agentId: r.agentId,
      target: r.target,
    })),
    ...range.deadlines.map((d) => ({
      kind: "deadline" as const,
      id: `deadline-${d.issueId}`,
      title: d.title,
      number: d.number,
      date: d.date,
    })),
  ];
}

function Proposal({ proposal }: { proposal: CalendarRange["proposals"][number] }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const toast = useToast();
  const actors = useActors();
  const action = useCalendarAction(org.id);
  const agent = { type: "agent" as const, id: proposal.agentId };
  const when = `${dayFull(i18n.language, new Date(proposal.start))}, ${formatTime(i18n.language, proposal.start)}–${formatTime(i18n.language, proposal.end)}`;
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

function Selected({ item }: { item: Item }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const actors = useActors();
  const channels = useChannels(org.id);
  const target = (tg: RoutineTarget) => {
    if (tg.type === "channel") return `#${channels.data?.find((c) => c.id === tg.channelId)?.name ?? ""}`;
    if (tg.type === "forum") return t("routines.target.forumShort");
    if (tg.type === "conversation") {
      const c = channels.data?.find((x) => x.id === tg.channelId);
      return c ? `#${c.name}` : t("routines.inConversation");
    }
    return t(tg.type === "dm" ? "routines.target.dmShort" : "routines.target.artifactShort");
  };
  const people =
    item.kind === "event" ? item.people : item.kind === "routine" ? [{ type: "agent" as const, id: item.agentId }] : [];
  return (
    <section aria-label={item.title} className="calendar-selected">
      <span className="ac-eyebrow">{t(`calendar.kind.${item.kind}`)}</span>
      <span className="calendar-selected__title">{item.title}</span>
      {item.kind !== "deadline" && (
        <span className="small muted">
          {dayFull(i18n.language, new Date(item.start))} · {formatTime(i18n.language, item.start)}–
          {formatTime(i18n.language, item.end)}
        </span>
      )}
      {item.kind === "event" && item.detail && <span className="small">{item.detail}</span>}
      {item.kind === "routine" && (
        <span className="small">
          {t("calendar.routineDetail", {
            agent: actors.name({ type: "agent", id: item.agentId }),
            target: target(item.target),
          })}
        </span>
      )}
      {item.kind === "deadline" && (
        <>
          <span className="small">{t("calendar.deadlineDetail")}</span>
          <Link
            to="/org/$orgId/issues/$number"
            params={{ orgId: org.id, number: String(item.number) }}
            className="ac-link small"
          >
            {t("calendar.openIssue")}
          </Link>
        </>
      )}
      {people.length > 0 && (
        <ul className="calendar-selected__people">
          {people.map((p) => (
            <li key={`${p.type}:${p.id}`} className="actor-label">
              {actors.avatar(p)}
              <span>{actors.name(p)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function NewEventDialog({ open, onClose, monday }: { open: boolean; onClose: () => void; monday: Date }) {
  const { t, i18n } = useTranslation();
  const { org, me } = useOrg();
  const toast = useToast();
  const action = useCalendarAction(org.id);
  const [title, setTitle] = useState("");
  const [day, setDay] = useState(() => toYmd(monday));
  const [start, setStart] = useState("10:00");
  const [end, setEnd] = useState("10:30");
  const [repeat, setRepeat] = useState<Recurrence>("none");
  const [picked, setPicked] = useState<Set<PickKey>>(new Set());
  const at = (hm: string) => {
    const [h, m] = hm.split(":").map(Number);
    const [y, mo, d] = day.split("-").map(Number);
    return new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, m ?? 0);
  };
  const timeOk = TIME.test(start) && TIME.test(end) && at(end) > at(start);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("calendar.new")}
      closeLabel={t("common.close")}
      width={560}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim() || !timeOk) return;
          const participants: Actor[] = [
            { type: "person", id: me.user.id },
            ...[...picked].map((k) => {
              const [type, id] = k.split(":");
              return { type: type as Actor["type"], id: id ?? "" };
            }),
          ];
          action.mutate(
            {
              type: "create",
              input: {
                title: title.trim(),
                start: at(start).toISOString(),
                end: at(end).toISOString(),
                recurrence: repeat,
                participants,
              },
            },
            {
              onSuccess: () => {
                toast.show(t("calendar.form.created"));
                setTitle("");
                setPicked(new Set());
                onClose();
              },
            },
          );
        }}
      >
        <DialogBody>
          <Field label={t("calendar.form.title")} id="ne-t">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("calendar.form.titlePlaceholder")}
            />
          </Field>
          <div className="grid-fields grid-fields--3">
            <Field label={t("calendar.form.day")} id="ne-d">
              <DatePicker
                value={day}
                onChange={setDay}
                locale={i18n.language}
                labels={{
                  previousMonth: t("common.previousMonth"),
                  nextMonth: t("common.nextMonth"),
                  choose: t("common.chooseDate"),
                }}
              />
            </Field>
            <Field label={t("calendar.form.start")} id="ne-s">
              <TimeSelect value={start} onChange={setStart} />
            </Field>
            <Field
              label={t("calendar.form.end")}
              id="ne-e"
              error={!timeOk ? t("calendar.form.timeInvalid") : undefined}
            >
              <TimeSelect value={end} onChange={setEnd} />
            </Field>
          </div>
          <Field label={t("calendar.form.repeat")} id="ne-r">
            <Select
              value={repeat}
              onValueChange={(v) => setRepeat(v as Recurrence)}
              options={RECURRENCES.map((r) => ({ value: r, label: t(`calendar.repeat.${r}`) }))}
            />
          </Field>
          <PeoplePicker
            label={t("calendar.form.participants")}
            searchLabel={t("calendar.form.participantsSearch")}
            help={t("calendar.form.participantsHelp")}
            emptyText={t("calendar.form.participantsEmpty")}
            selected={picked}
            onChange={setPicked}
          />
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("calendar.form.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!title.trim() || !timeOk || action.isPending}
            loading={action.isPending}
          >
            {t("calendar.form.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
