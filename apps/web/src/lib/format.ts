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

/** Day divider label: "Hoje", "Ontem", "12 out". */
export function dayLabel(t: TFunction, locale: string, iso: string, now = new Date()) {
  const days = daysBetween(iso, now);
  if (days === 0) return t("common.today");
  if (days === 1) return t("common.yesterday");
  return formatShortDate(locale, iso);
}

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
