import { isValidCron, nextCronTime, zonedParts, zonedTime } from "./cron";
import { cronToRule, type ScheduleRule, timezoneName } from "./rrule";

export type ScheduleParse =
  | { ok: true; cron: string; description: string; timezone: string }
  /** `code` is stable (the app translates it); `error` is the English fallback. */
  | { ok: false; error: string; code: string };

const WEEKDAYS: [RegExp, number][] = [
  [/\bdomingos?\b|\bsundays?\b/, 0],
  [/\bsegundas?(-feira)?s?\b|\bmondays?\b/, 1],
  [/\bter[cç]as?(-feira)?s?\b|\btuesdays?\b/, 2],
  [/\bquartas?(-feira)?s?\b|\bwednesdays?\b/, 3],
  [/\bquintas?(-feira)?s?\b|\bthursdays?\b/, 4],
  [/\bsextas?(-feira)?s?\b|\bfridays?\b/, 5],
  [/\bs[aá]bados?\b|\bsaturdays?\b/, 6],
];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const andList = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const plain = (s: string) => s.toLowerCase().normalize("NFC").replace(/\s+/g, " ").trim();

/** "às 9h", "9:30", "18h15", "9am", "at 5 pm", "meio-dia" → [hour, minute]. */
function timeOf(text: string): [number, number] | null {
  if (/meio[- ]dia|\bnoon\b/.test(text)) return [12, 0];
  if (/meia[- ]noite|\bmidnight\b/.test(text)) return [0, 0];
  const t = text.replace(/(a cada|every)\s+\d+\s*(minutos?|min|minutes?|horas?|hours?)/g, "");
  const suffix = "(h|hs|horas?|am|pm|a\\.m\\.|p\\.m\\.)";
  const m =
    new RegExp(`(?:às|as|at|@)\\s*(\\d{1,2})(?:[:h](\\d{2}))?\\s*${suffix}?`).exec(t) ??
    new RegExp(`(\\d{1,2})(?::|h)(\\d{2})\\s*${suffix}?`).exec(t) ??
    new RegExp(`(\\d{1,2})()\\s*${suffix}(?![a-z])`).exec(t);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3] ?? "";
  if (/^p/.test(ampm) && hour < 12) hour += 12;
  if (/^a/.test(ampm) && hour === 12) hour = 0;
  if (/(da|de) noite|à noite|da tarde/.test(t) && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return [hour, minute];
}

