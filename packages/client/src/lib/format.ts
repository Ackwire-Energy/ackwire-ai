import type { TFunction } from "i18next";

/**
 * Machine numbers, precise and spelled out (design README: "sonnet 5.5 ·
 * 1.240 tokens · US$ 0,004"). Locale-aware; pt-BR uses "," for decimals.
 */

/** US$ with 2 decimals, or more for tiny amounts (US$ 0,004). */
export function formatUsd(t: TFunction, locale: string, value: number) {
  const abs = Math.abs(value);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 3 : 2;
  const text = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
    value,
  );
  return t("format.usd", { value: text });
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

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

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

/** "Ada e Atlas", "Ada, Atlas e Theo". */
export function joinNames(names: string[], and: string) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")}${and}${names[names.length - 1]}`;
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
