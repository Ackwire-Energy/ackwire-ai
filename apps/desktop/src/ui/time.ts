import type { TFunction } from "i18next";

/** "agora", "2 min", "3 h" since a time. */
export function since(iso: string, t: TFunction, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return t("desktop.common.now");
  const min = Math.floor(ms / 60_000);
  if (min < 60) return t("desktop.common.minutes", { count: min });
  return t("desktop.common.hours", { count: Math.floor(min / 60) });
}

/** "16:24" (today) or "sex., 9:00" (another day), in the app's language. */
export function clock(iso: string, locale: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString(locale, { weekday: "short" })} ${time}`;
}

/** A day heading for dates older than yesterday: "12 de outubro". */
export function dayLabel(day: Date, locale: string): string {
  return day.toLocaleDateString(locale, { day: "numeric", month: "long" });
}

/** The last part of a path, for showing a folder by its name. */
export function baseName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** `/Users/ana/Documents/x` → `~/Documents/x` when we know the home prefix. */
export function shortPath(path: string): string {
  const m = /^\/Users\/[^/]+(\/.*)?$/.exec(path);
  return m ? `~${m[1] ?? ""}` : path;
}

/** "Ada, Bento e Lia" / "Ada, Bento and Lia". */
export function listNames(names: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}