const hhmm = ([h, m]: [number, number]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** Natural language (pt-BR or English) → cron, by code, with an English description. Null when it can't tell. */
export function phraseToCron(phrase: string): { cron: string; description: string } | null {
  const text = plain(phrase);
  if (isValidCron(text) && text.split(" ").length === 5) return { cron: text, description: `cron ${text}` };

  const every = /(?:a cada|every)\s+(\d+)?\s*(minutos?|min|minutes?|horas?|hours?)\b/.exec(text);
  if (every) {
    const n = Number(every[1] ?? 1);
    const unit = every[2] ?? "";
    if (/^min/.test(unit)) {
      if (n < 1 || n > 59) return null;
      return { cron: `*/${n} * * * *`, description: n === 1 ? "Every minute" : `Every ${n} minutes` };
    }
    if (n < 1 || n > 23) return null;
    return {
      cron: n === 1 ? "0 * * * *" : `0 */${n} * * *`,
      description: n === 1 ? "Every hour" : `Every ${n} hours`,
    };
  }
  if (/\b(de hora em hora|toda hora|every hour|hourly)\b/.test(text))
    return { cron: "0 * * * *", description: "Every hour" };

  const time = timeOf(text) ?? (/(manh[ãa]|morning)/.test(text) ? ([9, 0] as [number, number]) : null);
  const at = time ?? ([9, 0] as [number, number]);

  // Day of the month: "todo dia 1", "no dia 15 de cada mês", "every month on the 1st".
  const monthDay = /(?:todo|no|cada)\s+dia\s+(\d{1,2})\b|(?:on the|day)\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (monthDay && /(m[eê]s|month|todo dia \d)/.test(text)) {
    const day = Number(monthDay[1] ?? monthDay[2]);
    if (day < 1 || day > 31) return null;
    return { cron: `${at[1]} ${at[0]} ${day} * *`, description: `Every month on day ${day} at ${hhmm(at)}` };
  }

  if (/(dias [úu]teis|de segunda a sexta|weekdays|every weekday|monday to friday|seg(unda)? a sex(ta)?)/.test(text)) {
    return { cron: `${at[1]} ${at[0]} * * 1-5`, description: `Weekdays at ${hhmm(at)}` };
  }
  if (/(fins? de semana|weekends?)/.test(text)) {
    return { cron: `${at[1]} ${at[0]} * * 0,6`, description: `Weekends at ${hhmm(at)}` };
  }

  const days = WEEKDAYS.filter(([re]) => re.test(text)).map(([, d]) => d);
  if (days.length > 0) {
    const names = andList(days.map((d) => WEEKDAY_NAMES[d] ?? ""));
    return { cron: `${at[1]} ${at[0]} * * ${days.join(",")}`, description: `Every ${names} at ${hhmm(at)}` };
  }

  if (/(todo dia|todos os dias|diariamente|every day|daily|cada dia)/.test(text) || time) {
    return { cron: `${at[1]} ${at[0]} * * *`, description: `Every day at ${hhmm(at)}` };
  }
  return null;
}

/**
 * Parses a schedule phrase in the workspace time zone: by code first, then
 * (optional) a cheap model that answers with a cron expression.
 */
export async function parseSchedule(
  phrase: string,
  options: { timezone: string; llm?: (phrase: string) => Promise<string | null>; now?: Date },
): Promise<ScheduleParse> {
  const trimmed = phrase.trim();
  if (!trimmed) return { ok: false, error: "Say when the routine should run", code: "routine.schedule_required" };
  let parsed = phraseToCron(trimmed);
  if (!parsed && options.llm) {
    const cron = (await options.llm(trimmed).catch(() => null))?.trim() ?? null;
    if (cron && isValidCron(cron)) parsed = { cron, description: trimmed };
  }
  if (!parsed) {
    return { ok: false, error: 'Couldn\'t read the schedule. Try "weekdays at 9am".', code: "schedule.unreadable" };
  }
  if (!nextCronTime(parsed.cron, options.timezone, options.now ?? new Date())) {
    return { ok: false, error: "This schedule never happens", code: "schedule.never" };
  }
  return { ok: true, cron: parsed.cron, description: parsed.description, timezone: options.timezone };
}

// ── One-off times ("amanhã às 9h") for reminders ─────────────────────────────

/** `code` is stable (the app or the model can say it in the person's language); `error` is English. */
export type WhenParse =
  | { ok: true; at: Date; timezone: string; description: string }
  | { ok: false; error: string; code: string };

const addDays = (y: number, mo: number, d: number, n: number) => {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
};
const weekdayOf = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

/** "tomorrow, Oct 16, at 09:00 (Brasília time)"; other days by weekday ("Monday, Oct 19, …"). */
export function describeWhen(at: Date, timezone: string, now = new Date()) {
  const p = zonedParts(at, timezone);
  const today = zonedParts(now, timezone);
  const tomorrow = addDays(today.year, today.month, today.day, 1);
  const same = (a: { year: number; month: number; day: number }) =>
    a.year === p.year && a.month === p.month && a.day === p.day;
  const day = same(today)
    ? "today"
    : same(tomorrow)
      ? "tomorrow"
      : (WEEKDAY_NAMES[weekdayOf(p.year, p.month, p.day)] ?? "");
  const date = `${MONTH_NAMES[p.month - 1]} ${p.day}${p.year !== today.year ? `, ${p.year}` : ""}`;
  return `${day}, ${date}, at ${hhmm([p.hour, p.minute])} (${timezoneName(timezone)})`;
}

/**
 * A one-off time in natural language (pt-BR or English) or ISO 8601, read in
 * `timezone`: "amanhã às 9h", "hoje 15:30", "em 2 horas", "daqui a 30
 * minutos", "sexta às 10h", "16/10 às 9h", "2026-10-16T09:00". Needs a time
 * of day unless it's relative; the past is refused.
 */
export function parseWhen(input: string, timezone: string, now = new Date()): WhenParse {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Say when.", code: "when.required" };
  const done = (at: Date | null): WhenParse => {
    if (!at || Number.isNaN(at.getTime())) {
      return { ok: false, error: "That time doesn't exist in this time zone.", code: "when.nonexistent" };
    }
    if (at.getTime() <= now.getTime()) return { ok: false, error: "That time has already passed.", code: "when.past" };
    return { ok: true, at, timezone, description: describeWhen(at, timezone, now) };
  };
  // ISO with an offset or Z: exact. Without: local wall time in the zone.
  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw);
  if (iso) {
    if (iso[6]) return done(new Date(raw));
    return done(zonedTime(Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4]), Number(iso[5]), timezone));
  }
  const text = plain(raw);
  const rel =
    /(?:em|daqui a|daqui|in)\s+(\d+|um|uma|meia)\s*(minutos?|min|horas?|h|dias?|minutes?|hours?|days?)\b/.exec(text);
  if (rel) {
    const n = rel[1] === "um" || rel[1] === "uma" ? 1 : rel[1] === "meia" ? 0.5 : Number(rel[1]);
    const unit = rel[2] ?? "";
    const ms = /^(min)/.test(unit) ? 60_000 : /^(h)/.test(unit) ? 3_600_000 : 86_400_000;
    return done(new Date(Math.round((now.getTime() + n * ms) / 60_000) * 60_000));
  }
  const time = timeOf(text);
  const today = zonedParts(now, timezone);
  let date: { year: number; month: number; day: number } | null = null;
  const dm = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text);
  if (dm) {
    const year = dm[3] ? Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : today.year;
    date = { year, month: Number(dm[2]), day: Number(dm[1]) };
    if (!dm[3] && (date.month < today.month || (date.month === today.month && date.day < today.day))) date.year++;
  } else if (/depois de amanh[aã]|day after tomorrow/.test(text)) date = addDays(today.year, today.month, today.day, 2);
  else if (/amanh[aã]|tomorrow/.test(text)) date = addDays(today.year, today.month, today.day, 1);
  else if (/\bhoje\b|\btoday\b|\btonight\b|hoje à noite/.test(text)) date = { ...today };
  else {
    const wd = WEEKDAYS.find(([re]) => re.test(text));
    if (wd) {
      const current = weekdayOf(today.year, today.month, today.day);
      let ahead = (wd[1] - current + 7) % 7;
      if (ahead === 0) ahead = 7;
      date = addDays(today.year, today.month, today.day, ahead);
    }
  }
  if (!time) {
    return date
      ? { ok: false, error: 'The time of day is missing (for example, "at 9am").', code: "when.time_missing" }
      : {
          ok: false,
          error: 'Couldn\'t tell when. Try something like "tomorrow at 9am", "Friday at 3pm" or "in 2 hours".',
          code: "when.unreadable",
        };
  }
  if (!date) {
    // Only a time: today if it's still ahead, else tomorrow.
    date = { ...today };
    const at = zonedTime(date.year, date.month, date.day, time[0], time[1], timezone);
    if (!at || at.getTime() <= now.getTime()) date = addDays(today.year, today.month, today.day, 1);
  }
  return done(zonedTime(date.year, date.month, date.day, time[0], time[1], timezone));
}

