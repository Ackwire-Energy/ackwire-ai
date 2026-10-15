import {
  BUSINESS_DAYS,
  nextOccurrences,
  type RecurrenceLabels,
  type RecurrenceRule,
  WEEKDAYS,
  type Weekday,
  weekdayOfYmd,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import type { ApiRule } from "@/api/types";
import { joinNames } from "./format";
import { timezoneName } from "./routines";

const pad = (n: number) => String(n).padStart(2, "0");
const isBusiness = (days: Weekday[] | undefined) =>
  Boolean(days && days.length === 5 && BUSINESS_DAYS.every((d) => days.includes(d)));

/** A new rule: today, 09:00, every week on today's weekday. */
export function defaultRule(timezone: string, today = new Date()): RecurrenceRule {
  const start = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return { freq: "weekly", interval: 1, byWeekday: [weekdayOfYmd(start)], times: ["09:00"], timezone, start };
}

/** Labels of the picker, in the UI language. */
export function recurrenceLabels(t: TFunction, locale: string, rule: RecurrenceRule): RecurrenceLabels {
  const weekdays = Object.fromEntries(
    WEEKDAYS.map((wd) => [wd, { short: t(`recurrence.wd.${wd}.short`), long: t(`recurrence.wd.${wd}.long`) }]),
  ) as RecurrenceLabels["weekdays"];
  return {
    frequency: t("recurrence.frequency"),
    modes: {
      once: t("recurrence.mode.once"),
      daily: t("recurrence.mode.daily"),
      weekly: t("recurrence.mode.weekly"),
      monthly: t("recurrence.mode.monthly"),
      yearly: t("recurrence.mode.yearly"),
      custom: t("recurrence.mode.custom"),
    },
    every: t("recurrence.every"),
    units: {
      hourly: t("recurrence.unit.hourly"),
      daily: t("recurrence.unit.daily"),
      weekly: t("recurrence.unit.weekly"),
      monthly: t("recurrence.unit.monthly"),
      yearly: t("recurrence.unit.yearly"),
    },
    interval: t("recurrence.interval"),
    unit: t("recurrence.unitLabel"),
    businessDays: t("recurrence.businessDays"),
    weekdaysLabel: t("recurrence.weekdays"),
    weekdays,
    onDay: t("recurrence.onDay"),
    onThe: t("recurrence.onThe"),
    nth: (n) => (n === -1 ? t("recurrence.last") : t("recurrence.nth", { n })),
    lastBusinessDay: t("recurrence.lastBusinessDay"),
    yearlyOn: t("recurrence.yearlyOn", { date: dayMonth(locale, rule.start) }),
    times: t("recurrence.times"),
    addTime: t("recurrence.addTime"),
    removeTime: t("recurrence.removeTime"),
    from: t("recurrence.from"),
    period: t("recurrence.period"),
    starts: t("recurrence.starts"),
    ends: t("recurrence.ends"),
    endsNever: t("recurrence.endsNever"),
    endsOn: t("recurrence.endsOn"),
    endsAfter: t("recurrence.endsAfter"),
    occurrences: t("recurrence.occurrences"),
    timezone: t("recurrence.timezone"),
    upcoming: t("recurrence.upcoming"),
    date: {
      previousMonth: t("common.previousMonth"),
      nextMonth: t("common.nextMonth"),
      choose: t("common.chooseDate"),
    },
  };
}

/** "15 de outubro". */
const dayMonth = (locale: string, ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" }).format(
    new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1),
  );
};
/** "31/12" (with the year when it isn't this one). */
const shortDate = (locale: string, ymd: string, now = new Date()) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1);
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  }).format(date);
};

/**
 * The live sentence: "A cada 2 semanas, seg e qua, às 09:00 (horário de
 * Brasília), até 31/12".
 */
