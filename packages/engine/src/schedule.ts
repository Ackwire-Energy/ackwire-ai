import { isValidCron, nextCronTime, zonedParts, zonedTime } from "./cron";

export type ScheduleParse =
  | { ok: true; cron: string; description: string; timezone: string }
  | { ok: false; error: string };

const WEEKDAYS: [RegExp, number][] = [
  [/\bdomingos?\b|\bsundays?\b/, 0],
  [/\bsegundas?(-feira)?s?\b|\bmondays?\b/, 1],
  [/\bter[cç]as?(-feira)?s?\b|\btuesdays?\b/, 2],
  [/\bquartas?(-feira)?s?\b|\bwednesdays?\b/, 3],
  [/\bquintas?(-feira)?s?\b|\bthursdays?\b/, 4],
  [/\bsextas?(-feira)?s?\b|\bfridays?\b/, 5],
  [/\bs[aá]bados?\b|\bsaturdays?\b/, 6],
];
const WEEKDAY_NAMES = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

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

/** Natural language (pt-BR or English) → cron, by code. Null when it can't tell. */
export function phraseToCron(phrase: string): { cron: string; description: string } | null {
  const text = plain(phrase);
  if (isValidCron(text) && text.split(" ").length === 5) return { cron: text, description: `cron ${text}` };

  const every = /(?:a cada|every)\s+(\d+)?\s*(minutos?|min|minutes?|horas?|hours?)\b/.exec(text);
  if (every) {
    const n = Number(every[1] ?? 1);
    const unit = every[2] ?? "";
    if (/^min/.test(unit)) {
      if (n < 1 || n > 59) return null;
      return { cron: `*/${n} * * * *`, description: n === 1 ? "A cada minuto" : `A cada ${n} minutos` };
    }
    if (n < 1 || n > 23) return null;
    return {
      cron: n === 1 ? "0 * * * *" : `0 */${n} * * *`,
      description: n === 1 ? "A cada hora" : `A cada ${n} horas`,
    };
  }
  if (/\b(de hora em hora|toda hora|every hour|hourly)\b/.test(text))
    return { cron: "0 * * * *", description: "A cada hora" };

  const time = timeOf(text) ?? (/(manh[ãa]|morning)/.test(text) ? ([9, 0] as [number, number]) : null);
  const at = time ?? ([9, 0] as [number, number]);

  // Day of the month: "todo dia 1", "no dia 15 de cada mês", "every month on the 1st".
  const monthDay = /(?:todo|no|cada)\s+dia\s+(\d{1,2})\b|(?:on the|day)\s+(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  if (monthDay && /(m[eê]s|month|todo dia \d)/.test(text)) {
    const day = Number(monthDay[1] ?? monthDay[2]);
    if (day < 1 || day > 31) return null;
    return { cron: `${at[1]} ${at[0]} ${day} * *`, description: `Todo dia ${day} do mês às ${hhmm(at)}` };
  }

  if (/(dias [úu]teis|de segunda a sexta|weekdays|every weekday|monday to friday|seg(unda)? a sex(ta)?)/.test(text)) {
    return { cron: `${at[1]} ${at[0]} * * 1-5`, description: `Dias úteis às ${hhmm(at)}` };
  }
  if (/(fins? de semana|weekends?)/.test(text)) {
    return { cron: `${at[1]} ${at[0]} * * 0,6`, description: `Fins de semana às ${hhmm(at)}` };
  }

  const days = WEEKDAYS.filter(([re]) => re.test(text)).map(([, d]) => d);
  if (days.length > 0) {
    const names = days.map((d) => WEEKDAY_NAMES[d] ?? "").join(", ");
    return { cron: `${at[1]} ${at[0]} * * ${days.join(",")}`, description: `Toda ${names} às ${hhmm(at)}` };
  }

  if (/(todo dia|todos os dias|diariamente|every day|daily|cada dia)/.test(text) || time) {
    return { cron: `${at[1]} ${at[0]} * * *`, description: `Todo dia às ${hhmm(at)}` };
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
  if (!trimmed) return { ok: false, error: "Diga quando a rotina deve rodar." };
  let parsed = phraseToCron(trimmed);
  if (!parsed && options.llm) {
    const cron = (await options.llm(trimmed).catch(() => null))?.trim() ?? null;
    if (cron && isValidCron(cron)) parsed = { cron, description: trimmed };
  }
  if (!parsed) return { ok: false, error: 'Não entendi o horário. Tente "dias úteis às 9h" ou "toda segunda às 10h".' };
  if (!nextCronTime(parsed.cron, options.timezone, options.now ?? new Date())) {
    return { ok: false, error: "Esse horário nunca acontece." };
  }
  return { ok: true, cron: parsed.cron, description: parsed.description, timezone: options.timezone };
}

// ── One-off times ("amanhã às 9h") for reminders ─────────────────────────────

export type WhenParse = { ok: true; at: Date; timezone: string; description: string } | { ok: false; error: string };

const TZ_NAMES: Record<string, string> = {
  "America/Sao_Paulo": "horário de Brasília",
  "America/Manaus": "horário do Amazonas",
  "America/Fortaleza": "horário de Fortaleza",
  "America/Recife": "horário de Recife",
  "America/Belem": "horário de Belém",
  "America/Cuiaba": "horário de Cuiabá",
  "America/Rio_Branco": "horário do Acre",
  "America/Noronha": "horário de Fernando de Noronha",
};

/** "horário de Brasília", "UTC" or the IANA name. */
export const timezoneName = (tz: string) => (tz === "UTC" || tz === "Etc/UTC" ? "UTC" : (TZ_NAMES[tz] ?? tz));

const addDays = (y: number, mo: number, d: number, n: number) => {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
};
const weekdayOf = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();

/** "amanhã, 16/10, às 09:00 (horário de Brasília)". */
export function describeWhen(at: Date, timezone: string, now = new Date()) {
  const p = zonedParts(at, timezone);
  const today = zonedParts(now, timezone);
  const tomorrow = addDays(today.year, today.month, today.day, 1);
  const same = (a: { year: number; month: number; day: number }) =>
    a.year === p.year && a.month === p.month && a.day === p.day;
  const day = same(today)
    ? "hoje"
    : same(tomorrow)
      ? "amanhã"
      : (WEEKDAY_NAMES[weekdayOf(p.year, p.month, p.day)] ?? "");
  const date = `${String(p.day).padStart(2, "0")}/${String(p.month).padStart(2, "0")}${p.year !== today.year ? `/${p.year}` : ""}`;
  return `${day}, ${date}, às ${hhmm([p.hour, p.minute])} (${timezoneName(timezone)})`;
}

/**
 * A one-off time in natural language (pt-BR or English) or ISO 8601, read in
 * `timezone`: "amanhã às 9h", "hoje 15:30", "em 2 horas", "daqui a 30
 * minutos", "sexta às 10h", "16/10 às 9h", "2026-10-16T09:00". Needs a time
 * of day unless it's relative; the past is refused.
 */
export function parseWhen(input: string, timezone: string, now = new Date()): WhenParse {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Diga quando." };
  const done = (at: Date | null): WhenParse => {
    if (!at || Number.isNaN(at.getTime())) return { ok: false, error: "Esse horário não existe nesse fuso." };
    if (at.getTime() <= now.getTime()) return { ok: false, error: "Esse horário já passou." };
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
    return {
      ok: false,
      error: date
        ? "Falta o horário (por exemplo, às 9h)."
        : "Não entendi quando. Use algo como “amanhã às 9h”, “sexta às 15h” ou “em 2 horas”.",
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
