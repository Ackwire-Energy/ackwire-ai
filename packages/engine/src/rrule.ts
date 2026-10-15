import { zonedParts, zonedTime } from "./cron";
import { ValidationError } from "./errors";

/**
 * Recurrence rules (RRULE-like, as JSON) for routines and calendar events.
 * Evaluated on local dates and wall-clock times in the rule's time zone, so
 * "toda segunda às 9h" stays at 9:00 across DST. Cron can't say "a cada 2
 * semanas" or "último dia útil do mês"; these rules can.
 */
export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export type Freq = "hourly" | "daily" | "weekly" | "monthly" | "yearly";

export interface ScheduleRule {
  freq: Freq;
  /** Every n periods (default 1). */
  interval?: number;
  /** Days of the week; in monthly/yearly rules they may carry a position: "2TU" (2nd Tuesday), "-1FR" (last Friday). */
  byWeekday?: string[];
  /** Days of the month, 1..31; negative from the end (-1 = last day). */
  byMonthDay?: number[];
  /** Months, 1..12 (yearly). */
  byMonth?: number[];
  /** Picks among the days a month rule matched: 1 = first, -1 = last ("último dia útil"). One or several. */
  bySetPos?: number | number[];
  /** Wall-clock time(s), "HH:MM" (hourly: only the minutes count). */
  time?: string;
  times?: string[];
  /** IANA time zone the dates and times are in. */
  timezone: string;
  /** First day ("YYYY-MM-DD"): intervals count from here. */
  start?: string;
  /** Last day, inclusive ("YYYY-MM-DD"). */
  until?: string | null;
  /** At most this many occurrences, counted from `start`. */
  count?: number | null;
}

const WEEKDAYS: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_NAMES = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const DAY_LONG = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const FREQS: Freq[] = ["hourly", "daily", "weekly", "monthly", "yearly"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_SPEC = /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/;

const dayNumber = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
const fromDayNumber = (n: number) => {
  const dt = new Date(n * 86_400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), weekday: dt.getUTCDay() };
};
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const parseDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  return dayNumber(y, m, d);
};
export const localDate = (instant: Date, timezone: string) => {
  const p = zonedParts(instant, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};
const toDateString = (n: number) => {
  const { y, m, d } = fromDayNumber(n);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

/** Checks a rule and fills the defaults (`interval`, `start` = today in its zone, `times`). */
export function normalizeRule(input: ScheduleRule, now = new Date()): ScheduleRule {
  const rule = { ...input };
  if (rule.until === null) delete rule.until;
  if (rule.count === null) delete rule.count;
  if (typeof rule.bySetPos === "number") rule.bySetPos = [rule.bySetPos];
  if (!FREQS.includes(rule.freq)) throw new ValidationError("Frequência desconhecida.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: rule.timezone });
  } catch {
    throw new ValidationError("Fuso horário desconhecido.");
  }
  const interval = rule.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) throw new ValidationError("Intervalo inválido.");
  rule.interval = interval;
  const times = rule.times ?? (rule.time ? [rule.time] : ["09:00"]);
  if (times.length === 0 || times.length > 24 || times.some((t) => !TIME.test(t))) {
    throw new ValidationError("Horário inválido (use HH:MM).");
  }
  rule.times = [...new Set(times)].sort();
  delete rule.time;
  for (const w of rule.byWeekday ?? []) {
    const m = DAY_SPEC.exec(w);
    if (!m) throw new ValidationError(`Dia da semana inválido: ${w}`);
    if (m[1] && rule.freq !== "monthly" && rule.freq !== "yearly") {
      throw new ValidationError("Posições como 2ª terça só valem por mês ou por ano.");
    }
  }
  for (const d of rule.byMonthDay ?? []) {
    if (!Number.isInteger(d) || d === 0 || d < -31 || d > 31) throw new ValidationError("Dia do mês inválido.");
  }
  for (const m of rule.byMonth ?? []) {
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new ValidationError("Mês inválido.");
  }
  for (const p of setPos(rule)) {
    if (!Number.isInteger(p) || p === 0 || p < -31 || p > 31) throw new ValidationError("Posição inválida.");
  }
  rule.start = rule.start ? rule.start.slice(0, 10) : localDate(now, rule.timezone);
  if (!DATE.test(rule.start)) throw new ValidationError("Data de início inválida.");
  if (rule.until !== undefined) {
    rule.until = rule.until.slice(0, 10);
    if (!DATE.test(rule.until)) throw new ValidationError("Data final inválida.");
    if (rule.until < rule.start) throw new ValidationError("A data final vem antes do início.");
  }
  if (rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 10_000)) {
    throw new ValidationError("Número de vezes inválido.");
  }
  for (const k of ["byWeekday", "byMonthDay", "byMonth", "bySetPos"] as const) {
    if (rule[k] && (rule[k] as unknown[]).length === 0) delete rule[k];
  }
  return rule;
}