export function ruleSentence(
  t: TFunction,
  locale: string,
  rule: RecurrenceRule,
  now = new Date(),
  /** Leave the zone out (the card says it only when it isn't mine). */
  withZone = true,
): string {
  const and = t("newAgent.and");
  const n = Math.max(1, rule.interval || 1);
  const days = (list: Weekday[]) =>
    joinNames(
      list.map((d) => t(`recurrence.wd.${d}.abbr`)),
      and,
    );
  let head: string;
  switch (rule.freq) {
    case "once":
      head = t("recurrence.s.once", { date: shortDate(locale, rule.start, now) });
      break;
    case "hourly":
      head = t("recurrence.s.hourly", { count: n });
      break;
    case "daily":
      head = isBusiness(rule.byWeekday)
        ? t("recurrence.s.businessDays")
        : rule.byWeekday?.length
          ? days(rule.byWeekday)
          : t("recurrence.s.daily", { count: n });
      break;
    case "weekly":
      head = `${t("recurrence.s.weekly", { count: n })}, ${days(rule.byWeekday?.length ? rule.byWeekday : [weekdayOfYmd(rule.start)])}`;
      break;
    case "monthly": {
      const every = t("recurrence.s.monthly", { count: n });
      if (rule.bySetPos && rule.byWeekday?.length) {
        head =
          isBusiness(rule.byWeekday) && rule.bySetPos === -1
            ? t("recurrence.s.lastBusiness", { every })
            : t("recurrence.s.nth", {
                every,
                nth: rule.bySetPos === -1 ? t("recurrence.last") : t("recurrence.nth", { n: rule.bySetPos }),
                weekday: t(`recurrence.wd.${rule.byWeekday[0] as Weekday}.long`),
              });
      } else {
        const d = rule.byMonthDay?.[0] ?? Number(rule.start.slice(8, 10));
        head = d === -1 ? t("recurrence.s.lastDay", { every }) : t("recurrence.s.monthDay", { every, day: d });
      }
      break;
    }
    case "yearly":
      head = t("recurrence.s.yearly", { count: n, date: dayMonth(locale, rule.start) });
      break;
  }
  const times = [...rule.times].sort();
  const parts = [head];
  if (rule.freq === "hourly") parts.push(t("recurrence.s.from", { time: times[0] ?? "00:00" }));
  else if (times.length) parts.push(t("recurrence.s.at", { times: joinNames(times, and) }));
  let out = withZone ? `${parts.join(", ")} (${timezoneName(rule.timezone, locale)})` : parts.join(", ");
  if (rule.until) out += `, ${t("recurrence.s.until", { date: shortDate(locale, rule.until, now) })}`;
  else if (rule.count) out += `, ${t("recurrence.s.count", { count: rule.count })}`;
  return out;
}

/** The next occurrences, formatted ("seg, 20 out · 09:00"), in the rule's zone. */
export function upcomingLabels(locale: string, rule: RecurrenceRule, from = new Date(), n = 3) {
  return nextOccurrences(rule, from, n).map((d) => {
    const date = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: rule.timezone,
    })
      .format(d)
      .replace(/\./g, "")
      .replace(/ de /g, " ");
    const time = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: rule.timezone,
    }).format(d);
    return `${date} · ${time}`;
  });
}

// ── Phrase ⇄ rule (Portuguese; the backend's parser takes the same phrases) ──

