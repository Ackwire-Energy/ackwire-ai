import type { TFunction } from "i18next";

/**
 * Machine numbers, precise and spelled out (design README: "sonnet 5.5 ·
 * 1.240 tokens · US$ 0,004"). Locale-aware; pt-BR uses "," for decimals.
 */

/**
 * US$ with 2 decimals, or more for tiny amounts (US$ 0,004, a few Jev decisions' US$ 0,0003); a spend too small for
 * 4 decimals reads "<US$ 0,0001", like formatPercent's "<1%", never as zero.
 */
export function formatUsd(t: TFunction, locale: string, value: number) {
  const abs = Math.abs(value);
  const digits = abs === 0 ? 2 : abs < 0.001 ? 4 : abs < 0.01 ? 3 : 2;
  const fmt = (v: number) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  if (value > 0 && value < 0.00005) return `<${t("format.usd", { value: fmt(0.0001) })}`;
  return t("format.usd", { value: fmt(value) });
}

/** Budget use: "37,5%", "12%", "<1%" (members never see money, only this). */
export function formatPercent(locale: string, value: number) {
  const fmt = (v: number, digits: number) =>
    new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: digits }).format(v / 100);
  if (value > 0 && value < 1) return `<${fmt(1, 0)}`;
  return fmt(value, value < 10 ? 1 : 0);
}

/** "1.240" */
export const formatInt = (locale: string, value: number) => new Intl.NumberFormat(locale).format(Math.round(value));

/** "0,042" / "0.0001": a price of a fraction of a cent, in the locale's decimal sign. */
export const formatDecimal = (locale: string, value: number) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);

/** "3,1 mi" / "12 mil" / "940" */
export function formatTokensShort(t: TFunction, locale: string, value: number) {
  const fmt = (v: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v);
  if (value >= 1_000_000) return t("format.tokensMillions", { value: fmt(value / 1_000_000) });
  if (value >= 10_000) return t("format.tokensThousands", { value: fmt(value / 1_000) });
  return formatInt(locale, value);
}

/** "10:42" */
export const formatTime = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** "14:05" today, "24 out 14:05" another day (a pause's end, when a computer went offline). */
export const clockAt = (locale: string, iso: string, now = new Date()) =>
  daysBetween(iso, now) === 0 ? formatTime(locale, iso) : `${formatShortDate(locale, iso)} ${formatTime(locale, iso)}`;

/** "12 out" */
export const formatShortDate = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" })
    .format(new Date(iso))
    .replace(/\.$/, "")
    .replace(" de ", " ");

/** "outubro" */
export const formatMonth = (locale: string, date: Date) =>
  new Intl.DateTimeFormat(locale, { month: "long" }).format(date);

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Calendar distance in days (0 = today, 1 = yesterday). */
export const daysBetween = (iso: string, now: Date) =>
  Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000);

export const capitalize = (s: string, locale?: string) => s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);

/** A sentence's first letter in lower case, to follow a "·" ("Trabalhando · preencheu um campo"). */
export const lowerFirst = (s: string, locale?: string) => (s ? s.charAt(0).toLocaleLowerCase(locale) + s.slice(1) : s);

/** "Segunda-feira" */
export const formatWeekday = (locale: string, iso: string) =>
  capitalize(new Intl.DateTimeFormat(locale, { weekday: "long" }).format(new Date(iso)));

/** Day divider label: "Hoje", "Ontem", a weekday within the week ("Segunda-feira"), "12 out", "12 out 2025". */
export function dayLabel(t: TFunction, locale: string, iso: string, now = new Date()) {
  const days = daysBetween(iso, now);
  if (days === 0) return t("common.today");
  if (days === 1) return t("common.yesterday");
  if (days > 1 && days < 7) return formatWeekday(locale, iso);
  const year = new Date(iso).getFullYear();
  return year === now.getFullYear() ? formatShortDate(locale, iso) : `${formatShortDate(locale, iso)} ${year}`;
}

/** "terça-feira, 14 de outubro de 2026 às 21:10" (tooltip on a message's time). */
export const formatFullDate = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }).format(new Date(iso));