const setPos = (rule: Pick<ScheduleRule, "bySetPos">) =>
  rule.bySetPos === undefined ? [] : typeof rule.bySetPos === "number" ? [rule.bySetPos] : rule.bySetPos;

/** Days of month (y, m) a monthly/yearly rule picks, sorted. */
function monthDays(rule: ScheduleRule, y: number, m: number, startDay: number) {
  const dim = daysIn(y, m);
  let days: number[];
  const all = Array.from({ length: dim }, (_, i) => i + 1);
  const byMonthDay = rule.byMonthDay?.map((v) => (v > 0 ? v : dim + 1 + v)).filter((v) => v >= 1 && v <= dim);
  let byWeekday: number[] | null = null;
  if (rule.byWeekday) {
    const set = new Set<number>();
    for (const spec of rule.byWeekday) {
      const [, pos, code] = DAY_SPEC.exec(spec) as unknown as [string, string | undefined, Weekday];
      const wd = WEEKDAYS.indexOf(code);
      const matching = all.filter((d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay() === wd);
      if (!pos) for (const d of matching) set.add(d);
      else {
        const n = Number(pos);
        const pick = n > 0 ? matching[n - 1] : matching[matching.length + n];
        if (pick) set.add(pick);
      }
    }
    byWeekday = [...set];
  }
  if (byMonthDay && byWeekday) days = byMonthDay.filter((d) => (byWeekday as number[]).includes(d));
  else if (byMonthDay) days = byMonthDay;
  else if (byWeekday) days = byWeekday;
  else days = startDay <= dim ? [startDay] : [];
  days = [...new Set(days)].sort((a, b) => a - b);
  if (rule.bySetPos !== undefined) {
    const picked = setPos(rule)
      .map((p) => (p > 0 ? days[p - 1] : days[days.length + p]))
      .filter((d) => d !== undefined);
    days = [...new Set(picked as number[])].sort((a, b) => a - b);
  }
  return days;
}

function cachedMonth(cache: Map<string, number[]>, rule: ScheduleRule, y: number, m: number, startDay: number) {
  const key = `${y}-${m}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const days = monthDays(rule, y, m, startDay);
  cache.set(key, days);
  return days;
}

/** Whether a local day is one of the rule's days. */
function matchesDay(rule: ScheduleRule, n: number, startN: number, cache: Map<string, number[]>) {
  if (n < startN) return false;
  if (rule.until && n > parseDate(rule.until)) return false;
  const { y, m, d, weekday } = fromDayNumber(n);
  const start = fromDayNumber(startN);
  const interval = rule.interval ?? 1;
  const plainDays = rule.byWeekday?.map((w) => WEEKDAYS.indexOf(w.slice(-2) as Weekday));
  switch (rule.freq) {
    case "hourly":
    case "daily":
      if (rule.freq === "daily" && (n - startN) % interval !== 0) return false;
      if (plainDays && !plainDays.includes(weekday)) return false;
      if (rule.byMonthDay) {
        const dim = daysIn(y, m);
        if (!rule.byMonthDay.some((v) => (v > 0 ? v : dim + 1 + v) === d)) return false;
      }
      return true;
    case "weekly": {
      const monday = (x: number) => x - ((fromDayNumber(x).weekday + 6) % 7);
      if (((monday(n) - monday(startN)) / 7) % interval !== 0) return false;
      return (plainDays ?? [start.weekday]).includes(weekday);
    }
    case "monthly": {
      if ((y * 12 + m - (start.y * 12 + start.m)) % interval !== 0) return false;
      return cachedMonth(cache, rule, y, m, start.d).includes(d);
    }
    case "yearly": {
      if ((y - start.y) % interval !== 0) return false;
      if (!(rule.byMonth ?? [start.m]).includes(m)) return false;
      return cachedMonth(cache, rule, y, m, start.d).includes(d);
    }
  }
}

/** The instants of one matching day, in order. */
function dayInstants(rule: ScheduleRule, n: number, startN: number): Date[] {
  const { y, m, d } = fromDayNumber(n);
  const times = (rule.times ?? ["09:00"]).map((t) => t.split(":").map(Number) as [number, number]);
  const out: Date[] = [];
  if (rule.freq === "hourly") {
    const [h0, minute] = times[0] as [number, number];
    const interval = rule.interval ?? 1;
    for (let h = 0; h < 24; h++) {
      const index = (n - startN) * 24 + h - h0;
      if (index < 0 || index % interval !== 0) continue;
      const at = zonedTime(y, m, d, h, minute, rule.timezone);
      if (at) out.push(at);
    }
    return out;
  }
  for (const [h, mi] of times) {
    // A time skipped by DST runs at the first valid minute after it (the same day).
    let at = zonedTime(y, m, d, h, mi, rule.timezone);
    for (let shift = 1; !at && shift <= 120; shift++) {
      const total = h * 60 + mi + shift;
      if (total >= 24 * 60) break;
      at = zonedTime(y, m, d, Math.floor(total / 60), total % 60, rule.timezone);
    }
    if (at) out.push(at);
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

const MAX_DAYS = 366 * 12;

/**
 * Occurrences in [from, to), at most `limit`. With `count`, occurrences are
 * counted from `start` (so the series ends at the same place whatever the window).
 */
export function ruleOccurrences(rule: ScheduleRule, from: Date, to: Date, limit = 500): Date[] {
  const startN = parseDate(rule.start ?? localDate(from, rule.timezone));
  const firstN = rule.count ? startN : Math.max(startN, parseDate(localDate(from, rule.timezone)) - 1);
  const lastN = Math.min(
    parseDate(localDate(to, rule.timezone)) + 1,
    rule.until ? parseDate(rule.until) : Number.POSITIVE_INFINITY,
    firstN + MAX_DAYS,
  );
  const cache = new Map<string, number[]>();
  const out: Date[] = [];
  let seen = 0;
  for (let n = firstN; n <= lastN; n++) {
    if (!matchesDay(rule, n, startN, cache)) continue;
    for (const at of dayInstants(rule, n, startN)) {
      seen++;
      if (rule.count && seen > rule.count) return out;
      if (at.getTime() >= to.getTime()) return out;
      if (at.getTime() >= from.getTime()) {
        out.push(at);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/** The first occurrence strictly after `after`, or null when the series ended. */
export function nextOccurrence(rule: ScheduleRule, after: Date): Date | null {
  const startN = parseDate(rule.start ?? localDate(after, rule.timezone));
  const firstN = rule.count ? startN : Math.max(startN, parseDate(localDate(after, rule.timezone)) - 1);
  const lastN = Math.min(rule.until ? parseDate(rule.until) : Number.POSITIVE_INFINITY, firstN + MAX_DAYS);
  const cache = new Map<string, number[]>();
  let seen = 0;
  for (let n = firstN; n <= lastN; n++) {
    if (!matchesDay(rule, n, startN, cache)) continue;
    for (const at of dayInstants(rule, n, startN)) {
      seen++;
      if (rule.count && seen > rule.count) return null;
      if (at.getTime() > after.getTime()) return at;
    }
  }
  return null;
}

/** The same rule ending the day before `date` (for "este e os próximos"); null when nothing would be left. */
export function endRuleBefore(rule: ScheduleRule, date: string): ScheduleRule | null {
  const until = toDateString(parseDate(date) - 1);
  if (rule.start && until < rule.start) return null;
  const { count: _c, ...rest } = rule;
  return { ...rest, until: rule.until && rule.until < until ? rule.until : until };
}

const ZONES: Record<string, string> = {
  "America/Sao_Paulo": "horário de Brasília",
  "America/Fortaleza": "horário de Brasília",
  "America/Recife": "horário de Brasília",
  "America/Bahia": "horário de Brasília",
  UTC: "UTC",
};
const ORDINAL = (n: number) => (n === -1 ? "último" : n === -2 ? "penúltimo" : `${n}º`);
const ORDINAL_F = (n: number) => (n === -1 ? "última" : n === -2 ? "penúltima" : `${n}ª`);
const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`;
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const WORKDAYS = ["MO", "TU", "WE", "TH", "FR"];

/** "A cada 2 semanas, seg e qua, às 09:00 (horário de Brasília), até 31/12" */
export function describeRule(rule: ScheduleRule): string {
  const n = rule.interval ?? 1;
  const plain = (rule.byWeekday ?? []).every((w) => w.length === 2);
  const weekdays = (rule.byWeekday ?? []).filter((w) => w.length === 2);
  const isWorkdays = plain && weekdays.length === 5 && WORKDAYS.every((w) => weekdays.includes(w));
  const dayList = () => list(weekdays.map((w) => DAY_NAMES[WEEKDAYS.indexOf(w as Weekday)] as string));
  const parts: string[] = [];
  const monthPart = () => {
    if (rule.byWeekday && !plain) {
      return rule.byWeekday
        .map((w) => {
          const [, pos, code] = DAY_SPEC.exec(w) as unknown as [string, string, Weekday];
          return `na ${ORDINAL_F(Number(pos))} ${DAY_LONG[WEEKDAYS.indexOf(code)]}`;
        })
        .join(" e ");
    }
    if (isWorkdays && rule.bySetPos !== undefined) {
      return setPos(rule)
        .map((p) => `no ${ORDINAL(p)} dia útil`)
        .join(" e ");
    }
    if (weekdays.length && rule.bySetPos !== undefined) {
      const names = list(weekdays.map((w) => DAY_LONG[WEEKDAYS.indexOf(w as Weekday)] as string));
      return setPos(rule)
        .map((p) => `na ${ORDINAL_F(p)} ${names}`)
        .join(" e ");
    }
    if (rule.byMonthDay) {
      const days = rule.byMonthDay.map((d) => (d === -1 ? "último dia" : d < 0 ? `${ORDINAL(d)} dia` : `dia ${d}`));
      return `no ${list(days)}`;
    }
    return rule.start ? `no dia ${Number(rule.start.slice(8, 10))}` : "";
  };
  switch (rule.freq) {
    case "hourly":
      parts.push(n === 1 ? "A cada hora" : `A cada ${n} horas`);
      if (weekdays.length) parts.push(isWorkdays ? "em dias úteis" : dayList());
      break;
    case "daily":
      if (isWorkdays && n === 1) parts.push("Dias úteis");
      else {
        parts.push(n === 1 ? "Todo dia" : `A cada ${n} dias`);
        if (weekdays.length) parts.push(dayList());
      }
      break;
    case "weekly":
      parts.push(n === 1 ? "Toda semana" : `A cada ${n} semanas`);
      if (isWorkdays) parts.push("em dias úteis");
      else if (weekdays.length) parts.push(dayList());
      else if (rule.start) parts.push(DAY_NAMES[fromDayNumber(parseDate(rule.start)).weekday] as string);
      break;
    case "monthly":
      parts.push(n === 1 ? "Todo mês" : `A cada ${n} meses`);
      parts.push(monthPart());
      break;
    case "yearly": {
      parts.push(n === 1 ? "Todo ano" : `A cada ${n} anos`);
      const months = rule.byMonth ?? (rule.start ? [Number(rule.start.slice(5, 7))] : []);
      const where = monthPart();
      parts.push(`${where}${months.length ? ` de ${list(months.map((m) => MONTHS[m - 1] as string))}` : ""}`);
      break;
    }
  }
  const times = rule.times ?? (rule.time ? [rule.time] : []);
  if (rule.freq === "hourly") {
    const minute = times[0]?.slice(3) ?? "00";
    if (minute !== "00") parts.push(`aos ${minute} minutos`);
  } else if (times.length) parts.push(`às ${list(times)}`);
  let text = parts.filter(Boolean).join(", ");
  text += ` (${ZONES[rule.timezone] ?? rule.timezone})`;
  if (rule.until) {
    const [y, m, d] = rule.until.split("-");
    const thisYear = String(new Date().getUTCFullYear());
    text += `, até ${d}/${m}${y === thisYear ? "" : `/${y}`}`;
  }
  if (rule.count) text += `, ${rule.count} ${rule.count === 1 ? "vez" : "vezes"}`;
  return text;
}

/** [1,2,3,4,5,0] → "0,1-5" (runs of 3 or more as ranges, like people write cron). */
function cronList(values: number[]) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j++;
    parts.push(j - i >= 2 ? `${sorted[i]}-${sorted[j]}` : sorted.slice(i, j + 1).join(","));
    i = j + 1;
  }
  return parts.join(",");
}

