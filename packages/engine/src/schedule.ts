import { isValidCron, nextCronTime } from "./cron";

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