const PT_DAYS: Record<Weekday, string> = {
  MO: "segunda",
  TU: "terça",
  WE: "quarta",
  TH: "quinta",
  FR: "sexta",
  SA: "sábado",
  SU: "domingo",
};
const hourWord = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return m ? `${h}h${pad(m ?? 0)}` : `${h}h`;
};
const andList = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} e ${xs.at(-1)}`);

/** The picker's rule as a phrase ("a cada 2 semanas, segunda e quarta às 9h"). */
export function ruleToPhrase(rule: RecurrenceRule): string {
  const n = Math.max(1, rule.interval || 1);
  const at = `às ${andList([...rule.times].sort().map(hourWord))}`;
  const daysOf = (list: Weekday[]) => andList(list.map((d) => PT_DAYS[d]));
  let head: string;
  switch (rule.freq) {
    case "once": {
      const [y, m, d] = rule.start.split("-");
      head = `em ${d}/${m}/${y}`;
      break;
    }
    case "hourly":
      return `a cada ${n === 1 ? "hora" : `${n} horas`} a partir das ${hourWord(rule.times[0] ?? "00:00")}`;
    case "daily":
      head = isBusiness(rule.byWeekday)
        ? "dias úteis"
        : rule.byWeekday?.length
          ? `toda ${daysOf(rule.byWeekday)}`
          : n === 1
            ? "todos os dias"
            : `a cada ${n} dias`;
      break;
    case "weekly": {
      const days = daysOf(rule.byWeekday?.length ? rule.byWeekday : [weekdayOfYmd(rule.start)]);
      head = n === 1 ? `toda ${days}` : `a cada ${n} semanas, ${days}`;
      break;
    }
    case "monthly": {
      const every = n === 1 ? "de cada mês" : `a cada ${n} meses`;
      if (rule.bySetPos && rule.byWeekday?.length) {
        head =
          isBusiness(rule.byWeekday) && rule.bySetPos === -1
            ? `último dia útil ${every}`
            : `${rule.bySetPos === -1 ? "última" : `${rule.bySetPos}ª`} ${PT_DAYS[rule.byWeekday[0] as Weekday]} ${every}`;
      } else {
        const d = rule.byMonthDay?.[0] ?? Number(rule.start.slice(8, 10));
        head = d === -1 ? `último dia ${every}` : `dia ${d} ${every}`;
      }
      break;
    }
    case "yearly": {
      const [, m, d] = rule.start.split("-");
      head = n === 1 ? `todo ano em ${Number(d)}/${Number(m)}` : `a cada ${n} anos em ${Number(d)}/${Number(m)}`;
      break;
    }
  }
  let out = `${head} ${at}`;
  if (rule.until) {
    const [y, m, d] = rule.until.split("-");
    out += ` até ${d}/${m}/${y}`;
  } else if (rule.count) out += `, ${rule.count} vezes`;
  return out;
}

const DAY_WORDS: [RegExp, Weekday][] = [
  [/segunda/, "MO"],
  [/terça|terca/, "TU"],
  [/quarta/, "WE"],
  [/quinta/, "TH"],
  [/sexta/, "FR"],
  [/sábado|sabado/, "SA"],
  [/domingo/, "SU"],
];

/**
 * A phrase → rule, for the common Portuguese phrasings (until the backend's
 * phrase→rule parser answers). `null` when it doesn't understand.
 */
export function phraseToRule(phrase: string, base: RecurrenceRule): RecurrenceRule | null {
  const t = phrase.trim().toLowerCase();
  if (!t) return null;
  const keep = { timezone: base.timezone, start: base.start };
  const times = [...t.matchAll(/(\d{1,2})\s*(?:h|:)\s*(\d{2})?/g)]
    .map((m) => ({ h: Number(m[1]), m: m[2] ? Number(m[2]) : 0 }))
    .filter((x) => x.h <= 23 && x.m <= 59)
    .map((x) => `${pad(x.h)}:${pad(x.m)}`);
  const at = times.length ? [...new Set(times)] : base.times;
  const every = Number(t.match(/a cada (\d+)/)?.[1] ?? 1);
  const until = t.match(/até (\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
  const count = t.match(/(\d+)\s*vezes/);
  const period = {
    until: until ? `${until[3] ?? new Date().getFullYear()}-${pad(Number(until[2]))}-${pad(Number(until[1]))}` : null,
    count: count ? Number(count[1]) : null,
  };
  const days = DAY_WORDS.filter(([re]) => re.test(t)).map(([, d]) => d);
  if (/a cada (\d+ )?horas?/.test(t))
    return { freq: "hourly", interval: every, times: [at[0] ?? "09:00"], ...keep, ...period };
  if (/dias? úteis|dia útil/.test(t) && !/último dia útil/.test(t))
    return { freq: "daily", interval: 1, byWeekday: BUSINESS_DAYS, times: at, ...keep, ...period };
  if (/último dia útil/.test(t))
    return { freq: "monthly", interval: every, byWeekday: BUSINESS_DAYS, bySetPos: -1, times: at, ...keep, ...period };
  const nth = t.match(/(\d)ª|(última)/);
  if (nth && days.length === 1 && /m[eê]s|meses/.test(t))
    return {
      freq: "monthly",
      interval: every,
      byWeekday: days,
      bySetPos: nth[2] ? -1 : Number(nth[1]),
      times: at,
      ...keep,
      ...period,
    };
  const monthDay = t.match(/dia (\d{1,2})\b/);
  if (monthDay || /todo m[eê]s|meses/.test(t))
    return {
      freq: "monthly",
      interval: every,
      byMonthDay: [Number(monthDay?.[1] ?? base.start.slice(8, 10))],
      times: at,
      ...keep,
      ...period,
    };
  if (/todo ano|anos?\b/.test(t)) return { freq: "yearly", interval: every, times: at, ...keep, ...period };
  if (days.length) return { freq: "weekly", interval: every, byWeekday: days, times: at, ...keep, ...period };
  if (/semana/.test(t))
    return { freq: "weekly", interval: every, byWeekday: [weekdayOfYmd(base.start)], times: at, ...keep, ...period };
  if (/todo dia|todos os dias|diariamente|a cada \d+ dias/.test(t))
    return { freq: "daily", interval: every, times: at, ...keep, ...period };
  return null;
}

// ── The backend's rule ⇄ the picker's ───────────────────────────────────────

const POSITIONED = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/;

export function fromApiRule(r: ApiRule, fallbackStart: string): RecurrenceRule {
  let bySetPos = r.bySetPos ?? undefined;
  const byWeekday = (r.byWeekday ?? []).flatMap((w) => {
    const m = POSITIONED.exec(w);
    if (!m) return [];
    if (m[1]) bySetPos = Number(m[1]);
    return [m[2] as Weekday];
  });
  return {
    freq: r.freq,
    interval: Math.max(1, r.interval ?? 1),
    ...(byWeekday.length ? { byWeekday } : {}),
    ...(r.byMonthDay?.length && !(r.freq === "yearly") ? { byMonthDay: r.byMonthDay } : {}),
    ...(bySetPos ? { bySetPos } : {}),
    times: r.times?.length ? r.times : ["09:00"],
    timezone: r.timezone,
    start: r.start ?? fallbackStart,
    until: r.until ?? null,
    count: r.count ?? null,
  };
}

export function toApiRule(rule: RecurrenceRule): ApiRule {
  const base: ApiRule = {
    freq: rule.freq,
    interval: rule.interval,
    times: rule.times,
    timezone: rule.timezone,
    start: rule.start,
    until: rule.until ?? null,
    count: rule.count ?? null,
  };
  if (rule.freq === "monthly" && rule.bySetPos && rule.byWeekday?.length === 1)
    return { ...base, byWeekday: [`${rule.bySetPos}${rule.byWeekday[0]}`] };
  if (rule.freq === "yearly") {
    const [, m, d] = rule.start.split("-").map(Number);
    return { ...base, byMonth: [m ?? 1], byMonthDay: [d ?? 1] };
  }
  return {
    ...base,
    ...(rule.byWeekday?.length ? { byWeekday: rule.byWeekday } : {}),
    ...(rule.byMonthDay?.length ? { byMonthDay: rule.byMonthDay } : {}),
    ...(rule.bySetPos ? { bySetPos: rule.bySetPos } : {}),
  };
}