/** The cron of a rule when cron can say it (interval 1, plain days, no positions or limits); else null. */
export function ruleToCron(rule: ScheduleRule): string | null {
  const n = rule.interval ?? 1;
  const times = (rule.times ?? []).map((t) => t.split(":").map(Number) as [number, number]);
  if (rule.until || rule.count || rule.bySetPos !== undefined) return null;
  if ((rule.byWeekday ?? []).some((w) => w.length !== 2)) return null;
  if ((rule.byMonthDay ?? []).some((d) => d < 0)) return null;
  const dows = rule.byWeekday ? cronList(rule.byWeekday.map((w) => WEEKDAYS.indexOf(w as Weekday))) : "*";
  if (rule.freq === "hourly") {
    if (24 % n !== 0) return null;
    const minute = times[0]?.[1] ?? 0;
    return `${minute} ${n === 1 ? "*" : `*/${n}`} * * ${dows}`;
  }
  if (n !== 1 || times.length === 0) return null;
  const minutes = new Set(times.map((t) => t[1]));
  if (minutes.size !== 1) return null;
  const minute = [...minutes][0];
  const hours = times.map((t) => t[0]).join(",");
  const start = rule.start ? { m: Number(rule.start.slice(5, 7)), d: Number(rule.start.slice(8, 10)) } : null;
  switch (rule.freq) {
    case "daily":
      return `${minute} ${hours} ${rule.byMonthDay ? rule.byMonthDay.join(",") : "*"} * ${dows}`;
    case "weekly":
      return `${minute} ${hours} * * ${rule.byWeekday ? dows : start ? String(fromDayNumber(parseDate(rule.start as string)).weekday) : "*"}`;
    case "monthly":
      if (rule.byWeekday) return null;
      return `${minute} ${hours} ${(rule.byMonthDay ?? (start ? [start.d] : [1])).join(",")} * *`;
    case "yearly":
      if (rule.byWeekday) return null;
      return `${minute} ${hours} ${(rule.byMonthDay ?? (start ? [start.d] : [1])).join(",")} ${(rule.byMonth ?? (start ? [start.m] : [1])).join(",")} *`;
  }
}