/** "agora", "há 2 min", "há 3 h", "ontem", "12 out". */
export function relativeTime(t: TFunction, locale: string, iso: string, now = new Date()) {
  const diff = now.getTime() - new Date(iso).getTime();
  if (diff < 60_000) return t("common.now");
  if (diff < 3_600_000) return t("format.minutesAgo", { count: Math.floor(diff / 60_000) });
  const days = daysBetween(iso, now);
  if (days === 0) return t("format.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  if (days === 1) return t("common.yesterday").toLowerCase();
  return formatShortDate(locale, iso);
}

/** "hoje 10:44", "ontem 18:02", "12 out" (run history, decisions). */
export function whenAt(t: TFunction, locale: string, iso: string, now = new Date()) {
  const days = daysBetween(iso, now);
  if (now.getTime() - new Date(iso).getTime() < 60_000) return t("common.now");
  if (days === 0) return t("format.todayAt", { time: formatTime(locale, iso) });
  if (days === 1) return t("format.yesterdayAt", { time: formatTime(locale, iso) });
  return formatShortDate(locale, iso);
}

/** Time left: "23 h", "5 dias", "12 min". */
export function timeLeft(t: TFunction, iso: string, now = new Date()) {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return null;
  if (ms < 3_600_000) return t("format.inMinutes", { count: Math.max(1, Math.floor(ms / 60_000)) });
  if (ms < 2 * 86_400_000) return t("format.inHours", { count: Math.floor(ms / 3_600_000) });
  return t("format.inDays", { count: Math.floor(ms / 86_400_000) });
}

/** "Ana" for "Ana Souza". */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

/** "Ada e Atlas", "Ada, Atlas e Theo". */
export function joinNames(names: string[], and: string) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")}${and}${names[names.length - 1]}`;
}

/** How many names a list of a team says before "and N more" (`namesText`): a ready-made team's four, whole. */
export const NAMES_SHOWN = 4;

/** "Ana", "Ana e Bruno", "Ana, Bruno e mais 2": the first `max` names of `total`. */
export function namesText(t: TFunction, names: string[], max = 2, total = names.length) {
  const shown = names.slice(0, max);
  if (total <= shown.length) return joinNames(shown, t("notifications.and"));
  return t("notifications.namesMore", { names: shown.join(", "), count: total - shown.length });
}

/** Short model label for message meta: "Claude Sonnet 5.5" → "sonnet 5.5". */
export const shortModel = (label: string) => label.replace(/^Claude\s+/i, "").toLowerCase();

/** `YYYY-MM-DD` (a day, no time zone) → noon local time, so it never shifts a day. */
export const dateOnly = (ymd: string) => new Date(`${ymd}T12:00:00`);

export const toYmd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Due date: "hoje", "24 out". */
export function dueLabel(t: TFunction, locale: string, ymd: string, now = new Date()) {
  const iso = dateOnly(ymd).toISOString();
  return daysBetween(iso, now) === 0 ? t("common.today").toLowerCase() : formatShortDate(locale, iso);
}

/** "24/10" or "24/10/2026" → `YYYY-MM-DD` (this year when omitted); null when invalid. */
export function parseDayInput(value: string, now = new Date()): string | null {
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (!m) return null;
  const d = new Date(Number(m[3] ?? now.getFullYear()), Number(m[2]) - 1, Number(m[1]));
  if (d.getDate() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1) return null;
  return toYmd(d);
}

/**
 * A step's target cut to what names it on one short line, never with an ellipsis that hides what it is: a URL is its
 * host ("console.example.com", with or without its scheme), a path its last part ("refresh.ts"), anything else its first `max` characters, cut at
 * a word when one is near.
 */
export function shortTarget(text: string, max = 40) {
  const s = text.trim();
  let out = s;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      out = new URL(s).host || s;
    } catch {
      out = s;
    }
  } else if (/^\S*\/\S*$/.test(s)) {
    const parts = s.split("/").filter(Boolean);
    const first = parts[0] ?? "";
    const last = parts.at(-1) ?? s;
    // "acme/repo", "10/31", "and/or" name nothing shorter: only a path or a host without its scheme is cut.
    if (/^(\/|\.{1,2}\/|~)/.test(s)) out = last;
    else if (first.includes(".")) out = first;
    else if (/\.[a-z0-9]{1,6}$/i.test(last)) out = last;
  }
  if (out.length <= max) return out;
  const cut = out.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return space > max / 2 ? cut.slice(0, space) : cut;
}