// ── Phrase → structured rule (the period picker) ─────────────────────────────

const RULE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
// Word edges by hand: `\b` is ASCII-only in JS, so it never matches before "último".
const W = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const ordinal = (body: string, extra = "") => new RegExp(`${W}(${body})${E}${extra}`, "u");
const ORDINALS: [RegExp, number][] = [
  [ordinal("primeir[ao]|1[ºªa°o]?|first"), 1],
  [ordinal("segund[ao]|2[ºªa°o]?|second", "(?!-feira)"), 2],
  [ordinal("terceir[ao]|3[ºªa°o]?|third"), 3],
  [ordinal("quart[ao]|4[ºªa°o]?|fourth", "(?!-feira)"), 4],
  [ordinal("[úu]ltim[ao]|last"), -1],
];

/**
 * A schedule phrase as a structured rule, for the picker (and the way back:
 * `describeRule`). Understands what cron can't: "a cada 2 semanas na
 * segunda e quarta às 9h", "último dia útil do mês às 18h", "2ª terça do
 * mês", "até 31/12", "10 vezes". Falls back to the cron reading of the phrase.
 */
export function phraseToRule(phrase: string, timezone: string, now = new Date()): ScheduleRule | null {
  const text = plain(phrase);
  const time = timeOf(text);
  const times = time ? [hhmm(time)] : undefined;
  const today = zonedParts(now, timezone);
  const extras: Partial<ScheduleRule> = {};
  const until = /\b(?:até|ate|until)\s+(?:o dia\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(text);
  if (until) {
    let year = until[3] ? Number(until[3].length === 2 ? `20${until[3]}` : until[3]) : today.year;
    const month = Number(until[2]);
    const day = Number(until[1]);
    if (!until[3] && (month < today.month || (month === today.month && day < today.day))) year++;
    extras.until = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const count = /\b(\d+)\s*(?:vezes|times)\b/.exec(text);
  if (count) extras.count = Number(count[1]);
  const days = WEEKDAYS.filter(([re]) => re.test(text)).map(([, d]) => RULE_DAYS[d] as string);
  const workdays = /(dias? [úu]teis|de segunda a sexta|weekdays?|business days?)/.test(text);
  const interval =
    /(?:a cada|every)\s+(\d+)\s*(dias?|semanas?|meses|m[eê]s|anos?|horas?|days?|weeks?|months?|years?|hours?)\b/.exec(
      text,
    );
  const base = { timezone, ...(times ? { times } : {}), ...extras };
  const n = interval ? Number(interval[1]) : 1;
  const unit = interval?.[2] ?? "";

  // "último dia útil do mês", "primeiro dia útil".
  if (/dia [úu]til/.test(text) && /(m[eê]s|month)/.test(text)) {
    const pos = ORDINALS.find(([re]) => re.test(text))?.[1] ?? 1;
    return {
      freq: "monthly",
      interval: /mes|m[eê]s|month/.test(unit) ? n : 1,
      byWeekday: ["MO", "TU", "WE", "TH", "FR"],
      bySetPos: [pos],
      ...base,
    };
  }
  // "último dia do mês".
  if (/[úu]ltimo dia (do|de cada) m[eê]s|last day of (the )?month/.test(text)) {
    return { freq: "monthly", byMonthDay: [-1], ...base };
  }
  // "2ª terça do mês", "última sexta de cada mês".
  if (days.length > 0 && /(do|de cada|of the|of every) m[eê]s|month/.test(text)) {
    const pos = ORDINALS.find(([re]) => re.test(text))?.[1];
    if (pos) return { freq: "monthly", byWeekday: days.map((d) => `${pos}${d}`), ...base };
  }
  // "dia 15 de cada mês", "todo dia 1".
  const monthDay = /(?:todo|no|cada)\s+dia\s+(\d{1,2})\b|(?:on the|day)\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (monthDay && /(m[eê]s|month|todo dia \d)/.test(text)) {
    return {
      freq: "monthly",
      interval: /mes|m[eê]s|month/.test(unit) ? n : 1,
      byMonthDay: [Number(monthDay[1] ?? monthDay[2])],
      ...base,
    };
  }
  if (/^(semana|week)/.test(unit) || (days.length > 0 && interval)) {
    return { freq: "weekly", interval: n, ...(days.length ? { byWeekday: days } : {}), ...base };
  }
  if (/^(dia|day)/.test(unit)) return { freq: "daily", interval: n, ...base };
  if (/^(m[eê]s|meses|month)/.test(unit)) return { freq: "monthly", interval: n, ...base };
  if (/^(ano|year)/.test(unit)) return { freq: "yearly", interval: n, ...base };
  if (/^(hora|hour)/.test(unit))
    return { freq: "hourly", interval: n, times: [`00:${time ? hhmm(time).slice(3) : "00"}`], ...extras, timezone };
  if (workdays) return { freq: "weekly", byWeekday: ["MO", "TU", "WE", "TH", "FR"], ...base };
  if (days.length > 0) return { freq: "weekly", byWeekday: days, ...base };
  // Everything else: the cron reading, as a rule.
  const cron = phraseToCron(phrase);
  const fromCron = cron ? cronToRule(cron.cron, timezone) : null;
  return fromCron ? { ...fromCron, ...extras } : null;
}