/** A simple cron (minute hour day month weekday, numbers/lists/steps) as a rule; null when it doesn't map. */
export function cronToRule(cron: string, timezone: string): ScheduleRule | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, mon, dow] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(mi)) return null;
  const minute = Number(mi);
  const pad = (x: number) => String(x).padStart(2, "0");
  const days = (s: string) => {
    if (s === "*") return null;
    const out: number[] = [];
    for (const part of s.split(",")) {
      const range = /^(\d)-(\d)$/.exec(part);
      if (range) for (let x = Number(range[1]); x <= Number(range[2]); x++) out.push(x % 7);
      else if (/^\d$/.test(part)) out.push(Number(part) % 7);
      else return undefined;
    }
    return out;
  };
  const weekdays = days(dow);
  if (weekdays === undefined) return null;
  const byWeekday = weekdays ? [...new Set(weekdays)].sort().map((d) => WEEKDAYS[d] as string) : undefined;
  const step = /^\*\/(\d+)$/.exec(h);
  if (h === "*" || step) {
    if (dom !== "*" || mon !== "*") return null;
    return { freq: "hourly", interval: step ? Number(step[1]) : 1, times: [`00:${pad(minute)}`], timezone, byWeekday };
  }
  if (!/^\d+(,\d+)*$/.test(h)) return null;
  const times = h.split(",").map((x) => `${pad(Number(x))}:${pad(minute)}`);
  if (mon !== "*") {
    if (!/^\d+(,\d+)*$/.test(mon) || !/^\d+(,\d+)*$/.test(dom)) return null;
    return {
      freq: "yearly",
      byMonth: mon.split(",").map(Number),
      byMonthDay: dom.split(",").map(Number),
      times,
      timezone,
    };
  }
  if (dom !== "*") {
    if (!/^\d+(,\d+)*$/.test(dom) || byWeekday) return null;
    return { freq: "monthly", byMonthDay: dom.split(",").map(Number), times, timezone };
  }
  if (byWeekday) return { freq: "weekly", byWeekday, times, timezone };
  return { freq: "daily", times, timezone };
}
